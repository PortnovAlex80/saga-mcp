/**
 * D4 — authoritative discovery settlement engine integration tests.
 *
 * No LM. Uses the same fake-executor + fake-runtime pattern as the D3
 * lifecycle tests, and injects a fake settlementService to verify the central
 * D4 invariants at the engine-result boundary (§17):
 *   - successful discovery + settlement go -> authoritative go
 *     (outcomeAuthority=discovery_settlement_policy);
 *   - settlement clarify -> authoritative clarify, pipeline completed;
 *   - settlement reject -> authoritative reject;
 *   - settlement exception -> pipeline FAILED, no certificate, provisional
 *     preserved (D4 is the authoritative boundary, unlike D3 shadow);
 *   - outcomeAuthority becomes discovery_settlement_policy ONLY after a
 *     certificate (status=issued);
 *   - provisional outcome is preserved separately from the authoritative one;
 *   - finalStage stays 'discovery' (no formalization transition);
 *   - settlement runs even when readiness failed (policy fail-closes clarify);
 *   - missing/invalid Proposal -> settlement not_run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');

function validPayload(outcome = 'go') {
  return {
    problem_statement: 'p', observed_context: 'c',
    stakeholders_or_actors: ['u'], assumptions: ['a'], unknowns: ['u'],
    risks: ['r'], candidate_scope: 's', evidence_refs: ['e'],
    recommended_outcome: outcome, rationale: 'because',
  };
}

function fullConfig() {
  return { dbPath: '/d', claudePath: 'claude', lmStudioUrl: 'http://x/v1' };
}
function fakeHost() {
  return {
    processId: 42,
    acquireEngineLock: () => ({ status: 'acquired', ownerPid: 42 }),
    releaseEngineLock: () => {},
    workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s', logRoot: '/l', heartbeatLog: '/h' },
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat: (_ctx, event, msg) => {},
    scanRateLimitSignals: () => 0,
  };
}

/**
 * Fake readiness service — always returns a completed shadow (the D3 layer is
 * not under test here; D4 runs settlement after readiness regardless).
 */
function makeFakeReadinessService({ outcome = 'completed' } = {}) {
  return {
    async assess() {
      if (outcome === 'failed') {
        return {
          success: false, cycles: 5, error: 'advisor failed',
          shadow: {
            status: 'failed', authority: 'none',
            assessmentId: null, assessmentHash: null,
            overallReadiness: null, recommendedNextAction: null, error: 'advisor failed',
          },
        };
      }
      return {
        success: true, cycles: 7, error: null,
        shadow: {
          status: 'completed', authority: 'shadow_advisor',
          assessmentId: 99, assessmentHash: 'd'.repeat(64),
          overallReadiness: 'ready', recommendedNextAction: 'proceed_to_settlement', error: null,
        },
      };
    },
  };
}

/**
 * Fake settlement service. Returns a configurable settlement result and records
 * calls so we can assert the engine invoked it with the right inputs.
 */
function makeFakeSettlementService({ status = 'issued', decision = 'go', error = null } = {}) {
  const calls = [];
  return {
    calls,
    async settle(request) {
      calls.push(request);
      if (status === 'failed') {
        return {
          status: 'failed',
          settlementId: null, certificateId: null, certificateHash: null,
          policyVersion: null, policyHash: null,
          decision: null, reasonCodes: [], error: error ?? 'settlement infrastructure error',
        };
      }
      // issued
      return {
        status: 'issued',
        settlementId: 1, certificateId: 2, certificateHash: 'f'.repeat(64),
        policyVersion: 'saga3.discovery-settlement-policy.v1',
        policyHash: 'p'.repeat(64),
        decision,
        reasonCodes: decision === 'go' ? ['GO_READY_AND_GROUNDED']
          : decision === 'reject' ? ['REJECT_WORKER_AND_ADVISOR_AGREE']
          : ['CLARIFY_BLOCKING_GAPS'],
        error: null,
      };
    },
  };
}

// --- fakes mirroring d3 lifecycle test (minimal) ---------------------------

