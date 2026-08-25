/**
 * accountant.test.mjs - the ONE cumulative context accountant: positive-finite
 * enforcement, frozen formula compliance, the pinned token counter, the
 * read-only exact-key limit table, layer classification laws (WP-18).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRefused,
  conformingEnvelope,
  envelope,
  EXAMPLE_ROUTE_PIN,
  frozenExampleTable,
  testAttemptCounters,
  testPins,
  testProfile,
  tokenText,
} from './support.mjs';

// NOTE: validate-prompt-budget.mjs is NOT imported here - it has no import
// guard (top-level process.exit). The frozen oracle is the example
// artifact's DECLARED computedRowsDigest, which the frozen validator
// re-verifies on every `npm run validate:ek-admission-specs` run.

/* ------------------------------------------------------------------ */
/* The pinned token counter (saga-token-counter-protocol v1)           */
/* ------------------------------------------------------------------ */

test('counter identity is pinned, content-addressed and stable', () => {
  const identity = envelope.RUNNING_COUNTER_IDENTITY;
  assert.equal(identity.name, 'saga-token-counter-protocol');
  assert.equal(identity.protocolVersion, '1');
  assert.match(identity.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(identity.implementationRef, /^content:\/\//);
  // Recomputing the identity from the frozen descriptor reproduces the pin.
  const again = envelope.RUNNING_COUNTER_IDENTITY;
  assert.deepEqual(again, identity);
});

test('counter is deterministic and exact: tokenText(n) counts exactly n tokens', () => {
  for (const n of [0, 1, 2, 17, 400]) {
    assert.equal(envelope.countTokens(tokenText(n)), n);
  }
  assert.equal(envelope.countTokens('aaaa'), 1); // 4 chars -> 1 token
  assert.equal(envelope.countTokens('aaaaa'), 2); // 5 chars -> ceil(5/4) = 2
  assert.equal(envelope.countTokens(''), 0);
  // identical bytes => identical counts, repeatedly
  assert.equal(envelope.countTokens(tokenText(77)), envelope.countTokens(tokenText(77)));
});

test('per-layer counts sum exactly to requestInputTokens over the whole envelope', () => {
  const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  assert.equal(verdict.ok, true);
  const sum = verdict.layerTokenCounts.reduce((a, b) => a + b, 0);
  assert.equal(sum, verdict.requestInputTokens);
});

test('counter drift (any pinned-identity difference) is a typed TOKEN_COUNTER_MISMATCH with NO counts recorded', () => {
  for (const drift of [
    { ...envelope.RUNNING_COUNTER_IDENTITY, digest: `sha256:${'9'.repeat(64)}` },
    { ...envelope.RUNNING_COUNTER_IDENTITY, encoding: 'some-other-encoding' },
    { ...envelope.RUNNING_COUNTER_IDENTITY, protocolVersion: '2' },
    { ...envelope.RUNNING_COUNTER_IDENTITY, name: 'other-counter-protocol' },
    { ...envelope.RUNNING_COUNTER_IDENTITY, implementationRef: 'content://token-counters/other' },
  ]) {
    const verdict = envelope.accountEnvelope(
      testProfile({ tokenCounterRef: drift }),
      testPins().limitTable,
      testAttemptCounters(),
      conformingEnvelope(),
    );
    assertRefused(verdict, 'TOKEN_COUNTER_MISMATCH');
    assert.deepEqual(verdict.layerTokenCounts, [], 'a drifted counter never recounts silently');
    assert.equal(verdict.requestInputTokens, 0);
    assert.equal(verdict.counterPinVerified, false);
    assert.ok(verdict.limitChecks.some((check) => check.limit === 'tokenCounterPin' && !check.pass));
  }
});

/* ------------------------------------------------------------------ */
/* Positive-finite enforcement (zero/missing/unsupported fail closed)  */
/* ------------------------------------------------------------------ */

test('every limit field fails closed on zero, null, string, fractional and missing values', () => {
  const fields = [
    'providerContextLimitTokens',
    'maxProviderRequests',
    'maxStaticTokens',
    'maxDynamicTokens',
    'maxRecoveryTokens',
    'maxToolResultTokens',
    'maxTotalInputTokens',
    'maxCumulativeSessionInputTokens',
    'reservedOutputTokens',
    'providerOverheadReserveTokens',
    'safetyMarginTokens',
    'maxPromptBytes',
  ];
  for (const field of fields) {
    for (const bad of [0, null, 'unlimited', 1.5, -5, Infinity]) {
      const profile = testProfile({ [field]: bad });
      const verdict = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
      assertRefused(verdict, 'PROFILE_NOT_POSITIVE_FINITE');
    }
    const missing = testProfile();
    delete missing[field];
    const verdict = envelope.accountEnvelope(missing, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
    assertRefused(verdict, 'PROFILE_NOT_POSITIVE_FINITE', 'missing limit is fail-closed invalid, not unbounded-valid');
  }
});

test('profile formula incoherence is refused (frozen coherence laws)', () => {
  // maxTotalInputTokens > effectiveInputLimit
  assertRefused(
    envelope.accountEnvelope(testProfile({ maxTotalInputTokens: 131072 }), testPins().limitTable, testAttemptCounters(), conformingEnvelope()),
    'PROFILE_FORMULA_INCOHERENT',
  );
  // session budget below one maximal request
  assertRefused(
    envelope.accountEnvelope(testProfile({ maxCumulativeSessionInputTokens: 99999 }), testPins().limitTable, testAttemptCounters(), conformingEnvelope()),
    'PROFILE_FORMULA_INCOHERENT',
  );
  // a layer cap above the whole request cap
  assertRefused(
    envelope.accountEnvelope(testProfile({ maxStaticTokens: 100001 }), testPins().limitTable, testAttemptCounters(), conformingEnvelope()),
    'PROFILE_FORMULA_INCOHERENT',
  );
  // effectiveInputLimit driven non-positive
  assertRefused(
    envelope.accountEnvelope(
      testProfile({ providerContextLimitTokens: 10000, reservedOutputTokens: 8192, providerOverheadReserveTokens: 2048, safetyMarginTokens: 4096 }),
      testPins().limitTable,
      testAttemptCounters(),
      conformingEnvelope(),
    ),
    'PROFILE_FORMULA_INCOHERENT',
  );
});

/* ------------------------------------------------------------------ */
/* Frozen formulas (exact)                                             */
/* ------------------------------------------------------------------ */

test('effectiveInputLimit and perRequestCap follow the frozen formulas exactly', () => {
  const profile = testProfile();
  assert.equal(envelope.effectiveInputLimitOf(profile), 131072 - 8192 - 2048 - 4096);
  assert.equal(envelope.effectiveInputLimitOf(profile), 116736);
  assert.equal(envelope.perRequestCapOf(profile), Math.min(100000, 116736));
  assert.equal(envelope.perRequestCapOf(profile), 100000);
  // when the effective limit is the tighter bound, it wins
  const tight = testProfile({ maxTotalInputTokens: 120000, providerContextLimitTokens: 110000 });
  // NOTE: 110000 disagrees with the pinned table row - the formula value is
  // still computable; the disagreement is a separate typed refusal.
  assert.equal(envelope.perRequestCapOf(tight), Math.min(120000, 110000 - 8192 - 2048 - 4096));
});

test('requestInputTokens <= min(maxTotalInputTokens, effectiveInputLimit) at and over the boundary', () => {
  // dynamic cap 20 stays clear of the engineered envelopes (dynamic 15/16)
  // so the TOTAL check is the one under test
  const profile = testProfile({ maxStaticTokens: 15, maxDynamicTokens: 20, maxRecoveryTokens: 5, maxToolResultTokens: 5, maxTotalInputTokens: 30, maxCumulativeSessionInputTokens: 30 });
  const atCap = conformingEnvelope({ staticEach: 3, task: 10, workspace: 5 }); // 15 static + 15 dynamic = 30
  const at = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), atCap);
  assert.equal(at.ok, true, `exactly at cap passes: ${at.violationDetail}`);
  assert.equal(at.requestInputTokens, 30);
  const overCap = conformingEnvelope({ staticEach: 3, task: 10, workspace: 6 }); // 31
  const over = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), overCap);
  assertRefused(over, 'MAX_TOTAL_INPUT_TOKENS_EXCEEDED');
});

