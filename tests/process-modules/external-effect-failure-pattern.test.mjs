// tests/process-modules/external-effect-failure-pattern.test.mjs
//
// BLINDSIGHT F2 (persistence layer, PREVENTIVE-HUNT «Слепота по слоям»):
// `factory_external_effect_events` is a full append-only audit trail (every
// claim, result, and observation with its complete payload + payload hash),
// but the retry logic read ONLY the action row's `last_error` (one column,
// latest value). The RETRY PATTERN was invisible: the git-integration effect
// cycled failed -> observe absent-retry-safe -> retry-authorized -> claim ->
// fail with the SAME error, forever, each cycle indistinguishable from the
// first because only the last error survived.
//
// This suite pins the honest repair:
//   - the ledger exposes the audit-trail reader readExecutionFailurePattern
//     (consecutive identical failure identities, skipping the retry-cycle
//     bookkeeping events between them);
//   - the git-integration effect consults the PATTERN at the moment it is
//     about to authorize ANOTHER retry: K consecutive identical failures are
//     spin -> typed human_required (fail-closed), not one more blind retry.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { sha256Hex } = await import('../../dist/shared/canonical-json.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteExternalEffectLedger } = await import(
  '../../dist/process-modules/persistence/sqlite-external-effect-ledger.js'
);
const {
  DEFAULT_EFFECT_FAILURE_STASIS_THRESHOLD,
  integrationRetryDecision,
} = await import('../../dist/infrastructure/workplace/git-integration-effect.js');

const MODULE_REF = { name: 'software-delivery', version: '1.0.0' };

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-effect-pattern-'));
  process.env.DB_PATH = path.join(temp, 'effect-pattern.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const processRepo = new SqliteProcessRunRepository(db);
  const input = { releaseCandidateRef: 'candidate:abc' };
  const processRun = processRepo.start({
    moduleRef: MODULE_REF,
    executorKind: 'generic-flow',
    input: {
      schema: 'factory.delivery-case.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'delivery',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'operator',
      idempotencyKey: 'delivery-run-1',
    },
  }).record;
  return {
    temp,
    db,
    processRun,
    ledger: new SqliteExternalEffectLedger(db),
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startAction(ledger, processRunId, overrides = {}) {
  const request = overrides.request ?? {
    candidateHash: 'a'.repeat(64),
    environment: 'production',
  };
  return ledger.start({
    providerNamespace: overrides.providerNamespace ?? 'release-provider.v1',
    actionKey: overrides.actionKey ?? 'deploy:candidate-abc:production',
    processRunId: overrides.processRunId ?? processRunId,
    moduleRef: overrides.moduleRef ?? MODULE_REF,
    nodeId: overrides.nodeId ?? 'execute-release',
    request,
    requestHash: sha256Hex(request),
  }).record;
}

/** Drive one full failed retry cycle: claim -> fail(sameError) -> observe absent. */
function driveFailedCycle(ledger, actionId, error, owner) {
  const claimed = ledger.claim({ actionId, owner, leaseSeconds: 60 });
  assert.ok(claimed, 'claim must succeed for the cycle fixture');
  ledger.recordExecutionResult({
    claim: claimed.claim,
    result: { outcome: 'failed', error },
  });
  const observation = ledger.claimObservation({ actionId, owner: `${owner}:obs`, leaseSeconds: 60 });
  assert.ok(observation, 'observation claim must succeed for the cycle fixture');
  ledger.recordObservation({
    claim: observation.claim,
    observation: { outcome: 'absent-retry-safe', evidence: { proven: 'by-test' } },
  });
}

test('F2 ledger: readExecutionFailurePattern counts CONSECUTIVE identical failures across retry cycles', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id);
    assert.equal(
      ledger.readExecutionFailurePattern(action.id),
      null,
      'no failures recorded yet -> null pattern',
    );

    const error = 'GIT_MERGE_CONFLICT: refs/heads/dev';
    driveFailedCycle(ledger, action.id, error, 'executor-1');
    let pattern = ledger.readExecutionFailurePattern(action.id);
    assert.equal(pattern.consecutiveIdentical, 1);
    assert.equal(pattern.lastError, error);

    // The cycle repeats with the SAME error — the audit trail sees the
    // PATTERN, the row would only ever show the same single last_error.
    driveFailedCycle(ledger, action.id, error, 'executor-2');
    driveFailedCycle(ledger, action.id, error, 'executor-3');
    pattern = ledger.readExecutionFailurePattern(action.id);
    assert.equal(pattern.consecutiveIdentical, 3, 'three identical failures across cycles');

    // A DIFFERENT failure identity resets the consecutive run.
    driveFailedCycle(ledger, action.id, 'TRANSIENT_NETWORK_BLIP', 'executor-4');
    pattern = ledger.readExecutionFailurePattern(action.id);
    assert.equal(pattern.consecutiveIdentical, 1, 'a new failure identity resets the run');
    assert.equal(pattern.lastError, 'TRANSIENT_NETWORK_BLIP');
  } finally {
    cleanup(temp);
  }
});

