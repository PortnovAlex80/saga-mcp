import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { materializePinnedWorkspace } = await import(
  '../../dist/process-modules/application/pinned-workspace-materializer.js'
);

const encoder = new TextEncoder();
const trackerPath = 'package/resources/tracker.md';
const callPath = 'package/resources/call.json';
const checklistPath = 'package/resources/checklist.md';
const resources = [
  { logicalId: 'tracker', relativePath: trackerPath, content: '# Tracker\nTask: {TASK_ID}\n- [ ] submit\n' },
  { logicalId: 'call', relativePath: callPath, content: '{"task_id":0,"payload":{}}\n' },
  { logicalId: 'checklist', relativePath: checklistPath, content: '- [ ] valid\n' },
].map(item => ({
  ...item,
  digest: `${item.logicalId}-digest`,
  bytes: encoder.encode(item.content),
}));

function request(workspaceRoot, executionId) {
  const allResources = resources.map(resource => ({
    logicalId: resource.logicalId,
    kind: resource.logicalId === 'checklist' ? 'checklist' : 'template',
    relativePath: resource.relativePath,
    digest: resource.digest,
  }));
  return {
    projection: {
      installationId: 7,
      moduleRef: 'test-module@1.0.0',
      packageDigest: 'package-digest',
      storeLocation: 'Z:\\path-that-does-not-exist',
      nodeId: 'author',
      executionProfileId: 'author-profile',
      skills: {},
      templates: allResources.filter(resource => resource.kind === 'template'),
      checklists: allResources.filter(resource => resource.kind === 'checklist'),
      instructions: [],
      allResources,
      description: {},
    },
    storedPackage: {
      manifest: {
        assistance: [{
          nodeId: 'author',
          mode: 'intensive',
          budgets: { maxTokensPerBlock: 100, maxBlocksPerEvent: 4 },
          events: [
            {
              event: 'post-tool-success',
              blocks: [
                { kind: 'current-step', content: 'Continue {NODE_ID} from {TRACKER_PATH}.' },
                { kind: 'resource-path', content: 'Calls: {CALL_FILES}; checks: {CHECKLISTS}.' },
                { kind: 'allowed-tools', content: '{ALLOWED_TOOLS}' },
              ],
            },
            {
              event: 'post-tool-error',
              blocks: [
                { kind: 'retry-instruction', content: 'Repair {CALL_FILES} and retry.' },
              ],
            },
          ],
        }],
      },
      resources: resources.map(resource => ({
        logicalId: resource.logicalId,
        kind: resource.logicalId === 'checklist' ? 'checklist' : 'template',
        bytes: resource.bytes,
        digest: resource.digest,
      })),
      packageDigest: 'package-digest',
      storedAt: 'mem://verified-package',
    },
    workspaceRoot,
    module: {
      identity: {
        name: 'test-module',
        version: '1.0.0',
        kind: 'formalization',
      },
    },
    profile: {
      id: 'author-profile',
      trackerTemplate: trackerPath,
      workspaceTemplates: [],
      callTemplates: [callPath],
      checklists: [checklistPath],
      outputSchema: { id: 'test.output.v1' },
      allowedTools: ['task_get'],
      semanticSkill: 'test',
      retryPolicy: { maxAttempts: 2 },
    },
    projectId: 1,
    epicId: 1,
    task: {
      id: 1,
      metadata: {
        process_run_id: 10,
        process_node_id: 'author',
      },
    },
    executionId,
    workerId: 'worker-1',
  };
}

test('pinned materializer uses verified blobs and isolates semantic checkpoints by execution', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saga-pinned-workspace-'));
  try {
    const first = materializePinnedWorkspace(request(root, 'exec-one'));
    // CGAD P18: the desk is keyed by the NODE (workplace), not the task.
    // nodeId for this fixture is 'author' (see executionScope below).
    assert.match(first.executionDirectory, /node-author\/exec-one|node-author\\exec-one/);
    assert.match(readFileSync(first.trackerAbsolutePath, 'utf8'), /Task: 1/);
    writeFileSync(first.trackerAbsolutePath, '# Tracker\n- [x] stale completion\n');

    const second = materializePinnedWorkspace(request(root, 'exec-two'));
    assert.notEqual(second.trackerAbsolutePath, first.trackerAbsolutePath);
    assert.doesNotMatch(readFileSync(second.trackerAbsolutePath, 'utf8'), /stale completion/);
    assert.equal(
      JSON.parse(readFileSync(path.join(root, second.callFiles[0]), 'utf8')).task_id,
      1,
    );
    assert.match(readFileSync(path.join(root, second.checklists[0]), 'utf8'), /valid/);
    assert.ok(second.agentAssistanceAbsolutePath);
    const assistance = JSON.parse(
      readFileSync(second.agentAssistanceAbsolutePath, 'utf8'),
    );
    assert.equal(assistance.executionId, 'exec-two');
    assert.equal(assistance.executionScope.nodeId, 'author');
    assert.equal(assistance.executionScope.processRunId, 10);
    assert.deepEqual(
      assistance.events.map(event => event.event),
      ['post-tool-success', 'post-tool-error'],
    );
    assert.match(
      assistance.events[0].blocks[0].content,
      /docs[\\/]formalization[\\/]projects[\\/]1[\\/]executions[\\/]node-author[\\/]exec-two/,
    );
    assert.match(assistance.events[0].blocks[2].content, /task_get/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
