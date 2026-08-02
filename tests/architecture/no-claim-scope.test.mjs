// tests/architecture/no-claim-scope.test.mjs
//
// Slice 1 Zones 5-7 (node-breaker) — structural gate: the `claimScope`
// self-claim contract is GONE from WorkerExecutorStart. The runner is now
// single-path (infrastructure assigns via WorkAssignmentPort BEFORE the worker
// launches; the worker receives an AssignedWork and never searches the queue).
//
// This test makes a regression against the old two-path model structurally
// impossible: it FAILS if the identifier `claimScope` ever reappears as actual
// CODE under src/. It deliberately ALLOWS the word `claimScope` inside comments
// and string literals — the codebase legitimately documents "the legacy
// claimScope path is removed" in several places, and forbidding those mentions
// would force the documentation to lie. The gate cares only about executable
// code: a property, parameter, variable, or type named `claimScope`.
//
// How it works: for every .ts file under src/, strip
//   - block comments   /* ... */          (spanning lines)
//   - line comments    // ...             (to end of line)
//   - string literals  '...' "..." `...`  (template/string contents)
// then search the remaining CODE for the bare identifier `claimScope`. A match
// is a real code reference and fails the test with the offending file:line.
//
// The strip is conservative: it does not attempt full TS tokenization (that
// would require the compiler). It is sufficient to catch a reintroduced
// `claimScope` property/parameter/variable/type, which is the only realistic
// shape a regression would take. A `claimScope` hidden inside a string that is
// then eval'd is not a concern here — no such pattern exists or would be added.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.resolve(REPO_ROOT, 'src');

/** Recursively collect .ts files under a directory. */
function listTypeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (st.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments and string literals so only executable code remains. Handles:
 *   - block comments  /* ... *\/  (may span lines)
 *   - line comments   // ...      (to end of line)
 *   - string literals '...' "..." `...` (with backslash escapes)
 * Template literals are treated as opaque strings (their interior is removed);
 * this is conservative — a `${expr}` interpolation carrying `claimScope` would
 * be hidden, but no such pattern exists and the gate's job is to catch a
 * reintroduced property/parameter/type, not arbitrary string content.
 *
 * Newlines are preserved so line numbers in reported matches stay accurate.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment — consume to end of line (keep the newline).
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    // Block comment — consume to closing */ (newlines preserved for line nos).
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2; // skip closing */
      continue;
    }
    // String literal (single/double/template) — consume to matching quote,
    // honouring backslash escapes. Replace contents with a space placeholder so
    // identifiers cannot hide inside strings.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote; // keep the quote char so syntax shape is visible
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          // Escaped char — skip both.
          if (source[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (source[i] === '\n') out += '\n'; // preserve line count
        i += 1;
      }
      i += 1; // skip closing quote
      out += quote;
      continue;
    }
    // Regular code char.
    out += c;
    i += 1;
  }
  return out;
}

test('no executable code under src/ references the removed claimScope contract', () => {
  const files = listTypeScriptFiles(SRC_ROOT);
  assert.ok(files.length > 50, `expected to scan dozens of .ts files under src/, got ${files.length}`);

  const violations = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const raw = readFileSync(file, 'utf8');
    const code = stripCommentsAndStrings(raw);
    const lines = code.split('\n');
    for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
      // \b ensures we match the identifier, not a substring of another name.
      const m = /\bclaimScope\b/.exec(lines[lineNo]);
      if (m) {
        violations.push(`${rel}:${lineNo + 1}: ${lines[lineNo].trim()}`);
      }
    }
  }

  if (violations.length > 0) {
    assert.fail(
      `Found ${violations.length} executable-code reference(s) to the REMOVED ` +
        `'claimScope' contract under src/. The conveyor refactor (Slice 1 Zones ` +
        `1-7) deleted claimScope from WorkerExecutorStart: every caller must now ` +
        `pre-assign via WorkAssignmentPort BEFORE launching a worker (see ` +
        `src/saga3/application/assign-one-card.ts and src/app/dispatch-loop.ts ` +
        `startOne()). Reintroducing claimScope would silently restore the ` +
        `two-path model the node-breaker collapsed:\n  ` +
        violations.join('\n  '),
    );
  }
});
