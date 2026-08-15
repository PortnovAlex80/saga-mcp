// tests/application/module-conformance-runner.test.mjs
//
// W9-A7 — Shared module conformance runner tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md
//   §1 (W9-A7 owns the shared conformance runner + cross-module isolation
//   checks), §2 (exit gate: every installed module passes the same
//   installation/execution/review/recovery/restart/output conformance kit).
//
// WHAT THIS PROVES
//   The shared kit (src/application/module-conformance-runner.ts) correctly
//   classifies every installed module against the eight conformance
//   dimensions, and that the cross-module isolation checks catch inter-module
//   leaks and install-time collisions. Three layers:
//
//   LAYER 1 — every built-in module conforms structurally. The four catalogued
//   definitions (discovery/development/delivery/formalization) each pass the
//   structural dimensions (installation, execution, kernel, retry, recovery,
//   output). Module-owned dimensions (restart, settlement, package manifest)
//   SKIP cleanly because no probe/manifest is supplied — that is the
//   sibling-lane / integrator contract.
//
//   LAYER 2 — migration gating works. Formalization (the migrated Wave-8
//   pilot, kernel-gate acceptance + independent review) PASSES the migrated
//   migration-gated checks with a clear reason rather than failing.
//
//   LAYER 3 — the kit catches regressions. Synthetic bad modules (a kernel
//   node carrying an executionProfile, a self-reviewing profile, a bad
//   retryPolicy, a recovery entry pointing at a missing node, an inter-module
//   import leak, a duplicate outcome code) each produce a targeted FAILURE.
//
//   LAYER 4 — cross-module isolation. A synthetic graph with an inter-module
//   edge fails; the real on-disk graph (or a clean synthetic one) passes; a
//   duplicate outcome code across two synthetic modules fails.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  runModuleConformance,
  runCrossModuleIsolation,
  assertPassing,
  ON_EXHAUSTED_VALUES,
  RETRY_BACKOFF_VALUES,
} = await import('../../dist/application/module-conformance-runner.js');

// ---------------------------------------------------------------------------
// Built-in module definitions (the four the catalog registers).
// ---------------------------------------------------------------------------
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);

const BUILT_IN_MODULES = [
  ['discovery', discoveryProcessModule],
  ['development', developmentProcessModule],
  ['delivery', deliveryProcessModule],
  ['formalization', formalizationProcessModule],
];

// Helper: collect results of one dimension for one report.
function resultsFor(report, dimension) {
  return report.results.filter((r) => r.dimension === dimension);
}
function failedIn(report) {
  return report.results.filter((r) => r.status === 'failed');
}

// ===========================================================================
// LAYER 1 — every built-in module conforms structurally.
// ===========================================================================

for (const [label, module] of BUILT_IN_MODULES) {
  test(`W9-A7 ${label}: structural conformance passes (installation/execution/kernel/retry/recovery/output)`, async () => {
    const report = await runModuleConformance({ definition: module });
    const failures = failedIn(report);
    // The only allowed non-pass statuses are skips on module-owned dimensions.
    const failingDimensions = new Set(failures.map((r) => r.dimension));
    assert.equal(
      failures.length,
      0,
      `${label} had structural failures in ${[...failingDimensions].join(', ')}:\n` +
        failures.map((r) => `  [${r.dimension}/${r.check}] ${r.message}`).join('\n'),
    );
  });

  test(`W9-A7 ${label}: report counts are consistent and passing is true`, async () => {
    const report = await runModuleConformance({ definition: module });
    assert.equal(report.passing, true, `${label} report must be passing`);
    const total = report.counts.passed + report.counts.failed + report.counts.skipped;
    assert.equal(total, report.results.length, `${label} counts must sum to results length`);
    assert.equal(report.counts.failed, 0, `${label} must have zero failures`);
    // Every module exercises at least the structural dimensions.
    assert.ok(report.counts.passed > 0, `${label} must have at least one pass`);
  });
}

// ===========================================================================
// LAYER 2 — migration gating: formalization passes the migrated checks;
// ===========================================================================

test('W9-A7 migration-gating: formalization (migrated) passes kernel-gate acceptance + independent review', async () => {
  const report = await runModuleConformance({ definition: formalizationProcessModule });
  const exec = resultsFor(report, 'execution').find((r) => r.check === 'artifact_acceptance_kernel_gate');
  const review = resultsFor(report, 'review').find((r) => r.check === 'independent_review_skill');
  assert.equal(exec.status, 'passed', 'formalization must pass kernel-gate acceptance');
  assert.equal(review.status, 'passed', 'formalization must pass independent review');
});

