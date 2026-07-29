import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ClaudeBoardRunner } from '../../tracker-view/claude-runner.mjs';
import {
  applyTestWarmStart,
  captureTestWarmStart,
} from '../../dist/infrastructure/testing/test-warm-start.js';

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('timed out'));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function workspace(root) {
  return {
    profileId: 'formalization-use-cases',
    moduleRef: 'solution-formalization@1.0.0',
    trackerPath: 'docs/tracker.md',
    trackerAbsolutePath: path.join(root, 'docs', 'tracker.md'),
    executionDirectory: 'docs/formalization/execution',
    workspaceFiles: [],
    callFiles: [],
    checklists: [],
  };
}

function fixture({
  policy = 'learn',
  createDraft = true,
  content = '# Existing use cases\n',
  epicId = 1,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-warm-start-'));
  const execution = path.join(root, 'docs', 'formalization', 'execution');
  const draft = path.join(root, 'docs', 'requirements', 'use-cases.md');
  mkdirSync(execution, { recursive: true });
  mkdirSync(path.dirname(draft), { recursive: true });
  if (createDraft) writeFileSync(draft, content);
  const hash = createDraft
    ? createHash('sha256').update(readFileSync(draft)).digest('hex')
    : null;
  const fixturePath = path.join(root, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 'saga3.test-warm-start-fixture.v1',
    fixtureId: 'uc-smoke-v1',
    epicId,
    nodes: [{
      moduleRef: 'solution-formalization@1.0.0',
      nodeId: 'model-use-cases',
      mode: 'verify-and-submit-existing-draft',
      drafts: [{
        path: 'docs/requirements/use-cases.md',
        seedPath: 'docs/requirements/use-cases.md',
        policy,
        ...(policy === 'locked' ? { sha256: hash } : {}),
      }],
    }],
  }));
  return { root, fixturePath };
}

test('disabled warm start is a byte-for-byte no-op', () => {
  const f = fixture();
  const original = workspace(f.root);
  assert.equal(applyTestWarmStart({
    env: {},
    workspaceRoot: f.root,
    epicId: 1,
    moduleRef: original.moduleRef,
    nodeId: 'model-use-cases',
    processWorkspace: original,
  }), original);
});

test('warm start exposes verified drafts without completing protocol work', () => {
  const f = fixture();
  const result = applyTestWarmStart({
    env: {
      SAGA_TEST_WARM_START: '1',
      SAGA_TEST_WARM_START_FIXTURE: f.fixturePath,
    },
    workspaceRoot: f.root,
    epicId: 1,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'model-use-cases',
    processWorkspace: workspace(f.root),
  });
  assert.deepEqual(result.testWarmStart.draftFiles, [
    'docs/requirements/use-cases.md',
  ]);
  assert.deepEqual(result.testWarmStart.coldStartFiles, []);
  assert.match(result.testWarmStart.instruction, /normal MCP calls/);
  const receipt = JSON.parse(readFileSync(
    path.join(f.root, result.testWarmStart.receiptPath),
    'utf8',
  ));
  assert.equal(receipt.fixtureId, 'uc-smoke-v1');
  assert.equal('completedSteps' in receipt, false);
});

test('learn policy treats missing and empty files as cold starts', () => {
  for (const f of [
    fixture({ createDraft: false }),
    fixture({ content: '   \n' }),
  ]) {
    const result = applyTestWarmStart({
      env: {
        SAGA_TEST_WARM_START: '1',
        SAGA_TEST_WARM_START_FIXTURE: f.fixturePath,
      },
      workspaceRoot: f.root,
      epicId: 1,
      moduleRef: 'solution-formalization@1.0.0',
      nodeId: 'model-use-cases',
      processWorkspace: workspace(f.root),
    });
    assert.deepEqual(result.testWarmStart.draftFiles, []);
    assert.deepEqual(result.testWarmStart.coldStartFiles, [
      'docs/requirements/use-cases.md',
    ]);
  }
});

test('warm start fails closed on one-key enablement and locked hash drift', () => {
  const f = fixture({ policy: 'locked' });
  const request = {
    workspaceRoot: f.root,
    epicId: 1,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'model-use-cases',
    processWorkspace: workspace(f.root),
  };
  assert.throws(
    () => applyTestWarmStart({
      ...request,
      env: { SAGA_TEST_WARM_START: '1' },
    }),
    /TEST_WARM_START_INTERLOCK_REQUIRED/,
  );
  writeFileSync(
    path.join(f.root, 'docs', 'requirements', 'use-cases.md'),
    '# changed\n',
  );
  assert.throws(
    () => applyTestWarmStart({
      ...request,
      env: {
        SAGA_TEST_WARM_START: '1',
        SAGA_TEST_WARM_START_FIXTURE: f.fixturePath,
      },
    }),
    /TEST_WARM_START_DRAFT_HASH_MISMATCH/,
  );
});

