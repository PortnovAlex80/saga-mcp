/**
 * structure.test.mjs - WP-11V structural fences of the Development
 * workshop package:
 *   - the package is data + composition only: no SQL, no schema, no
 *     aggregate-table writes; the data modules import no session at all;
 *   - module/package identity lives in manifest data: no bare lifecycle
 *     family-name literal appears in the package source (the EK-2
 *     workshops.nameBranchLiterals dimension stays zero);
 *   - the package is reachable ONLY from focused tests: no production
 *     entrypoint outside the kernel imports it;
 *   - the package builds ON the WP-08 vertical by import, never re-implements
 *     it (no obligation-consumer or scheduler stem appears in the package).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImporters } from '../../support/import-scan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGE_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'development');

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

/** Source with comments stripped: the guards scan CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the workshop package holds zero SQL and creates no schema', () => {
  for (const file of packageFiles) {
    const source = codeOf(file);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${file}: aggregate-table write`);
    assert.equal(source.match(/\bUPDATE\s+[a-z_]+\s+SET\b/i), null, `${file}: UPDATE write`);
    assert.equal(source.match(/\bDELETE\s+FROM\b/i), null, `${file}: DELETE write`);
    assert.equal(source.match(/\bCREATE\s+(TABLE|TRIGGER|INDEX)/i), null, `${file}: schema creation`);
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    const sqlLiterals = literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal));
    assert.deepEqual(sqlLiterals, [], `${file}: SQL string literals (the owning repositories own all SQL)`);
  }
});

test('the data modules import no persistence session (purity of the installation data)', () => {
  const dataModules = ['installation.ts', 'manifest.ts', 'products.ts', 'mappings.ts', 'checkplans.ts', 'bindings.ts', 'waits.ts', 'effects.ts'];
  for (const name of dataModules) {
    const source = codeOf(join(PACKAGE_SRC, name));
    assert.equal(/from\s+'\.\.\/\.\.\/persistence/.test(source), false, `${name} must not import the persistence layer`);
    assert.equal(/KernelPersistenceSession/.test(source), false, `${name} must not name the session type`);
  }
  // The runbook is composition code: it may TYPE-import the session only.
  const runbookSource = readFileSync(join(PACKAGE_SRC, 'runbook.ts'), 'utf8');
  assert.equal(/import\s+type\s*\{[^}]*KernelPersistenceSession/.test(runbookSource.replace(/\/\*[\s\S]*?\*\//g, ' ')), true, 'the runbook type-imports the session (erased at runtime)');
});

test('module/package identity is manifest data: no bare lifecycle family-name literal in the package source', () => {
  // Mirrors the EK-2 dimension workshops.nameBranchLiterals (binding, target
  // zero) over this package's scope: a bare quoted family name anywhere -
  // code OR comment - would count. Dotted/prefixed identifiers are data.
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/;
  for (const file of packageFiles) {
    const raw = readFileSync(file, 'utf8');
    const match = raw.match(rx);
    assert.equal(match, null, `${file}: bare family-name literal ${match?.[0]} (identity belongs to manifest data)`);
  }
});

test('the package owns no driver: no obligation-consumer or scheduler stem', () => {
  for (const file of packageFiles) {
    const name = file.split(/[\\/]/).pop();
    assert.equal(/(obligation-consumer|scheduler|flow-executor|flow-engine|handler-registry)/i.test(name), false, `${name}: a workshop package never owns a driver stem`);
  }
});

test('the package is reachable ONLY from focused tests: no production entrypoint imports it', () => {
  // EK-8 cutover (WP-12): resolver-based importer scan (support/import-scan.mjs)
  // - strictly stronger than the pre-cutover absolute-path regex.
  const offenders = findImporters([
    { dir: join(REPO_ROOT, 'src'), extensions: ['.ts'] },
    { dir: join(REPO_ROOT, 'tools'), extensions: ['.mjs'] },
  ], 'src/workflow-kernel/workshops');
  // EK-8 cutover repin: the ONE production composition is the ONLY legal
  // production importer of the workshop packages (stronger than the
  // pre-cutover zero-importer law: the composition is enumerable).
  const outsideComposition = offenders.map((f) => f.replaceAll('\\', '/')).filter((f) => !f.includes('/src/workflow-kernel/composition/'));
  assert.deepEqual(outsideComposition, [], 'only the ONE production composition may import the workshop packages');
  assert.ok(offenders.length > 0, 'the composition must import this package (the cutover landed)');
});

test('the package builds on the WP-08 vertical by import (no re-implementation)', () => {
  const runbook = codeOf(join(PACKAGE_SRC, 'runbook.ts'));
  assert.equal(/from\s+'\.\.\/\.\.\/development\/material-chain\.js'/.test(runbook), true, 'the runbook imports the WP-08 vertical');
  assert.equal(/driveDevelopmentVertical/.test(runbook), true, 'the runbook drives through the WP-08 staged vertical');
  // No private transition table: the runbook declares no reducer-like data.
  assert.equal(/fromStatuses/.test(runbook), false, 'the runbook holds no private transition table');
});

test('the installed manifest is complete for the workshop semantic interface', async () => {
  const manifest = await import('../../../../dist/workflow-kernel/workshops/development/manifest.js');
  const installation = await import('../../../../dist/workflow-kernel/workshops/development/installation.js');
  const value = manifest.developmentWorkshopInstallation();
  const validated = installation.validateWorkshopInstallation(value);
  assert.equal(validated.valid, true);
  for (const section of ['products', 'checkPlans', 'gates', 'effects', 'waits']) {
    assert.ok(Array.isArray(value[section]) && value[section].length > 0, `the installation declares ${section}`);
  }
  assert.ok(value.installed.skills.length > 0 && value.installed.tools.length > 0 && value.installed.hooks.length > 0, 'skills, tools and hooks are installed');
});