test('W9-A7 migration-gating: delivery (no profiles) reports a vacuous execution dimension', async () => {
  const report = await runModuleConformance({ definition: deliveryProcessModule });
  const execBind = resultsFor(report, 'execution').find((r) => r.check === 'lm_nodes_bind_profiles');
  assert.equal(execBind.status, 'passed');
  assert.ok(/external-only module/.test(execBind.message), 'delivery execution must be flagged vacuous');
});

// ===========================================================================
// LAYER 3 — the kit catches regressions (synthetic bad modules).
// ===========================================================================

// Clone helper: deep-structured clone of a definition with overrides applied
// to nodes/profiles by id.
function cloneModule(module) {
  return JSON.parse(JSON.stringify(module));
}

test('W9-A7 regression: a kernel node carrying an executionProfile FAILS the kernel dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  const kernelNode = bad.flow.nodes.find((n) => n.kind === 'kernel');
  kernelNode.executionProfile = 'stolen-profile';
  const report = await runModuleConformance({ definition: bad });
  const neverAuthor = resultsFor(report, 'kernel').find((r) => r.check === 'kernel_nodes_never_author');
  assert.equal(neverAuthor.status, 'failed');
  assert.equal(report.passing, false);
});

test('W9-A7 regression: an LM node carrying a handler FAILS the kernel dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  const lmNode = bad.flow.nodes.find((n) => n.kind === 'lm');
  lmNode.handler = 'stolen-handler';
  const report = await runModuleConformance({ definition: bad });
  const lmHandler = resultsFor(report, 'kernel').find((r) => r.check === 'lm_nodes_never_carry_handler');
  assert.equal(lmHandler.status, 'failed');
});

test('W9-A7 regression: a migrated module that self-reviews FAILS the review dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  // Force a profile to self-review (reviewSkill === executionSkill).
  const profile = bad.executionProfiles[0];
  profile.reviewSkill = profile.executionSkill;
  const report = await runModuleConformance({ definition: bad });
  const review = resultsFor(report, 'review').find((r) => r.check === 'independent_review_skill');
  assert.equal(review.status, 'failed');
  assert.ok(review.message.includes('self-review'));
});

test('W9-A7 regression: a profile with maxAttempts=0 FAILS the retry dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.executionProfiles[0].retryPolicy.maxAttempts = 0;
  const report = await runModuleConformance({ definition: bad });
  const retry = resultsFor(report, 'retry').find((r) => r.check === 'profile_retry_policy');
  assert.equal(retry.status, 'failed');
  assert.ok(retry.details[0].some((d) => d.includes('maxAttempts')));
});

test('W9-A7 regression: a profile with an open backoff literal FAILS the retry dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.executionProfiles[0].retryPolicy.backoff = 'quantum';
  const report = await runModuleConformance({ definition: bad });
  const retry = resultsFor(report, 'retry').find((r) => r.check === 'profile_retry_policy');
  assert.equal(retry.status, 'failed');
});

test('W9-A7 regression: a recovery entry pointing at a missing node FAILS the recovery dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.flow.recovery[0].verifyNodeId = 'does-not-exist';
  const report = await runModuleConformance({ definition: bad });
  const recovery = resultsFor(report, 'recovery').find((r) => r.check === 'flow_recovery_entries');
  assert.equal(recovery.status, 'failed');
});

test('W9-A7 regression: a recovery entry with an open onExhausted literal FAILS', async () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.flow.recovery[0].onExhausted = 'pray';
  const report = await runModuleConformance({ definition: bad });
  const recovery = resultsFor(report, 'recovery').find((r) => r.check === 'flow_recovery_entries');
  assert.equal(recovery.status, 'failed');
});

test('W9-A7 regression: a terminal node emitting an undeclared outcome FAILS the output dimension', async () => {
  const bad = cloneModule(formalizationProcessModule);
  // Find a terminal kernel node and make it emit a bogus outcome.
  const terminalId = bad.flow.terminalNodeIds[0];
  const terminalNode = bad.flow.nodes.find((n) => n.id === terminalId);
  terminalNode.emitsOutcome = 'totally-bogus-outcome';
  const report = await runModuleConformance({ definition: bad });
  const outcomes = resultsFor(report, 'output').find((r) => r.check === 'terminal_outcomes_declared');
  assert.equal(outcomes.status, 'failed');
});

test('W9-A7 regression: an LM node referencing an unknown profile FAILS execution', async () => {
  const bad = cloneModule(formalizationProcessModule);
  const lmNode = bad.flow.nodes.find((n) => n.kind === 'lm');
  lmNode.executionProfile = 'no-such-profile';
  const report = await runModuleConformance({ definition: bad });
  const exec = resultsFor(report, 'execution').find((r) => r.check === 'lm_nodes_bind_profiles');
  assert.equal(exec.status, 'failed');
});

