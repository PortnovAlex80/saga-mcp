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

const { prepareProcessExecutionWorkspace } = await import(
  '../../dist/process-modules/application/process-execution-workspace.js'
);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-process-workspace-'));
  const templates = path.join(root, 'tool-templates', 'example');
  mkdirSync(templates, { recursive: true });
  writeFileSync(
    path.join(templates, 'tracker.md'),
    [
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
    ].join('\n'),
  );
  writeFileSync(
    path.join(templates, 'submit-call-template.json'),
    JSON.stringify({
      task_id: 'FILL_INTEGER_MACHINE_BOUND_TASK_ID',
      work_intent_id: 'FILL_INTEGER_MACHINE_BOUND_WORK_INTENT_ID',
      execution_id: 'FILL_MACHINE_BOUND_EXECUTION_ID',
      semantic_payload: 'FILL_BY_MODEL',
    }, null, 2),
  );
  writeFileSync(
    path.join(templates, 'checklist.md'),
    '# Checklist\n- [ ] verify\n',
  );
  return root;
}

const moduleDefinition = {
  identity: {
    name: 'example-module',
    version: '1.0.0',
    kind: 'example',
    displayName: 'Example',
    description: 'Example',
  },
};

const profile = {
  id: 'example-worker',
  protocolSkill: 'protocol',
  semanticSkill: 'semantic',
  allowedTools: ['task_get', 'worker_done', 'Read'],
  trackerTemplate: 'tool-templates/example/tracker.md',
  workspaceTemplates: ['tool-templates/example/submit-call-template.json'],
  callTemplates: ['tool-templates/example/submit-call-template.json'],
  checklists: ['tool-templates/example/checklist.md'],
  outputSchema: { id: 'example.output.v1' },
  retryPolicy: { maxAttempts: 2 },
};

test('workspace materializer binds exact task and preserves checkpoints on retry', () => {
  const root = fixture();
  try {
    const base = {
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
          process_node_id: 'produce-proposal',
        },
      },
    };
    const first = prepareProcessExecutionWorkspace({
      ...base,
      executionId: 'exec-1',
      workerId: 'worker-1',
    });
    assert.equal(
      first.trackerPath,
      'docs/example/projects/39/project-39-example-stage-6291.md',
    );
    const firstTracker = readFileSync(first.trackerAbsolutePath, 'utf8');
    assert.match(firstTracker, /process_run_id: 44/);
    assert.match(firstTracker, /work_intent_id: 10271/);
    assert.match(firstTracker, /execution_id: `exec-1`/);

    const call = JSON.parse(
      readFileSync(path.join(root, first.callFiles[0]), 'utf8'),
    );
    assert.equal(call.task_id, 6291);
    assert.equal(call.work_intent_id, 10271);
    assert.equal(call.execution_id, 'exec-1');
    assert.equal(call.semantic_payload, 'FILL_BY_MODEL');

    writeFileSync(
      first.trackerAbsolutePath,
      firstTracker.replace('- [ ] 1. first', '- [x] 1. first'),
    );
    const replay = prepareProcessExecutionWorkspace({
      ...base,
      executionId: 'exec-2',
      workerId: 'worker-2',
    });
    const replayTracker = readFileSync(replay.trackerAbsolutePath, 'utf8');
    assert.match(replayTracker, /- \[x\] 1\. first/);
    assert.match(replayTracker, /execution_id: `exec-2`/);
    assert.match(replayTracker, /worker_id: `worker-2`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace materializer rejects descriptor assets escaping the workspace', () => {
  const root = fixture();
  try {
    assert.throws(
      () => prepareProcessExecutionWorkspace({
        workspaceRoot: root,
        module: moduleDefinition,
        profile: {
          ...profile,
          workspaceTemplates: ['../outside.json'],
        },
        projectId: 7,
        epicId: 39,
        task: { id: 1, metadata: {} },
        executionId: 'exec',
        workerId: 'worker',
      }),
      /PROCESS_WORKSPACE_ASSET_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
