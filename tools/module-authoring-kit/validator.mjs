// tools/module-authoring-kit/validator.mjs
//
// W10-A5 — Module Authoring Kit: validator library + CLI.
//
// Spec: docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md lane A5.
// Task:  docs/refactor-management/05-subagent-tasks/W10-a5.md.
//
// This module is the single entry point a module author uses to scaffold a new
// Process Module package, validate it, and run the conformance contract test
// corpus. It deliberately IMPORTS THE CANONICAL VALIDATORS from the built
// `dist/` tree (W1-A2 manifest validator + application-layer definition
// validator) so the kit and the Wave 2 content-addressed installer NEVER drift.
// A manifest that passes `validateManifest()` here is accepted by the installer;
// a manifest that fails here is rejected there. That invariance is the point of
// this kit.
//
// No production behavior lives here — this is a developer tool. It is plain Node
// ESM (.mjs), so it does not participate in `tsc` and does NOT touch `src/`
// (WAVE10-EXTENSIBILITY-SPEC §3 anti-scope). The dependency-direction ratchet
// scans only `src/`, so this file is invisible to it by construction.
//
// Three verbs:
//   scaffold <nodeKind> <outDir> --vars key=val ...   copy a template package
//   validate  <manifestPath>                           run canonical validation
//   conform   <manifestPath>                           validate + extra kit checks
//   conform-corpus                                     run the fixture corpus
//
// The library surface (validateManifest, scaffoldPackage, runConformanceCorpus)
// is exported for the kit's own test suite (validator.test.mjs).

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, cpSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KIT_ROOT = __dirname;
const REPO_ROOT = path.resolve(KIT_ROOT, '..', '..');

// Resolve the canonical validators from the built dist/ tree. Using
// createRequire against the repo root lets the kit locate dist/ regardless of
// the caller's cwd, and keeps the import out of the TypeScript build graph.
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));
const canonicalManifestValidatorPath = requireFromRepo.resolve(
  './dist/process-modules/domain/spi/module-manifest.js',
);
const canonicalDefinitionValidatorPath = requireFromRepo.resolve(
  './dist/process-modules/application/validate-process-module.js',
);

const { validateProcessModuleManifest } = await import(
  pathToFileURL(canonicalManifestValidatorPath).href
);
const { validateProcessModuleDefinition } = await import(
  pathToFileURL(canonicalDefinitionValidatorPath).href
);

