/**
 * scenario.test.mjs - the EK-9 scenario contract (WP-13A):
 *   - the canonical fixtures validate against the closed vocabulary;
 *   - scenarios round-trip through the canonical form (JSON stability,
 *     key-order-independent digest);
 *   - every closed-vocabulary violation is rejected with a precise
 *     path/code error (unknown keys, unknown kinds, bad enums, bad shapes).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENARIO_FORMAT_VERSION,
  ScenarioValidationError,
  assertValidScenario,
  canonicalScenario,
  scenarioDigest,
  validateScenario,
} from './scenario.mjs';
import {
  duplicateCompletionScenario,
  ingressScenario,
  omissionScenario,
  planningScenario,
  staleRevisionScenario,
} from './scenario-fixture.mjs';

/* ---------------- fixtures validate ---------------- */

test('every canonical fixture validates against the closed contract', () => {
  for (const scenario of [
    ingressScenario(),
    planningScenario(),
    planningScenario(['cont', 'plan']),
    duplicateCompletionScenario(),
    staleRevisionScenario(),
    omissionScenario(),
  ]) {
    const { valid, errors } = validateScenario(scenario);
    assert.deepEqual(errors, [], `fixture must validate: ${JSON.stringify(errors)}`);
    assert.equal(valid, true);
    assertValidScenario(scenario); // throwing form agrees
  }
});

/* ---------------- round-trip + digest ---------------- */

test('a scenario round-trips through the canonical form (JSON stable)', () => {
  const scenario = planningScenario();
  const canonical = canonicalScenario(scenario);
  assert.deepEqual(canonical, scenario, 'canonicalization preserves content');
  assert.deepEqual(JSON.parse(JSON.stringify(canonical)), canonical, 'JSON round-trip is stable');
  assertValidScenario(canonical);
});

test('the scenario digest is key-order independent and content sensitive', () => {
  const scenario = ingressScenario();
  const reordered = {};
  for (const key of Object.keys(scenario).reverse()) reordered[key] = scenario[key];
  assert.equal(scenarioDigest(reordered), scenarioDigest(scenario), 'key order does not change the digest');
  const mutated = structuredClone(scenario);
  mutated.seedInput.seed += 1;
  assert.notEqual(scenarioDigest(mutated), scenarioDigest(scenario), 'content changes change the digest');
  assert.match(scenarioDigest(scenario), /^[0-9a-f]{64}$/, 'the digest is sha256 hex');
});

/* ---------------- closed vocabulary: shape ---------------- */

const expectError = (scenario, path, code) => {
  const { valid, errors } = validateScenario(scenario);
  assert.equal(valid, false, `scenario at ${path} must be invalid`);
  const match = errors.find((e) => (path === null || e.path === path) && (code === null || e.code === code));
  assert.ok(match, `expected an error at ${path ?? '<any>'} [${code ?? '<any>'}], got ${JSON.stringify(errors)}`);
  return match;
};

test('a non-object scenario is rejected', () => {
  const { valid, errors } = validateScenario('not-a-scenario');
  assert.equal(valid, false);
  assert.equal(errors[0].code, 'wrong-type');
});

test('unknown top-level keys are rejected (closed shape)', () => {
  const scenario = ingressScenario();
  scenario.freeExtraBag = { anything: 1 };
  expectError(scenario, '$', 'unknown-key');
});

test('missing required top-level keys are rejected', () => {
  const scenario = ingressScenario();
  delete scenario.timeBudgets;
  expectError(scenario, '$.timeBudgets', 'missing-key');
});

test('the format version is pinned', () => {
  const scenario = ingressScenario();
  scenario.formatVersion = 'ek.workflow-scenario.ek8.v0';
  expectError(scenario, '$.formatVersion', 'invalid-value');
  assert.equal(SCENARIO_FORMAT_VERSION, 'ek.workflow-scenario.ek9.v1');
});

/* ---------------- closed vocabulary: identity ---------------- */

test('identity: protocol version must equal the frozen universe version', () => {
  const scenario = ingressScenario();
  scenario.identity.protocolVersion = 'ek.transition-universe.other.v9';
  expectError(scenario, '$.identity.protocolVersion', 'invalid-value');
});