function makeFakeRuntime({ proposalPayload = null, finalTaskStatus = 'done' }) {
  let intent = null;
  let task = null;
  let proposal = null;
  let nextId = 1;
  return {
    readEpicObjective: () => ({ name: 'e', description: 'discover' }),
    readOpenIntent: (_e, kind) => intent && intent.kind === kind && intent.status !== 'concluded' ? intent : null,
    createIntent(command) {
      intent = { id: nextId++, epic_id: command.epic_id, kind: command.kind, objective: command.objective,
        authority_scope: command.authority_scope, output_schema: command.output_schema,
        projected_task_id: null, status: 'open', created_at: 't' };
      return intent;
    },
    setProjectedTask: (i, t) => { intent.projected_task_id = t; },
    setIntentStatus: (i, exp, next) => { if (intent.status === exp) { intent.status = next; return true; } return false; },
    ensureProjectedTask() { if (!task) task = { id: 100, status: 'todo' }; return task.id; },
    readTaskState: () => task ? task.status : null,
    prepareIntentForExecution: () => ({ state: 'ready', intentStatus: 'open', taskStatus: 'todo' }),
    readWorkIntentForTask: () => null,
    readLatestProposal: () => proposal,
    readLatestRawSubmission: () => null,
    ensureNormalizationControl: () => ({ controlIntentId: 1, sourceSubmissionId: 1, controlStatus: 'concluded', authorityIntentId: 2, authorityIntentStatus: 'concluded', taskId: 100 }),
    setControlIntentStatus: () => true,
    ensureReadinessControl: () => ({ controlIntentId: 1, proposalId: 50, proposalContentHash: 'h', controlStatus: 'open', authorityIntentId: 2, authorityIntentStatus: 'open', taskId: 101 }),
    setReadinessControlStatus: () => true,
    readLatestReadinessAssessment: () => null,
    // D4 settlement port methods — the fake settlement service does not call
    // these (it returns canned results), but the runtime shape stays complete.
    readProposalForSettlement: () => null,
    readAcceptedReadinessAssessmentForProposal: () => null,
    findSettlementByInputKey: () => null,
    insertSettlement: () => ({ record: { id: 1 }, replayed: false }),
    markSettlementCertificateIssued: () => true,
    markSettlementFailed: () => {},
    insertCertificate: () => ({ record: { id: 2, certificate_hash: 'f'.repeat(64) }, replayed: false }),
    readCertificateForSettlement: () => null,
    _simulateWorkerTick() {
      if (proposalPayload && !proposal) {
        proposal = { id: 50, payload: proposalPayload, content_hash: 'h'.repeat(64), provenance: null };
      }
      if (task) task.status = finalTaskStatus;
    },
  };
}

function makeFakeExecutor(onPoll) {
  let stopped = false;
  return {
    start() {},
    status() {
      if (!stopped) onPoll();
      if (stopped) return null;
      return { id: 'fake-run', project_id: 1, concurrency: 1, status: 'running', active: [], completed: 0, failed: 0, claimed: 1 };
    },
    setConcurrency() {},
    stop() { stopped = true; },
    dispose() {},
  };
}

async function runEngine({ proposalPayload, settlementStatus, settlementDecision, readinessOutcome = 'completed', finalTaskStatus = 'done' }) {
  const runtime = makeFakeRuntime({ proposalPayload, finalTaskStatus });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick());
  const readiness = makeFakeReadinessService({ outcome: readinessOutcome });
  const settlement = makeFakeSettlementService({ status: settlementStatus, decision: settlementDecision });
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
    readinessService: readiness, settlementService: settlement,
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  return { result, settlement, runtime };
}

// ---- §17 engine integration tests ----------------------------------------

test('D4 engine: successful discovery + settlement go -> authoritative go', async () => {
  const { result, settlement } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'go' });
  assert.equal(result.outcome, 'go');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.settlement.status, 'issued');
  assert.equal(result.settlement.decision, 'go');
  assert.deepEqual(result.settlement.reasonCodes, ['GO_READY_AND_GROUNDED']);
  assert.equal(result.settlement.certificateHash.length, 64);
  assert.equal(settlement.calls.length, 1);
});

test('D4 engine: settlement clarify -> authoritative clarify, pipeline completed', async () => {
  const { result } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'clarify' });
  assert.equal(result.outcome, 'clarify');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.settlement.status, 'issued');
  assert.equal(result.settlement.decision, 'clarify');
});

test('D4 engine: settlement reject -> authoritative reject', async () => {
  const { result } = await runEngine({ proposalPayload: validPayload('reject'), settlementStatus: 'issued', settlementDecision: 'reject' });
  assert.equal(result.outcome, 'reject');
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.settlement.decision, 'reject');
  assert.deepEqual(result.settlement.reasonCodes, ['REJECT_WORKER_AND_ADVISOR_AGREE']);
});

test('D4 engine: settlement exception -> pipeline FAILED, no certificate, provisional preserved', async () => {
  const { result } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'failed' });
  // D4 is the authoritative boundary: a settlement failure means the run failed.
  assert.equal(result.outcome, 'failed');
  assert.equal(result.outcomeAuthority, 'none');
  assert.equal(result.reason, 'failed');
  assert.equal(result.scopeCompleted, false);
  assert.equal(result.settlement.status, 'failed');
  assert.equal(result.settlement.certificateId, null);
  assert.ok(result.settlement.error);
  // The worker's provisional recommendation is preserved separately.
  assert.equal(result.provisional.outcome, 'go');
  assert.equal(result.provisional.authority, 'worker_proposal');
});

test('D4 engine: outcomeAuthority becomes discovery_settlement_policy ONLY after a certificate', async () => {
  // When settlement is issued -> authoritative.
  const issued = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'go' });
  assert.equal(issued.result.outcomeAuthority, 'discovery_settlement_policy');
  // When settlement failed -> NOT authoritative (stays none).
  const failed = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'failed' });
  assert.notEqual(failed.result.outcomeAuthority, 'discovery_settlement_policy');
});

