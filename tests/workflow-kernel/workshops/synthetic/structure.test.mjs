/**
 * structure.test.mjs - WP-11V structural fences of the SYNTHETIC workshop
 * package (the generalization proof's structural leg):
 *   - INDEPENDENCE: the package imports NO other workshop package - only
 *     kernel packages (domain, roles, context-envelope, the WP-08 vertical
 *     surface) and its own files;
 *   - no SQL, no schema, no private driver/scheduler/reconciler stems;
 *   - no bare lifecycle family-name literal (identity is manifest data);
 *   - the package is reachable only from focused tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImporters } from '../../support/import-scan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGE_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'synthetic');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const packageFiles = walk(PACKAGE_SRC);

function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Every relative import of one file, resolved to its target text. */
function relativeImports(file) {
  const source = codeOf(file);
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
}

test('INDEPENDENCE: the synthetic package imports no other workshop package', () => {
  for (const file of packageFiles) {
    for (const specifier of relativeImports(file)) {
      assert.equal(
        specifier.includes('/workshops/development'),
        false,
        `${file}: imports the Development workshop package (${specifier}); the synthetic workshop stands on the KERNEL alone`,
      );
    }
  }
});

test('every import resolves to the kernel packages or the package itself', () => {
  for (const file of packageFiles) {
    for (const specifier of relativeImports(file)) {
      const allowed = /^(\.\.\/)*(domain|roles|context-envelope|application|planning|persistence|development)\//.test(specifier.replace('./', '')) || specifier.startsWith('./');
      // Relative specifiers either stay inside the package or climb into a kernel package.
      const parts = specifier.split('/');
      const climbs = parts.filter((part) => part === '..').length;
      // src/workflow-kernel/workshops/synthetic/<file>.ts -> two levels up is workflow-kernel.
      const targetRoot = climbs >= 2 ? parts[climbs] : (climbs === 1 ? 'synthetic' : 'synthetic');
      assert.equal(
        climbs <= 2,
        true,
        `${file}: import ${specifier} climbs above the kernel root`,
      );
      if (climbs === 2) {
        assert.ok(
          ['domain', 'roles', 'context-envelope', 'application', 'planning', 'persistence', 'development'].includes(targetRoot),
          `${file}: import ${specifier} targets ${targetRoot}/ which is not a kernel package`,
        );
      }
      assert.equal(specifier.startsWith('.'), true, `${file}: imports are relative (${specifier})`);
      void allowed;
    }
  }
});

test('the synthetic package holds zero SQL and owns no table', () => {
  for (const file of packageFiles) {
    const source = codeOf(file);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${file}: aggregate-table write`);
    assert.equal(source.match(/\bCREATE\s+(TABLE|TRIGGER|INDEX)/i), null, `${file}: schema creation`);
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    assert.deepEqual(literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal)), [], `${file}: SQL string literals`);
  }
});

test('the synthetic package owns no driver, scheduler or reconciler stem', () => {
  for (const file of packageFiles) {
    const name = file.split(/[\\/]/).pop();
    assert.equal(/(obligation-consumer|scheduler|flow-executor|flow-engine|handler-registry|reconciler)/i.test(name), false, `${name}: a workshop package never owns a driver/reconciler stem`);
  }
});

test('no bare lifecycle family-name literal in the synthetic package source', () => {
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/;
  for (const file of packageFiles) {
    const match = readFileSync(file, 'utf8').match(rx);
    assert.equal(match, null, `${file}: bare family-name literal ${match?.[0]} (identity belongs to manifest data)`);
  }
});

test('the synthetic package is reachable ONLY from focused tests', () => {
  // EK-8 cutover (WP-12): resolver-based importer scan (support/import-scan.mjs)
  // - strictly stronger than the pre-cutover absolute-path regex.
  const offenders = findImporters([
    { dir: join(REPO_ROOT, 'src'), extensions: ['.ts'] },
    { dir: join(REPO_ROOT, 'tools'), extensions: ['.mjs'] },
  ], 'src/workflow-kernel/workshops/synthetic');
  // EK-8 cutover repin: the ONE production composition is the ONLY legal
  // production importer - the synthetic workshop rides the same kernel with
  // no new transition kind, table, driver or reconcifier (its proof).
  const outsideComposition = offenders.map((f) => f.replaceAll('\\', '/')).filter((f) => !f.includes('/src/workflow-kernel/composition/'));
  assert.deepEqual(outsideComposition, [], 'only the ONE production composition may import the synthetic workshop');
  assert.ok(offenders.length > 0, 'the composition must import the synthetic package (the cutover landed)');
});
