// tests/architecture/workplace-domain-purity.test.mjs
//
// Conveyor v4 step 1.4 ratchet — purity of the new Workplace domain.
//
// The target architecture (CONVEYOR-MENTAL-MODEL v4 +
// FACTORY-DOMAIN-ACCEPTANCE-REGISTRY) requires the domain layer to stay PURE:
// it must not import SQLite, MCP, the global db, schema.ts, filesystem, the
// application/behavioral layer, persistence adapters, composition, modules,
// or infrastructure. This is the same rule the existing
// `dependency-direction.test.mjs` enforces for `src/process-modules/domain/`
// (Rule 5: domain may not import outward); this file narrows the same rule to
// the new `src/process-modules/domain/workplace/` subtree so a careless import
// added during the v4 migration is caught the moment it lands.
//
// This test is a STATIC source check: it reads the .ts files under
// domain/workplace/ and asserts no forbidden import specifier appears. It
// does not execute the code. It guards the REG-03/REG-05 domain purity
// acceptance criterion: "Module domain and application code do not import
// SQLite, MCP, a model driver, filesystem adapters, global `getDb`, or shared
// concrete repositories."

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKPLACE_DOMAIN_DIR = path.join(
  REPO_ROOT,
  'src',
  'process-modules',
  'domain',
  'workplace',
);

// Forbidden substrings in any import/export-from specifier inside the
// workplace domain. Each names an outward dependency the domain must not
// reach into (Rule 5 / REG-03 domain purity).
//
// `application/` is forbidden because the application layer holds BEHAVIOR
// (executors, coordinators, registries); the domain only declares types and
// pure functions. Sibling `domain/spi/` and `domain/workplace/` and the
// shared canonical-json leaf are ALLOWED (they are pure data).
const FORBIDDEN_SPECIFIER_SUBSTRINGS = [
  'better-sqlite3',
  '../application/',
 '../../application/',
 '../../../application/',
  '../persistence/',
  '../../persistence/',
  '../../../persistence/',
  '../infrastructure/',
  '../../infrastructure/',
  '../../../infrastructure/',
  '../../db.js',
  '../../../db.js',
  '../../schema.js',
  '../../../schema.js',
  'node:fs',
  'node:child_process',
  '../tools/',
  '../../tools/',
  '../composition/',
  '../../composition/',
  '../modules/',
  '../../modules/',
  '@modelcontextprotocol',
];

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('REG-03/REG-05 domain purity: domain/workplace/ imports no outward dependency', () => {
  const files = listTsFiles(WORKPLACE_DOMAIN_DIR);
  assert.ok(files.length >= 6, `expected at least 6 workplace domain files, found ${files.length}`);
  const violations = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    // Match import/export ... from '...' specifiers.
    const specRegex = /(?:import|export)\b[\s\S]*?from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = specRegex.exec(source)) !== null) {
      const spec = m[1];
      for (const forbidden of FORBIDDEN_SPECIFIER_SUBSTRINGS) {
        if (spec.includes(forbidden)) {
          violations.push(`${rel}: '${spec}' contains forbidden '${forbidden}'`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `domain/workplace/ must stay pure (REG-03/REG-05). Violations:\n${violations.join('\n')}`,
  );
});

test('REG-03/REG-05 domain purity: domain/workplace/ declares no runtime side effects', () => {
  // A pure domain module may export types, interfaces, const enums, and pure
  // functions. It must NOT call process.exit, spawn processes, open files, or
  // mutate global state at module load. This is a coarse guard; the
  // import-specifier test above is the primary gate, but this catches a
  // module that, e.g., opens a DB connection at the top level.
  const files = listTsFiles(WORKPLACE_DOMAIN_DIR);
  const violations = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const forbiddenCalls = [
      /\bprocess\.exit\b/,
      /\bspawn\(/,
      /\bspawnSync\(/,
      /\bexecFile\(/,
      /\bexecFileSync\(/,
      /\bnew Database\(/,
      /\bgetDb\(\)/,
    ];
    for (const re of forbiddenCalls) {
      if (re.test(source)) {
        violations.push(`${rel}: forbidden runtime call ${re.source}`);
      }
    }
  }
  assert.deepEqual(violations, [], `domain/workplace/ must have no runtime side effects`);
});
