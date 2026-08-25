/**
 * prompt-fixtures.test.mjs - WP-08 deliverable 8: production-size prompt
 * fixtures for the preserved Elite-3 (436KB planner request) and Elite-8
 * failure classes, proving required scope/unknown/terminal-claim information
 * is referenced or admitted - never silently dropped to fit the budget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionPins, roleRuntime, ROUTE_PIN_GLM47, sha256 } from './support.mjs';

const envelope = await import('../../../dist/workflow-kernel/context-envelope/index.js');
const fixtures = await import('../../../dist/workflow-kernel/development/envelope-assembly.js');

const ATTEMPT = 'prompt-fixture-attempt';

function memoryStore() {
  return new envelope.InMemoryAttemptAdmissionStore([
    {
      attemptRef: ATTEMPT,
      contextRevision: 0,
      nextRequestOrdinal: 1,
      cumulativeInputTokens: 0,
      providerRoutePin: ROUTE_PIN_GLM47,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/test',
      promptBudgetProfileDigest: 'sha256:' + sha256('profile'),
    },
  ]);
}

async function admitWith(profileOverrides, fixtureEnvelope) {
  const { pins } = await admissionPins(profileOverrides);
  return envelope.admitProviderRequest(pins, memoryStore(), {
    attemptRef: ATTEMPT,
    expectedContextRevision: 0,
    envelope: fixtureEnvelope,
    idempotencyKey: `fixture:${Math.random().toString(36).slice(2)}`,
  });
}

test('Elite-3: the 436KB planner request is ADMITTED whole at the production-scale profile', async () => {
  const fixture = fixtures.elite3PlannerFixture(fixtures.ELITE3_REQUEST_BYTES);
  assert.ok(fixture.frameBytes >= 436_000 - 10, `frame is production size (${fixture.frameBytes} bytes)`);
  const outcome = await admitWith({}, fixture.envelope);
  assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome).slice(0, 300));
  const receipt = outcome.receipt;
  // The whole frame was admitted: the serialized bytes carry the 436KB frame.
  assert.ok(receipt.serializedRequestBytes >= fixture.frameBytes);
  assert.ok(receipt.requestInputTokens > 90_000, `token count is production size (${receipt.requestInputTokens})`);
  // NOTHING was silently dropped: every PRESENT layer was admitted (the
  // receipt's omissions contain only absent OPTIONAL layers and are disjoint
  // from the admitted layer set - mandatory layers can never appear there).
  const optional = new Set(envelope.LAYER_RULES.filter((rule) => !rule.mandatory).map((rule) => rule.layer));
  for (const omitted of receipt.omissions) {
    assert.ok(optional.has(omitted), `omitted layer ${omitted} must be optional`);
    assert.equal(receipt.layerNames.includes(omitted), false, 'an admitted layer may never be listed as omitted');
  }
  assert.equal(receipt.layerNames.includes('initial-prompt-frame'), true);
  assert.equal(receipt.layerNames.includes('task-projection'), true);
  assert.ok(fixtures.allRequiredInfoSurvived(fixture.requiredInfo, receipt.externalReferences),
    'every scope/unknown/terminal-claim reference is carried by the admitted receipt');
  const dispositions = fixtures.requiredInfoDisposition(fixture.requiredInfo, receipt.externalReferences);
  assert.ok(dispositions.every((entry) => entry.disposition === 'referenced-or-inline'));
});

test('Elite-3 at a smaller profile: typed refusal, never silent truncation', async () => {
  const fixture = fixtures.elite3PlannerFixture(fixtures.ELITE3_REQUEST_BYTES);
  const outcome = await admitWith({ maxStaticTokens: 50_000 }, fixture.envelope);
  assert.equal(outcome.kind, 'refused', 'the production-size frame must not be silently shrunk to fit');
  assert.equal(outcome.violation, 'MAX_STATIC_TOKENS_EXCEEDED');
  // The refused receipt persists the REJECTED envelope digest and the typed
  // violation; the required info was not dropped to make it fit - the whole
  // envelope was rejected, with its references recorded.
  assert.match(outcome.receipt.rejectedEnvelopeDigest, /^sha256:/);
  assert.ok(fixtures.allRequiredInfoSurvived(fixture.requiredInfo, outcome.receipt.externalReferences));
  // No counters advanced: nothing was consumed.
  assert.equal(outcome.nextCounters.cumulativeInputTokens, 0);
  assert.equal(outcome.nextCounters.nextRequestOrdinal, 1);
});

test('Elite-8 repeated recovery: bounded memory admits within cap, refuses typed beyond it', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const within = await admitWith({ maxRecoveryTokens: 8_000 }, elite8.repeatedRecovery(50));
  assert.equal(within.kind, 'admitted', JSON.stringify(within).slice(0, 200));
  const beyond = await admitWith({ maxRecoveryTokens: 200 }, elite8.repeatedRecovery(50));
  assert.equal(beyond.kind, 'refused');
  assert.equal(beyond.violation, 'MAX_RECOVERY_TOKENS_EXCEEDED');
});

test('Elite-8 large accepted products: travel by content address, never recopied', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const { envelope: big, productRefs, totalProductBytes } = elite8.largeAcceptedProducts(12, 4_000_000);
  const outcome = await admitWith({}, big);
  assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome).slice(0, 200));
  // 48MB of accepted products referenced; the serialized request stays tiny.
  assert.equal(totalProductBytes, 48_000_000);
  assert.ok(outcome.receipt.serializedRequestBytes < 5_000, `raw bytes never recopied (${outcome.receipt.serializedRequestBytes})`);
  assert.deepEqual(outcome.receipt.externalReferences.map((ref) => ref.ref), productRefs.map((ref) => ref.ref));
});

test('Elite-8 duplicate metadata: the same layer twice is refused (FORBIDDEN class)', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const skeleton = elite8.skeleton(slot.slot.contract);
  const duplicated = elite8.duplicateMetadata(skeleton);
  const outcome = await admitWith({}, duplicated);
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.violation, 'UNCLASSIFIED_LAYER', 'one layer, one slot; duplicates are refused');
});

test('Elite-8 Unicode: multi-byte content is counted exactly and byte-checked', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const unicode = elite8.unicode(30_000);
  const outcome = await admitWith({}, unicode);
  assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome).slice(0, 200));
  assert.ok(outcome.receipt.serializedRequestBytes > 30_000, 'the byte backstop counts UTF-8 bytes, not code units');
  // The same envelope at a tiny byte cap is refused typed.
  const refused = await admitWith({ maxPromptBytes: 10_000 }, unicode);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.violation, 'MAX_PROMPT_BYTES_EXCEEDED');
});

test('Elite-8 hooks/additional context: bounded within maxDynamicTokens, typed refusal beyond', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const within = await admitWith({ maxDynamicTokens: 30_000 }, elite8.hooksAdditionalContext(5, 200));
  assert.equal(within.kind, 'admitted');
  const beyond = await admitWith({ maxDynamicTokens: 300 }, elite8.hooksAdditionalContext(5, 200));
  assert.equal(beyond.kind, 'refused');
  assert.equal(beyond.violation, 'MAX_DYNAMIC_TOKENS_EXCEEDED');
});

test('Elite-8 bounded tool results: within the tool-result budget admits, beyond refuses typed', async () => {
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const elite8 = fixtures.elite8Fixtures(slot.slot.contract);
  const within = await admitWith({ maxToolResultTokens: 12_000 }, elite8.boundedToolResults(5_000));
  assert.equal(within.kind, 'admitted');
  const beyond = await admitWith({ maxToolResultTokens: 1_000 }, elite8.boundedToolResults(5_000));
  assert.equal(beyond.kind, 'refused');
  assert.equal(beyond.violation, 'MAX_TOOL_RESULT_TOKENS_EXCEEDED');
});

test('the one counter identity law: a drifted counter pin is TOKEN_COUNTER_MISMATCH', async () => {
  const fixture = fixtures.elite3PlannerFixture(10_000);
  const drifted = await admitWith({ tokenCounterRef: { ...envelope.RUNNING_COUNTER_IDENTITY, digest: 'sha256:' + '0'.repeat(64) } }, fixture.envelope);
  assert.equal(drifted.kind, 'refused');
  assert.equal(drifted.violation, 'TOKEN_COUNTER_MISMATCH');
});