// ---------------------------------------------------------------------------
// Public types (documented in JSDoc for editor support; no runtime effect).
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} KitValidationError
 * @property {string} code       Stable error code (mirrors the canonical
 *                               validator's codes, plus kit-only `KIT_*` codes).
 * @property {string} path       JSON path of the offending field.
 * @property {string} message    Human-readable explanation.
 */

/**
 * @typedef {Object} KitValidationResult
 * @property {boolean} ok                 True iff `errors` is empty.
 * @property {KitValidationError[]} errors  Structural validation errors.
 * @property {string[]} definitionErrors  Semantic definition errors (from the
 *                                        application-layer validator). Empty when
 *                                        the manifest envelope itself is invalid.
 */

// ---------------------------------------------------------------------------
// validateManifest — the canonical manifest + definition check.
// ---------------------------------------------------------------------------

/**
 * Validate a `ProcessModuleManifest` value against the SAME validators the
 * Wave 2 installer runs. Returns `{ ok, errors, definitionErrors }`.
 *
 * Phase 1 — canonical manifest validation (W1-A2): structural completeness +
 * canonical serializability. Produces typed `ValidationError[]` with stable
 * codes (MANIFEST_*, RESOURCE_*, HANDLER_*).
 *
 * Phase 2 — semantic definition validation (application layer): identifier
 * format, semver, flow reachability, outcome emission, terminal-node set, etc.
 * Only runs when phase 1 succeeds, mirroring the installer's gating order.
 *
 * A manifest is installable iff `ok === true` AND `definitionErrors` is empty.
 *
 * @param {unknown} manifest
 * @returns {KitValidationResult}
 */
export function validateManifest(manifest) {
  /** @type {KitValidationError[]} */
  const errors = [];

  let manifestResult;
  try {
    manifestResult = validateProcessModuleManifest(manifest);
  } catch (e) {
    // assertCanonicalSerializable throws a plain object on purity violations.
    errors.push({
      code: 'MANIFEST_NOT_CANONICALLY_SERIALIZABLE',
      path: '$',
      message: `manifest is not canonically serializable: ${errMessage(e)}`,
    });
    return { ok: false, errors, definitionErrors: [] };
  }

  if (!manifestResult.ok) {
    return {
      ok: false,
      errors: manifestResult.errors.map((e) => ({ ...e })),
      definitionErrors: [],
    };
  }

  // Phase 2 — semantic definition validation. definition is structurally present
  // (phase 1 enforced it), so run the application-layer validator on it.
  const definition = /** @type {{definition: unknown}} */ (manifest).definition;
  let definitionErrors = /** @type {string[]} */ ([]);
  try {
    const defResult = validateProcessModuleDefinition(definition);
    definitionErrors = defResult.errors.slice();
  } catch (e) {
    definitionErrors = [`definition validation threw: ${errMessage(e)}`];
  }

  // Wrap definition errors into the typed error surface too, so callers have a
  // single list. Kit-only code prefix distinguishes them from envelope codes.
  const wrapped = definitionErrors.map((msg) => ({
    code: 'KIT_DEFINITION_INVALID',
    path: '$.definition',
    message: msg,
  }));

  return {
    ok: definitionErrors.length === 0,
    errors: [...errors, ...wrapped],
    definitionErrors,
  };
}

/**
 * Validate a manifest loaded from a JSON file on disk. Returns the same shape
 * as {@link validateManifest}, plus the parsed manifest on success.
 *
 * @param {string} manifestPath
 * @returns {{ ok: boolean, errors: KitValidationError[], definitionErrors: string[], manifest?: unknown }}
 */
export function validateManifestFile(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      errors: [{
        code: 'KIT_MANIFEST_UNREADABLE',
        path: '$',
        message: `could not read manifest file '${manifestPath}': ${errMessage(e)}`,
      }],
      definitionErrors: [],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [{
        code: 'KIT_MANIFEST_NOT_JSON',
        path: '$',
        message: `manifest is not valid JSON: ${errMessage(e)}`,
      }],
      definitionErrors: [],
    };
  }
  const result = validateManifest(parsed);
  return { ...result, manifest: parsed };
}

// ---------------------------------------------------------------------------
// runConformanceCorpus — run the kit's fixture corpus end-to-end.
// ---------------------------------------------------------------------------

/**
 * Run the kit's contract test corpus (fixtures/index.json) and return a
 * pass/fail summary. Each valid fixture must pass validation; each negative
 * fixture must fail with at least its declared expectedErrorCodes.
 *
 * @param {Object} [opts]
 * @param {string} [opts.fixturesDir]  Override the fixtures directory.
 * @returns {{ passed: boolean, total: number, results: Array<{id:string, kind:'valid'|'negative', ok:boolean, detail:string}> }}
 */
