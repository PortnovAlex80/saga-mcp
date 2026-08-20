// tests/factory-proof/scenario-dsl.mjs
//
// W0-3 — the runtime validator for CausalFaultScenario (ADR-084 /
// GRAPH-TEST-STRATEGY §E; brief revision a8014c03 adds the generated-mutation
// binding: obligationId / mutantId / operatorId / violatedConstraint /
// seedDigest).
//
// The DSL is TEST vocabulary only — it never decides production transitions,
// never routes recovery, and never becomes a second runtime. A scenario that
// does not declare fairness, budget and diagnosability does not validate:
// those three are what make the causal claim falsifiable.

import { createHash } from 'node:crypto';

export const SCENARIO_SCHEMA_VERSION = 'factory.proof.causal-fault-scenario.v1';

export const FAULT_CLASSES = Object.freeze([
  'authored-semantic', 'contract-shape', 'authority-binding',
  'derived-evidence', 'detector-fault', 'feedback-fault',
  'durable-transition', 'effect-external', 'scheduler-fence',
]);

export const ORACLE_CLASSES = Object.freeze(['mechanical', 'semantic-adjudicated', 'harvested']);

export const INJECTION_BOUNDARIES = Object.freeze([
  'worker-output', 'world-state', 'provider-output', 'feedback-delivery',
  'durable-boundary', 'scheduler',
]);

export const DIAGNOSABILITY = Object.freeze(['isolated', 'ambiguous', 'external']);

const isNonEmptyArray = v => Array.isArray(v) && v.length > 0;
const isNonEmptyString = v => typeof v === 'string' && v.length > 0;

/**
 * Validate one scenario. Returns an error list (empty = valid). Pure.
 */
export function validateCausalFaultScenario(scenario) {
  const errors = [];
  const fail = m => errors.push(m);

  if (!scenario || typeof scenario !== 'object') return ['scenario must be an object'];
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCENARIO_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(scenario.defectId)) fail('defectId required');
  if (!FAULT_CLASSES.includes(scenario.faultClass)) {
    fail(`faultClass must be one of ${FAULT_CLASSES.join('|')}`);
  }
  if (!isNonEmptyArray(scenario.proves)) fail('proves: at least one normative obligation id');

  const oracle = scenario.oracle;
  if (!oracle || !ORACLE_CLASSES.includes(oracle.class)) {
    fail(`oracle.class must be one of ${ORACLE_CLASSES.join('|')}`);
  }
  // A harvested oracle is a quality label, not a truth: it must name its
  // independent verification before its positive can count.
  if (oracle?.class === 'harvested' && !isNonEmptyString(oracle.independentMarking)) {
    fail('oracle.class=harvested requires independentMarking (harvested acceptance alone is not truth)');
  }

  const assumptions = scenario.assumptions;
  if (!assumptions) fail('assumptions required');
  if (assumptions && !['single', 'declared-pair'].includes(assumptions.faultMultiplicity)) {
    fail('assumptions.faultMultiplicity must be single|declared-pair');
  }
  if (assumptions && !isNonEmptyArray(assumptions.fairness)) {
    fail('assumptions.fairness must be declared (what makes the drain fair) — '
      + 'a scenario without declared fairness is not falsifiable');
  }

  const injection = scenario.injection;
  if (!injection || !INJECTION_BOUNDARIES.includes(injection?.boundary)) {
    fail(`injection.boundary must be one of ${INJECTION_BOUNDARIES.join('|')}`);
  }
  if (injection && !isNonEmptyString(injection.fixtureRef)) {
    fail('injection.fixtureRef required');
  }
  // The injector may sever a boundary; it may never pre-paint the outcome.
  if (injection && (!Array.isArray(injection.forbidden)
    || !injection.forbidden.includes('direct-outcome-write'))) {
    fail('injection.forbidden must be a declared array including direct-outcome-write');
  }

  const expected = scenario.expected;
  if (!expected) fail('expected required');
  if (expected && !isNonEmptyString(expected.detectorRef)) fail('expected.detectorRef required');
  if (expected && !isNonEmptyString(expected.reasonCode)) fail('expected.reasonCode required');
  if (expected && !DIAGNOSABILITY.includes(expected.diagnosability)) {
    fail(`expected.diagnosability must be one of ${DIAGNOSABILITY.join('|')} — `
      + 'undeclared diagnosability makes the frontier unfalsifiable');
  }
  if (expected && !isNonEmptyString(expected.repairOwner)) fail('expected.repairOwner required');
  if (expected && !isNonEmptyString(expected.repairFrontier)) fail('expected.repairFrontier required');
  if (expected && !isNonEmptyArray(expected.preservedPrefix)) fail('expected.preservedPrefix required');
  if (expected && !isNonEmptyArray(expected.invalidationCone)) fail('expected.invalidationCone required');
  if (expected && !isNonEmptyString(expected.terminalBudget)) {
    fail('expected.terminalBudget required (bounded outcome, not an open loop)');
  }

  const repair = scenario.repair;
  if (!repair || !isNonEmptyString(repair?.triggerReasonCode) || !isNonEmptyString(repair?.fixtureRef)) {
    fail('repair {triggerReasonCode, fixtureRef} required');
  }
  if (repair && repair.triggerReasonCode && expected?.reasonCode
    && repair.triggerReasonCode !== expected.reasonCode) {
    fail('repair.triggerReasonCode must equal expected.reasonCode — the repair is driven by the EXACT feedback, not by a different signal');
  }

  if (!isNonEmptyArray(scenario.counterfactualFeedback)) {
    fail('counterfactualFeedback must declare the absent/stale/corrupted variants '
      + 'whose actors must NOT produce the magical repair');
  }
  if (!isNonEmptyArray(scenario.independentFacts)) {
    fail('independentFacts required (what an independent observer computes/reports)');
  }

  // Generated-mutation binding (W0-3 §1b): when the defect is a compiled
  // mutant, its identity travels with the scenario.
  if (scenario.mutant) {
    const m = scenario.mutant;
    for (const k of ['obligationId', 'mutantId', 'operatorId', 'violatedConstraint', 'seedDigest']) {
      if (!isNonEmptyString(m[k])) fail(`mutant.${k} required when mutant is declared`);
    }
    if (m.seedDigest && !/^[0-9a-f]{64}$/.test(m.seedDigest)) {
      fail('mutant.seedDigest must be sha256 hex');
    }
  }

  return errors;
}

