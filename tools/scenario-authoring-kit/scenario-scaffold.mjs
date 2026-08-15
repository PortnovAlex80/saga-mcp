#!/usr/bin/env node
// scenario-scaffold v0.1 — scaffold a new Lifecycle Scenario from templates.
//
// W10-A6 Scenario Authoring Kit (plan §0.13.10, WAVE10-EXTENSIBILITY-SPEC).
//
// Copies the two kit templates (manifest + definition) into a target directory
// and substitutes every {{PLACEHOLDER}} token. The result is a scenario that
// passes `scenario-validator.mjs` out of the box — a developer can then edit
// the real values and re-validate.
//
// Side effect: writes files. Refuses to overwrite an existing directory unless
// --force is given.

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const SCAFFOLD_VERSION = 'scenario-scaffold/0.1.0';

// Tokens that have a single sensible default derived from the scenario name.
// Everything else is required.
const TOKEN_DEFAULTS = (name) => ({
  SCENARIO_NAME: name,
  SCENARIO_DISPLAY_NAME: toDisplayName(name),
  SCENARIO_DESCRIPTION: `Lifecycle scenario '${name}'.`,
  ENTRY_STAGE_ID: 'draft',
  ENTRY_STAGE_DISPLAY_NAME: 'Draft',
  STAGE_2_ID: 'approve',
  STAGE_2_DISPLAY_NAME: 'Approve',
  MODULE_NAME_1: `${name}-module-a`,
  MODULE_VERSION_1: '0.1.0',
  MODULE_NAME_2: `${name}-module-b`,
  MODULE_VERSION_2: '0.1.0',
  OUTCOME_1: 'drafted',
  OUTCOME_2_OK: 'approved',
  OUTCOME_2_FAIL: 'rejected',
  TERMINAL_STATUS_OK: `${name}-approved`,
  TERMINAL_STATUS_FAIL: `${name}-rejected`,
});

function toDisplayName(name) {
  return String(name)
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

const REQUIRED_TEMPLATES = ['manifest.template.json', 'definition.template.mjs'];

/**
 * Tokenize a manifest.json into the set of {{TOKEN}}s it contains, in the order
 * they first appear. Used to drive substitution and to emit a definition.mjs
 * with the SAME tokens in the SAME order (the contract-test invariant).
 * @param {string} text
 * @returns {string[]}
 */
export function extractTokens(text) {
  const re = /\{\{([A-Z0-9_]+)\}\}/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Substitute {{TOKEN}} -> value across a template string.
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function substitute(text, vars) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (full, key) =>
    key in vars ? String(vars[key]) : full,
  );
}

/**
 * Scaffold a scenario into `targetDir`. Pure I/O; throws on bad inputs.
 *
 * @param {string} name - kebab-case scenario name
 * @param {string} targetDir - absolute directory to write into (created if missing)
 * @param {{ force?: boolean, overrides?: Record<string,string>, templatesDir?: string }} [options]
 * @returns {{ dir: string, written: string[], vars: Record<string,string> }}
 */
export function scaffoldScenario(name, targetDir, options = {}) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`scenario name must be kebab-case (lowercase, digits, hyphen); got '${name}'`);
  }
  const templatesDir = options.templatesDir || TEMPLATES_DIR;
  for (const t of REQUIRED_TEMPLATES) {
    if (!existsSync(path.join(templatesDir, t))) {
      throw new Error(`template missing: ${path.join(templatesDir, t)}`);
    }
  }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    if (!options.force) {
      throw new Error(`target directory not empty: ${targetDir} (use --force to overwrite)`);
    }
  }
  mkdirSync(targetDir, { recursive: true });

  const vars = { ...TOKEN_DEFAULTS(name), ...(options.overrides || {}) };
  const written = [];

  // manifest.json
  const manifestTpl = readUtf8(path.join(templatesDir, 'manifest.template.json'));
  const manifestOut = substitute(manifestTpl, vars);
  const manifestPath = path.join(targetDir, 'manifest.json');
  writeFileSync(manifestPath, manifestOut);
  written.push(manifestPath);

  // definition.mjs
  const defTpl = readUtf8(path.join(templatesDir, 'definition.template.mjs'));
  const defOut = substitute(defTpl, vars);
  const defPath = path.join(targetDir, 'definition.mjs');
  writeFileSync(defPath, defOut);
  written.push(defPath);

  return { dir: targetDir, written, vars };
}

function readUtf8(p) {
  // centralised so error messages are consistent
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`cannot read '${p}': ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function usage() {
  return [
    `${SCAFFOLD_VERSION} — scaffold a new Lifecycle Scenario from templates.`,
    '',
    'W10-A6 Scenario Authoring Kit.',
    '',
    'Usage:',
    '  node scenario-scaffold.mjs <scenario-name> <target-dir> [--force]',
    '                          [--set KEY=VALUE ...]',
    '',
    'Creates <target-dir>/manifest.json and <target-dir>/definition.mjs with',
    'every {{PLACEHOLDER}} substituted. The result validates clean against',
    'scenario-validator.mjs. Edit the real module refs / stages and re-validate.',
    '',
    'The <scenario-name> must be kebab-case (lowercase, digits, hyphen).',
    '',
    'Options:',
    '  --force              overwrite a non-empty target directory',
    '  --set KEY=VALUE      override a placeholder (repeatable). Recognised keys:',
    '                       SCENARIO_DISPLAY_NAME, ENTRY_STAGE_ID, MODULE_NAME_1,',
    '                       MODULE_VERSION_1, MODULE_NAME_2, MODULE_VERSION_2,',
    '                       OUTCOME_1, OUTCOME_2_OK, OUTCOME_2_FAIL,',
    '                       TERMINAL_STATUS_OK, TERMINAL_STATUS_FAIL, etc.',
    '  -h, --help           show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    return { help: true };
  }
  let name = null;
  let targetDir = null;
  let force = false;
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return { help: true };
    else if (a === '--force') force = true;
    else if (a === '--set') {
      const v = args[++i];
      if (!v || !v.includes('=')) throw new Error(`--set expects KEY=VALUE, got '${v}'`);
      const eq = v.indexOf('=');
      overrides[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else if (name === null) {
      name = a;
    } else if (targetDir === null) {
      targetDir = a;
    } else {
      throw new Error(`unexpected extra positional: ${a}`);
    }
  }
  if (!name) throw new Error('missing required positional: <scenario-name>');
  if (!targetDir) throw new Error('missing required positional: <target-dir>');
  return { name, targetDir, force, overrides, help: false };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${usage()}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const absTarget = path.resolve(opts.targetDir);
  let result;
  try {
    result = scaffoldScenario(opts.name, absTarget, {
      force: opts.force,
      overrides: opts.overrides,
    });
  } catch (e) {
    process.stderr.write(`scaffold failed: ${e.message}\n`);
    return 2;
  }
  for (const f of result.written) {
    process.stdout.write(`  wrote ${f}\n`);
  }
  process.stdout.write(`\n  Scaffolded scenario '${opts.name}' into ${result.dir}.\n`);
  process.stdout.write(`  Validate with: node tools/scenario-authoring-kit/scenario-validator.mjs ${path.join(result.dir, 'manifest.json')}\n`);
  return 0;
}

// Run only when invoked directly (not when imported by tests). Uses
// fileURLToPath for an OS-independent comparison (the naive file:// strip is
// wrong on Windows, where import.meta.url is file:///D:/... ).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv);
  process.exitCode = code;
}
