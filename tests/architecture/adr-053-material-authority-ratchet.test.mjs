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
// BASELINE (captured 2026-08-11 on saga4, Phase 0; lowered Phase 7; ZEROED Phase 7 replay cutover):
//   latestCandidate           : 0  (Phase 7 removed all calls + definition;
//                                   post-acceptance reads from CellFinalAcceptance)
//   ORDER BY sealed_at DESC   : 0  (Phase 7 replay cutover: all 3 replay paths now
//                                   resolve accepted author set by gate-decision ref)
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
  latestCandidate: 0,
  orderBySealedAtDesc: 0,
  // ADR-053 B-6 — gate-decision recency: selecting "the latest accepted gate
  // decision" for a workplace by decided_at. Post-seal, the accepted gate
  // decision must be resolved by its exact decision_key (authority.
  // gateDecisionKey), NOT by recency. B-6 is now a clean-break zero inventory.
  orderByDecidedAtDesc: 0,
  postSealDescendingWinner: 0,
});

const POST_SEAL_AUTHORITY_FILES = Object.freeze([
  'src/modules/discovery/application/discovery-check-providers.ts',
  'src/modules/discovery/application/discovery-production-cell-installation.ts',
  'src/process-modules/application/review-verdict-check-provider.ts',
  'src/infrastructure/verification/local-runnability-check-provider.ts',
  'src/modules/development/infrastructure/sqlite-development-settlement-state.ts',
  'src/infrastructure/replay/replay-claim-binder.ts',
  'src/infrastructure/replay/sqlite-replay-capsule-repository.ts',
  'src/infrastructure/replay/capsule-replay-executor.ts',
  'src/tools/products.ts',
]);

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
// Ratchet 3 — ORDER BY decided_at DESC (gate-decision recency). [ADR-053 B-6]
// ===========================================================================
test('ADR-053 B-6 ratchet: ORDER BY decided_at DESC count must not exceed baseline', () => {
  const files = collectFiles();
  const sites = [];
  let total = 0;
  for (const { rel, abs } of files) {
    const src = stripComments(readFileSync(abs, 'utf8'));
    const lower = src.toLowerCase();
    const n = countOccurrences(lower, 'decided_at desc');
    if (n > 0) {
      total += n;
      sites.push(`${rel} (${n})`);
    }
  }
  assert.ok(
    total <= BASELINE.orderByDecidedAtDesc,
    `ADR-053 B-6 ratchet REGRESSION: 'ORDER BY ... decided_at DESC' count increased to ` +
      `${total} (baseline ${BASELINE.orderByDecidedAtDesc}). This SQL selects the accepted ` +
      `gate decision by recency — a post-seal 'latest' authority that ADR-053 forbids. ` +
      `Each must be replaced with an exact gateDecisionKey lookup (B-9). If you intentionally ` +
      `REMOVED occurrences, LOWER the BASELINE.orderByDecidedAtDesc constant — never raise it. ` +
      `Current sites:\n  - ${sites.join('\n  - ')}`,
  );
});

// ===========================================================================
// Ratchet 4 — TASK-SHADOW removal pins (SM-14/MM-3 + F1/F2/F3 follow-up).
// The task-shadow fix DELETED the `readTaskForWorkplace` port (newest task
// row of a workplace) and the two `ORDER BY id DESC LIMIT 1` task reads in
// src/app/engine-start-adoption.ts. Both selected the workplace's NEWEST
// task row: in a multi-task singleton workplace (author + reviewer
// generations) that bound crash-attempt accounting, scope widening and
// engine-start repair to the WRONG (neighbor/superseded) card. The role task
// must resolve through the exact-key read (`readProjectedRoleTask`: stable
// author key; reviewer key = exact CURRENT subject_candidate_set_ref from the
// accepted-author authority head). These pins fail on ANY reintroduction
// anywhere under src/ — including src/app, which the Phase-0 ratchets above
// did not cover.
// ===========================================================================
test('TASK-SHADOW ratchet: the readTaskForWorkplace port stays deleted in src/', () => {
  const files = collectFiles();
  const sites = [];
  let total = 0;
  for (const { rel, abs } of files) {
    const src = stripComments(readFileSync(abs, 'utf8'));
    const n = countOccurrences(src, 'readTaskForWorkplace');
    if (n > 0) {
      total += n;
      sites.push(`${rel} (${n})`);
    }
  }
  assert.equal(
    total,
    0,
    `TASK-SHADOW REGRESSION: 'readTaskForWorkplace' reappeared under src/ `
      + `(${sites.join(', ')}). That port selected the workplace's NEWEST task row; `
      + `resolve the role task through the exact-key readProjectedRoleTask `
      + `(stable author key; reviewer key = exact CURRENT `
      + `subject_candidate_set_ref from the accepted-authority head) instead.`,
  );
});