export function runConformanceCorpus(opts = {}) {
  const fixturesDir = opts.fixturesDir || path.join(KIT_ROOT, 'fixtures');
  const indexPath = path.join(fixturesDir, 'index.json');
  /** @type {{valid: Array<{id:string,path:string,description?:string}>, negative: Array<{id:string,path:string,expectedErrorCodes:string[]}>}} */
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return {
      passed: false,
      total: 0,
      results: [{
        id: '(index)',
        kind: 'valid',
        ok: false,
        detail: `could not read fixtures/index.json: ${errMessage(e)}`,
      }],
    };
  }

  /** @type {Array<{id:string, kind:'valid'|'negative', ok:boolean, detail:string}>} */
  const results = [];

  for (const entry of index.valid || []) {
    const abs = path.join(fixturesDir, entry.path);
    const r = validateManifestFile(abs);
    const ok = r.ok;
    const detail = ok
      ? 'valid manifest accepted'
      : `expected valid but got errors: ${formatErrors(r.errors)}`;
    results.push({ id: entry.id, kind: 'valid', ok, detail });
  }

  for (const entry of index.negative || []) {
    const abs = path.join(fixturesDir, entry.path);
    /** @type {{manifest?: unknown, expectedErrorCodes?: string[]}} */
    let payload;
    try {
      payload = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      results.push({ id: entry.id, kind: 'negative', ok: false, detail: `unreadable fixture: ${errMessage(e)}` });
      continue;
    }
    const expected = entry.expectedErrorCodes || payload.expectedErrorCodes || [];
    const r = validateManifest(payload.manifest);
    const actual = new Set(r.errors.map((e) => e.code));
    // The negative case must FAIL validation, and must surface at least one of
    // its declared expected codes (a manifest could fail for several reasons;
    // we assert the documented one is among them).
    const ok = !r.ok && expected.every((code) => actual.has(code));
    const detail = ok
      ? `rejected as expected with codes: ${[...actual].join(', ')}`
      : (r.ok
          ? `expected to fail (${expected.join(', ')}) but was accepted`
          : `expected codes ${expected.join(', ')} but got: ${[...actual].join(', ')}`);
    results.push({ id: entry.id, kind: 'negative', ok, detail });
  }

  const passed = results.every((r) => r.ok);
  return { passed, total: results.length, results };
}

// ---------------------------------------------------------------------------
// scaffoldPackage — copy a template and substitute {{VARS}}.
// ---------------------------------------------------------------------------

/**
 * The template node-kinds the kit ships. Mirrors the synthetic fixtures + the
 * four production module kinds (plan §3.6, §7.2).
 */
export const TEMPLATE_KINDS = Object.freeze(['lm-node', 'kernel-node', 'external-node', 'human-node']);

const TEMPLATE_DIR = path.join(KIT_ROOT, 'templates');

/**
 * Parse a `--vars key=val key=val` array into a plain object.
 * @param {readonly string[]} vars
 * @returns {Record<string, string>}
 */
export function parseVars(vars) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const v of vars || []) {
    const idx = v.indexOf('=');
    if (idx <= 0) {
      throw new Error(`invalid --vars entry '${v}'; expected key=value`);
    }
    out[v.slice(0, idx)] = v.slice(idx + 1);
  }
  return out;
}

/**
 * Scaffold a new module package from a template into `outDir`.
 *
 * Copies the template directory recursively, then substitutes every `{{KEY}}`
 * placeholder in the copied files' textual contents with the matching value
 * from `vars`. Binary files (anything whose UTF-8 decode is lossy) are copied
 * verbatim. The `outDir` must not already exist (or must be empty) to avoid
 * clobbering an in-progress package.
 *
 * Required vars: MODULE_NAME, MODULE_VERSION. Recommended: MODULE_KIND,
 * MODULE_DISPLAY_NAME, MODULE_DESCRIPTION (defaults derived from MODULE_NAME).
 *
 * @param {string} nodeKind      One of {@link TEMPLATE_KINDS}.
 * @param {string} outDir        Target directory (created if missing).
 * @param {Record<string, string>} vars  Placeholder substitutions.
 * @returns {{ outDir: string, kind: string, filesWritten: string[] }}
 */
export function scaffoldPackage(nodeKind, outDir, vars) {
  if (!TEMPLATE_KINDS.includes(nodeKind)) {
    throw new Error(`unknown node kind '${nodeKind}'. Valid: ${TEMPLATE_KINDS.join(', ')}`);
  }
  const resolved = withDefaults(vars);
  if (outDir && existsSync(outDir) && !dirIsEmpty(outDir)) {
    throw new Error(`output directory '${outDir}' exists and is not empty; refusing to clobber`);
  }
  const templateDir = path.join(TEMPLATE_DIR, nodeKind);
  if (!existsSync(templateDir)) {
    throw new Error(`template '${nodeKind}' not found at ${templateDir}`);
  }
  mkdirSync(outDir, { recursive: true });

  const files = [];
  walkAndCopy(templateDir, outDir);
  // Substitute placeholders in every copied text file.
  const copied = [];
  collectFiles(outDir, copied);
  for (const f of copied) {
    substituteInFile(f, resolved);
    files.push(path.relative(outDir, f));
  }
  return { outDir, kind: nodeKind, filesWritten: files.sort() };
}