test('W9-A7 regression: a module with zero outcomes FAILS installation validation', async () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.outcomes = [];
  const report = await runModuleConformance({ definition: bad });
  const install = resultsFor(report, 'installation').find((r) => r.check === 'definition_validates');
  assert.equal(install.status, 'failed');
  assert.equal(report.passing, false);
});

test('W9-A7 restart probe: a passing probe yields passed restart results', async () => {
  const report = await runModuleConformance({
    definition: formalizationProcessModule,
    restartProbe: async () => ({
      replayedIdempotently: true,
      divergentRejected: true,
      evidence: 'synthetic probe ok',
    }),
  });
  const replay = resultsFor(report, 'restart').find((r) => r.check === 'durable_replay_idempotent');
  const divergent = resultsFor(report, 'restart').find((r) => r.check === 'divergent_payload_rejected');
  assert.equal(replay.status, 'passed');
  assert.equal(divergent.status, 'passed');
});

test('W9-A7 restart probe: a failing probe (divergent accepted) FAILS', async () => {
  const report = await runModuleConformance({
    definition: formalizationProcessModule,
    restartProbe: async () => ({
      replayedIdempotently: true,
      divergentRejected: false, // write-once violated
      evidence: 'divergent hash was accepted',
    }),
  });
  const divergent = resultsFor(report, 'restart').find((r) => r.check === 'divergent_payload_rejected');
  assert.equal(divergent.status, 'failed');
  assert.equal(report.passing, false);
});

test('W9-A7 restart probe: a probe that throws is caught and reported as a failure', async () => {
  const report = await runModuleConformance({
    definition: formalizationProcessModule,
    restartProbe: async () => { throw new Error('probe exploded'); },
  });
  const replay = resultsFor(report, 'restart').find((r) => r.check === 'durable_replay_idempotent');
  assert.equal(replay.status, 'failed');
  assert.ok(replay.message.includes('probe exploded'));
});

test('W9-A7 settlement probe: a deterministic probe with a 64-char hash passes; non-determinism fails', async () => {
  const good = await runModuleConformance({
    definition: formalizationProcessModule,
    settlementProbe: () => ({ deterministic: true, inputHashLength: 64, evidence: 'pure fn' }),
  });
  const goodSettle = resultsFor(good, 'output').find((r) => r.check === 'settlement_deterministic');
  assert.equal(goodSettle.status, 'passed');

  const bad = await runModuleConformance({
    definition: formalizationProcessModule,
    settlementProbe: () => ({ deterministic: false, inputHashLength: 64, evidence: 'used Date.now()' }),
  });
  const badSettle = resultsFor(bad, 'output').find((r) => r.check === 'settlement_deterministic');
  assert.equal(badSettle.status, 'failed');
});

// ===========================================================================
// LAYER 4 — cross-module isolation.
// ===========================================================================

test('W9-A7 cross-module isolation: clean graph (no inter-module imports) passes', async () => {
  const graph = {
    'src/process-modules/modules/discovery/discovery-process-module.ts': [
      'src/process-modules/domain/process-module.js',
      'src/shared/work-intent.js',
    ],
    'src/process-modules/modules/formalization/formalization-process-module.ts': [
      'src/process-modules/domain/process-module.js',
    ],
  };
  const report = await runCrossModuleIsolation({ graph });
  const noLeaks = report.results.find((r) => r.check === 'no_inter_module_imports');
  assert.equal(noLeaks.status, 'passed');
  assert.equal(report.passing, true);
});

test('W9-A7 cross-module isolation: an inter-module import edge FAILS', async () => {
  const graph = {
    'src/process-modules/modules/delivery/delivery-settlement-policy.ts': [
      'src/process-modules/modules/development/development-schemas.ts',
    ],
  };
  const report = await runCrossModuleIsolation({ graph });
  const noLeaks = report.results.find((r) => r.check === 'no_inter_module_imports');
  assert.equal(noLeaks.status, 'failed');
  assert.ok(noLeaks.details[0].some((d) => d.includes('delivery') && d.includes('development')));
  assert.equal(report.passing, false);
});

test('W9-A7 cross-module isolation: duplicate module keys FAIL', async () => {
  const a = cloneModule(formalizationProcessModule);
  const b = cloneModule(formalizationProcessModule); // same identity → same key
  const report = await runCrossModuleIsolation({
    graph: {},
    definitions: [a, b],
  });
  const keys = report.results.find((r) => r.check === 'module_keys_unique');
  assert.equal(keys.status, 'failed');
});

