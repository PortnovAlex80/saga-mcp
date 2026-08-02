// tests/architecture/no-sqlite-in-modules.test.mjs
//
// W7-RECHECK (2026-08-02) — Physical-placement gate (Wave 7 §"ПОВТОРНАЯ
// ПРОВЕРКА 2026-08-02" / WAVE-7-REMARKS.txt).
//
// The Rule 1-3 dependency-direction ratchet (dependency-direction.test.mjs)
// classifies violations by IMPORT EDGES — a module file that imports a
// persistence adapter / infra / db.ts. That classifier cannot see a SQLite
// implementation that is PHYSICALLY PLACED inside the module tree, because the
// offending file does not import a substrate edge from elsewhere — it IS the
// substrate. The re-check confirmed this blind spot: eight SQLite adapter
// files lived and compiled inside src/process-modules/modules/{development,
// delivery,formalization}/ while the ratchet reported zero violations.
//
// This test closes that gap with a PHYSICAL-PLACEMENT rule. It scans every
// `.ts` file under `src/process-modules/modules/` and FAILS if any file:
//
//   (a) imports `better-sqlite3` (the SQLite driver — only infrastructure
//       adapters may touch it);
//   (b) imports `getDb` from `db.ts` (the global DB singleton — modules must
//       receive the handle via a constructor port);
//   (c) declares a `class Sqlite*` (concrete adapter classes belong in
//       `src/infrastructure/process-modules/`);
//   (d) has a filename matching `sqlite-*.ts` AND is NOT a pure re-export
//       shim (the only legitimate reason for a `sqlite-*` name to remain in
//       the module tree is a backwards-compatibility re-export shim that
//       points at the real adapter in infrastructure; such a shim imports no
//       driver, declares no class, and contains only `export ... from`
//       statements).
//
// A pure re-export shim is detected by: no `better-sqlite3` import, no `getDb`
// import, no `class` declaration, and every top-level declaration being an
// `export ... from '...'` re-export. This lets the Wave 7 hex extraction leave
// a thin compat shim at the historical import path (so sibling modules, tests
// and the composition root keep resolving during the parallel-agent refactor
// window) WITHOUT re-introducing the substrate into the module tree.
//
// EXIT GATE (WAVE-7-REMARKS.txt §"Критерий завершения"): "В
// src/process-modules/modules нет импортов better-sqlite3, getDb, concrete
// persistence repositories и классов Sqlite." This test codifies that gate.
//
// This test is INTENTIONALLY a separate file from dependency-direction.test.mjs
// so the physical-placement concern is visible, individually runnable, and
// immune to changes in the edge-classification ratchet's allowlist machinery.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULES_ROOT = path.join(REPO_ROOT, 'src', 'process-modules', 'modules');

// ---------------------------------------------------------------------------
// File discovery — every .ts file under src/process-modules/modules/.
// ---------------------------------------------------------------------------

/**
 * Recursively collect every `.ts` file under `dir`, returning repo-relative
 * POSIX paths (for readable failure messages) paired with their absolute paths.
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
// Source classifiers. Each operates on raw UTF-8 source text.
//
// We strip line comments (slash-slash) and block comments (slash-star ... star-
// slash) so a driver/class name appearing only in prose documentation does not
// produce a false positive. String LITERALS are NOT stripped: an `import` from
// 'better-sqlite3' is itself a string literal we must catch, and a class name
// referenced in a string is rare and harmless to flag for review.
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

// A VALUE import of better-sqlite3 pulls the native SQLite driver into the
// module's runtime graph — that is the substrate edge Wave 7 forbids inside
// src/process-modules/modules/. A pure `import type Database from 'better-
// sqlite3'` is ERASED at compile time (it only types a constructor parameter)
// and carries no runtime edge, so it is allowed — mirroring how the moved
// development/delivery/formalization adapters used `import type` before their
// extraction and how the discovery module types its injected handle today.
//
// We match every `import ... from 'better-sqlite3'` and require each to be
// preceded by the `type` modifier (either `import type ...` or a per-binding
// `type` qualifier when default + named mix). The simplest correct check: an
// import is a VALUE import iff it starts with `import` (not `import type`)
// and binds at least one non-type value.
const SQLITE_IMPORT_RE =
  /import\s+(type\s+)?(?:[^'"]+?)\s+from\s*['"]better-sqlite3['"]/g;

/**
 * Does `stripped` (comment-stripped) source contain a VALUE import of
 * better-sqlite3 (a runtime driver edge)? Pure `import type` imports are
 * erased and do not count.
 * @param {string} stripped
 * @returns {boolean}
 */