/** Default the optional vars from MODULE_NAME so a minimal scaffold works. */
function withDefaults(vars) {
  const name = vars.MODULE_NAME;
  if (!name) throw new Error("required var MODULE_NAME is missing (pass --vars MODULE_NAME=...)");
  if (!vars.MODULE_VERSION) throw new Error("required var MODULE_VERSION is missing (pass --vars MODULE_VERSION=...)");
  return {
    MODULE_KIND: vars.MODULE_KIND || name,
    MODULE_DISPLAY_NAME: vars.MODULE_DISPLAY_NAME || name,
    MODULE_DESCRIPTION: vars.MODULE_DESCRIPTION || `Process Module package '${name}'.`,
    ...vars,
  };
}

function walkAndCopy(src, dest) {
  cpSync(src, dest, { recursive: true, filter: noTopLevelDotgitignore });
}

// The template .gitignore is shared scaffolding; copy it as .gitignore too, but
// skip copying it under its template name to avoid a stray file.
function noTopLevelDotgitignore(src) {
  const base = path.basename(src);
  if (base === '.gitignore') return false;
  return true;
}

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
}

function substituteInFile(filePath, vars) {
  let content = readFileSync(filePath, 'utf8');
  // Detect whether this file decodes cleanly as UTF-8 text; if not, leave it.
  if (!isProbablyText(content)) return;
  for (const [key, value] of Object.entries(vars)) {
    content = content.split(`{{${key}}}`).join(String(value));
  }
  writeFileSync(filePath, content, 'utf8');
}

function isProbablyText(s) {
  // Reject strings containing C0 control chars other than the common whitespace
  // ones; that's a strong binary-content signal.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0E-\x1F]/.test(s);
}

