// tests/factory-proof/scenario-evidence.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REFERENCE_SCENARIO } from './scenario-dsl.mjs';
import {
  buildScenarioEvidenceBundle,
  validateScenarioEvidenceBundle,
} from './scenario-evidence.mjs';

const TRACE = {
  observedAt: '2026-08-21T00:00:00.000Z',
  lifecycleRuns: [{ id: 1, status: 'completed', current_stage_id: 4, terminal_status: 'accepted' }],
  processRuns: [],
  workIntents: [{ id: 7, task_kind: 'formalization', status: 'done', workplace_ref: 'wp:1' }],
  workplaces: [{ workplace_ref: 'wp:1', process_run_id: 2, kanban_phase: 'done', loop_state: 'terminal', terminal_reason: 'accepted', revision: 4, next_role: null }],
  candidateSets: [],
  gateDecisions: [],
  checkReceipts: [],
  finalAcceptances: [],
  acceptedAuthorityHeads: [],
  effectReceipts: [],
  transitionObligations: [],
  recoveryEpochs: [],
  workerExecutions: [],
};

const FINGERPRINT = {
  fingerprint: 'a'.repeat(64),
  overlayKeys: ['workerExecutorFactory'],
  sections: { lifecycle: 'b'.repeat(64) },
};

const IDENTITY = {
  lifecycle: { id: 'product-delivery@1.0.0', stages: [{ stageId: 'formalization' }] },
  modules: [{ name: 'formalization', version: '1.0.0', packageDigest: 'c'.repeat(64) }],
  providers: [],
};

function bundle(trace = TRACE) {
  return buildScenarioEvidenceBundle({
    scenario: REFERENCE_SCENARIO,
    proofModes: ['Contract', 'CanonicalFast'],
    fingerprint: FINGERPRINT,
    identity: IDENTITY,
    durableTrace: trace,
    progress: {
      ok: true,
      stalls: [],
      rows: [{ workplace: 'wp:1', classification: 'typed-terminal', evidence: 'accepted' }],
    },
    actorEvidence: [{ visibleInputDigest: 'd'.repeat(64), actorOutputDigest: 'e'.repeat(64) }],
    oracleResults: [{ id: 'reference.detector-fired', passed: true, evidenceRefs: ['receipt:1'] }],
    terminal: { reachedTerminal: true, terminalReason: 'accepted' },
  });
}

test('evidence bundle is immutable, complete and validates', () => {
  const evidence = bundle();
  assert.deepEqual(validateScenarioEvidenceBundle(evidence), []);
  assert.equal(evidence.verdict, 'pass');
  assert.match(evidence.bundleDigest, /^[0-9a-f]{64}$/);
  assert.match(evidence.durableTraceDigest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.scenario));
  assert.ok(Object.isFrozen(evidence.normalizedTrace));
  assert.throws(() => { evidence.scenario.id = 'mutated'; }, TypeError);
});

test('incidental observation time cannot change the semantic evidence digest', () => {
  const first = bundle();
  const second = bundle({ ...TRACE, observedAt: '2099-01-01T12:34:56.000Z' });
  assert.equal(first.durableTraceDigest, second.durableTraceDigest);
  assert.equal(first.bundleDigest, second.bundleDigest);
  assert.notEqual(first.rawDurableTrace.observedAt, second.rawDurableTrace.observedAt);
});

test('a semantic durable-trace mutation changes both trace and bundle digests', () => {
  const first = bundle();
  const second = bundle({
    ...TRACE,
    workplaces: [{ ...TRACE.workplaces[0], terminal_reason: 'failed' }],
  });
  assert.notEqual(first.durableTraceDigest, second.durableTraceDigest);
  assert.notEqual(first.bundleDigest, second.bundleDigest);
});

test('oracle failure or anonymous stall makes the bundle fail closed', () => {
  const failedOracle = buildScenarioEvidenceBundle({
    scenario: REFERENCE_SCENARIO,
    proofModes: ['Contract'],
    fingerprint: FINGERPRINT,
    identity: IDENTITY,
    durableTrace: TRACE,
    progress: { ok: true, rows: [], stalls: [] },
    oracleResults: [{ id: 'negative-control', passed: false }],
  });
  assert.equal(failedOracle.verdict, 'fail');

  const stalled = buildScenarioEvidenceBundle({
    scenario: REFERENCE_SCENARIO,
    proofModes: ['Contract'],
    fingerprint: FINGERPRINT,
    identity: IDENTITY,
    durableTrace: TRACE,
    progress: { ok: false, rows: [], stalls: [{ workplace: 'wp:stalled' }] },
    oracleResults: [{ id: 'other', passed: true }],
  });
  assert.equal(stalled.verdict, 'fail');
});