// TASK-SHADOW L1 (2026-08-24) — the newest-wins pin below originally matched
// only the EXACT retired spelling (`FROM tasks WHERE workplace_ref=? ORDER BY
// id DESC LIMIT 1`). Equivalent task-selection chronology could evade by
// trivially re-spelling the selector. The detector now covers the audited
// evasion shapes while staying scoped to TASK selection by workplace:
//   (a) MAX(id)/MAX(rowid) aggregates (scalar subquery or plain aggregate);
//   (b) ORDER BY created_at/updated_at/rowid DESC (any task-row chronology
//       column, not just id);
//   (c) ORDER BY <col> DESC with NO LIMIT — the caller takes the first row
//       of the result set (`.get()`), same newest-wins semantics;
//   (d) predicate/alias formatting — `workplace_ref = ?`, `t.workplace_ref`,
//       JOIN ... ON workplace_ref, extra predicates between FROM and ORDER
//       BY, `tasks AS t`, quoted identifiers, secondary sort keys
//       (`ORDER BY sort_order, id DESC`).
// Scope guard (what must NOT fire): chronology over NON-task columns (an
// execution-attempt frontier inside an already-exact task, e.g.
// `ORDER BY we.reserved_at DESC`), exact append-frontiers keyed by a logical
// key other than the workplace (e.g. `WHERE generation_key=? ORDER BY id
// DESC LIMIT 1`), ascending full-chain reads, and workplace-UNSCOPED
// newest-first operator listings. These stay classified/legal.
const SQL_KEYWORDS = new Set([
  'where', 'group', 'order', 'join', 'left', 'inner', 'outer', 'right', 'on',
  'using', 'limit', 'union', 'set', 'values', 'having', 'as', 'cross',
  'natural', 'full',
]);

