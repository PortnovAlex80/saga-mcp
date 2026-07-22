import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AcceptWorkerSubmission } from '../../dist/saga3/control/application/accept-worker-submission.js';

function makeHarness() {
  const pending = [];
  let acceptance = null;
  let oracleCalls = 0;
  let id = 0;
  const authority = {
    assignmentId: 'assignment-1',
    workIntentId: 'intent-1',
    executionId: 'execution-1',
    episodeSpecId: 'episode-1',
    generation: 3,
    conditionType: 'VerificationCurrent',
    obligationId: 'AC-8',
    scopeType: 'obligation',
    scopeId: 'AC-8',
    leaseEpoch: 7,
    assignmentState: 'running',
    sourceFingerprint: 'source-fp',
    environmentFingerprint: 'env-fp',
  };

  const submissions = {
    appendArtifact(proposal) {
      pending.push({ kind: 'artifact', proposal });
    },
    appendVerification(proposal) {
      pending.push({ kind: 'verification', proposal });
    },
    loadAuthority(executionId) {
      return executionId === authority.executionId ? authority : null;
    },
    listPending(executionId) {
      return executionId === authority.executionId ? pending : [];
    },
    commitCompletion(value) {
      acceptance = value;
    },
    listArtifacts() {
      return [];
    },
    listConditions() {
      return [];
    },
  };

  const service = new AcceptWorkerSubmission({
    submissions,
    artifacts: {
      write(input) {
        return { path: input.path, digest: input.expectedDigest };
      },
    },
    oracle: {
      async observe(request) {
        oracleCalls++;
        assert.equal(request.oracleId, 'evidence-check');
        assert.equal(request.command, 'npm test -- --runInBand');
        return { verdict: 'passed', rawDigest: 'oracle-digest', executed: true };
      },
    },
    clock: {
      now: () => 123456,
      deadline: (afterMs) => ({ at: 123456 + afterMs, expired: () => false }),
    },
    ids: {
      next(prefix) {
        id++;
        return `${prefix}-${id}`;
      },
    },
    oraclePolicy: {
      requiredOracle(conditionType) {
        assert.equal(conditionType, 'VerificationCurrent');
        return {
          oracleId: 'evidence-check',
          oracleVersion: '1',
          trustClass: 'deterministic',
        };
      },
    },
  });

  return {
    service,
    pending,
    getAcceptance: () => acceptance,
    getOracleCalls: () => oracleCalls,
  };
}

test('worker submissions are proposals; application executes oracle and commits evidence', async () => {
  const harness = makeHarness();

  harness.service.proposeArtifact({
    executionId: 'execution-1',
    kind: 'test',
    path: 'tests/ac-8.test.ts',
    content: 'export const ok = true;\n',
  });
  harness.service.proposeVerification({
    executionId: 'execution-1',
    oracleId: 'evidence-check',
    oracleVersion: '1',
    command: 'npm test -- --runInBand',
    diagnosticSummary: 'Worker proposes the test command; no verdict is supplied.',
  });

  assert.equal(harness.pending.length, 2);
  assert.equal(harness.getOracleCalls(), 0, 'proposal must not execute the oracle');
  assert.equal(harness.getAcceptance(), null, 'proposal must not mutate authoritative state');

  const result = await harness.service.complete({
    executionId: 'execution-1',
    workerDeclaredResult: 'completed',
  });

  assert.equal(harness.getOracleCalls(), 1);
  assert.equal(result.conditionStatus, 'True');
  const acceptance = harness.getAcceptance();
  assert.ok(acceptance);
  assert.equal(acceptance.conditionStatus, 'True');
  assert.equal(acceptance.evidence.verdict, 'passed');
  assert.equal(acceptance.evidence.trustClass, 'deterministic');
  assert.equal(acceptance.evidence.generation, 3);
  assert.equal(acceptance.evidence.sourceFingerprint, 'source-fp');
  assert.equal(acceptance.evidence.environmentFingerprint, 'env-fp');
});

test('submission without a live assignment is rejected before persistence', () => {
  const harness = makeHarness();
  assert.throws(
    () => harness.service.proposeArtifact({
      executionId: 'unknown-execution',
      kind: 'code',
      path: 'src/nope.ts',
      content: 'nope',
    }),
    /No active Saga 3 assignment/,
  );
  assert.equal(harness.pending.length, 0);
});
