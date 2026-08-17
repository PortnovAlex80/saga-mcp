// tests/architecture/effects-no-material-reselection.test.mjs
//
// K11 — ban material re-selection inside effects (AST/SQL ratchets).
//
// AUDIT FINDING (2026-08-17, K11): the train's refactor work was already
// delivered — PostAcceptanceEffectInput is authority-only (ADR-053 Phase 6;
// pinned by effect-input-exact-refs.test.mjs since K7), and all three
// registered effects consume exact AcceptedCandidateAuthority:
//
//   formalization.accept-exact-products — assertPersisted first; material
//     from the sealed snapshot via authority product refs; CAS by exact
//     artifact id + sealed hash.
//   git-integration — assertAuthority first; every coordinate from the
//     authority; idempotent external-effect ledger keyed by the
//     authority-derived request hash; the integration consumer reads its
//     task from the accepted-authority head (proven by the C5 adversarial
//     matrix), never from worker selection.
//   replay-capture — assertPersistedAcceptedCandidateAuthority first; exact
//     decision_key / candidate_set_ref / workplace_ref lookups.
//
// This ratchet pins the exit gate deterministically: no post-acceptance
// effect reads material through process, task, node, schema, latest
// submission, or execution identity.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

// The closed set of post-acceptance effect implementation files. A NEW
// effect must be added here in the same commit — an unclassified effect is
// exactly where re-selection could hide.
const EFFECT_FILES = Object.freeze([
  'src/modules/formalization/application/formalization-accept-products-effect.ts',
  'src/infrastructure/workplace/git-integration-effect.ts',
  'src/infrastructure/replay/replay-capture-effect.ts',
]);

// SQL shapes that would select MATERIAL by operational identity or
// chronology inside an effect. Exact-key lookups (id=?, workplace_ref=?,
// decision_key=?, candidate_set_ref=?) remain legal.
const BANNED_SQL = /task_id\s*=|node_id\s*=|execution_id\s*=|epic_id\s*=|order\s+by|sealed_at\s+desc|decided_at\s+desc|limit\s+1/iu;

// Identifiers of legacy re-selection helpers.
const BANNED_IDENTIFIERS = /\b(readLatest\w*|latestCandidate|listArtifactsFor\w+|readLatestSubmission\w*)\b/u;

function readEffect(rel) {
  return stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

test('K11/ban: no effect file selects material by operational identity or chronology', () => {
  const violations = [];
  for (const rel of EFFECT_FILES) {
    const source = readEffect(rel);
    const sqlMatch = source.match(BANNED_SQL);
    if (sqlMatch) violations.push(`${rel}: banned SQL shape '${sqlMatch[0]}'`);
    const idMatch = source.match(BANNED_IDENTIFIERS);
    if (idMatch) violations.push(`${rel}: banned identifier '${idMatch[0]}'`);
  }
  assert.deepEqual(
    violations,
    [],
    'A post-acceptance effect acts on accepted authority only. Reading '
    + 'material by task/node/execution/epic identity, or by any ordering/'
    + 'recency/latest selector, re-introduces the legacy failure class the '
    + 'K11 negative theorem (authority-only-effects-theorem.test.mjs) pins.',
  );
});

test('K11/ban: every effect asserts the persisted authority BEFORE acting', () => {
  for (const rel of EFFECT_FILES) {
    const source = readEffect(rel);
    const runAt = source.indexOf('run(');
    assert.ok(runAt >= 0, `${rel}: run() exists`);
    const runRegion = source.slice(runAt);
    const assertAt = runRegion.search(/assertPersisted\w*\(|integration\.assertAuthority\(/u);
    assert.ok(assertAt >= 0, `${rel}: run() asserts the persisted authority`);
    // The assertion must precede every SQL mutation and every material read.
    const firstAction = runRegion.search(/db\.(prepare|transaction)|ledger\.start|integration\.(integrate|observe)/u);
    assert.ok(
      firstAction < 0 || assertAt < firstAction,
      `${rel}: the authority assertion precedes all DB/ledger/integration use`,
    );
  }
});

test('K11/ban: the effect registry still fail-closes on unbound authority (K7 theorem C holds)', () => {
  // Cross-reference pin: the registry validates the authority digest before
  // invoking any effect (assertAuthorityBound inside run, pinned since K7).
  // A regression that reorders validation after invocation breaks here too.
  const source = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'application', 'post-acceptance-effects.ts'),
    'utf8',
  ));
  const runAt = source.indexOf('run(effectId: string, input: PostAcceptanceEffectInput)');
  const region = source.slice(runAt, source.indexOf('identity(effectId', runAt));
  const validateAt = region.indexOf('assertAuthorityBound(input)');
  const invokeAt = region.indexOf('effect.run(input)');
  assert.ok(validateAt >= 0 && invokeAt > validateAt,
    'the registry fail-closes on the authority BEFORE invoking the effect');
});
