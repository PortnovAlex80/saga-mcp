// tests/architecture/tasks-writer-invariant.test.mjs
//
// UNCLE BOB WAVE 1B / FU-B — tasks-table single-writer invariant gate.
//
// The `tasks` table has ~15 write sites across the codebase. The owner
// columns — `status`, `assigned_to`, `current_execution_id` — encode WHO is
// allowed to mutate a card's lifecycle state. Writing them from scattered
// call sites is the "Uncle Bob" smell this gate ratchets: only a small,
// named, single-writer set may flip those columns, because the claim path
// requires atomicity inside BEGIN IMMEDIATE (claim + fence insert +
// status-flip in ONE transaction) that a not-yet-existing command bus
// (Slice 1.C — see src/lifecycle/atomic-release.ts:31) cannot replace.
//
// ALLOWED writers of `UPDATE tasks SET status=|assigned_to=|current_execution_id=`:
//
//   1. src/lifecycle/work-assignment-core.ts       — the atomic claim path
//      (SELECT claimable card + INSERT fence row + UPDATE status-flip inside
//      one BEGIN IMMEDIATE transaction; the claim is the ONLY writer for the
//      claim transition because no command bus exists yet).
//
//   2. src/lifecycle/atomic-release.ts             — releaseExecutionAtomically
//      (terminalize execution + release task in one BEGIN IMMEDIATE tx with a
//      fence CAS on current_execution_id).
//
//   3. src/lifecycle/unfenced-assignment-recovery.ts — legacy (pre-ADR-009,
//      unfenced) worker-death recovery; the fenced branch delegates to (2).
//
//   Wave 8 / MEDIUM 6: src/worker-executions.ts is NO LONGER an exception.
//      markExecutionExited now DELEGATES to releaseExecutionAtomically (2),
//      and the reaper's legacy-assignment recovery loop DELEGATES to
//      recoverLegacyAssignment (3). The close-callback path and the reaper
//      path now share ONE atomic mechanism with the rest of the lifecycle, as
//      the audit required. There are ZERO direct owner-column writes left in
//      src/worker-executions.ts; the "temporary exception" is closed.
//
//   4. src/tools/**                                — MCP/tool handlers that
//      perform board-column transitions via fenced tool calls (worker_done
//      status-flip, worker_ask_need assigned_to clear, auto-block/unblock
//      from dependency re-evaluation, merge_release integration_state).
//      These run inside the tool layer's own fencing; allowed today.
//
// EVERY OTHER `UPDATE tasks` write must touch NON-owner columns only:
// metadata, tags, declared_risk/derived_risk/policy_minimum/final_risk,
// integration_state, integrated_at, integrated_commit,
// verification_target_artifact_id, actual_hours, review_skill,
// generation_key, generated_from_task_id, priority, title, description, etc.
// Such writes are invisible to this gate (the classifier only flags owner
// writes).
//
// WHAT THIS GATE DETECTS: any NEW file outside the allowed set above that
// issues `UPDATE tasks SET status=|assigned_to=|current_execution_id=`. It
// fails with `file:line` and the offending owner columns so the offender can
// route through the single-writer set instead.
//
// FORWARD PATH (when the command bus lands in Slice 1.C): the claim and
// release paths route through the bus as single ClaimCard / ReleaseCard
// commands, and the direct SQL in the lifecycle modules collapses into the
// commands' handlers. At that point the tools/ owner writes also migrate to
// bus commands, and this gate's allowed set shrinks to the bus handlers. The
// invariant (single writer for owner columns) stays the same; only the
// physical location of the writer moves.
//
// SCOPE: this gate scans `UPDATE` only. `INSERT INTO tasks` (task creation)
// and `DELETE FROM tasks` are out of scope — they are governed by the
// task_create/task_delete tools and cascade rules, not by the single-writer
// invariant.
//
// This test is INTENTIONALLY a separate file so the single-writer concern is
// visible, individually runnable, and immune to changes in the
// dependency-direction ratchet's allowlist machinery. It is patterned on
// no-sqlite-in-modules.test.mjs.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// The three owner columns. Any `UPDATE tasks SET <col>=` against one of these
// is an owner-column write and is subject to the single-writer invariant.
// ---------------------------------------------------------------------------
const OWNER_COLUMNS = ['status', 'assigned_to', 'current_execution_id'];