function hasSqliteDriverValueImport(stripped) {
  for (const match of stripped.matchAll(SQLITE_IMPORT_RE)) {
    const isTypeOnly = match[1] !== undefined; // the optional `type ` group
    if (!isTypeOnly) return true;
  }
  return false;
}

const GETDB_RE = /\bgetDb\b/;

/**
 * Detect a class declaration whose name starts with Sqlite (e.g. class
 * SqliteFoo, export class SqliteFoo, export default class SqliteFoo, plus
 * generic/extends forms). All concrete adapter classes follow the Sqlite*
 * naming convention, so this catches any concrete adapter declared inside the
 * module tree.
 */
const SQLITE_CLASS_DECL_RE = /\bclass\s+Sqlite[A-Za-z0-9_]*/;

/**
 * A complete re-export statement: `export { ... } from '...'` or
 * `export * [as X] from '...'`, possibly spanning multiple lines, optionally
 * terminated by `;`. We capture each as one token so multi-line `export {\n X,\n Y,\n}`
 * blocks classify as a single pure re-export rather than failing the per-line
 * heuristic.
 */
const REXPORT_STMT_RE =
  /export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*(?:,\s*\{[^}]*\}\s*)*from\s*['"][^'"]+['"]\s*;?/g;

/**
 * A complete `import type ... from '...'` statement (erased at compile time,
 * carries no runtime substrate edge). Allowed in a shim because it types an
 * injected handle without pulling the driver.
 */
const TYPE_IMPORT_STMT_RE =
  /import\s+type\s+[^'"]*?\s+from\s*['"][^'"]+['"]\s*;?/g;

/**
 * Classify whether a `.ts` file is a PURE re-export shim: its comment-stripped
 * body, with every re-export statement and every `import type` statement
 * removed, leaves only whitespace. This means the file imports no driver,
 * declares no class/function/interface/type/const, and references no getDb —
 * it is purely a pass-through to the infrastructure adapter. A blank or
 * comment-only file is treated as a shim (vacuously pure).
 *
 * @param {string} stripped comment-stripped source
 * @returns {boolean}
 */
function isPureReexportShim(stripped) {
  if (hasSqliteDriverValueImport(stripped)) return false;
  if (GETDB_RE.test(stripped)) return false;
  if (SQLITE_CLASS_DECL_RE.test(stripped)) return false;
  // Any own declaration disqualifies the shim (the re-export + import-type
  // removal below would otherwise leave these behind and trip the emptiness
  // check; this is also a belt-and-braces guard against a shim that grew a
  // real declaration).
  if (/\b(?:function|interface|const|let|var|enum|namespace|class)\b/.test(stripped)) {
    return false;
  }
  // Remove every complete re-export statement and every `import type`
  // statement. What remains must be ONLY whitespace (and optional `export type
  // {...}` alias re-exports, handled by the same REXPORT_STMT_RE shape when the
  // clause is a brace list — but a bare `export type Foo = ...` assignment
  // would remain and fail the emptiness check, which is correct: that is an
  // own declaration).
  let remainder = stripped;
  remainder = remainder.replace(REXPORT_STMT_RE, '');
  remainder = remainder.replace(TYPE_IMPORT_STMT_RE, '');
  return remainder.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Violation collection.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ file: string, rule: string, detail: string }} Violation
 */

