// tests/architecture/effect-input-exact-refs.test.mjs
//
// K7 commit 3 — accepted-material read before effect invocation.
//
// AUDIT FINDING (2026-08-17, K7): the migration this ratchet pins was already
// complete when the Core Renewal Program reached K7. The effect invocation
// vertical passes exact refs forward end-to-end:
//
//   1. PostAcceptanceEffectInput carries ONLY `authority` (ADR-053 Phase 6
//      replaced the former execution-scoped fields — presenter identity,
//      process/node/task selectors, expected-schema rediscovery).
//   2. The authority is built at both live invocation sites
//      (settleAcceptanceEffect, recordFinalAcceptanceAndCapture in
//      production-cell-node-executor.ts) exclusively via the exact readers
//      getAcceptedGateDecisionKey / getAcceptedPrimaryOutput (exact
//      (workplace, subject, gate_phase='final'), fail-closed on zero or >1
//      rows), and crash recovery (C8) resolves the accepted candidate through
//      the durable authority pointer readAuthorCandidateSetRef — never by
//      hash order or recency.
//   3. sqlite-accepted-candidate-authority.ts re-verifies every persisted
//      coordinate by exact key before any post-seal effect.
//   4. The invoker contains ZERO direct SQL (comment-stripped): material is
//      resolved only through ports.
//
// Existing ratchets already pin the SQL side (adr-053-material-authority-
// ratchet: latestCandidate=0, sealed_at DESC=0, decided_at DESC=0;
// no-execution-scoped-lookup: listArtifactsForExecution etc. banned) and
// runtime fail-closed behavior (post-acceptance-authority-validation, C17).
// What NONE of them pin is the STRUCTURAL theorem: the effect input TYPE
// cannot grow an execution/task/node coordinate back, and the invoker cannot
// grow direct material SQL. This test fails the moment either regresses, so
// the "re-query by task/node/execution" legacy path cannot be reintroduced
// through the effect boundary.
//
// To consciously change the effect input surface (e.g. a future ADR adds a
// field), edit the EXPECTED sets in THIS file in the same commit — the test
// is the proof, not an obstacle.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EFFECT_CONTRACT_PATH = path.join(
  REPO_ROOT, 'src', 'process-modules', 'application', 'post-acceptance-effects.ts',
);
const EFFECT_INVOKER_PATH = path.join(
  REPO_ROOT, 'src', 'process-modules', 'application', 'node-executors',
  'production-cell-node-executor.ts',
);

function stripComments(src) {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  return out;
}

/**
 * Extract the brace-balanced body of `interface <name> { ... }` from
 * comment-stripped source.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function extractInterfaceBody(source, name) {
  const header = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`);
  const headerMatch = header.exec(source);
  assert.ok(headerMatch, `interface ${name} not found`);
  const start = headerMatch.index + headerMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  assert.ok(depth === 0, `interface ${name} body is brace-balanced`);
  return source.slice(start, i - 1);
}

/**
 * Top-level member names of an interface body. The base indent is the
 * indentation of the first member declaration; members of nested inline
 * literal types sit one level deeper and are excluded.
 *
 * @param {string} body
 * @returns {string[]}
 */
function interfaceMemberNames(body) {
  const re = /^([ \t]*)(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm;
  const names = [];
  let baseIndent = null;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (baseIndent === null) baseIndent = m[1];
    if (m[1] === baseIndent) names.push(m[2]);
  }
  return names;
}

// ===========================================================================
// Theorem A — the effect input is authority-ONLY.
//
// PostAcceptanceEffectInput must declare exactly one member: `authority`.
// Any additional member (an execution id, a task selector, a presenter
// coordinate, a "fallback" flag) fails this test: after ADR-053 Phase 6 the
// sole post-seal material input to an effect is the sealed authority, and
// operational coordinates are provenance the effect must not re-select
// material with.
// ===========================================================================
test('K7/effects: PostAcceptanceEffectInput declares exactly one member — authority', () => {
  const source = stripComments(readFileSync(EFFECT_CONTRACT_PATH, 'utf8'));
  const members = interfaceMemberNames(extractInterfaceBody(source, 'PostAcceptanceEffectInput'));
  assert.deepEqual(
    members,
    ['authority'],
    'PostAcceptanceEffectInput must carry ONLY the accepted-candidate authority. ' +
    'ADR-053 Phase 6 removed the execution-scoped fields (presenter identity, ' +
    'process/node/task selectors, expected-schema rediscovery); reintroducing ' +
    'any member lets an effect re-derive material from transient coordinates. ' +
    'If a new ADR legitimately extends the effect input, update the expected ' +
    'list in this test in the same commit — with an ADR reference. ' +
    `Found: [${members.join(', ')}]`,
  );
});