test('F2 ledger: failure identity is the payload hash (same text, different details = different identity)', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id);
    const claimed1 = ledger.claim({ actionId: action.id, owner: 'e1', leaseSeconds: 60 });
    ledger.recordExecutionResult({
      claim: claimed1.claim,
      result: { outcome: 'failed', error: 'merge failed', details: { attempt: 1, head: 'aaa' } },
    });
    const observation1 = ledger.claimObservation({ actionId: action.id, owner: 'o1', leaseSeconds: 60 });
    ledger.recordObservation({
      claim: observation1.claim,
      observation: { outcome: 'absent-retry-safe', evidence: {} },
    });
    const claimed2 = ledger.claim({ actionId: action.id, owner: 'e2', leaseSeconds: 60 });
    ledger.recordExecutionResult({
      claim: claimed2.claim,
      // Same error TEXT but a materially different failure payload.
      result: { outcome: 'failed', error: 'merge failed', details: { attempt: 2, head: 'bbb' } },
    });
    const pattern = ledger.readExecutionFailurePattern(action.id);
    assert.equal(
      pattern.consecutiveIdentical,
      1,
      'byte-identical payloads are required for a repeat; changed evidence is a new failure identity',
    );
  } finally {
    cleanup(temp);
  }
});

test('F2 decision: K identical failures convert the next retry authorization into a typed fail-closed block', () => {
  const K = DEFAULT_EFFECT_FAILURE_STASIS_THRESHOLD;
  assert.ok(K >= 2, 'threshold is exported, parameterizable, and at least 2');

  const retryAuthorized = { id: 42, state: 'retry-authorized', lastError: 'GIT_MERGE_CONFLICT: refs/heads/dev' };
  const action = retryAuthorized;

  // Below K: one more honest retry.
  const below = integrationRetryDecision(action, { consecutiveIdentical: K - 1, lastError: action.lastError });
  assert.equal(below.outcome, 'pending');
  assert.match(below.reason, /absence proven; retry authorized/);

  // At K: the loop ends with a typed human_required escalation.
  const trip = integrationRetryDecision(action, { consecutiveIdentical: K, lastError: action.lastError });
  assert.equal(trip.outcome, 'human_required');
  assert.match(trip.reason, /EXTERNAL_EFFECT_FAILURE_STASIS/);
  assert.match(trip.reason, new RegExp(`${K} times consecutively`));
  assert.match(trip.reason, /GIT_MERGE_CONFLICT/);
});

test('F2 decision: a null pattern (no failures) and non-retry states keep the existing behavior', () => {
  const action = { id: 42, state: 'retry-authorized', lastError: null };
  const decision = integrationRetryDecision(action, null);
  assert.equal(decision.outcome, 'pending');
  assert.match(decision.reason, /absence proven; retry authorized/);
});
