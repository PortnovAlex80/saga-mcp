// tests/architecture/adr-053-g-points.test.mjs
//
// ADR-053 CUTOVER — G-points acceptance gate (G-1..G-7, in-memory verifiable).
//
// Each G-point is the acceptance criterion for allowing the next real-model
// canary. G-1..G-7 are verifiable in-memory (grep/schema/type assertions);
// G-8 (clean scripted E2E), G-9 (temporal suite) and G-10 (real-model canary)
// require a factory-idle lifecycle run and are gated separately.
//
// This test is the consolidation of the B-1..B-9 cutover work: each assertion
// maps to a B-point that delivered it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

function listTypeScriptFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) out.push(...listTypeScriptFiles(abs));
    else if (st.isFile() && entry.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  return out;
}

function countInSrc(needle) {
  const lower = needle.toLowerCase();
  let total = 0;
  for (const abs of listTypeScriptFiles(SRC_ROOT)) {
    const src = stripComments(readFileSync(abs, 'utf8')).toLowerCase();
    let idx = 0;
    while ((idx = src.indexOf(lower, idx)) !== -1) { total += 1; idx += lower.length; }
  }
  return total;
}

function readFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ===========================================================================
// G-1 — no post-seal material recency (latestCandidate / sealed_at) in code.
// (decided_at is captured in the B-6 ratchet at baseline 9; B-9 lowers it.)
// ===========================================================================
test('G-1: no latestCandidate / ORDER BY sealed_at DESC material recency in src/', () => {
  assert.equal(countInSrc('latestCandidate'), 0, 'latestCandidate eliminated');
  assert.equal(countInSrc('order by sealed_at desc'), 0, 'ORDER BY sealed_at DESC eliminated');
});

// ===========================================================================
// G-2 — CandidateSet may never reference an absent revision (structural FK).
// ===========================================================================
test('G-2: factory_candidate_sets.production_revision_ref has a structural FK', () => {
  const schema = readFile('src/schema.ts');
  assert.match(
    schema,
    /FOREIGN KEY \(production_revision_ref\) REFERENCES factory_workplace_production_revisions\(revision_ref\)/,
    'CandidateSet → revision FK exists',
  );
  assert.match(schema, /production_revision_ref TEXT NOT NULL/, 'production_revision_ref is NOT NULL');
  assert.match(readFile('src/db.ts'), /foreign_keys = ON/, 'foreign_keys=ON globally');
});

// ===========================================================================
// G-4 — post-acceptance effect input is authority-only (no legacy selectors).
// ===========================================================================
test('G-4: PostAcceptanceEffectInput is authority-only (no legacy material selectors)', () => {
  const src = readFile('src/process-modules/application/post-acceptance-effects.ts');
  assert.match(src, /readonly authority: AcceptedCandidateAuthority/, 'authority field present');
  assert.doesNotMatch(src, /readonly operational: \{/, 'effect input has no secondary selector bag');
  // No top-level legacy material selectors on the input.
  assert.doesNotMatch(src, /readonly expectedProductSchema: string;/, 'no expectedProductSchema on input');
});

// ===========================================================================
// G-7 — replay-capture resolves the gate decision by exact key, not recency.
// ===========================================================================
test('G-7: replay-capture resolves gate decision by exact decision_key (no decided_at recency)', () => {
  const src = readFile('src/infrastructure/replay/replay-capture-effect.ts');
  assert.match(src, /WHERE decision_key=\?/, 'exact decision_key lookup');
  assert.match(src, /input\.authority\.gateDecisionKey/, 'bound to authority.gateDecisionKey');
  assert.doesNotMatch(src, /order by decided_at/i, 'no decided_at recency in replay-capture');
});

// ===========================================================================
// G-3 / G-5 / G-6 — verified by their dedicated test files (referenced here):
//   G-3 partition invariance  → tests/infrastructure/candidate-set-revision-authority.test.mjs (B-2 convergence test)
//   G-5 obligation atomicity  → tests/infrastructure/candidate-set-revision-authority.test.mjs (B-8 atomicity tests)
//   G-6 workshop parity       → tests/architecture/adr-053-cutover-gates.test.mjs (Gate 7)
// G-8/G-9/G-10 require a factory-idle lifecycle/canary run (gated separately).
// ===========================================================================
test('G-3/G-5/G-6: dedicated verifying test files exist (in-memory); G-8/G-9/G-10 are lifecycle/canary', () => {
  const exists = rel => { try { statSync(path.join(REPO_ROOT, rel)); return true; } catch { return false; } };
  assert.ok(exists('tests/infrastructure/candidate-set-revision-authority.test.mjs'), 'G-3/G-5 verifier exists');
  assert.ok(exists('tests/architecture/adr-053-cutover-gates.test.mjs'), 'G-6 verifier exists');
  assert.ok(exists('tests/architecture/adr-053-material-authority-ratchet.test.mjs'), 'G-1 ratchet exists');
});