test('D4 engine: provisional outcome preserved separately from authoritative', async () => {
  // Worker said go, but settlement authoritatively said clarify.
  const { result } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'clarify' });
  assert.equal(result.outcome, 'clarify');            // authoritative
  assert.equal(result.outcomeAuthority, 'discovery_settlement_policy');
  assert.equal(result.provisional.outcome, 'go');     // provisional preserved
  assert.equal(result.provisional.authority, 'worker_proposal');
  assert.equal(result.provisional.proposalId, 50);
});

test('D4 engine: finalStage stays discovery (no formalization transition)', async () => {
  const { result } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'go' });
  assert.equal(result.finalStage, 'discovery');
});

test('D4 engine: settlement runs even when readiness failed (policy fail-closes clarify)', async () => {
  const { result, settlement } = await runEngine({ proposalPayload: validPayload('go'), settlementStatus: 'issued', settlementDecision: 'clarify', readinessOutcome: 'failed' });
  // Readiness failed, but settlement still ran and issued a certificate.
  assert.equal(result.readiness.status, 'failed');
  assert.equal(result.settlement.status, 'issued');
  assert.equal(settlement.calls.length, 1);
  // The readiness shadow is threaded into the settle() request.
  assert.equal(settlement.calls[0].readiness.status, 'failed');
});

test('D4 engine: missing Proposal -> settlement not_run, provisional stays top-level', async () => {
  const { result, settlement } = await runEngine({ proposalPayload: null, settlementStatus: 'issued', settlementDecision: 'go' });
  assert.equal(result.scopeCompleted, false);
  assert.equal(result.settlement.status, 'not_run');
  assert.equal(settlement.calls.length, 0, 'settlement must not run without a valid Proposal');
  // outcomeAuthority stays provisional/none, never discovery_settlement_policy.
  assert.notEqual(result.outcomeAuthority, 'discovery_settlement_policy');
});

test('D4 engine: no settlementService wired -> settlement not_run, backward compatible', async () => {
  // Legacy / D1-D3 test wiring: no settlementService. The engine must still run
  // and report settlement.status='not_run' with the provisional outcome as
  // top-level (backward compatible).
  const runtime = makeFakeRuntime({ proposalPayload: validPayload('go') });
  const executor = makeFakeExecutor(() => runtime._simulateWorkerTick());
  const readiness = makeFakeReadinessService({ outcome: 'completed' });
  const engine = new Saga3DiscoveryEngine({
    config: fullConfig(), workerExecutorFactory: () => executor,
    persistence: { episodes: { currentStage: () => 'discovery' }, workspaces: { resolve: () => ({ workspaceRoot: '/w' }) } },
    host: fakeHost(), runtimePersistence: runtime, pollMs: 0,
    readinessService: readiness,
    // settlementService intentionally omitted.
  });
  const result = await engine.run({ projectId: 1, epicId: 10, concurrency: 1 });
  assert.equal(result.settlement.status, 'not_run');
  assert.equal(result.outcome, 'go');
  assert.equal(result.outcomeAuthority, 'worker_proposal'); // provisional stays top-level
  assert.equal(result.provisional.outcome, 'go');
});

// ---- P0-1: lifecycle eligibility (certificate must not legalize an incomplete lifecycle) ----

test('D4 engine: valid Proposal + blocked lifecycle -> settlement NOT run (P0-1)', async () => {
  // Worker submitted a valid Proposal but the task ended 'blocked' (not clean).
  // Settlement must NOT issue a certificate that legalizes the incomplete run.
  const { result, settlement } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'go',
    finalTaskStatus: 'blocked',
  });
  assert.equal(result.settlement.status, 'not_run');
  assert.equal(settlement.calls.length, 0, 'settlement must not run on a non-clean lifecycle');
  // The original failed result is preserved: not authoritative.
  assert.notEqual(result.outcomeAuthority, 'discovery_settlement_policy');
});

// ---- P1-3: settlement failure populates top-level lastError ----

test('D4 engine: settlement failure populates top-level lastError (P1-3)', async () => {
  // A clean discovery (lastError=null) whose settlement then crashes must
  // surface the settlement error in lastError, not hide it behind null.
  const { result } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'failed',
  });
  assert.equal(result.reason, 'failed');
  assert.equal(result.settlement.status, 'failed');
  assert.ok(result.lastError, 'lastError must be populated on settlement failure');
  assert.equal(result.lastError, result.settlement.error);
});

test('D4 engine: settlement issued leaves lastError null (clean discovery)', async () => {
  const { result } = await runEngine({
    proposalPayload: validPayload('go'),
    settlementStatus: 'issued', settlementDecision: 'go',
  });
  assert.equal(result.reason, 'completed');
  assert.equal(result.lastError, null);
});