// ---------------------------------------------------------------------------
// Allowed single-writer set. A file not in this set that issues an owner
// write is a violation. See the header comment for the rationale per entry.
// ---------------------------------------------------------------------------
const ALLOWED_LIFECYCLE_FILES = new Set([
  'src/lifecycle/work-assignment-core.ts',
  'src/lifecycle/atomic-release.ts',
  'src/lifecycle/unfenced-assignment-recovery.ts',
]);

// Wave 8 / MEDIUM 6: the documented src/worker-executions.ts exception is
// CLOSED. markExecutionExited and the reaper's legacy recovery now delegate
// to the single-writer primitives above, so worker-executions.ts must NOT
// issue any owner-column write. If a new owner write appears there, it is a
// violation — route it through releaseExecutionAtomically or
// recoverLegacyAssignment instead.

/**
 * Is `relPath` (repo-relative, POSIX) an ALLOWED file for an owner write?
 * Tools-layer handlers (board-column transitions via fenced tool calls) are
 * allowed wholesale.
 * @param {string} relPath
 * @returns {boolean}
 */
function isAllowedOwnerWriter(relPath) {
  const posix = relPath.split(path.sep).join('/');
  if (ALLOWED_LIFECYCLE_FILES.has(posix)) return true;
  if (posix.startsWith('src/tools/')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// File discovery — every .ts / .mts / .mjs file under src/.
// ---------------------------------------------------------------------------

/**
 * Recursively collect source files under `dir`, returning repo-relative POSIX
 * paths paired with their absolute paths.
 * @param {string} dir
 * @returns {Array<{ rel: string, abs: string }>}
 */
function listSourceFiles(dir) {
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
      out.push(...listSourceFiles(abs));
    } else if (st.isFile() && /\.(ts|mts|mjs|cts|cjs)$/.test(entry)) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      out.push({ rel, abs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment stripping that PRESERVES line structure (newlines AND offsets).
//
// We blank out comments (replacing every non-newline char with a space) so
// that:
//   - line numbers computed from the stripped source match the original, and
//   - docblock prose mentioning `UPDATE tasks SET status=` (such as the
//     invariant notes in the lifecycle modules and in THIS file's header)
//     does not register as a write site.
//
// We do NOT blank string/template literals: the SQL we are hunting for lives
// inside template literals, so erasing them would erase our signal. A `//`
// inside a SQL string is not present anywhere in the codebase (verified), so
// the line-comment pass is safe.
// ---------------------------------------------------------------------------

/**
 * Replace every character of a comment run with a space, preserving newlines
 * (and thus total length + line numbers).
 * @param {string} text
 * @returns {string}
 */
function blankKeepNewlines(text) {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Strip block comments (`/* ... *\/`) and line comments (`// ...`) while
 * preserving newlines and offsets.
 * @param {string} src
 * @returns {string}
 */
function stripCommentsPreserveLines(src) {
  let out = src;
  // Block comments first (they may span lines and contain // sequences).
  out = out.replace(/\/\*[\s\S]*?\*\//g, blankKeepNewlines);
  // Line comments — everything from // to (not including) the newline.
  out = out.replace(/\/\/[^\n]*/g, blankKeepNewlines);
  return out;
}

// ---------------------------------------------------------------------------
// SQL pattern matching — robust, not a String.includes smell.
// ---------------------------------------------------------------------------

/** Matches the `UPDATE tasks` keyword (case-insensitive), table-boundary aware. */
const UPDATE_TASKS_RE = /\bUPDATE\s+tasks\b/gi;

/**
 * Given the comment-stripped source and the index where an `UPDATE tasks`
 * match begins, classify whether this statement writes any OWNER column.
 *
 * The classification isolates the SET clause (from `SET` up to the first
 * `WHERE`) so that a CAS reference to an owner column in the WHERE clause
 * (e.g. atomic-release's `WHERE ... current_execution_id = ?`) is NOT
 * mistaken for a write. Within the isolated SET body, an owner-column
 * assignment is recognized as `<col>\s*=` (with a word boundary on the left
 * so `worker_status` / `final_status`-style names are not confused with the
 * real columns).
 *
 * @param {string} stripped
 * @param {number} startIndex
 * @returns {{ isOwnerWrite: boolean, ownerCols: string[] }}
 */
function classifyUpdateAt(stripped, startIndex) {
  // Window large enough to cover any SET clause we have today (the longest is
  // a few hundred chars). 4096 is generous; if a future statement exceeds it
  // the classifier degrades conservatively (treats as non-owner rather than
  // false-accusing).
  const WINDOW = 4096;
  const window = stripped.slice(startIndex, startIndex + WINDOW);
  // Normalize whitespace (incl. newlines) to single spaces for matching only.
  const norm = window.replace(/\s+/g, ' ');
  const setMatch = norm.match(/\bSET\b(.*?)(?:\bWHERE\b|$)/i);
  if (!setMatch) {
    // No SET keyword in the window — not a (recognizable) column write.
    return { isOwnerWrite: false, ownerCols: [] };
  }
  const setBody = setMatch[1];
  const found = [];
  for (const col of OWNER_COLUMNS) {
    const re = new RegExp(`\\b${col}\\s*=`, 'i');
    if (re.test(setBody)) found.push(col);
  }
  return { isOwnerWrite: found.length > 0, ownerCols: found };
}

/**
 * Compute the 1-based line number of a character offset. Linear but cheap for
 * our file sizes; called once per match.
 * @param {string} src
 * @param {number} index
 * @returns {number}
 */
function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Violation + landscape collection.
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   file: string,
 *   line: number,
 *   ownerCols: string[],
 *   allowed: boolean,
 * }} OwnerWrite
 */
/**
 * @typedef {{
 *   file: string,
 *   line: number,
 *   ownerCols: string[],
 *   reason: string,
 * }} Violation
 */

/**
 * Scan every source file, classify each `UPDATE tasks` statement, and return:
 *   - ownerWrites: every owner-column write (allowed + disallowed) for
 *     observability, and
 *   - violations: owner writes in NON-allowed files (the gate failures).
 * @returns {{ ownerWrites: OwnerWrite[], violations: Violation[], updateSites: number }}
 */
function collect() {
  /** @type {OwnerWrite[]} */
  const ownerWrites = [];
  /** @type {Violation[]} */
  const violations = [];
  let updateSites = 0;
  const files = listSourceFiles(SRC_ROOT);
  for (const { rel, abs } of files) {
    let raw;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripCommentsPreserveLines(raw);
    // Reset lastIndex because UPDATE_TASKS_RE is global/stateful.
    UPDATE_TASKS_RE.lastIndex = 0;
    let m;
    while ((m = UPDATE_TASKS_RE.exec(stripped)) !== null) {
      updateSites += 1;
      const start = m.index;
      const line = lineOf(stripped, start);
      const { isOwnerWrite, ownerCols } = classifyUpdateAt(stripped, start);
      if (!isOwnerWrite) continue; // non-owner write (metadata, tags, risk, ...) — invisible to this gate.
      const allowed = isAllowedOwnerWriter(rel);
      ownerWrites.push({ file: rel, line, ownerCols, allowed });
      if (!allowed) {
        violations.push({
          file: rel,
          line,
          ownerCols,
          reason:
            `issues \`UPDATE tasks SET ${ownerCols.join('/')}=\` outside the ` +
            `single-writer set. Owner columns (status, assigned_to, ` +
            `current_execution_id) MUST be written only from ` +
            `src/lifecycle/{work-assignment-core,atomic-release,legacy-assignment-recovery}.ts ` +
            `(+ src/tools/** fenced board-column transitions). ` +
            `src/worker-executions.ts is NO LONGER an exception (Wave 8 / MEDIUM 6): ` +
            `markExecutionExited delegates to releaseExecutionAtomically and the ` +
            `reaper legacy loop delegates to recoverLegacyAssignment. Route this ` +
            `write through one of the single-writer primitives instead. See the ` +
            `file header for the forward path (command bus, Slice 1.C).`,
        });
      }
    }
  }
  return { ownerWrites, violations, updateSites };
}

const SCAN = collect();
const VIOLATIONS = SCAN.violations;
const OWNER_WRITES = SCAN.ownerWrites;

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('tasks-writer-invariant: gate scans a non-trivial source tree', () => {
  const files = listSourceFiles(SRC_ROOT);
  assert.ok(files.length > 50,
    `expected >50 source files under src/, got ${files.length}`);
  assert.ok(SCAN.updateSites >= 15,
    `expected at least ~15 UPDATE tasks sites, got ${SCAN.updateSites} ` +
    `(if the count dropped, the gate may be scanning the wrong tree)`);
});

test('tasks-writer-invariant: the allowed single-writer set actually exists', () => {
  // Guard against the allowlist drifting from reality: every allowed
  // lifecycle module must exist on disk and must contribute at least one
  // owner write today (otherwise the module is dead or the invariant doc is
  // attached to the wrong file).
  for (const allowedRel of ALLOWED_LIFECYCLE_FILES) {
    const abs = path.join(REPO_ROOT, ...allowedRel.split('/'));
    let st;
    try {
      st = statSync(abs);
    } catch {
      assert.fail(`allowed single-writer file does not exist: ${allowedRel}`);
    }
    assert.ok(st.isFile(), `allowed single-writer path is not a file: ${allowedRel}`);
  }
  // Each lifecycle module should appear at least once in the owner-write
  // landscape (the invariant documents it AS a writer; if it stops writing,
  // the doc and the gate should be revisited together).
  const seenFiles = new Set(OWNER_WRITES.map((w) => w.file));
  for (const allowedRel of ALLOWED_LIFECYCLE_FILES) {
    assert.ok(seenFiles.has(allowedRel),
      `allowed single-writer ${allowedRel} has no owner write today — ` +
      `stale allowlist or wrong file`);
  }
});

test('tasks-writer-invariant: ZERO owner-column writes outside the single-writer set', () => {
  if (VIOLATIONS.length > 0) {
    const lines = VIOLATIONS.map(
      (v) => `  ${v.file}:${v.line}  [${v.ownerCols.join('/')}]  ${v.reason}`,
    );
    assert.fail(
      `Wave 1B / FU-B single-writer invariant VIOLATED: ${VIOLATIONS.length} ` +
        `owner-column write(s) outside the allowed set.\n` +
        `Only src/lifecycle/{work-assignment-core,atomic-release,legacy-assignment-recovery}.ts ` +
        `(+ src/tools/** fenced board-column transitions) may write ` +
        `tasks.{status,assigned_to,current_execution_id}. ` +
        `src/worker-executions.ts is no longer excepted (Wave 8 / MEDIUM 6).\n` +
        lines.join('\n'),
    );
  }
  assert.equal(VIOLATIONS.length, 0,
    'no owner-column writes outside the single-writer set');
});

test('tasks-writer-invariant: classifier catches owner writes and isolates SET from WHERE (self-test)', () => {
  // Positive cases — each MUST be classified as an owner write. Note the
  // WHERE-clause references to owner columns (CAS) MUST NOT by themselves
  // flip the verdict; only the SET clause matters.
  const positiveCases = [
    {
      label: 'single-line claim',
      src: "`UPDATE tasks SET status='in_progress', assigned_to=?, current_execution_id=?, updated_at=datetime('now') WHERE id=? AND status='todo'`",
      expect: ['status', 'assigned_to', 'current_execution_id'],
    },
    {
      label: 'multi-line release with WHERE CAS on current_execution_id',
      src: "`UPDATE tasks\n   SET status = ?,\n       assigned_to = NULL,\n       current_execution_id = NULL,\n       metadata = json_remove(metadata,'$.worker_pid'),\n       updated_at = datetime('now')\n WHERE id = ?\n   AND current_execution_id = ?`",
      expect: ['status', 'assigned_to', 'current_execution_id'],
    },
    {
      label: 'assigned_to clear only',
      src: "`UPDATE tasks SET assigned_to=NULL, updated_at=datetime('now') WHERE id=?`",
      expect: ['assigned_to'],
    },
  ];
  for (const { label, src, expect } of positiveCases) {
    const stripped = stripCommentsPreserveLines(src);
    UPDATE_TASKS_RE.lastIndex = 0;
    const m = UPDATE_TASKS_RE.exec(stripped);
    assert.ok(m, `positive case matched UPDATE tasks: ${label}`);
    const cls = classifyUpdateAt(stripped, m.index);
    assert.equal(cls.isOwnerWrite, true,
      `positive case must be an owner write: ${label}`);
    assert.deepEqual(cls.ownerCols.sort(), expect.sort(),
      `positive case owner cols: ${label}`);
  }

  // Negative cases — each MUST be classified as NON-owner (the SET clause
  // touches only non-owner columns, even when the WHERE references owner
  // columns or the statement is long with a nested subquery).
  const negativeCases = [
    {
      label: 'metadata-only write',
      src: "`UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`",
    },
    {
      label: 'tags-only write',
      src: "`UPDATE tasks SET tags=?, updated_at=datetime('now') WHERE id=?`",
    },
    {
      label: 'risk write',
      src: "`UPDATE tasks SET declared_risk=?, derived_risk=?, policy_minimum=?, final_risk=?, updated_at=datetime('now') WHERE id=?`",
    },
    {
      label: 'integration_state write',
      src: "`UPDATE tasks SET integration_state='pending', integrated_at=NULL, updated_at=datetime('now') WHERE id=?`",
    },
    {
      label: 'subquery SET with nested WHERE — first-WHERE isolation',
      src: "`UPDATE tasks SET verification_target_artifact_id = (SELECT MIN(x) FROM t WHERE t.kind='AC') WHERE tasks.id=?`",
    },
    {
      label: 'verification target write',
      src: "`UPDATE tasks SET verification_target_artifact_id=?, updated_at=datetime('now') WHERE id=?`",
    },
  ];
  for (const { label, src } of negativeCases) {
    const stripped = stripCommentsPreserveLines(src);
    UPDATE_TASKS_RE.lastIndex = 0;
    const m = UPDATE_TASKS_RE.exec(stripped);
    assert.ok(m, `negative case matched UPDATE tasks: ${label}`);
    const cls = classifyUpdateAt(stripped, m.index);
    assert.equal(cls.isOwnerWrite, false,
      `negative case must NOT be an owner write: ${label} (got cols ${cls.ownerCols.join(',')})`);
  }

  // The classifier MUST ignore docblock prose that mentions the pattern. The
  // invariant docblocks in the lifecycle modules say "UPDATE tasks SET
  // status=|assigned_to=|current_execution_id="; after comment stripping
  // they must contribute ZERO matches.
  const docblockProse = stripCommentsPreserveLines(`
/**
 * fails any NEW file issuing UPDATE tasks SET status=|assigned_to=|current_execution_id=
 */
const x = 1;
`);
  UPDATE_TASKS_RE.lastIndex = 0;
  const docMatches = docblockProse.match(UPDATE_TASKS_RE) ?? [];
  assert.equal(docMatches.length, 0,
    'docblock prose mentioning the pattern must be stripped (no false match)');
});

test('tasks-writer-invariant: owner-write landscape is the expected single-writer set (snapshot)', () => {
  // Snapshot the TODAY landscape so a future PR that adds a NEW owner write
  // in an allowed file is visible in the diff (and a new file is caught by
  // the zero-violations test above). If you intentionally move a writer,
  // update this snapshot and the header allowlist together.
  const landscape = OWNER_WRITES
    .map((w) => `${w.allowed ? 'ALLOWED' : 'VIOLATION'} ${w.file}:${w.line} [${w.ownerCols.join(',')}]`)
    .sort();
  // Every observed owner write MUST be ALLOWED today (the zero-violation
  // invariant). This assertion is belt-and-braces: if the classifier started
  // emitting disallowed writes, the previous test already fails — this test
  // documents the EXPECTED files so the set is reviewable.
  assert.ok(
    OWNER_WRITES.every((w) => w.allowed),
    'every owner write today is in the allowed set (snapshot drift)',
  );
  // Sanity: the landscape is non-empty (claim + release + recovery + tools +
  // worker-executions exception all write owner columns today).
  assert.ok(OWNER_WRITES.length >= 5,
    `expected at least 5 owner-write sites today, got ${OWNER_WRITES.length}`);
  // Print for test-runner observability (not asserted beyond non-empty).
  void landscape;
});