test('a failed cold run populates one epic source and the next run restores it', () => {
  const f = fixture({ createDraft: false, epicId: 41 });
  const request = {
    env: {
      SAGA_TEST_WARM_START: '1',
      SAGA_TEST_WARM_START_FIXTURE: f.fixturePath,
    },
    workspaceRoot: f.root,
    epicId: 41,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'model-use-cases',
  };
  const first = applyTestWarmStart({
    ...request,
    processWorkspace: workspace(f.root),
  });
  assert.deepEqual(first.testWarmStart.coldStartFiles, [
    'docs/requirements/use-cases.md',
  ]);

  const target = path.join(f.root, 'docs', 'requirements', 'use-cases.md');
  writeFileSync(target, '# Draft produced before a later failure\n');
  captureTestWarmStart(f.root, first, 'failed');

  writeFileSync(target, '');
  const second = applyTestWarmStart({
    ...request,
    processWorkspace: workspace(f.root),
  });
  assert.deepEqual(second.testWarmStart.draftFiles, [
    'docs/requirements/use-cases.md',
  ]);
  assert.equal(
    readFileSync(target, 'utf8'),
    '# Draft produced before a later failure\n',
  );
  assert.match(second.testWarmStart.cacheRoot, /epics\/41/);

  const otherEpic = applyTestWarmStart({
    ...request,
    epicId: 42,
    processWorkspace: workspace(f.root),
  });
  assert.equal(otherEpic.testWarmStart, undefined);
});

test('dynamic execution paths use a logical workspace slot without globbing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-warm-dynamic-'));
  const seed = path.join(root, 'seed', 'discovery.md');
  const firstTarget = path.join(root, 'docs', 'execution-1', 'discovery-doc.md');
  mkdirSync(path.dirname(seed), { recursive: true });
  mkdirSync(path.dirname(firstTarget), { recursive: true });
  writeFileSync(seed, '# Prior discovery\n');
  writeFileSync(firstTarget, '# Empty template\n');
  const fixturePath = path.join(root, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 'saga3.test-warm-start-fixture.v1',
    fixtureId: 'dynamic-discovery',
    epicId: 9,
    nodes: [{
      moduleRef: 'product-discovery@3.0.2',
      nodeId: 'produce-proposal',
      mode: 'verify-and-submit-existing-draft',
      drafts: [{
        slot: 'discovery-document',
        workspaceFile: 'discovery-doc.md',
        seedPath: 'seed/discovery.md',
        policy: 'learn',
      }],
    }],
  }));
  const env = {
    SAGA_TEST_WARM_START: '1',
    SAGA_TEST_WARM_START_FIXTURE: fixturePath,
  };
  const firstWorkspace = {
    ...workspace(root),
    moduleRef: 'product-discovery@3.0.2',
    executionDirectory: 'docs/execution-1',
    workspaceFiles: ['docs/execution-1/discovery-doc.md'],
  };
  const first = applyTestWarmStart({
    env,
    workspaceRoot: root,
    epicId: 9,
    moduleRef: 'product-discovery@3.0.2',
    nodeId: 'produce-proposal',
    processWorkspace: firstWorkspace,
  });
  assert.equal(readFileSync(firstTarget, 'utf8'), '# Prior discovery\n');
  writeFileSync(firstTarget, '# Improved discovery\n');
  captureTestWarmStart(root, first, 'completed');

  const secondTarget = path.join(root, 'docs', 'execution-2', 'discovery-doc.md');
  mkdirSync(path.dirname(secondTarget), { recursive: true });
  writeFileSync(secondTarget, '# Fresh template\n');
  const second = applyTestWarmStart({
    env,
    workspaceRoot: root,
    epicId: 9,
    moduleRef: 'product-discovery@3.0.2',
    nodeId: 'produce-proposal',
    processWorkspace: {
      ...firstWorkspace,
      executionDirectory: 'docs/execution-2',
      workspaceFiles: ['docs/execution-2/discovery-doc.md'],
    },
  });
  assert.equal(readFileSync(secondTarget, 'utf8'), '# Improved discovery\n');
  assert.equal(second.testWarmStart.cacheEntries[0].slot, 'discovery-document');
});