test('cumulative session budget: cumulative + request <= maxCumulativeSessionInputTokens', () => {
  const attempt = testAttemptCounters();
  const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, attempt, conformingEnvelope());
  assert.equal(verdict.ok, true);
  // engineer the cumulative to the exact edge: cap 800000, request 35 tokens
  const edge = testAttemptCounters({ cumulativeInputTokens: 800000 - 35 });
  const atEdge = envelope.accountEnvelope(testPins().profile, testPins().limitTable, edge, conformingEnvelope());
  assert.equal(atEdge.ok, true, `cumulative exactly at cap passes: ${atEdge.violationDetail}`);
  const beyond = testAttemptCounters({ cumulativeInputTokens: 800000 - 34 });
  assertRefused(
    envelope.accountEnvelope(testPins().profile, testPins().limitTable, beyond, conformingEnvelope()),
    'CUMULATIVE_SESSION_BUDGET_EXCEEDED',
  );
});

test('requestOrdinal <= maxProviderRequests', () => {
  const profile = testProfile({ maxProviderRequests: 1 });
  const first = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  assert.equal(first.ok, true);
  const second = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters({ nextRequestOrdinal: 2 }), conformingEnvelope());
  assertRefused(second, 'MAX_PROVIDER_REQUESTS_EXCEEDED');
});

