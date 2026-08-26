/**
 * structure.test.mjs - WP-11L: the structural fences of the Delivery
 * workshop package.
 *   - The package holds ZERO SQL (the sole-writer law: all SQL lives in
 *     the owning repositories; the WP-06 ratchet applies to this layer).
 *   - No legacy import: nothing under src/modules/** or
 *     src/process-modules/** is imported (the legacy Delivery module is
 *     semantic reference only).
 *   - No kernel conditional on workshop identity: the package may not
 *     compare a quoted workshop name (manifest data carries semantics;
 *     the complexity dimension workshops.nameBranchLiterals stays 0).
 *   - Manifest data only: no scheduler, no private state table, no
 *     credentials, no network send surface in the package.
 *   - The package is reachable ONLY from focused tests: no production
 *     entrypoint outside src/workflow-kernel imports it.
 *   - The EK-8 deletion set is documented in the owned paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImporters } from '../../support/import-scan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGE_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'delivery');

/** Source with comments stripped: the guard scans CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function packageFiles() {
  return readdirSync(PACKAGE_SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(PACKAGE_SRC, name));
}

test('the delivery package executes no SQL (zero SQL string literals)', () => {
  for (const file of packageFiles()) {
    const source = codeOf(file);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${file} contains an INSERT`);
    assert.equal(source.match(/\bUPDATE\s+[a-z_]+\s+SET\b/i), null, `${file} contains an UPDATE`);
    assert.equal(source.match(/\bDELETE\s+FROM\b/i), null, `${file} contains a DELETE`);
    assert.equal(source.match(/CREATE\s+TABLE/i), null, `${file} creates schema`);
    assert.equal(source.match(/\.prepare\s*\(/), null, `${file} prepares a statement`);
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    const sqlLiterals = literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal));
    assert.deepEqual(sqlLiterals, [], `${file} must not contain SQL literals (the owning repositories own all SQL)`);
  }
});

test('the delivery package imports no legacy module (semantic reference only, never linked)', () => {
  for (const file of packageFiles()) {
    const source = codeOf(file);
    assert.equal(source.match(/from\s+'[^']*\/modules\//), null, `${file} imports a legacy src/modules path`);
    assert.equal(source.match(/from\s+'[^']*process-modules/), null, `${file} imports a legacy process-modules path`);
    assert.equal(source.match(/sqlite-delivery-approval-inbox/), null, `${file} references the legacy approval inbox implementation`);
  }
});

test('no kernel conditional on workshop identity (manifest data carries semantics)', () => {
  // The complexity dimension workshops.nameBranchLiterals (target 0,
  // binding now) forbids quoted workshop-name literals anywhere in
  // src/workflow-kernel/**; this package keeps that law locally too.
  for (const file of packageFiles()) {
    const source = codeOf(file);
    const quoted = source.match(/['"`](discovery|formalization|development|delivery|documentation)['"`]/g) ?? [];
    assert.deepEqual(quoted, [], `${file} quotes a workshop-name literal (workshops.nameBranchLiterals must stay 0)`);
  }
});

test('the package declares no scheduler, no credential VALUE surface, no network send', () => {
  for (const file of packageFiles()) {
    const source = codeOf(file);
    assert.equal(source.match(/\bfetch\s*\(/), null, `${file} performs a network fetch (local packaging only)`);
    assert.equal(source.match(/\bhttps?:\/\//), null, `${file} names a network endpoint`);
    // Credential VALUES are forbidden: no assignment, read or storage of a
    // credential anywhere in the package. The declared policy FIELD
    // (`credentials: "none"` and its typed-equality/printout shapes) is
    // manifest data; prose inside typed refusal details is not a surface.
    const noneOnly = source
      .replace(/readonly credentials:\s*'none'/g, '')
      .replace(/credentials:\s*'none'\s*(as const)?/g, '')
      .replace(/credentials\s*[!=]==?\s*'none'/g, '')
      .replace(/credentials\s*=\$\{String\((?:policy|input)\.credentials\)\}/g, '')
      .replace(/\.\bcredentials\b/g, '')
      .replace(/\bcredentials\b/g, '');
    assert.equal(noneOnly.match(/(password|secret|api[_-]?key|credential)\s*[:=]/i), null, `${file} assigns or reads a credential value surface beyond the none declaration`);
    assert.equal(source.match(/\bprocess\.env\b/), null, `${file} reads environment secrets`);
    assert.equal(source.match(/setInterval|setTimeout\s*\(/), null, `${file} owns a timer (no workshop scheduler)`);
  }
});

test('the package is reachable ONLY from focused tests: no production entrypoint imports it', () => {
  // EK-8 cutover (WP-12): resolver-based importer scan (support/import-scan.mjs)
  // - strictly stronger than the pre-cutover absolute-path regex.
  const offenders = findImporters([
    { dir: join(REPO_ROOT, 'src'), extensions: ['.ts'] },
    { dir: join(REPO_ROOT, 'tools'), extensions: ['.mjs'] },
  ], 'src/workflow-kernel/workshops/delivery');
  const allowed = new Set(packageFiles().map((file) => file.replaceAll('\\', '/')));
  // EK-8 cutover repin: the ONE production composition is additionally the
  // sole legal production importer (pre-cutover this was test-only reach).
  for (const offender of offenders) {
    const normalized = offender.replaceAll('\\', '/');
    const packageInternal = [...allowed].some((allowedPath) => normalized.endsWith(allowedPath.slice(allowedPath.indexOf('workshops/delivery/'))));
    assert.ok(
      packageInternal || normalized.includes('/src/workflow-kernel/composition/'),
      `production path outside the ONE composition imports the focused-test workshop package: ${offender}`,
    );
  }
  assert.ok(offenders.some((offender) => offender.replaceAll('\\', '/').includes('/src/workflow-kernel/composition/')), 'the composition must import this package (the cutover landed)');
});

test('the EK-8 legacy deletion set is documented in the owned paths', () => {
  const doc = join(PACKAGE_SRC, 'EK8-DELETION-SET.md');
  assert.equal(existsSync(doc), true, 'src/workflow-kernel/workshops/delivery/EK8-DELETION-SET.md exists');
  const text = readFileSync(doc, 'utf8');
  for (const legacy of [
    'src/modules/delivery',
    'sqlite-delivery-approval-inbox.ts',
    'product-delivery-lifecycle.ts',
    'factory_delivery_approval_requests',
  ]) {
    assert.ok(text.includes(legacy), `the deletion set names ${legacy}`);
  }
  assert.ok(text.includes('NOT deleted'), 'the preserved set is explicit');
});