function detectNewestWinsTaskSelections(src) {
  const findings = [];
  const fromTasks = /\bfrom\s+["'`[]?tasks["'`\]]?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
  for (const match of src.matchAll(fromTasks)) {
    const rawAlias = (match[1] ?? '').toLowerCase();
    const alias = rawAlias && !SQL_KEYWORDS.has(rawAlias) ? rawAlias : null;
    const afterStart = match.index + match[0].length;
    const after = src.slice(afterStart, afterStart + 420);
    // Task selection BY WORKPLACE: the workplace predicate (WHERE/JOIN ON)
    // must follow the tasks reference.
    if (!/workplace_ref/i.test(after)) continue;
    const qualifiedOrder = /(?:order\s+by|,)\s*([a-z_][a-z0-9_]*)\s*\.\s*(id|rowid|created_at|updated_at)\s+desc/i.exec(after);
    const bareOrder = /(?:order\s+by|,)\s*(id|rowid|created_at|updated_at)\s+desc/i.exec(after);
    if (qualifiedOrder ?? bareOrder) {
      // A qualified column of a DIFFERENT table is not task-row chronology
      // (e.g. `ORDER BY we.reserved_at DESC` — an execution frontier).
      const qualifier = qualifiedOrder ? qualifiedOrder[1].toLowerCase() : null;
      if (!qualifier || qualifier === 'tasks' || qualifier === alias) {
        findings.push(
          `${src.slice(match.index, Math.min(src.length, afterStart + 200)).replace(/\s+/gu, ' ').trim()}`,
        );
      }
    }
    // MAX(id)/MAX(rowid) directly before `FROM tasks` (aggregate select list
    // or scalar subquery head): `SELECT MAX(id) FROM tasks WHERE workplace_ref=?`.
    const before = src.slice(Math.max(0, match.index - 120), match.index);
    const qualifiedMax = /max\s*\(\s*(?:distinct\s+)?([a-z_][a-z0-9_]*)\s*\.\s*(id|rowid)\s*\)/i.exec(before);
    const bareMax = /max\s*\(\s*(?:distinct\s+)?(id|rowid)\s*\)/i.exec(before);
    if (qualifiedMax ?? bareMax) {
      const qualifier = qualifiedMax ? qualifiedMax[1].toLowerCase() : null;
      if (!qualifier || qualifier === 'tasks' || qualifier === alias) {
        findings.push(
          `${src.slice(Math.max(0, match.index - 120), Math.min(src.length, afterStart + 120)).replace(/\s+/gu, ' ').trim()}`,
        );
      }
    }
  }
  return findings;
}

test('TASK-SHADOW ratchet: no newest-wins workplace task selection in src/ (audited evasion shapes included)', () => {
  const files = collectFiles();
  const sites = [];
  for (const { rel, abs } of files) {
    const src = stripComments(readFileSync(abs, 'utf8'));
    for (const finding of detectNewestWinsTaskSelections(src)) {
      sites.push(`${rel}: ${finding}`);
    }
  }
  assert.equal(
    sites.length,
    0,
    `TASK-SHADOW REGRESSION: a newest-wins workplace task read reappeared `
      + `under src/ (src/app included — F3; MAX(id), non-id chronology columns, `
      + `LIMIT-less first-row reads and predicate re-formatting included — L1). `
      + `Resolve the CURRENT role's task through the exact-key `
      + `readProjectedRoleTask; chronology must never select the task a `
      + `budget/repair/widening binds to:\n  - ${sites.join('\n  - ')}`,
  );
});

test('TASK-SHADOW ratchet: the newest-wins detector catches every audited evasion shape and spares the classified-legal ones', () => {
  // Mutation fixtures — each audited evasion spelling MUST fire. These are
  // permanent: a future weakening of the detector (e.g. restoring an
  // exact-literal regex) fails here even when src/ itself is clean.
  const evasions = [
    ['retired exact spelling', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1`'],
    ['MAX(id) aggregate', '`SELECT MAX(id) AS id FROM tasks WHERE workplace_ref=?`'],
    ['qualified MAX(t.id)', "`SELECT MAX(t.id) FROM tasks AS t WHERE t.workplace_ref = ?`"],
    ['scalar-subquery MAX(id)', "`SELECT ... FROM x WHERE id=(SELECT MAX(id) FROM tasks WHERE workplace_ref=?)`"],
    ['ORDER BY created_at DESC LIMIT 1', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY created_at DESC LIMIT 1`'],
    ['ORDER BY updated_at DESC LIMIT 1', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY updated_at DESC LIMIT 1`'],
    ['ORDER BY rowid DESC LIMIT 1', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY rowid DESC LIMIT 1`'],
    ['ORDER BY id DESC then first row (no LIMIT)', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC`'],
    ['predicate formatting + alias + extra predicates', "`SELECT t.id FROM tasks AS t WHERE t.workplace_ref = ? AND json_extract(t.metadata,'$.role')='author' ORDER BY t.id DESC LIMIT 1`"],
    ['JOIN-scoped workplace predicate', '`SELECT t.id FROM tasks t JOIN factory_workplaces w ON w.workplace_ref=t.workplace_ref ORDER BY t.id DESC LIMIT 1`'],
    ['secondary sort key DESC', '`SELECT id FROM tasks WHERE workplace_ref=? ORDER BY sort_order, id DESC`'],
    ['lowercase sql', "`select id from tasks where workplace_ref=? order by id desc limit 1`"],
  ];
  for (const [name, sql] of evasions) {
    assert.ok(
      detectNewestWinsTaskSelections(sql).length >= 1,
      `evasion shape must be caught: ${name}`,
    );
  }
  // Classified-legal shapes must NOT fire (scope guard — see the block
  // comment above): exact append-frontiers and non-task chronology stay out.
  const legal = [
    ['exact generation_key append frontier (no workplace chronology)', '`SELECT id FROM tasks WHERE generation_key=? ORDER BY id DESC LIMIT 1`'],
    ['execution-attempt frontier inside the exact author task', "`FROM tasks t JOIN worker_executions we ON we.task_id=t.id WHERE t.workplace_ref=? AND json_extract(t.metadata,'$.role')='author' ORDER BY we.reserved_at DESC,we.execution_id DESC LIMIT 1`"],
    ['ascending full-chain read', '`FROM tasks t JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref ORDER BY t.id`'],
    ['ascending single-read tiebreak', "`SELECT t.id FROM tasks t WHERE t.workplace_ref=? AND json_extract(t.metadata,'$.role')='author' ORDER BY t.id LIMIT 1`"],
    ['workplace-unscoped newest-first operator listing', '`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50`'],
    ['workplace projection without chronology', '`SELECT id FROM tasks WHERE workplace_ref=?`'],
  ];
  for (const [name, sql] of legal) {
    assert.deepEqual(
      detectNewestWinsTaskSelections(sql),
      [],
      `classified-legal shape must not fire: ${name}`,
    );
  }
});

// ===========================================================================
// Inventory snapshot — documents the known post-seal-authority defect sites
// from the Phase 0 inventory. This test does not gate on the full list (some
// patterns are hard to distinguish statically from provenance/pre-seal uses);
// it exists so the inventory is versioned alongside the ratchet and reviewers
// can see exactly what the cutover must remove. Update as Phases 5–7 land.
// ===========================================================================
test('ADR-053 B-6 ratchet: sealed-authority consumers have no descending LIMIT-1 winner', () => {
  const sites = [];
  const winner = /order\s+by[\s\S]{0,240}?\bdesc\b[\s\S]{0,120}?limit\s+1/giu;
  for (const rel of POST_SEAL_AUTHORITY_FILES) {
    const source = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    const matches = source.match(winner) ?? [];
    for (const match of matches) sites.push(`${rel}: ${match.replace(/\s+/gu, ' ').trim()}`);
  }
  assert.equal(
    sites.length,
    BASELINE.postSealDescendingWinner,
    `ADR-053 B-6 regression: a sealed-authority consumer selects a winner by recency/order:\n  - ${sites.join('\n  - ')}`,
  );
});

test('ADR-053 B-6 ratchet: reviewer projection resolves author semantics from the exact authority head', () => {
  const source = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src/app/product-lifecycle-runtime.ts'),
    'utf8',
  ));
  const start = source.indexOf('readAuthorSemanticDigestForWorkplace:');
  const end = source.indexOf('activateRoleTask:', start);
  assert.ok(start >= 0 && end > start, 'reviewer semantic-input authority region exists');
  const region = source.slice(start, end);
  assert.match(region, /factory_accepted_authority_head/gu);
  assert.match(region, /accepted_author_task_id/gu);
  assert.doesNotMatch(region, /order\s+by|limit\s+1/giu);
});

test('ADR-053 B-6 ratchet: candidate_read never treats singleton cardinality as acceptance', () => {
  const source = stripComments(readFileSync(path.join(REPO_ROOT, 'src/tools/products.ts'), 'utf8'));
  assert.doesNotMatch(source, /sets\.length\s*===\s*1/gu);
  assert.match(source, /CANDIDATE_SET_AUTHORITY_REQUIRED/gu);
});

test('ADR-053 Phase 0 inventory: post-seal-authority defect sites are documented', () => {
  const inventory = [
    // A. Gate check providers selecting by execution_id / latest.
    // [FIXED] development-check-providers.ts — all 3 sites now resolve by productRef
    // [FIXED] discovery-check-providers.ts — producerSubmission resolves by member digest
    'src/modules/development/application/development-check-providers.ts:191 — [FIXED] task-graph check now resolves by productRef (was execution_id)',
    'src/modules/discovery/application/discovery-check-providers.ts:84 — readiness check latest proposal by node_id',
    'src/modules/discovery/application/discovery-check-providers.ts:131 — [FIXED] producerSubmission now resolves by member digest (was execution_id)',
    'src/process-modules/application/submission-validator-check-provider.ts:67 — artifact productions by execution_id (provenance check)',
    'src/process-modules/application/submission-validator-check-provider.ts:75 — trace productions by execution_id (provenance check)',
    // B. Post-acceptance effect execution_id fallback.
    'src/modules/formalization/application/formalization-accept-products-effect.ts:65 — [FIXED] execution_id fallback DELETED',
    // C. Settlement/kernel readSubmission by execution_id.
    'src/modules/discovery/application/discovery-production-cell-installation.ts:86,92,311 — [FIXED] readSubmission now resolves by productRef.digest (was execution_id)',
    // D. latestCandidate / ORDER BY sealed_at DESC — ALL ELIMINATED.
    'src/process-modules/application/node-executors/production-cell-node-executor.ts — [FIXED] latestCandidate=0 (all calls removed)',
    'src/infrastructure/workplace/sqlite-candidate-set-repository.ts:188 — [FIXED] listForWorkplace uses candidate_set_ref DESC (not sealed_at)',
    'src/infrastructure/replay/replay-authority-rebinder.ts:74 — [FIXED] resolves by gate-decision subject_candidate_set_ref',
    'src/infrastructure/replay/replay-claim-binder.ts:143 — [FIXED] resolves by gate-decision subject_candidate_set_ref',
    'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:384 — [FIXED] resolves by gate-decision subject_candidate_set_ref',
    'src/modules/development/infrastructure/sqlite-development-settlement-state.ts:580,590 — [FIXED] now JOINs factory_cell_final_acceptances for exact accepted author set',
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
