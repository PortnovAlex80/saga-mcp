import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyTestWarmStart } from '../../dist/infrastructure/testing/test-warm-start.js';

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

function fixture({ policy = 'learn', createDraft = true, content = '# Existing use cases\n' } = {}) {
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
    nodes: [{
      moduleRef: 'solution-formalization@1.0.0',
      nodeId: 'model-use-cases',
      mode: 'verify-and-submit-existing-draft',
      drafts: [{
        path: 'docs/requirements/use-cases.md',
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
    moduleRef: 'solution-formalization@1.0.0',
    nodeId: 'model-use-cases',
    processWorkspace: workspace(f.root),
  });
  assert.deepEqual(result.testWarmStart.draftFiles, [
    'docs/requirements/use-cases.md',
  ]);
  assert.deepEqual(result.testWarmStart.coldStartFiles, []);
  assert.match(result.testWarmStart.instruction, /normal materialized MCP calls/);
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
