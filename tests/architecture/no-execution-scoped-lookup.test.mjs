// tests/architecture/no-execution-scoped-lookup.test.mjs
//
// WAVE 6 CUTOVER GATE — forbids re-introducing execution-scoped product
// lookup under src/process-modules/.
//
// WHAT THIS PROVES (WAVE-6-REMARKS.txt §"ПОВТОРНАЯ ПРОВЕРКА 2026-08-02")
//   The Wave 6 exact-ProductRef cutover retired the execution-scoped
//   (intentId / taskId / executionId) product-resolution fallback. The two
//   methods that implemented it —
//     - ManagedProductionLedger.listArtifactsForExecution(query)
//     - ManagedProductionLedger.listTracesForExecution(query)
//   — were removed from the kernel-port interfaces (development-kernel-ports,
//   formalization-kernel-ports), the formalization package port
//   (formalization-package-ports), and the shared concrete adapter
//   (sqlite-managed-production-ledger). They contradicted the cutover: a
//   verifier resolving products by transient execution id could read the
//   product of the CURRENT attempt instead of the exact product the card or
//   durable workplace produced, blinding the gate to artifacts from an
//   earlier fence of the same node (CGAD P18, execution-context-assembler
//   §9.11: no epic-scope / latest-in-run / by-execution fallback).
//
//   The LIVE product-resolution path is:
//     - listArtifactsForNodeInProcessRun / listTracesForNodeInProcessRun
//       (durable node-scope, CGAD P18); and
//     - ProcessProductRepository.getByProductRef (exact-by-(schemaId, ref,
//       digest), execution-context-assembler §8).
//
//   This test FAILS if either banned identifier reappears as a bare
//   identifier in CODE (not in comments) anywhere under src/process-modules/.
//   Scope is src/process-modules/ (NOT src/infrastructure/) — that matches
//   the cut boundary: the concrete formalization adapter that still carries
//   the delegation lives in src/infrastructure/ and is out of this gate's
//   scope (its owning lane migrates it separately; the gate is the
//   module-tree contract).
//
// This test is INTENTIONALLY separate from dependency-direction.test.mjs and
// the cutover-architecture-checks.test.mjs so the execution-scoped-lookup
// concern is visible, individually runnable, and immune to changes in those
// files' allowlist machinery.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROCESS_MODULES_ROOT = path.join(REPO_ROOT, 'src', 'process-modules');

// The identifiers the Wave 6 cutover retired. Matched as whole-word
// identifiers (word boundaries on both sides) so a substring like
// 'listArtifactsForExecutionFoo' or 'mylistArtifactsForExecution' is NOT a
// false positive.
//
// `restoreFrame` was added at the fourth audit (2026-08-02): the live
// executor data flow now calls `assembleFrameFromDurableNodeRuns` directly,
// and the `restoreFrame` symbol was fully removed. Forbidding it here
// prevents it from drifting back into owning frame-reconstruction logic.
const BANNED_IDENTIFIERS = Object.freeze([
  'listArtifactsForExecution',
  'listTracesForExecution',
  'restoreFrame',
]);

// ---------------------------------------------------------------------------
// File discovery — every .ts file under src/process-modules/ (recursive).
// ---------------------------------------------------------------------------

/**
 * Recursively collect every `.ts` file under `dir`, returning repo-relative
 * POSIX paths (for readable failure messages) paired with absolute paths.
 *
 * @param {string} dir
 * @returns {Array<{ rel: string, abs: string }>}
 */
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

// ---------------------------------------------------------------------------
// Comment stripping.
//
// We strip line comments (slash-slash) and block comments (slash-star ...
// star-slash) so a banned identifier appearing only in prose documentation
// (e.g. the WAVE 6 CUTOVER notes left in each port explaining WHY the methods
// were removed) does NOT produce a false positive. The banned names MUST be
// gone from CODE — declarations, calls, type annotations — not from comments.
//
// String literals are NOT stripped: a banned name in a string would itself be
// a code smell (e.g. dynamic dispatch by method name) worth flagging. This
// mirrors the no-sqlite-in-modules.test.mjs convention.
// ---------------------------------------------------------------------------

/**
 * Remove line comments and block comments from source. CRLF and LF agnostic.
 * Does NOT remove quoted string literals.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  return out;
}

/**
 * Find every occurrence of `identifier` as a bare whole-word token in
 * comment-stripped source, returning the 1-based line numbers it appears on.
 * A whole-word match uses `\b` boundaries on both sides so substrings and
 * longer identifiers sharing the prefix/suffix do not match.
 *
 * @param {string} stripped
 * @param {string} identifier
 * @returns {number[]}
 */
function findBareIdentifierLines(stripped, identifier) {
  const re = new RegExp(`\\b${identifier}\\b`, 'g');
  const lines = [];
  let match;
  while ((match = re.exec(stripped)) !== null) {
    // Map the match index to a 1-based line number in the stripped source.
    const lineNo = stripped.slice(0, match.index).split(/\r?\n/).length;
    lines.push(lineNo);
  }
  return lines;
}

// ===========================================================================
// The gate.
// ===========================================================================

test('WAVE 6 CUTOVER: no execution-scoped product lookup (listArtifactsForExecution / listTracesForExecution) reappears in code under src/process-modules/', () => {
  const files = listTypeScriptFiles(PROCESS_MODULES_ROOT);
  assert.ok(files.length > 0, 'discovered .ts files under src/process-modules/');

  const violations = [];
  for (const { rel, abs } of files) {
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch (err) {
      violations.push(`${rel}: UNREADABLE (${err.code ?? err.message})`);
      continue;
    }
    const stripped = stripComments(src);
    for (const identifier of BANNED_IDENTIFIERS) {
      const lines = findBareIdentifierLines(stripped, identifier);
      for (const lineNo of lines) {
        violations.push(`${rel}:${lineNo}: banned identifier '${identifier}' in code`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    'Wave 6 exact-ProductRef cutover forbids execution-scoped product lookup ' +
      '(listArtifactsForExecution / listTracesForExecution) anywhere under ' +
      'src/process-modules/. The live product-resolution path is ' +
      'listArtifactsForNodeInProcessRun (durable node-scope, CGAD P18) and ' +
      'ProcessProductRepository.getByProductRef (exact-by-ProductRef, ' +
      'execution-context-assembler §9.11: no epic-scope / latest-in-run / ' +
      'by-execution fallback). Offending files:\n  - ' +
      violations.join('\n  - '),
  );
});
