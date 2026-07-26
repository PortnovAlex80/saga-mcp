// P4 tests: Formalization settlement policy (deterministic, no DB).
//
// Uses a fake FormalizationArtifactGraphPort to drive the policy through all
// decision branches without touching SQLite. The SQLite-backed graph port is
// exercised in P6 (E2E smoke against a real artifact store).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const { ReferenceFormalizationSettlementPolicy } = await import(
  '../../dist/process-modules/modules/formalization/sqlite-formalization-kernel.js'
);
const { buildFormalizationCertificatePayload } = await import(
  '../../dist/process-modules/modules/formalization/formalization-kernel-ports.js'
);
const {
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
} = await import(
  '../../dist/process-modules/modules/formalization/formalization-schemas.js'
);
const { canonicalJson } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// --- Fake graph port --------------------------------------------------------

function fakeGraph(overrides = {}) {
  const defaults = {
    prd: 1,
    frs: [10],
    nfrs: [11],
    rules: [],
    ucs: [20],
    acs: [30, 31],
    srs: 40,
    baselineHash: 'b'.repeat(64),
    baselineClean: true,
    baselineDirty: [],
    traceGap: null,
    tasksReady: true,
    blockingTaskIds: [],
  };
  const state = { ...defaults, ...overrides };
  return {
    _state: state,
    readAcceptedArtifacts(_epicId) {
      return {
        prd: state.prd, frs: state.frs, nfrs: state.nfrs, rules: state.rules,
        ucs: state.ucs, acs: state.acs, srs: state.srs,
      };
    },
    readAcceptanceBaselineHash(_epicId) {
      return { hash: state.baselineHash, clean: state.baselineClean, dirty: state.baselineDirty };
    },
    findFirstTraceabilityGap(_epicId) { return state.traceGap; },
    areTasksReady(_epicId) {
      return { ready: state.tasksReady, blockingTaskIds: state.blockingTaskIds };
    },
  };
}

function makeBundle(overrides = {}) {
  const partial = {
    schemaVersion: 'saga3.solution-contract-certificate.v1',
    formalizationEpicId: 100,
    prdArtifactId: 1, frArtifactIds: [10], nfrArtifactIds: [11],
    ruleArtifactIds: [], ucArtifactIds: [20], acArtifactIds: [30, 31],
    acceptanceBaselineHash: 'b'.repeat(64),
    srsArtifactId: 40,
    ...overrides,
  };
  const bundleHash = createHash('sha256').update(canonicalJson(partial)).digest('hex');
  return { ...partial, bundleHash };
}

function makeInput(overrides = {}) {
  const { bundle: bundleOverrides = {}, ...inputOverrides } = overrides;
  return {
    schemaVersion: FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
    formalizationEpicId: 100,
    discoveryCertificateRef: 'certificate:5',
    discoveryCertificateHash: 'd'.repeat(64),
    bundle: makeBundle(bundleOverrides),
    ...inputOverrides,
  };
}

function expectedInputHash(input) {
  // The policy uses canonicalJson; replicate via the same module.
  // Simpler: just assert it's a 64-char hex string and stable across calls.
  return input;
}

// --- Tests ------------------------------------------------------------------

test('policy returns formalized when the contract graph is complete', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph(), makeInput());
  assert.equal(result.decision, 'formalized');
  assert.deepEqual(result.reasonCodes, []);
  assert.match(result.rationale, /complete, traceable, baseline-frozen/);
  assert.match(result.inputHash, /^[0-9a-f]{64}$/);
});

test('policy returns clarification-required when PRD is missing', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ prd: null }),
    makeInput({ bundle: { prdArtifactId: null } }),
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('prd-missing'));
});

test('policy returns clarification-required when no AC artifacts exist', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ acs: [] }),
    makeInput({ bundle: { acArtifactIds: [] } }),
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('acceptance-empty'));
});

test('policy returns clarification-required when SRS is missing', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(
    fakeGraph({ srs: null }),
    makeInput({ bundle: { srsArtifactId: null } }),
  );
  assert.equal(result.decision, 'clarification-required');
  assert.ok(result.reasonCodes.includes('srs-missing'));
});

test('policy returns inconsistent when baseline is dirty', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    baselineClean: false, baselineDirty: [30],
  }), makeInput());
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('baseline-missing'));
});

test('policy returns inconsistent when baseline hash in input disagrees with graph', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ bundle: { acceptanceBaselineHash: 'z'.repeat(64) } });
  const result = policy.settle(fakeGraph(), input);
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('baseline-missing'));
  assert.match(result.rationale, /Baseline hash mismatch/);
});

test('policy fails closed when bundle ids do not equal the canonical graph', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ bundle: { frArtifactIds: [10, 999] } });
  const result = policy.settle(fakeGraph(), input);
  assert.equal(result.decision, 'failed');
  assert.ok(result.reasonCodes.includes('infrastructure-error'));
  assert.match(result.rationale, /exact canonical graph snapshot/);
});

test('policy returns inconsistent when there is a traceability gap', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    traceGap: {
      artifactType: 'UC', artifactId: 20,
      missingEdge: 'covers → FR',
      description: 'UC #20 has no covers trace to any FR.',
    },
  }), makeInput());
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('traceability-gap'));
});

test('policy returns inconsistent when formalization tasks are not ready', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const result = policy.settle(fakeGraph({
    tasksReady: false, blockingTaskIds: [55, 56],
  }), makeInput());
  assert.equal(result.decision, 'inconsistent');
  assert.ok(result.reasonCodes.includes('tasks-not-ready'));
  assert.match(result.rationale, /#55, #56/);
});

test('policy returns failed when the settlement input schema is wrong', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput({ schemaVersion: 'bogus' });
  const result = policy.settle(fakeGraph(), input);
  assert.equal(result.decision, 'failed');
  assert.ok(result.reasonCodes.includes('infrastructure-error'));
});

test('policy is deterministic: same inputs → same inputHash + decision', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const g = fakeGraph();
  const input = makeInput();
  const a = policy.settle(g, input);
  const b = policy.settle(g, input);
  assert.equal(a.inputHash, b.inputHash);
  assert.equal(a.decision, b.decision);
  assert.deepEqual(a.reasonCodes, b.reasonCodes);
});

test('buildFormalizationCertificatePayload assembles the certificate envelope', () => {
  const policy = new ReferenceFormalizationSettlementPolicy();
  const input = makeInput();
  const result = policy.settle(fakeGraph(), input);
  const payload = buildFormalizationCertificatePayload(result, input.bundle, input);
  assert.equal(payload.decision, 'formalized');
  assert.equal(payload.discoveryCertificateRef, 'certificate:5');
  assert.equal(payload.bundleHash, input.bundle.bundleHash);
  assert.equal(payload.acceptanceBaselineHash, input.bundle.acceptanceBaselineHash);
  assert.equal(payload.schemaVersion, 'saga3.solution-contract-certificate.generic.v1');
});
