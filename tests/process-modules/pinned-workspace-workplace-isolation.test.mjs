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
const resources = [
  { logicalId: 'tracker', relativePath: trackerPath, content: '# Tracker\nTask: {TASK_ID}\n' },
  { logicalId: 'call', relativePath: callPath, content: '{"task_id":0,"payload":{}}\n' },
].map(item => ({
  ...item,
  digest: `${item.logicalId}-digest`,
  bytes: encoder.encode(item.content),
}));

function request(workspaceRoot, executionId, workplaceRef, taskId) {
  const allResources = resources.map(resource => ({
    logicalId: resource.logicalId,
    kind: 'template',
    relativePath: resource.relativePath,
    digest: resource.digest,
  }));
  return {
    projection: {
      installationId: 7,
      moduleRef: 'test-module@1.0.0',
      packageDigest: 'package-digest',
      storeLocation: 'mem://package',
      nodeId: 'author',
      executionProfileId: 'author-profile',
      skills: {},
      templates: allResources,
      checklists: [],
      instructions: [],
      allResources,
      description: {},
    },
    storedPackage: {
      manifest: { assistance: [] },
      resources: resources.map(resource => ({
        logicalId: resource.logicalId,
        kind: 'template',
        bytes: resource.bytes,
        digest: resource.digest,
      })),
      packageDigest: 'package-digest',
      storedAt: 'mem://verified-package',
    },
    workspaceRoot,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'formalization' },
    },
    profile: {
      id: 'author-profile',
      trackerTemplate: trackerPath,
      workspaceTemplates: [],
      callTemplates: [callPath],
      checklists: [],
      outputSchema: { id: 'test.output.v1' },
      allowedTools: ['task_get'],
      semanticSkill: 'test',
      retryPolicy: { maxAttempts: 3 },
    },
    projectId: 1,
    epicId: 1,
    task: {
      id: taskId,
      metadata: {
        process_run_id: 10,
        process_node_id: 'author',
        workplace_ref: workplaceRef,
        production_cell_id: 'cell-a',
        work_key: workplaceRef.endsWith('/a') ? 'a' : 'b',
      },
    },
    executionId,
    workerId: `worker-${executionId}`,
  };
}

test('fan-out executions with the same node never inherit another Workplace desk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saga-workplace-isolation-'));
  try {
    const refA = 'workplace/10/test-module@1.0.0/cell-a/a';
    const refB = 'workplace/10/test-module@1.0.0/cell-a/b';

    const a1 = materializePinnedWorkspace(request(root, 'exec-a1', refA, 1));
    assert.equal(a1.workplaceRef, refA);
    assert.match(a1.executionDirectory, /node-author[\\/]workplace-[a-f0-9]{24}[\\/]exec-a1/);

    const a1Call = path.join(root, a1.callFiles[0]);
    const aDraft = JSON.parse(readFileSync(a1Call, 'utf8'));
    aDraft.semantic_checkpoint = 'ONLY-A';
    writeFileSync(a1Call, `${JSON.stringify(aDraft, null, 2)}\n`);
    writeFileSync(a1.trackerAbsolutePath, '# Tracker\nA checkpoint\n');

    const b1 = materializePinnedWorkspace(request(root, 'exec-b1', refB, 2));
    assert.equal(b1.workplaceRef, refB);
    assert.notEqual(b1.trackerAbsolutePath, a1.trackerAbsolutePath);
    assert.notEqual(
      path.dirname(path.join(root, b1.executionDirectory)),
      path.dirname(path.join(root, a1.executionDirectory)),
      'different workKeys must have different physical Workplace roots',
    );
    const bDraft = JSON.parse(readFileSync(path.join(root, b1.callFiles[0]), 'utf8'));
    assert.equal(bDraft.semantic_checkpoint, undefined, 'B must not inherit A draft bytes');

    const a2 = materializePinnedWorkspace(request(root, 'exec-a2', refA, 1));
    assert.equal(a2.trackerAbsolutePath, a1.trackerAbsolutePath,
      'repair execution must reuse the stable Workplace tracker');
    assert.match(readFileSync(a2.trackerAbsolutePath, 'utf8'), /A checkpoint/);
    const a2Draft = JSON.parse(readFileSync(path.join(root, a2.callFiles[0]), 'utf8'));
    assert.equal(a2Draft.semantic_checkpoint, 'ONLY-A',
      'same-Workplace repair may inherit its own prior draft');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