/** Throwing wrapper used by pack registration. */
export function assertValidScenario(scenario) {
  const errors = validateCausalFaultScenario(scenario);
  if (errors.length > 0) {
    const e = new Error(
      `CAUSAL_SCENARIO_INVALID: ${scenario?.defectId ?? '<anonymous>'}\n  ${errors.join('\n  ')}`,
    );
    e.code = 'CAUSAL_SCENARIO_INVALID';
    e.errors = errors;
    throw e;
  }
  return scenario;
}

/** Deterministic scenario digest (for pack manifests and trace binding). */
export function scenarioDigest(scenario) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: scenario.schemaVersion,
    defectId: scenario.defectId,
    faultClass: scenario.faultClass,
    proves: scenario.proves,
    expected: scenario.expected,
    repair: scenario.repair,
    mutant: scenario.mutant ?? null,
  }), 'utf8').digest('hex');
}

/**
 * A minimal, fully valid reference scenario — the shape every pack copies.
 * Declared for the fabricated-derived-evidence defect (W1-1's subject).
 */
export const REFERENCE_SCENARIO = Object.freeze({
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  defectId: 'fabricated-derived-evidence/reference',
  faultClass: 'derived-evidence',
  proves: ['frm.submission.acceptance-contract'],
  oracle: { class: 'mechanical' },
  assumptions: {
    faultMultiplicity: 'single',
    fairness: ['fair-drain: dispatch loop runs until empty streak', 'single-worker card'],
  },
  injection: {
    boundary: 'worker-output',
    fixtureRef: 'worker submits a shape-valid 64-hex content_hash with no resolvable bytes',
    forbidden: ['direct-outcome-write', 'authority-sql'],
  },
  expected: {
    detectorRef: 'factory.submission-validator.formalization.acceptance-contract.v1',
    acceptableFallbackDetectors: ['artifact intake (ARTIFACT_CONTENT_HASH_UNVERIFIABLE)'],
    reasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
    evidenceKind: 'typed-rejection-with-repair-recipe',
    diagnosability: 'isolated',
    repairOwner: 'container presentation author (worker)',
    repairFrontier: 'workspace/path presentation boundary — never the digest field',
    preservedPrefix: ['discovery artifacts', 'formalization product-contract + use-cases cells'],
    invalidationCone: ['the rejected presentation only — no accepted material mutates'],
    terminalBudget: 'cell repair epochs (bounded by ADR-075 ceilings)',
  },
  repair: {
    triggerReasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
    fixtureRef: 'actor sees exact path/reason, writes the bytes, resubmits WITHOUT the hash',
  },
  counterfactualFeedback: ['absent', 'stale', 'corrupted-nonce'],
  independentFacts: ['sha256 of the on-disk bytes computed by the test, not by the factory'],
});