test('identity: digests must be sha256 hex', () => {
  const scenario = ingressScenario();
  scenario.identity.buildDigest = 'not-hex';
  expectError(scenario, '$.identity.buildDigest', 'invalid-value');
  scenario.identity.buildDigest = 'ABCDEF';
  expectError(scenario, '$.identity.buildDigest', 'invalid-value');
});

test('identity: closed key set', () => {
  const scenario = ingressScenario();
  scenario.identity.extraIdentity = 'x';
  expectError(scenario, '$.identity', 'unknown-key');
});

/* ---------------- closed vocabulary: seed input ---------------- */

test('seedInput: fresh must be true, seed must be a uint32', () => {
  const scenario = ingressScenario();
  scenario.seedInput.fresh = false;
  expectError(scenario, '$.seedInput.fresh', 'invalid-value');
  const scenario2 = ingressScenario();
  scenario2.seedInput.seed = 2 ** 32;
  expectError(scenario2, '$.seedInput.seed', 'invalid-value');
  const scenario3 = ingressScenario();
  scenario3.seedInput.seed = 1.5;
  expectError(scenario3, '$.seedInput.seed', 'invalid-value');
});

test('a command step accepts no free-form payload key (no manifest bag)', () => {
  const scenario = ingressScenario();
  scenario.seedInput.ingress[0].freeFormPayload = { re: 'solvable' };
  expectError(scenario, '$.seedInput.ingress[0]', 'unknown-key');
});

test('ingress commands must come from the frozen 53-command universe', () => {
  const scenario = ingressScenario();
  scenario.seedInput.ingress[0].command = 'factoryRun.magic';
  expectError(scenario, '$.seedInput.ingress[0].command', 'not-in-vocabulary');
});

/* ---------------- closed vocabulary: actor program ---------------- */

test('actor behavior, semantic profile and protocol role are closed sets', () => {
  const scenario = planningScenario();
  scenario.actorProgram[0].behavior = 'mostly-fine';
  expectError(scenario, '$.actorProgram[0].behavior', 'not-in-vocabulary');
  const scenario2 = planningScenario();
  scenario2.actorProgram[0].semanticProfile = 'architect';
  expectError(scenario2, '$.actorProgram[0].semanticProfile', 'not-in-vocabulary');
  const scenario3 = planningScenario();
  scenario3.actorProgram[0].protocolRole = 'auditor';
  expectError(scenario3, '$.actorProgram[0].protocolRole', 'not-in-vocabulary');
});

test('typed command discriminators are closed sets', () => {
  const scenario = planningScenario();
  scenario.actorProgram[0].gateVerdict = 'mostly-accepted';
  expectError(scenario, '$.actorProgram[0].gateVerdict', 'not-in-vocabulary');
  const scenario2 = planningScenario();
  scenario2.actorProgram[0].effectOutcome = 'partially-applied';
  expectError(scenario2, '$.actorProgram[0].effectOutcome', 'not-in-vocabulary');
  const scenario3 = planningScenario();
  scenario3.actorProgram[0].terminalOutcome = 'partial-success';
  expectError(scenario3, '$.actorProgram[0].terminalOutcome', 'not-in-vocabulary');
});

test('rolePin must be the exact reference/digest pair shape', () => {
  const scenario = planningScenario();
  scenario.actorProgram[0].rolePin = { roleContractRef: 'ref-not-sha256', roleContractDigest: 'abc' };
  expectError(scenario, '$.actorProgram[0].rolePin.roleContractRef', 'invalid-value');
});

/* ---------------- closed vocabulary: topology ---------------- */

test('topology shapes and concurrency caps are closed/bounded', () => {
  const scenario = ingressScenario();
  scenario.topology.shape = 'spaghetti';
  expectError(scenario, '$.topology.shape', 'not-in-vocabulary');
  const scenario2 = ingressScenario();
  scenario2.topology.concurrencyCap = 0;
  expectError(scenario2, '$.topology.concurrencyCap', 'invalid-value');
  const scenario3 = ingressScenario();
  scenario3.topology.edges = [['a']];
  expectError(scenario3, '$.topology.edges[0]', 'wrong-type');
});

/* ---------------- closed vocabulary: fault schedule ---------------- */