// ===========================================================================
// Theorem B — the authority carries sealed-material coordinates ONLY.
//
// The exact member set of AcceptedCandidateAuthority is pinned so that NO new
// member can appear without consciously editing this test. In particular an
// execution/task/node/presenter coordinate smuggled into the authority would
// hand effects a selector to re-query material by — the legacy path K7
// removes. All eight pinned members are sealed exact-ref identities.
// ===========================================================================
test('K7/effects: AcceptedCandidateAuthority member set is exactly the sealed coordinates', () => {
  const source = stripComments(readFileSync(EFFECT_CONTRACT_PATH, 'utf8'));
  const members = interfaceMemberNames(extractInterfaceBody(source, 'AcceptedCandidateAuthority'));
  assert.deepEqual(
    [...members].sort(),
    [
      'acceptanceDigest',
      'acceptedProductRefs',
      'candidateSetRef',
      'gateDecisionKey',
      'productContractRef',
      'productSchema',
      'productionRevisionRef',
      'workplaceRef',
    ],
    'AcceptedCandidateAuthority must consist solely of sealed exact-ref identities ' +
    '(workplace, candidate set, production revision, product refs+schema, gate ' +
    'decision, contract, acceptance digest). Adding a member — especially an ' +
    'execution/task/node/presenter coordinate — reintroduces material ' +
    're-selection by transient identity. Consciously extending the authority ' +
    'requires updating this list in the same commit with an ADR reference. ' +
    `Found: [${members.join(', ')}]`,
  );
});

// ===========================================================================
// Theorem C — the registry validates the authority BEFORE invoking the effect.
//
// assertAuthorityBound(input) (fail-closed on incomplete/inconsistent
// authority, C17) must run before effect.run(input) inside
// FactoryPostAcceptanceEffectRegistry.run. Reordering would let an unbound
// authority reach an external effect.
// ===========================================================================
test('K7/effects: registry.run() fail-closes on the authority before invoking the effect', () => {
  const source = stripComments(readFileSync(EFFECT_CONTRACT_PATH, 'utf8'));
  const runHeader = /run\(effectId:\s*string,\s*input:\s*PostAcceptanceEffectInput\)[^{]*\{/;
  const headerMatch = runHeader.exec(source);
  assert.ok(headerMatch, 'FactoryPostAcceptanceEffectRegistry.run(effectId, input) found');
  const regionStart = headerMatch.index + headerMatch[0].length;
  const nextMethod = source.indexOf('identity(effectId', regionStart);
  const region = source.slice(regionStart, nextMethod === -1 ? undefined : nextMethod);
  const validateAt = region.indexOf('assertAuthorityBound(input)');
  const invokeAt = region.indexOf('effect.run(input)');
  assert.ok(validateAt >= 0, 'run() calls assertAuthorityBound(input)');
  assert.ok(invokeAt >= 0, 'run() invokes effect.run(input)');
  assert.ok(
    validateAt < invokeAt,
    'assertAuthorityBound(input) must precede effect.run(input) — a fail-closed ' +
    'authority check that runs after invocation (or not at all) lets external ' +
    'effects consume an unbound / forged accepted authority',
  );
});

// ===========================================================================
// Theorem D — the live invoker resolves material ONLY through exact-reader
// ports; zero direct SQL.
//
// production-cell-node-executor.ts is where effects are invoked. If it grew a
// db.prepare or a factory_* table query, the effect path would have bypassed
// the exact readers (getAcceptedGateDecisionKey / getAcceptedPrimaryOutput /
// readAuthorCandidateSetRef) and re-selected material on its own. The reader
// ports themselves are pinned green by the C4/C6/C17 tests; this pins that
// the invoker actually goes through them.
// ===========================================================================
test('K7/effects: the effect invoker has no direct SQL and funnels through the exact readers', () => {
  const source = stripComments(readFileSync(EFFECT_INVOKER_PATH, 'utf8'));
  const violations = [];
  if (/db\.prepare/.test(source)) violations.push('db.prepare in the effect invoker');
  const fromFactory = source.match(/from\s+factory_\w+/gi) ?? [];
  for (const hit of fromFactory) violations.push(`direct SQL table read (${hit})`);
  assert.deepEqual(
    violations,
    [],
    'production-cell-node-executor.ts must resolve accepted material exclusively ' +
    'through the exact-reader ports (finalAcceptance.getAcceptedGateDecisionKey / ' +
    'getAcceptedPrimaryOutput, authorityHead.readAuthorCandidateSetRef, ' +
    'candidateSetRepo.read). Direct SQL in the invoker is a material ' +
    're-selection path K7 forbids.',
  );

  // Positive pin — the exact readers are actually used on the invocation paths.
  assert.match(
    source,
    /getAcceptedGateDecisionKey\(/,
    'invoker resolves the accepted gate decision via the exact key reader',
  );
  assert.match(
    source,
    /getAcceptedPrimaryOutput\(/,
    'invoker resolves accepted product refs via the exact primary-output reader',
  );
  assert.match(
    source,
    /readAuthorCandidateSetRef\(/,
    'invoker resolves the accepted author candidate via the durable authority pointer',
  );
});