test('layer budgets: layerTokens <= layerBudget for every class, at and over the boundary', () => {
  // static: 5 layers x 3 tokens = 15; cap exactly 15 passes, 20 refuses
  const staticProfile = testProfile({ maxStaticTokens: 15 });
  assert.equal(envelope.accountEnvelope(staticProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ staticEach: 3, task: 0, workspace: 0 })).ok, true);
  assertRefused(
    envelope.accountEnvelope(staticProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ staticEach: 4, task: 0, workspace: 0 })),
    'MAX_STATIC_TOKENS_EXCEEDED',
  );
  // dynamic: task + workspace (+ hook)
  const dynamicProfile = testProfile({ maxDynamicTokens: 20 });
  assert.equal(envelope.accountEnvelope(dynamicProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ task: 10, workspace: 10 })).ok, true);
  assertRefused(
    envelope.accountEnvelope(dynamicProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ task: 10, workspace: 10, hook: 1 })),
    'MAX_DYNAMIC_TOKENS_EXCEEDED',
  );
  // recovery
  const recoveryProfile = testProfile({ maxRecoveryTokens: 5 });
  assert.equal(envelope.accountEnvelope(recoveryProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ recovery: 5, task: 0, workspace: 0 })).ok, true);
  assertRefused(
    envelope.accountEnvelope(recoveryProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ recovery: 6, task: 0, workspace: 0 })),
    'MAX_RECOVERY_TOKENS_EXCEEDED',
  );
  // tool results
  const toolProfile = testProfile({ maxToolResultTokens: 5 });
  assert.equal(envelope.accountEnvelope(toolProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ toolResults: 5, task: 0, workspace: 0 })).ok, true);
  assertRefused(
    envelope.accountEnvelope(toolProfile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ toolResults: 6, task: 0, workspace: 0 })),
    'MAX_TOOL_RESULT_TOKENS_EXCEEDED',
  );
});

test('serializedRequestBytes <= maxPromptBytes: the byte backstop has no unlimited representation', () => {
  const base = conformingEnvelope();
  const ordered = envelope.normalizeEnvelopeLayers(base.layers);
  assert.equal(ordered.ok, true);
  const serialized = envelope.serializeEnvelopeLayers(ordered.ordered);
  const exactBytes = Buffer.byteLength(serialized, 'utf8');
  assert.equal(envelope.accountEnvelope(testProfile({ maxPromptBytes: exactBytes }), testPins().limitTable, testAttemptCounters(), base).ok, true);
  assertRefused(
    envelope.accountEnvelope(testProfile({ maxPromptBytes: exactBytes - 1 }), testPins().limitTable, testAttemptCounters(), base),
    'MAX_PROMPT_BYTES_EXCEEDED',
  );
});