test('fault classes and restart boundaries are closed sets', () => {
  const scenario = staleRevisionScenario();
  scenario.faultSchedule[0].fault = 'cosmic-ray';
  expectError(scenario, '$.faultSchedule[0].fault', 'not-in-vocabulary');
  const scenario2 = staleRevisionScenario();
  scenario2.faultSchedule[0].boundary = 'mid-thought';
  expectError(scenario2, '$.faultSchedule[0].boundary', 'not-in-vocabulary');
});

test('fault anchors must name a declared command occurrence', () => {
  const scenario = staleRevisionScenario();
  scenario.faultSchedule[0].anchor.command = 'factoryRun.magic';
  expectError(scenario, '$.faultSchedule[0].anchor.command', 'not-in-vocabulary');
  const scenario2 = staleRevisionScenario();
  scenario2.faultSchedule[0].anchor.occurrence = 0;
  expectError(scenario2, '$.faultSchedule[0].anchor.occurrence', 'invalid-value');
});

/* ---------------- closed vocabulary: expectations ---------------- */

test('expected events/obligations/waits/proofs come from the frozen universe', () => {
  const scenario = ingressScenario();
  scenario.expectations.events = ['WorkflowEvent:factoryRun.bootstrapped', 'WorkflowEvent:factoryRun.magic'];
  expectError(scenario, '$.expectations.events[1]', 'not-in-vocabulary');
  const scenario2 = ingressScenario();
  scenario2.expectations.obligations = [{ kind: 'obligation:magic', state: 'open' }];
  expectError(scenario2, '$.expectations.obligations[0].kind', 'not-in-vocabulary');
  const scenario3 = ingressScenario();
  scenario3.expectations.obligations = [{ kind: 'obligation:ingestCapsuleFacts', state: 'half-done' }];
  expectError(scenario3, '$.expectations.obligations[0].state', 'not-in-vocabulary');
  const scenario4 = ingressScenario();
  scenario4.expectations.waits = [{ kind: 'TypedWait:magic', state: 'pending' }];
  expectError(scenario4, '$.expectations.waits[0].kind', 'not-in-vocabulary');
  const scenario5 = ingressScenario();
  scenario5.expectations.proofs = ['TerminalProof:cell.magic'];
  expectError(scenario5, '$.expectations.proofs[0]', 'not-in-vocabulary');
});

test('expected evidence must sit in its declared class (material/gate/effect)', () => {
  const scenario = ingressScenario();
  scenario.expectations.evidence.material = ['CapsuleIngressReceipt'];
  expectError(scenario, '$.expectations.evidence.material[0]', 'invalid-value');
  const scenario2 = ingressScenario();
  scenario2.expectations.evidence.gate = ['EffectReceipt:success'];
  expectError(scenario2, '$.expectations.evidence.gate[0]', 'invalid-value');
  const scenario3 = ingressScenario();
  scenario3.expectations.evidence.effect = ['GateDecision:accepted'];
  expectError(scenario3, '$.expectations.evidence.effect[0]', 'invalid-value');
  const scenario4 = ingressScenario();
  scenario4.expectations.evidence.effect = ['EffectReceipt:MagicOutcome'];
  expectError(scenario4, '$.expectations.evidence.effect[0]', 'not-in-vocabulary');
});

/* ---------------- closed vocabulary: verification + budgets ---------------- */

test('product verification commands and time budgets are typed', () => {
  const scenario = ingressScenario();
  scenario.verification.productCommands = [''];
  expectError(scenario, '$.verification.productCommands[0]', 'wrong-type');
  const scenario2 = ingressScenario();
  scenario2.timeBudgets.totalMs = 0;
  expectError(scenario2, '$.timeBudgets.totalMs', 'invalid-value');
  const scenario3 = ingressScenario();
  scenario3.timeBudgets.perStepMs = -1;
  expectError(scenario3, '$.timeBudgets.perStepMs', 'invalid-value');
});

/* ---------------- throwing form ---------------- */

test('assertValidScenario lists every violation when it throws', () => {
  const scenario = ingressScenario();
  scenario.expectations.events = ['WorkflowEvent:factoryRun.magic'];
  scenario.topology.shape = 'spaghetti';
  assert.throws(() => assertValidScenario(scenario), (error) => {
    assert.ok(error instanceof ScenarioValidationError);
    assert.equal(error.errors.length, 2, 'both violations are reported');
    assert.ok(error.message.includes('WorkflowEvent:factoryRun.magic'));
    return true;
  });
});