test('W9-A7 cross-module isolation: outcome codes are NOT required to be unique across modules (module-local)', async () => {
  // 'failed', 'blocked', 'clarification-required' legitimately appear in
  // several built-in modules. The kit must NOT flag this: an outcome code is
  // module-local (ProcessRun.localOutcome is namespaced by module). This test
  // pins that contract so a future over-eager check is caught.
  const report = await runCrossModuleIsolation({
    graph: {},
    definitions: BUILT_IN_MODULES.map(([, m]) => m),
  });
  const hasOutcomeCheck = report.results.some((r) => r.check === 'outcome_codes_unique');
  assert.equal(hasOutcomeCheck, false, 'kit must not check cross-module outcome-code uniqueness');
});

test('W9-A7 cross-module isolation: colliding resource logicalIds across manifests FAIL', async () => {
  const a = cloneModule(formalizationProcessModule);
  a.identity.name = 'module-a';
  const b = cloneModule(formalizationProcessModule);
  b.identity.name = 'module-b';
  const manifestA = {
    manifestFormatVersion: '1',
    definition: a,
    resourceIndex: [
      { logicalId: 'shared.skill', path: 'a.md', kind: 'skill', digest: 'pending@wave-2' },
    ],
    handlerRefs: [],
    inputContractRef: { schemaId: a.inputContract.id, version: '1.0.0', digest: 'pending' },
    outputContractRef: { schemaId: a.outputContract.id, version: '1.0.0', digest: 'pending' },
    runtimeCompatibilityRange: '^3.0.0',
  };
  const manifestB = {
    manifestFormatVersion: '1',
    definition: b,
    resourceIndex: [
      { logicalId: 'shared.skill', path: 'b.md', kind: 'skill', digest: 'pending@wave-2' },
    ],
    handlerRefs: [],
    inputContractRef: { schemaId: b.inputContract.id, version: '1.0.0', digest: 'pending' },
    outputContractRef: { schemaId: b.outputContract.id, version: '1.0.0', digest: 'pending' },
    runtimeCompatibilityRange: '^3.0.0',
  };
  const report = await runCrossModuleIsolation({
    graph: {},
    definitions: [a, b],
    manifests: [manifestA, manifestB],
  });
  const logical = report.results.find((r) => r.check === 'manifest_logical_ids_unique');
  assert.equal(logical.status, 'failed');
  assert.ok(logical.details[0].some((d) => d.includes('shared.skill')));
});

test('W9-A7 cross-module isolation: the four built-in modules have unique keys', async () => {
  const report = await runCrossModuleIsolation({
    graph: {},
    definitions: BUILT_IN_MODULES.map(([, m]) => m),
  });
  const keys = report.results.find((r) => r.check === 'module_keys_unique');
  assert.equal(keys.status, 'passed', 'built-in module keys must be unique');
});

// ===========================================================================
// assertPassing helper.
// ===========================================================================

test('W9-A7 assertPassing: throws a rendered breakdown on a failing report', () => {
  const bad = cloneModule(formalizationProcessModule);
  bad.executionProfiles[0].retryPolicy.maxAttempts = 0;
  return runModuleConformance({ definition: bad }).then((report) => {
    assert.equal(report.passing, false);
    assert.throws(
      () => assertPassing(report),
      /conformance report for .* has \d+ failure\(s\):[\s\S]*profile_retry_policy/,
    );
  });
});

test('W9-A7 assertPassing: does not throw on a passing report', async () => {
  const report = await runModuleConformance({ definition: formalizationProcessModule });
  assert.doesNotThrow(() => assertPassing(report));
});

// ===========================================================================
// Closed-vocabulary re-export sanity (guards against an accidental rename).
// ===========================================================================

test('W9-A7 closed vocabularies are re-exported unchanged from the Wave-1 SPI unions', () => {
  assert.deepEqual([...ON_EXHAUSTED_VALUES], ['fail', 'pause', 'escalate']);
  assert.deepEqual([...RETRY_BACKOFF_VALUES], ['none', 'fixed', 'exponential']);
});

// ===========================================================================
// SMOKE — prove the kit ran non-trivially across all four modules.
// ===========================================================================

test('W9-A7 smoke: running the kit across all four modules produces a dimension-complete result set each', async () => {
  const DIMENSIONS = ['installation', 'execution', 'review', 'kernel', 'retry', 'recovery', 'restart', 'output'];
  for (const [, module] of BUILT_IN_MODULES) {
    const report = await runModuleConformance({ definition: module });
    const present = new Set(report.results.map((r) => r.dimension));
    for (const d of DIMENSIONS) {
      assert.ok(present.has(d), `module ${module.identity.name} missing dimension ${d}`);
    }
  }
});
