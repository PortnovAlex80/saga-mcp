// tests/architecture/adr-053-material-authority-ratchet.test.mjs
//
// ADR-053 CUTOVER — Phase 0 ratchet.
//
// ADR-053 (docs/architecture/decisions/
//   053-workplace-production-revision-as-accepted-material-authority.md)
// establishes that after a CandidateSet is sealed, NO material consumer may
// select accepted material by execution_id, task_id, node_id, or "latest".
// The sole post-seal authority must be an exact sealed
// WorkplaceProductionRevision / CandidateSet / ProductRef.
//
// This ratchet captures the BASELINE count of the two cleanest post-seal-
// authority anti-patterns observed in the Phase 0 inventory and FAILS if that
// count INCREASES. As Phases 5–7 of the cutover replace these lookups with
// exact-revision reads, the baseline is LOWERED (never raised). A raise is a
// regression: someone reintroduced execution-scoped / latest material
// authority.
//
// Tracked anti-patterns (whole src/ tree, comment-stripped):
//
//   1. `latestCandidate` — the helper that selects the newest CandidateSet for
//      a workplace+role (production-cell-node-executor.ts). Every call site is
//      a post-seal "pick the most recent batch" decision. The cutover replaces
//      each with an exact sealed revision / accepted CandidateSet ref.
//
//   2. `ORDER BY sealed_at DESC` — SQL that orders CandidateSets by recency to
//      pick "the latest one". Appears in candidate-set, replay-capsule,
//      replay-claim-binder and replay-authority-rebinder repositories. The
//      cutover replaces each with an exact-ref lookup.
//
// BASELINE (captured 2026-08-11 on saga4, Phase 0):
//   latestCandidate           : 5  (4 call sites + 1 definition)
//   ORDER BY sealed_at DESC   : 4
//
// These numbers MUST only go DOWN as the cutover proceeds. To lower a
// baseline, remove real occurrences in the cutover phase that owns that path
// (Phase 5 for CandidateSet, Phase 6 for effects, Phase 7 for settlement/
// replay) and update the constant here in the SAME commit.
//
// This ratchet is INTENTIONALLY complementary to
// no-execution-scoped-lookup.test.mjs (which bans listArtifactsForExecution /
// listTracesForExecution) and the CGAD P18 execution-scoped .filter guard.
// Those cover the Wave 6 managed-production cutover; this one covers the
// ADR-053 CandidateSet/revision authority cutover.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// Baselines — LOWER ONLY, never raise. See file header.
// ---------------------------------------------------------------------------
const BASELINE = Object.freeze({
  latestCandidate: 5,
  orderBySealedAtDesc: 4,
});

// ---------------------------------------------------------------------------
// File discovery — every .ts file under src/ (recursive).
// ---------------------------------------------------------------------------
function listTypeScriptFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listTypeScriptFiles(abs));
    } else if (st.isFile() && entry.endsWith('.ts')) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      out.push({ rel, abs });
    }
  }
  return out;
}

