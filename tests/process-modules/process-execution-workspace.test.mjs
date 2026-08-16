// tests/process-modules/process-execution-workspace.test.mjs
//
// `prepareProcessExecutionWorkspace` function and the loose
// `ProcessExecutionWorkspace` interface were REMOVED in D2. The pinned
// materializer (`materializePinnedWorkspace`) is now the SOLE desk creator
// and returns the strict `WorkplaceDesk` contract enforced by
// `assertDeskInvariants`.
//
// This file was rewritten to cover what survived the cutover:
//   1. The reusable helpers still exported from process-execution-workspace.ts
//      (parseMetadata, buildMachineBindings, fillKnownPlaceholders,
//      refreshMarkdownMachineBindings, materializedName, relativeWorkspacePath).
//   2. The strict WorkplaceDesk contract end-to-end via materializePinnedWorkspace:
//      node-stable tracker + execution directory, machine-binding fill, retry
//      checkpoint preservation, and assertDeskInvariants enforcement.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  parseMetadata,
  buildMachineBindings,
  fillKnownPlaceholders,
  refreshMarkdownMachineBindings,
  materializedName,
  relativeWorkspacePath,
} = await import('../../dist/process-modules/application/process-execution-workspace.js');

const {
  materializePinnedWorkspace,
  assertDeskInvariants,
} = await import('../../dist/process-modules/application/pinned-workspace-materializer.js');

const encoder = new TextEncoder();
const trackerPath = 'resources/process-stage-tracker.md';
const callPath = 'resources/submit-call-template.json';
const checklistPath = 'resources/checklist.md';

function trackerContent() {
  return [
    '# Tracker',
    '- process_module_ref: `{PROCESS_MODULE_REF}`',
    '- process_run_id: `{PROCESS_RUN_ID}`',
    '- node_id: `{NODE_ID}`',
    '- work_intent_id: `{WORK_INTENT_ID}`',
    '- task_id: `{TASK_ID}`',
    '- execution_id: `{EXECUTION_ID}`',
    '- worker_id: `{WORKER_ID}`',
    '## Current Step: 1',
    '- [ ] 1. first',
    '- [ ] 2. second',
    '',
  ].join('\n');
}

function callTemplateContent() {
  return JSON.stringify({
    task_id: 'FILL_INTEGER_MACHINE_BOUND_TASK_ID',
    work_intent_id: 'FILL_INTEGER_MACHINE_BOUND_WORK_INTENT_ID',
    execution_id: 'FILL_MACHINE_BOUND_EXECUTION_ID',
    semantic_payload: 'FILL_BY_MODEL',
  }, null, 2);
}

/**
 * Build the WorkspaceProjection + StoredModulePackage fixtures the pinned
 * materializer consumes. Resources are in-memory blobs keyed by logicalId so
 * no project-tree asset reads are needed.
 */
function pinnedPackageFixture() {
  const resources = [
    {
      logicalId: 'tracker',
      relativePath: trackerPath,
      kind: 'template',
      content: trackerContent(),
    },
    {
      logicalId: 'call',
      relativePath: callPath,
      kind: 'template',
      content: callTemplateContent(),
    },
    {
      logicalId: 'checklist',
      relativePath: checklistPath,
      kind: 'checklist',
      content: '# Checklist\n- [ ] verify\n',
    },
  ].map(resource => ({
    ...resource,
    digest: `${resource.logicalId}-digest`,
    bytes: encoder.encode(resource.content),
  }));
  const projectionResources = resources.map(
    ({ content: _c, bytes: _b, ...item }) => item,
  );
  const storedResources = resources.map(
    ({ relativePath: _p, content: _c, ...item }) => item,
  );
  return { resources, projectionResources, storedResources };
}

const moduleDefinition = {
  identity: {
    name: 'example-module',
    version: '1.0.0',
    kind: 'example',
    displayName: 'Example',
    description: 'Example',
  },
  flow: { nodes: [] },
};

const profile = {
  id: 'example-worker',
  protocolSkill: 'protocol',
  semanticSkill: 'semantic',
  allowedTools: ['task_get', 'worker_done', 'Read'],
  trackerTemplate: trackerPath,
  workspaceTemplates: [],
  callTemplates: [callPath],
  checklists: [checklistPath],
  outputSchema: { id: 'example.output.v1' },
  retryPolicy: { maxAttempts: 2 },
};