test('later epic stages add independent slots without overwriting earlier drafts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-warm-stages-'));
  const execution = path.join(root, 'docs', 'formalization', 'execution');
  mkdirSync(execution, { recursive: true });
  mkdirSync(path.join(root, 'docs', 'requirements'), { recursive: true });
  const fixturePath = path.join(root, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 'saga3.test-warm-start-fixture.v1',
    fixtureId: 'stage-accumulation',
    epicId: 12,
    nodes: [
      {
        moduleRef: 'solution-formalization@1.0.0',
        nodeId: 'model-use-cases',
        mode: 'verify-and-submit-existing-draft',
        drafts: [{
          slot: 'use-cases',
          path: 'docs/requirements/use-cases.md',
          policy: 'learn',
        }],
      },
      {
        moduleRef: 'solution-formalization@1.0.0',
        nodeId: 'define-acceptance-contract',
        mode: 'verify-and-submit-existing-draft',
        drafts: [{
          slot: 'acceptance',
          path: 'docs/requirements/acceptance.md',
          policy: 'learn',
        }],
      },
    ],
  }));
  const base = {
    env: {
      SAGA_TEST_WARM_START: '1',
      SAGA_TEST_WARM_START_FIXTURE: fixturePath,
    },
    workspaceRoot: root,
    epicId: 12,
    moduleRef: 'solution-formalization@1.0.0',
  };
  const uc = applyTestWarmStart({
    ...base,
    nodeId: 'model-use-cases',
    processWorkspace: workspace(root),
  });
  writeFileSync(
    path.join(root, 'docs', 'requirements', 'use-cases.md'),
    '# Use cases\n',
  );
  captureTestWarmStart(root, uc, 'completed');

  const ac = applyTestWarmStart({
    ...base,
    nodeId: 'define-acceptance-contract',
    processWorkspace: workspace(root),
  });
  writeFileSync(
    path.join(root, 'docs', 'requirements', 'acceptance.md'),
    '# Acceptance\n',
  );
  captureTestWarmStart(root, ac, 'failed');

  assert.equal(
    readFileSync(
      path.join(root, uc.testWarmStart.cacheEntries[0].cachePath),
      'utf8',
    ),
    '# Use cases\n',
  );
  assert.equal(
    readFileSync(
      path.join(root, ac.testWarmStart.cacheEntries[0].cachePath),
      'utf8',
    ),
    '# Acceptance\n',
  );
  assert.notEqual(
    uc.testWarmStart.cacheEntries[0].cachePath,
    ac.testWarmStart.cacheEntries[0].cachePath,
  );
});

test('two unchanged failed captures force a substantial rewrite on the next run', () => {
  const f = fixture({ epicId: 77 });
  const request = {
    env: {
      SAGA_TEST_WARM_START: '1',
      SAGA_TEST_WARM_START_FIXTURE: f.fixturePath,
    },
    workspaceRoot: f.root,
    epicId: 77,
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'model-use-cases',
  };
  const first = applyTestWarmStart({
    ...request,
    processWorkspace: workspace(f.root),
  });
  captureTestWarmStart(f.root, first, 'failed');
  const second = applyTestWarmStart({
    ...request,
    processWorkspace: workspace(f.root),
  });
  captureTestWarmStart(f.root, second, 'changes_requested');
  const third = applyTestWarmStart({
    ...request,
    processWorkspace: workspace(f.root),
  });
  assert.deepEqual(third.testWarmStart.forceRewriteSlots, ['use-cases.md']);
});

test('runner invokes post-worker capture even when the worker exits before worker_done', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-warm-runner-'));
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  let claimed = false;
  const captures = [];
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(root, 'saga.db'),
    sagaEntry: path.join(root, 'dist', 'index.js'),
    sagaSkillRoot: path.join(root, 'skills'),
    logRoot: path.join(root, 'logs'),
    getProject: id => ({ id, name: 'warm-runner' }),
    resolveWorkspace: () => root,
    claimTask: ({ worker_id }) => {
      if (claimed) return { task: null, skill: null };
      claimed = true;
      return {
        task: {
          id: 1,
          title: 'Interrupted draft',
          status: 'todo',
          assigned_to: worker_id,
          tags: '[]',
        },
        skill: 'saga-worker',
      };
    },
    getTaskState: () => ({
      id: 1,
      status: 'in_progress',
      assigned_to: 'worker',
    }),
    recoverAssignment: () => true,
    prepareWorkspace: () => ({
      ...workspace(root),
      testWarmStart: {
        fixtureId: 'runner-capture',
        mode: 'verify-and-submit-existing-draft',
        nodeId: 'model-use-cases',
        draftFiles: [],
        coldStartFiles: [],
        forceRewriteSlots: [],
        instruction: 'test',
        receiptPath: 'receipt.json',
        cacheRoot: '.saga/test-draft-cache/epics/1',
        cacheEntries: [],
      },
    }),
    captureWorkspace: input => captures.push(input),
    spawn: () => {
      const child = fakeChild(9001);
      setTimeout(() => child.emit('close', 1), 10);
      return child;
    },
  });
  try {
    runner.start({ projectId: 1, epicId: 1, concurrency: 1 });
    await waitFor(() => captures.length === 1);
    assert.equal(captures[0].outcome, 'failed');
    assert.equal(captures[0].workspaceRoot, root);
    assert.equal(captures[0].processWorkspace.testWarmStart.fixtureId, 'runner-capture');
  } finally {
    runner.dispose();
  }
});