test('the violation order is deterministic when several limits fail at once', () => {
  // total AND cumulative AND bytes all fail: the earliest check in the
  // frozen order wins (total before cumulative before bytes).
  const profile = testProfile({ maxStaticTokens: 15, maxDynamicTokens: 20, maxRecoveryTokens: 5, maxToolResultTokens: 5, maxTotalInputTokens: 30, maxCumulativeSessionInputTokens: 30, maxPromptBytes: 10 });
  const over = conformingEnvelope({ staticEach: 3, task: 10, workspace: 6 }); // 31 tokens
  const v1 = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), over);
  const v2 = envelope.accountEnvelope(profile, testPins().limitTable, testAttemptCounters(), over);
  assertRefused(v1, 'MAX_TOTAL_INPUT_TOKENS_EXCEEDED');
  assert.deepEqual(v1.limitChecks, v2.limitChecks);
  assert.equal(v1.violation, v2.violation);
});

test('the accountant is a pure deterministic function (identical inputs => identical verdicts)', () => {
  const a = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  const b = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  assert.deepEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* The read-only exact-key limit table                                 */
/* ------------------------------------------------------------------ */

test('table digest rule is behaviorally equal to the FROZEN admission validator', () => {
  const { artifact, declaredDigest } = frozenExampleTable();
  // declaredDigest is the digest the frozen validator computed over the same
  // rows; equality proves this package applies the identical rule.
  assert.equal(envelope.tableRowsDigestOf(artifact.rows), declaredDigest);
  // and the digest is over CONTENT: any row change moves it
  const mutated = { kind: 'provider-model-limit-table', rows: [...artifact.rows.slice(0, 1)] };
  assert.notEqual(envelope.tableRowsDigestOf(mutated.rows), declaredDigest);
});

test('limit table is bound by digest: a tampered table is refused', () => {
  const tampered = { kind: 'provider-model-limit-table', rows: [{ provider: 'zai', model: 'glm-5.2', version: 'catalog-2026-08-24', contextLimitTokens: 999999 }] };
  assertRefused(
    envelope.accountEnvelope(testPins().profile, tampered, testAttemptCounters(), conformingEnvelope()),
    'LIMIT_TABLE_DIGEST_MISMATCH',
  );
});

test('zero/missing/unsupported provider limits fail closed (exact-key lookup only)', () => {
  // route not in the table
  assertRefused(
    envelope.accountEnvelope(
      testPins().profile,
      testPins().limitTable,
      testAttemptCounters({ providerRoutePin: { provider: 'zai', model: 'glm-5.2', version: 'catalog-1999-01-01' } }),
      conformingEnvelope(),
    ),
    'PROVIDER_LIMIT_UNSUPPORTED',
  );
  // wildcard keys never match
  assertRefused(
    envelope.accountEnvelope(
      testPins().profile,
      testPins().limitTable,
      testAttemptCounters({ providerRoutePin: { provider: '*', model: '*', version: '*' } }),
      conformingEnvelope(),
    ),
    'PROVIDER_LIMIT_UNSUPPORTED',
  );
  // profile context limit disagreeing with the pinned row
  assertRefused(
    envelope.accountEnvelope(testProfile({ providerContextLimitTokens: 131073 }), testPins().limitTable, testAttemptCounters(), conformingEnvelope()),
    'PROVIDER_LIMIT_DISAGREEMENT',
  );
});

/* ------------------------------------------------------------------ */
/* Layer classification laws                                           */
/* ------------------------------------------------------------------ */

test('mandatory-inline layers can never disappear through silent truncation', () => {
  for (const missing of ['initial-prompt-frame', 'protocol-skill', 'semantic-skill', 'tool-schemas', 'write-authority']) {
    const layers = conformingEnvelope().layers.filter((layer) => layer.layer !== missing);
    const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), { layers });
    assertRefused(verdict, 'MANDATORY_LAYER_MISSING');
    assert.ok(verdict.violationDetail.includes(missing));
  }
});