function dirIsEmpty(dir) {
  return readdirSync(dir).length === 0;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function errMessage(e) {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String(/** @type {{message:unknown}} */ (e).message);
  return String(e);
}

function formatErrors(errors) {
  return errors.map((e) => `${e.path} [${e.code}] ${e.message}`).join('; ');
}

const USAGE = `Module Authoring Kit (W10-A5)

Usage:
  node tools/module-authoring-kit/validator.mjs scaffold <nodeKind> <outDir> [--vars key=val ...]
  node tools/module-authoring-kit/validator.mjs validate <manifestPath>
  node tools/module-authoring-kit/validator.mjs conform   <manifestPath>
  node tools/module-authoring-kit/validator.mjs conform-corpus

Commands:
  scaffold        Copy a template package into <outDir> with {{VARS}} substituted.
                  nodeKind: ${TEMPLATE_KINDS.join(' | ')}
                  Required vars: MODULE_NAME, MODULE_VERSION.
  validate        Run the canonical manifest + definition validators on a manifest.
  conform         validate PLUS extra kit conformance checks (resource files exist).
  conform-corpus  Run the kit fixture corpus end-to-end (exit 0 if all pass).

The validators are imported from the built dist/ tree, so a manifest that passes
here is accepted by the Wave 2 content-addressed installer. Build first: \`npm run build\`.
`;

/**
 * CLI entry point. Returns a process exit code; the caller (the `if` guard at
 * the bottom) calls process.exit with it.
 *
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function cli(argv) {
  const args = argv.slice(2);
  const [verb, ...rest] = args;
  if (!verb || verb === '-h' || verb === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    if (verb === 'validate') return cmdValidate(rest);
    if (verb === 'conform') return cmdConform(rest);
    if (verb === 'conform-corpus') return cmdConformCorpus(rest);
    if (verb === 'scaffold') return cmdScaffold(rest);
    process.stderr.write(`unknown command '${verb}'\n\n${USAGE}`);
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${errMessage(e)}\n`);
    return 1;
  }
}

function cmdValidate(rest) {
  const manifestPath = rest[0];
  if (!manifestPath) { process.stderr.write('validate: missing <manifestPath>\n'); return 2; }
  const r = validateManifestFile(manifestPath);
  if (r.ok) {
    process.stdout.write(`OK: ${manifestPath} is a valid ProcessModuleManifest.\n`);
    return 0;
  }
  process.stderr.write(`FAIL: ${manifestPath} is invalid.\n`);
  for (const e of r.errors) {
    process.stderr.write(`  ${e.path} [${e.code}] ${e.message}\n`);
  }
  for (const msg of r.definitionErrors) {
    process.stderr.write(`  $.definition [KIT_DEFINITION_INVALID] ${msg}\n`);
  }
  return 1;
}

function cmdConform(rest) {
  const manifestPath = rest[0];
  if (!manifestPath) { process.stderr.write('conform: missing <manifestPath>\n'); return 2; }
  const r = validateManifestFile(manifestPath);
  if (!r.ok) {
    process.stderr.write(`FAIL: ${manifestPath} failed validation.\n`);
    for (const e of r.errors) process.stderr.write(`  ${e.path} [${e.code}] ${e.message}\n`);
    for (const msg of r.definitionErrors) process.stderr.write(`  $.definition [KIT_DEFINITION_INVALID] ${msg}\n`);
    return 1;
  }
  // Extra kit conformance check: every declared resource file must exist on
  // disk relative to the manifest's package root.
  const pkgRoot = path.dirname(path.resolve(manifestPath));
  const manifest = /** @type {{resourceIndex?: Array<{logicalId:string, path:string, kind:string, digest:string}>}} */ (r.manifest);
  const missing = [];
  for (const entry of manifest.resourceIndex || []) {
    if (!path.isAbsolute(entry.path) && !existsSync(path.join(pkgRoot, entry.path))) {
      missing.push(`${entry.logicalId} -> ${entry.path}`);
    }
  }
  if (missing.length > 0) {
    process.stderr.write(`FAIL: ${manifestPath} declares resources that do not exist:\n`);
    for (const m of missing) process.stderr.write(`  ${m}\n`);
    return 1;
  }
  process.stdout.write(`OK: ${manifestPath} conforms (valid + resources present).\n`);
  return 0;
}

function cmdConformCorpus() {
  const r = runConformanceCorpus();
  let valid = 0, negative = 0;
  for (const res of r.results) {
    const tag = res.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${tag}] ${res.kind}: ${res.id} — ${res.detail}\n`);
    if (res.kind === 'valid' && res.ok) valid++;
    if (res.kind === 'negative' && res.ok) negative++;
  }
  process.stdout.write(`\nCorpus: ${r.passed ? 'PASS' : 'FAIL'} (${r.total} cases)\n`);
  return r.passed ? 0 : 1;
}

function cmdScaffold(rest) {
  const nodeKind = rest[0];
  const outDir = rest[1];
  if (!nodeKind || !outDir) {
    process.stderr.write('scaffold: usage: scaffold <nodeKind> <outDir> [--vars key=val ...]\n');
    return 2;
  }
  // Collect positional vars after <outDir>. Accept both `--vars k=v k=v` and
  // bare `k=v` forms. The literal `--vars` token is consumed as a flag.
  const varEntries = rest.slice(2).filter((a) => {
    if (a === '--vars') return false; // flag, not a value
    return a.includes('=');
  });
  const vars = parseVars(varEntries);
  const r = scaffoldPackage(nodeKind, path.resolve(outDir), vars);
  process.stdout.write(`Scaffolded ${r.kind} package into ${r.outDir}.\n`);
  for (const f of r.filesWritten) process.stdout.write(`  ${f}\n`);
  return 0;
}

// Entry point when invoked directly.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const code = cli(process.argv);
  if (code !== 0) process.exit(code);
}

export const __internal = {
  REPO_ROOT,
  KIT_ROOT,
  TEMPLATE_DIR,
  withDefaults,
  substituteInFile,
  isProbablyText,
};