function pinnedRequest(root, overrides = {}) {
  const { projectionResources, storedResources } = pinnedPackageFixture();
  return {
    projection: {
      installationId: 1,
      moduleRef: 'example-module@1.0.0',
      packageDigest: 'example-digest',
      storeLocation: 'memory',
      nodeId: 'produce-example',
      executionProfileId: 'example-worker',
      skills: {},
      templates: projectionResources,
      checklists: [],
      instructions: [],
      allResources: projectionResources,
      description: {},
    },
    storedPackage: {
      manifest: { definition: {}, assistance: [] },
      resources: storedResources,
      packageDigest: 'example-digest',
      storedAt: 'memory',
    },
    workspaceRoot: root,
    module: moduleDefinition,
    profile,
    projectId: 7,
    epicId: 39,
    task: {
      id: 6291,
      metadata: {
        work_intent_id: 10271,
        process_run_id: 44,
        process_node_id: 'produce-example',
      },
    },
    executionId: 'exec-1',
    workerId: 'worker-1',
    ...overrides,
  };
}

// ===========================================================================
// 1. Surviving helpers from process-execution-workspace.ts
// ===========================================================================

test('parseMetadata: returns {} for null/undefined/non-object, parses JSON string', () => {
  assert.deepEqual(parseMetadata(null), {});
  assert.deepEqual(parseMetadata(undefined), {});
  assert.deepEqual(parseMetadata('not json'), {});
  assert.deepEqual(parseMetadata(123), {});
  assert.deepEqual(parseMetadata({ a: 1 }), { a: 1 });
  assert.deepEqual(parseMetadata('{"b":2}'), { b: 2 });
  // Array JSON is not an object record.
  assert.deepEqual(parseMetadata('[1,2,3]'), {});
});

test('materializedName: strips -template suffix, keeps extension', () => {
  assert.equal(materializedName('foo/submit-call-template.json'), 'submit-call.json');
  assert.equal(materializedName('foo/tracker.md'), 'tracker.md');
  // Case-insensitive suffix.
  assert.equal(materializedName('foo/X-TEMPLATE.json'), 'X.json');
});

test('relativeWorkspacePath: POSIX-normalised project-relative path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-rel-'));
  try {
    const abs = path.join(root, 'docs', 'example', 'tracker.md');
    assert.equal(
      relativeWorkspacePath(root, abs),
      'docs/example/tracker.md',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fillKnownPlaceholders: replaces {UPPER} tokens from bindings', () => {
  const filled = fillKnownPlaceholders(
    'task={TASK_ID} node={NODE_ID} missing={NOPE}',
    { TASK_ID: 5, NODE_ID: 'n-1' },
  );
  assert.equal(filled, 'task=5 node=n-1 missing={NOPE}');
});

test('refreshMarkdownMachineBindings: rewrites `- key: value` lines from bindings (string backticked, number bare)', () => {
  const refreshed = refreshMarkdownMachineBindings(
    '- task_id: 0\n- node_id: x\n- execution_id: e\n',
    {
      TASK_ID: 6291,
      NODE_ID: 'produce-example',
      EXECUTION_ID: 'exec-1',
      ALLOWED_TOOLS: ['task_get'],
    },
  );
  // task_id is a number → rendered bare; node_id/execution_id strings → backticked.
  assert.match(refreshed, /- task_id: 6291\r?\n/);
  assert.match(refreshed, /- node_id: `produce-example`/);
  assert.match(refreshed, /- execution_id: `exec-1`/);
});

// ===========================================================================
// 2. WorkplaceDesk contract via materializePinnedWorkspace
// ===========================================================================