/** @returns {Violation[]} */
function collectViolations() {
  /** @type {Violation[]} */
  const violations = [];
  const files = listTypeScriptFiles(MODULES_ROOT);
  for (const { rel, abs } of files) {
    let raw;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(raw);
    const filename = path.basename(rel);

    // (a) better-sqlite3 VALUE import (runtime driver edge; `import type` is
    //     erased and allowed — it only types an injected constructor handle).
    if (hasSqliteDriverValueImport(stripped)) {
      violations.push({
        file: rel,
        rule: 'no-better-sqlite3-import',
        detail: "imports 'better-sqlite3' (value import) — the SQLite driver belongs in src/infrastructure/, not inside a module; use `import type` for a constructor-handle type",
      });
    }

    // (b) getDb import from db.ts.
    if (GETDB_RE.test(stripped)) {
      violations.push({
        file: rel,
        rule: 'no-getdb-import',
        detail: "references getDb (the global DB singleton) — modules must receive the Database handle via a constructor port",
      });
    }

    // (c) class Sqlite* declaration.
    if (SQLITE_CLASS_DECL_RE.test(stripped)) {
      const match = stripped.match(SQLITE_CLASS_DECL_RE);
      violations.push({
        file: rel,
        rule: 'no-sqlite-class-declaration',
        detail: `declares ${match?.[0] ?? 'a Sqlite* class'} — concrete adapter classes belong in src/infrastructure/process-modules/`,
      });
    }

    // (d) sqlite-*.ts filename that is NOT a pure re-export shim.
    if (/^sqlite-.*\.ts$/i.test(filename)) {
      if (!isPureReexportShim(stripped)) {
        violations.push({
          file: rel,
          rule: 'no-sqlite-filename-impl',
          detail: "filename matches 'sqlite-*.ts' but the file is not a pure re-export shim — SQLite implementation files must live under src/infrastructure/process-modules/",
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const VIOLATIONS = collectViolations();

test('no-sqlite-in-modules: physical-placement gate scans a non-trivial module tree', () => {
  const files = listTypeScriptFiles(MODULES_ROOT);
  assert.ok(files.length > 20,
    `expected >20 .ts files under src/process-modules/modules/, got ${files.length}`);
});

test('no-sqlite-in-modules: ZERO SQLite substrate inside src/process-modules/modules/', () => {
  if (VIOLATIONS.length > 0) {
    const lines = VIOLATIONS.map(
      (v) => `  ${v.file}\n     [${v.rule}] ${v.detail}`,
    );
    assert.fail(
      `Wave 7 physical-placement gate VIOLATED: ${VIOLATIONS.length} SQLite-substrate occurrence(s)\n` +
        `inside src/process-modules/modules/. Concrete SQLite adapters (better-sqlite3 imports,\n` +
        `Sqlite* classes, getDb) must live under src/infrastructure/process-modules/. A module may\n` +
        `keep a thin backwards-compat re-export shim at the historical path ONLY if it is a pure\n` +
        `export-from with no driver import and no class declaration.\n${lines.join('\n')}`,
    );
  }
  assert.equal(VIOLATIONS.length, 0,
    'no SQLite substrate physically placed inside the module tree');
});

test('no-sqlite-in-modules: gate detects the four violation kinds (self-test)', () => {
  // Guard against the classifier silently becoming a no-op. Each synthetic
  // snippet below must be classified as a violation by exactly one rule.
  const positiveCases = [
    { rule: 'no-better-sqlite3-import', src: `import Database from 'better-sqlite3';\n` },
    { rule: 'no-getdb-import', src: `import { getDb } from '../../db.js';\n` },
    { rule: 'no-sqlite-class-declaration', src: `export class SqliteFoo { constructor() {} }\n` },
  ];
  for (const { rule, src } of positiveCases) {
    const stripped = stripComments(src);
    let hit = false;
    if (rule === 'no-better-sqlite3-import' && hasSqliteDriverValueImport(stripped)) hit = true;
    if (rule === 'no-getdb-import' && GETDB_RE.test(stripped)) hit = true;
    if (rule === 'no-sqlite-class-declaration' && SQLITE_CLASS_DECL_RE.test(stripped)) hit = true;
    assert.ok(hit, `classifier must catch ${rule}`);
  }
  // `import type` is ERASED — it carries no runtime driver edge and must NOT
  // be flagged. This mirrors how the discovery module types its injected
  // Database handle today and how the moved adapters used `import type` before
  // extraction.
  const typeOnly = stripComments(`import type Database from 'better-sqlite3';\n`);
  assert.equal(hasSqliteDriverValueImport(typeOnly), false,
    '`import type` better-sqlite3 is erased and must NOT be flagged as a value import');
  // Pure re-export shim (single-line AND multi-line) must NOT be flagged as a
  // violating impl.
  const shimSingle = stripComments(
    `export { SqliteFoo } from '../../../infrastructure/process-modules/foo/bar.js';\n`,
  );
  const shimMulti = stripComments(
    `export {\n  SqliteFoo,\n  type SqliteFooOptions,\n} from '../../../infrastructure/process-modules/foo/bar.js';\n`,
  );
  assert.equal(isPureReexportShim(shimSingle), true,
    'a single-line pure export-from shim must be allowed');
  assert.equal(isPureReexportShim(shimMulti), true,
    'a multi-line pure export-from shim must be allowed (no driver, no class decl)');
});