// Strip line + block comments so documentation prose does not false-positive.
function stripComments(src) {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  return out;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function collectFiles() {
  const files = listTypeScriptFiles(SRC_ROOT);
  assert.ok(files.length > 0, 'discovered .ts files under src/');
  return files;
}

// ===========================================================================
// Ratchet 1 — latestCandidate (newest-CandidateSet selection helper).
// ===========================================================================
test('ADR-053 Phase 0 ratchet: latestCandidate occurrence count must not exceed baseline', () => {
  const files = collectFiles();
  const sites = [];
  let total = 0;
  for (const { rel, abs } of files) {
    const src = stripComments(readFileSync(abs, 'utf8'));
    const n = countOccurrences(src, 'latestCandidate');
    if (n > 0) {
      total += n;
      sites.push(`${rel} (${n})`);
    }
  }
  assert.ok(
    total <= BASELINE.latestCandidate,
    `ADR-053 ratchet REGRESSION: 'latestCandidate' count increased to ${total} ` +
      `(baseline ${BASELINE.latestCandidate}). This helper selects the newest ` +
      `CandidateSet by recency — a post-seal 'latest' authority that ADR-053 ` +
      `forbids. Every call site must be replaced with an exact sealed ` +
      `revision / accepted CandidateSet ref (cutover Phases 5–7). If you ` +
      `intentionally REMOVED occurrences as part of the cutover, LOWER the ` +
      `BASELINE.latestCandidate constant in this file — never raise it. ` +
      `Current sites:\n  - ${sites.join('\n  - ')}`,
  );
});

// ===========================================================================
// Ratchet 2 — ORDER BY sealed_at DESC (recency-based CandidateSet SQL).
// ===========================================================================
test('ADR-053 Phase 0 ratchet: ORDER BY sealed_at DESC count must not exceed baseline', () => {
  const files = collectFiles();
  const sites = [];
  let total = 0;
  // Case-insensitive: SQL may use any casing.
  for (const { rel, abs } of files) {
    const src = stripComments(readFileSync(abs, 'utf8'));
    const lower = src.toLowerCase();
    const n = countOccurrences(lower, 'order by sealed_at desc');
    if (n > 0) {
      total += n;
      sites.push(`${rel} (${n})`);
    }
  }
  assert.ok(
    total <= BASELINE.orderBySealedAtDesc,
    `ADR-053 ratchet REGRESSION: 'ORDER BY sealed_at DESC' count increased to ` +
      `${total} (baseline ${BASELINE.orderBySealedAtDesc}). This SQL selects ` +
      `CandidateSets by recency — a post-seal 'latest' authority that ADR-053 ` +
      `forbids. Each must be replaced with an exact-ref lookup (cutover ` +
      `Phases 5–7). If you intentionally REMOVED occurrences, LOWER the ` +
      `BASELINE.orderBySealedAtDesc constant — never raise it. ` +
      `Current sites:\n  - ${sites.join('\n  - ')}`,
  );
});

// ===========================================================================
// Inventory snapshot — documents the known post-seal-authority defect sites
// from the Phase 0 inventory. This test does not gate on the full list (some
// patterns are hard to distinguish statically from provenance/pre-seal uses);
// it exists so the inventory is versioned alongside the ratchet and reviewers
// can see exactly what the cutover must remove. Update as Phases 5–7 land.
// ===========================================================================
test('ADR-053 Phase 0 inventory: post-seal-authority defect sites are documented', () => {
  const inventory = [
    // A. Gate check providers selecting by execution_id / latest.
    'src/modules/development/application/development-check-providers.ts:191 — task-graph check latest submission by execution_id',
    'src/modules/discovery/application/discovery-check-providers.ts:84 — readiness check latest proposal by node_id',
    'src/modules/discovery/application/discovery-check-providers.ts:131 — producerSubmission latest by execution_id',
    'src/process-modules/application/submission-validator-check-provider.ts:67 — artifact productions by execution_id',
    'src/process-modules/application/submission-validator-check-provider.ts:75 — trace productions by execution_id',
    // B. Post-acceptance effect execution_id fallback.
    'src/modules/formalization/application/formalization-accept-products-effect.ts:65 — managed_artifact_productions fallback by execution_id',
    // C. Settlement/kernel readSubmission by execution_id.
    'src/modules/discovery/application/discovery-production-cell-installation.ts:86,92,311 — readSubmission by execution_id ORDER BY id DESC',
    // D. latestCandidate / ORDER BY sealed_at DESC (covered by ratchets above).
    'src/process-modules/application/node-executors/production-cell-node-executor.ts:372,505,714,981,993 — latestCandidate helper + 4 call sites',
    'src/infrastructure/workplace/sqlite-candidate-set-repository.ts:188 — listForWorkplace ORDER BY sealed_at DESC',
    'src/infrastructure/replay/replay-authority-rebinder.ts:74 — latest author set',
    'src/infrastructure/replay/replay-claim-binder.ts:143 — latest author set',
    'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:384 — latest candidate set',
    'src/modules/development/infrastructure/sqlite-development-settlement-state.ts:580,590 — latest author/reviewer per workplace',
    'src/tools/products.ts:148 — candidate_read MCP tool selects latest by role',
  ];
  // Sanity: the inventory is non-empty and each entry names a real file path
  // prefix (not a full line check — paths drift during the cutover, which is
  // the point). This keeps the inventory honest without making it brittle.
  assert.ok(inventory.length >= 14, 'inventory lists the known defect sites');
  for (const entry of inventory) {
    const filePrefix = entry.split(' — ')[0].split(':')[0];
    assert.ok(
      filePrefix.startsWith('src/'),
      `inventory entry references a src/ path: ${entry}`,
    );
  }
});