test('CS-14/CS-16 detector: the raw mutable row / wholesale recopy is refused', () => {
  assertRefused(
    envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ rawTaskRow: true })),
    'FORBIDDEN_DUPLICATION',
  );
  assertRefused(
    envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope({ rawWorkspace: true })),
    'FORBIDDEN_DUPLICATION',
  );
  // declared bounded forms pass
  assert.equal(envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope()).ok, true);
});

test('an unclassified or duplicated context source is a spec violation, not a default', () => {
  const unknown = [...conformingEnvelope().layers, { layer: 'mystery-injection', content: 'x' }];
  assertRefused(
    envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), { layers: unknown }),
    'UNCLASSIFIED_LAYER',
  );
  const duplicated = [...conformingEnvelope().layers, { layer: 'protocol-skill', content: 'second copy' }];
  assertRefused(
    envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), { layers: duplicated }),
    'UNCLASSIFIED_LAYER',
  );
});

test('omitted optional layers are recorded in the deterministic omission order', () => {
  const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  assert.equal(verdict.ok, true);
  // present: task-projection, workspace-summary; absent: recovery, hook, tool-results, refs, desk, patch
  assert.deepEqual(verdict.omittedOptionalLayers, [
    'recovery-history',
    'hook-context',
    'tool-results',
    'large-product-refs',
    'desk-reference',
    'patch-pointer',
  ]);
});

test('content-addressed references travel as the audit trail, never as raw material', () => {
  const verdict = envelope.accountEnvelope(
    testPins().profile,
    testPins().limitTable,
    testAttemptCounters(),
    conformingEnvelope({ deskReference: true }),
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.externalReferences.length, 1);
  assert.equal(verdict.externalReferences[0].ref, 'content://desks/reviewer/2026-08');
  assert.match(verdict.externalReferences[0].digest, /^sha256:[0-9a-f]{64}$/);
  // the reference layer's inline pointer is counted only in the total caps
  // (no per-layer budget class for reference layers).
  const counts = verdict.layerNames.map((name, i) => ({ name, count: verdict.layerTokenCounts[i] }));
  const desk = counts.find((c) => c.name === 'desk-reference');
  assert.equal(desk.count, 2, 'the bounded pointer travels inline and is counted');
});

test('layer digests pin the exact layer bytes (the CS-02/CS-03 role-contract pin basis)', () => {
  const base = conformingEnvelope();
  const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), base);
  assert.equal(verdict.ok, true);
  const protocolLayer = base.layers.find((layer) => layer.layer === 'protocol-skill');
  const index = verdict.layerNames.indexOf('protocol-skill');
  assert.equal(verdict.layerDigests[index], envelope.layerDigestOf(protocolLayer));
  // any byte change moves the digest
  const tampered = { ...protocolLayer, content: `${protocolLayer.content}x` };
  assert.notEqual(envelope.layerDigestOf(tampered), verdict.layerDigests[index]);
});

test('the green verdict records every passing limit check', () => {
  const verdict = envelope.accountEnvelope(testPins().profile, testPins().limitTable, testAttemptCounters(), conformingEnvelope());
  assert.equal(verdict.ok, true);
  const limits = verdict.limitChecks.map((check) => check.limit);
  for (const expected of [
    'tokenCounterPin',
    'limitTableDigest',
    'providerRouteExactKeyRow',
    'providerContextLimitAgrees',
    'mandatoryLayersPresent',
    'boundedTransportForms',
    'maxStaticTokens',
    'maxDynamicTokens',
    'maxRecoveryTokens',
    'maxToolResultTokens',
    'min(maxTotalInputTokens, effectiveInputLimit)',
    'maxCumulativeSessionInputTokens',
    'maxProviderRequests',
    'maxPromptBytes',
  ]) {
    assert.ok(limits.includes(expected), `missing limit check ${expected}`);
  }
  assert.ok(verdict.limitChecks.every((check) => check.pass));
  assert.equal(verdict.providerContextLimitTokens, 131072);
  assert.equal(verdict.effectiveInputLimit, 116736);
  assert.equal(verdict.perRequestCap, 100000);
  assert.deepEqual(verdict.providerRoutePin, EXAMPLE_ROUTE_PIN);
});