test('materializePinnedWorkspace: binds exact task + node, returns a WorkplaceDesk satisfying I1–I5', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-pinned-desk-'));
  try {
    const desk = materializePinnedWorkspace(pinnedRequest(root));
    // I1: tracker filename is node-stable.
    assert.equal(
      path.basename(desk.trackerAbsolutePath),
      'project-39-example-node-produce-example.md',
    );
    assert.ok(desk.trackerAbsolutePath.endsWith('node-produce-example.md'));
    // I2: executionDirectory keyed by node.
    assert.ok(desk.executionDirectory.includes('node-produce-example'));
    // Strict feedback tuples: nothing present for this fixture.
    assert.equal(desk.recoveryFeedback.present, false);
    assert.equal(desk.recoveryFeedback.path, null);
    assert.equal(desk.reviewFeedback.present, false);
    assert.equal(desk.reviewFeedback.path, null);
    // agentAssistance.required is false (package has no assistance manifest).
    assert.equal(desk.agentAssistance.required, false);
    assert.equal(desk.agentAssistance.path, null);
    // Identity fields.
    assert.equal(desk.nodeId, 'produce-example');
    assert.equal(desk.profileId, 'example-worker');
    assert.equal(desk.moduleRef, 'example-module@1.0.0');
    // templates) + feedback paths. This fixture has no workspace templates and
    // no feedback, so it is empty.
    assert.deepEqual(desk.workspaceFiles, []);
    // callFiles carries the materialized call templates separately.
    assert.ok(desk.callFiles.length === 1);

    // Machine bindings flowed into the tracker. The binding renderer wraps
    // STRING values in backticks but emits NUMBERS bare, so numeric metadata
    // (process_run_id: 44, work_intent_id: 10271) render without backticks
    // while the string execution_id renders with backticks.
    const tracker = readFileSync(desk.trackerAbsolutePath, 'utf8');
    assert.match(tracker, /- process_run_id: 44\r?\n/);            // number → bare
    assert.match(tracker, /- work_intent_id: 10271\r?\n/);          // number → bare
    assert.match(tracker, /- task_id: 6291\r?\n/);                  // number → bare
    assert.match(tracker, /- node_id: `produce-example`/);          // string → backticked
    assert.match(tracker, /- execution_id: `exec-1`/);              // string → backticked
    assert.match(tracker, /- worker_id: `worker-1`/);               // string → backticked

    // The JSON call file got task_id/work_intent_id/execution_id overwritten.
    const call = JSON.parse(readFileSync(path.join(root, desk.callFiles[0]), 'utf8'));
    assert.equal(call.task_id, 6291);
    assert.equal(call.work_intent_id, 10271);
    assert.equal(call.execution_id, 'exec-1');
    assert.equal(call.semantic_payload, 'FILL_BY_MODEL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializePinnedWorkspace: node-stable desk inherits prior execution drafts and keeps a node-stable tracker filename across retries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-pinned-retry-'));
  try {
    const first = materializePinnedWorkspace(pinnedRequest(root));
    // A model-authored call-file draft (semantic work) in the first execution.
    const firstCallPath = path.join(root, first.callFiles[0]);
    writeFileSync(
      firstCallPath,
      JSON.stringify({ model_authored: true, preserved: 'draft' }, null, 2),
    );

    // Replay: a NEW execution (exec-2) under the SAME node. The desk is
    // node-keyed, so the new execution directory is a SIBLING of the first
    // under executions/node-produce-example/. Draft inheritance (step 5)
    // copies the call file from the prior execution so semantic work survives.
    const replay = materializePinnedWorkspace(
      pinnedRequest(root, { executionId: 'exec-2', workerId: 'worker-2' }),
    );
    // I1: tracker FILENAME is node-stable across executions (same name).
    assert.equal(
      path.basename(replay.trackerAbsolutePath),
      path.basename(first.trackerAbsolutePath),
    );
    // I2: both execution directories share the node-stable parent segment.
    assert.ok(first.executionDirectory.includes('node-produce-example'));
    assert.ok(replay.executionDirectory.includes('node-produce-example'));
    assert.notEqual(first.executionDirectory, replay.executionDirectory);
    // Draft inheritance: the call-file draft from exec-1 was copied into exec-2.
    const replayCall = JSON.parse(
      readFileSync(path.join(root, replay.callFiles[0]), 'utf8'),
    );
    assert.equal(replayCall.model_authored, true);
    assert.equal(replayCall.preserved, 'draft');
    // The tracker in exec-2 got the refreshed execution-scoped binding.
    const replayTracker = readFileSync(replay.trackerAbsolutePath, 'utf8');
    assert.match(replayTracker, /- execution_id: `exec-2`/);
    assert.match(replayTracker, /- worker_id: `worker-2`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializePinnedWorkspace: recovery_feedback surfaces as a present feedback tuple (I4)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-pinned-recovery-'));
  try {
    const desk = materializePinnedWorkspace(pinnedRequest(root, {
      task: {
        id: 6291,
        metadata: {
          work_intent_id: 10271,
          process_run_id: 44,
          process_node_id: 'produce-example',
          recovery_feedback: { issue_id: 'ISSUE-1', severity: 'blocking' },
        },
      },
    }));
    // I4: present === true → path !== null (asserted by assertDeskInvariants).
    assert.equal(desk.recoveryFeedback.present, true);
    assert.ok(desk.recoveryFeedback.path);
    assert.ok(desk.recoveryFeedback.path.endsWith('recovery-feedback.json'));
    const recovery = JSON.parse(
      readFileSync(path.join(root, desk.recoveryFeedback.path), 'utf8'),
    );
    assert.deepEqual(recovery, { issue_id: 'ISSUE-1', severity: 'blocking' });
    // Computed workspaceFiles now includes the feedback path.
    assert.ok(
      desk.workspaceFiles.includes(desk.recoveryFeedback.path),
      'workspaceFiles must include recovery feedback path for backward compat',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3. assertDeskInvariants — direct contract enforcement (I1–I5)
// ===========================================================================

test('assertDeskInvariants: throws WORKPLACE_DESK_TRACKER_NOT_NODE_STABLE when tracker filename is not node-stable (I1)', () => {
  const desk = {
    workplaceRef: null,
    nodeId: 'n1',
    trackerAbsolutePath: '/x/project-1-stage-task-99.md', // wrong suffix
    executionDirectory: 'docs/s/executions/node-n1/exec-1',
    recoveryFeedback: { present: false, path: null },
    reviewFeedback: { present: false, path: null },
    agentAssistance: { required: false, path: null },
  };
  assert.throws(
    () => assertDeskInvariants(desk),
    /WORKPLACE_DESK_TRACKER_NOT_NODE_STABLE/,
  );
});

test('assertDeskInvariants: throws WORKPLACE_DESK_DIR_NOT_NODE_KEYED when executionDirectory is not keyed by node (I2)', () => {
  const desk = {
    workplaceRef: null,
    nodeId: 'n1',
    trackerAbsolutePath: '/x/node-n1.md',
    executionDirectory: 'docs/s/executions/task-99', // wrong segment
    recoveryFeedback: { present: false, path: null },
    reviewFeedback: { present: false, path: null },
    agentAssistance: { required: false, path: null },
  };
  assert.throws(
    () => assertDeskInvariants(desk),
    /WORKPLACE_DESK_DIR_NOT_NODE_KEYED/,
  );
});

test('assertDeskInvariants: throws WORKPLACE_DESK_ASSISTANCE_REQUIRED_BUT_MISSING when required but path null (I3)', () => {
  const desk = {
    workplaceRef: null,
    nodeId: 'n1',
    trackerAbsolutePath: '/x/node-n1.md',
    executionDirectory: 'docs/s/executions/node-n1/exec-1',
    recoveryFeedback: { present: false, path: null },
    reviewFeedback: { present: false, path: null },
    agentAssistance: { required: true, path: null },
  };
  assert.throws(
    () => assertDeskInvariants(desk),
    /WORKPLACE_DESK_ASSISTANCE_REQUIRED_BUT_MISSING/,
  );
});

test('assertDeskInvariants: throws WORKPLACE_DESK_RECOVERY_PRESENT_BUT_NO_PATH (I4) and REVIEW_PRESENT_BUT_NO_PATH (I5)', () => {
  const base = {
    workplaceRef: null,
    nodeId: 'n1',
    trackerAbsolutePath: '/x/node-n1.md',
    executionDirectory: 'docs/s/executions/node-n1/exec-1',
    agentAssistance: { required: false, path: null },
  };
  assert.throws(
    () => assertDeskInvariants({
      ...base,
      recoveryFeedback: { present: true, path: null },
      reviewFeedback: { present: false, path: null },
    }),
    /WORKPLACE_DESK_RECOVERY_PRESENT_BUT_NO_PATH/,
  );
  assert.throws(
    () => assertDeskInvariants({
      ...base,
      recoveryFeedback: { present: false, path: null },
      reviewFeedback: { present: true, path: null },
    }),
    /WORKPLACE_DESK_REVIEW_PRESENT_BUT_NO_PATH/,
  );
});

test('assertDeskInvariants: passes a well-formed desk (all invariants satisfied)', () => {
  const desk = {
    workplaceRef: null,
    nodeId: 'n1',
    trackerAbsolutePath: '/x/project-1-stage-node-n1.md',
    executionDirectory: 'docs/s/executions/node-n1/exec-1',
    recoveryFeedback: { present: true, path: 'docs/s/executions/node-n1/exec-1/recovery-feedback.json' },
    reviewFeedback: { present: false, path: null },
    agentAssistance: { required: true, path: 'docs/s/executions/node-n1/exec-1/agent-assistance.json' },
  };
  // Does not throw.
  assertDeskInvariants(desk);
});
