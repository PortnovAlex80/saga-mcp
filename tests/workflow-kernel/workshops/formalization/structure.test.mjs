/**
 * structure.test.mjs - the WP-11F structural fences:
 *   - the pure modules (products, manifest, ingress verification, gates,
 *     effects, envelope, actors, roles) import NO persistence surface,
 *     execute no SQL and cannot write factory tables;
 *   - the whole package composes ONLY frozen command ids (the 53-command
 *     universe is closed);
 *   - no quoted workshop-name literal appears anywhere in kernel scope
 *     (the complexity dimension workshops.nameBranchLiterals stays 0);
 *   - the package is reachable ONLY from focused tests (no production
 *     entrypoint imports it);
 *   - the EK-8 deletion set is documented in the owned paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImporters } from '../../support/import-scan.mjs';

const REPO_ROOT = join(dirnameOf(import.meta.url), '..', '..', '..', '..');
const PACKAGE_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization');

function dirnameOf(url) {
  return join(fileURLToPath(url), '..');
}

function walk(dir, filter = () => true) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!filter(path + '/')) continue;
      entries.push(...walk(path, filter));
    } else if (path.endsWith('.ts') && filter(path)) entries.push(path);
  }
  return entries;
}

// FRF-WP11 cutover: the cells/ and contracts/ subtrees are INSTALLED
// package surfaces (the desks gate through the cells; the WP03 contracts
// live in-package at their canonical home). The module pin below covers
// the package ROOT (kernel-mechanics modules); the subtrees carry their
// own per-cell structure suites, and the contracts tree is pinned by the
// FRF removal guard (docs snapshot byte-equality + the pinned digests).
const packageFiles = walk(PACKAGE_SRC, (p) => !p.split(/[\\/]/).includes('cells') && !p.split(/[\\/]/).includes('contracts'));

/** Source with comments stripped: the guards scan CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the package owns exactly its root mechanics modules plus the installed cells/contracts subtrees', () => {
  // The FRF-WP11 shape: the old products.ts + contribution.ts died at the
  // cutover (replaced by the cells and the in-package contracts); the
  // shared content-addressing vocabulary re-homed to contracts/artifacts.ts.
  assert.deepEqual(
    packageFiles.map((file) => basename(file)).sort(),
    ['actors.ts', 'driver.ts', 'effects.ts', 'envelope.ts', 'gates.ts', 'index.ts', 'ingress.ts', 'manifest.ts', 'roles.ts'],
  );
  // The installed subtrees exist (the cells + the canonical WP03 contracts).
  assert.equal(existsSync(join(PACKAGE_SRC, 'cells', 'dispatch.mjs')), true, 'the installed semantic dispatch exists');
  for (const cell of ['acceptance', 'product-intent', 'srs-realization', 'system-requirements', 'use-cases', 'what-freeze']) {
    assert.equal(statSync(join(PACKAGE_SRC, 'cells', cell)).isDirectory(), true, `the ${cell} cell is installed`);
  }
  assert.equal(existsSync(join(PACKAGE_SRC, 'contracts', 'validators', 'common.mjs')), true, 'the canonical WP03 contracts tree exists');
  assert.equal(existsSync(join(PACKAGE_SRC, 'contracts', 'identity.ts')), true, 'the pinned contract identity table exists');
});

test('the cognition actors and pure validators import no persistence surface and execute no SQL', () => {
  for (const file of [join(PACKAGE_SRC, 'actors.ts'), join(PACKAGE_SRC, 'envelope.ts'), join(PACKAGE_SRC, 'roles.ts'), join(PACKAGE_SRC, 'contracts', 'artifacts.ts'), join(PACKAGE_SRC, 'contracts', 'identity.ts'), join(PACKAGE_SRC, 'gates.ts'), join(PACKAGE_SRC, 'effects.ts'), join(PACKAGE_SRC, 'manifest.ts')]) {
    const source = codeOf(file);
    const forbidden = [
      /from\s+'\.\.\/\.\.\/\.\.\/persistence/,
      /\bprepare\s*\(/,
      /\bINSERT\b/i,
      /\bUPDATE\s+\w+/i,
      /\bDELETE\b\s+FROM/i,
      /KernelPersistenceSession/,
      /openKernelDatabase/,
    ];
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      assert.equal(match, null, `${basename(file)}: forbidden surface ${pattern} (${match?.[0]})`);
    }
  }
});

test('the package never writes aggregate-owned SQL (zero SQL string literals anywhere)', () => {
  for (const file of packageFiles.filter((file) => file.endsWith('.ts'))) {
    const source = codeOf(file);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${basename(file)} contains an aggregate-table write`);
    assert.equal(source.match(/\bUPDATE\s+[a-z_]+\s+SET\b/i), null, `${basename(file)} contains an UPDATE write`);
    assert.equal(source.match(/\bDELETE\s+FROM\b/i), null, `${basename(file)} contains a DELETE write`);
    assert.equal(source.match(/CREATE\s+TABLE/i), null, `${basename(file)} creates schema`);
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    const sqlLiterals = literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal));
    assert.deepEqual(sqlLiterals, [], `${basename(file)} must not contain SQL literals (the owning repositories own all SQL)`);
  }
});

test('the frozen command universe is closed: only declared command ids are composed', async () => {
  const { COMMAND_NAMES } = await import('../../../../dist/workflow-kernel/domain/universe.js');
  const declared = new Set(COMMAND_NAMES);
  const commandLike = /['"]([a-zA-Z]+\.[a-zA-Z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*)*)['"]/g;
  for (const file of packageFiles.filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    let match;
    while ((match = commandLike.exec(source)) !== null) {
      const candidate = match[1];
      if (!/^(factoryRun|lifecycleRun|stageRun|processRun|nodeRun|workplace|activityAttempt|workItem|cognition)\./.test(candidate)) continue;
      assert.ok(
        declared.has(candidate),
        `${basename(file)} references "${candidate}" which is not in the frozen 53-command universe`,
      );
    }
  }
});

test('no quoted workshop-name literal in kernel scope (workshops.nameBranchLiterals stays 0)', () => {
  const kernelRoot = join(REPO_ROOT, 'src', 'workflow-kernel');
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/g;
  let hits = 0;
  for (const file of walk(kernelRoot)) {
    hits += (readFileSync(file, 'utf8').match(rx) ?? []).length;
  }
  assert.equal(hits, 0, 'a bare workshop-name literal entered kernel scope (complexity dimension red)');
});

test('the package is reachable ONLY from focused tests: no production entrypoint imports it', () => {
  // EK-8 cutover (WP-12): resolver-based importer scan (support/import-scan.mjs)
  // - strictly stronger than the pre-cutover absolute-path regex.
  const offenders = findImporters([
    { dir: join(REPO_ROOT, 'src'), extensions: ['.ts'] },
    { dir: join(REPO_ROOT, 'tools'), extensions: ['.mjs'] },
  ], 'src/workflow-kernel/workshops/formalization');
  // Only this package's own sources may reference it (relative imports).
  const allowedRoot = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization');
  // EK-8 cutover repin: the ONE production composition is additionally the
  // sole legal production importer (pre-cutover this was test-only reach).
  const compositionRoot = join(REPO_ROOT, 'src', 'workflow-kernel', 'composition');
  for (const offender of offenders) {
    assert.ok(
      offender.startsWith(allowedRoot) || offender.startsWith(compositionRoot),
      `production path outside the ONE composition imports the focused-test workshop package: ${offender}`,
    );
  }
  assert.ok(offenders.some((offender) => offender.startsWith(compositionRoot)), 'the composition must import this package (the cutover landed)');
});

test('the kernel never conditions on workshop identity: no module-identity branch in kernel packages', () => {
  const kernelPackages = [
    join(REPO_ROOT, 'src', 'workflow-kernel', 'domain'),
    join(REPO_ROOT, 'src', 'workflow-kernel', 'application'),
    join(REPO_ROOT, 'src', 'workflow-kernel', 'persistence'),
    join(REPO_ROOT, 'src', 'workflow-kernel', 'planning'),
    join(REPO_ROOT, 'src', 'workflow-kernel', 'roles'),
    join(REPO_ROOT, 'src', 'workflow-kernel', 'context-envelope'),
  ];
  const rx = /workshops\/formalization|workshop:solution-formalization/;
  for (const dir of kernelPackages) {
    for (const file of walk(dir)) {
      const source = codeOf(file);
      assert.equal(source.match(rx), null, `${basename(file)}: a kernel path references the workshop identity`);
    }
  }
});

test('the EK-8 legacy deletion set is documented in the owned paths', () => {
  const doc = join(PACKAGE_SRC, 'EK8-DELETION-SET.md');
  assert.equal(existsSync(doc), true, 'src/workflow-kernel/workshops/formalization/EK8-DELETION-SET.md exists');
  const text = readFileSync(doc, 'utf8');
  for (const legacy of [
    'src/modules/formalization',
    'src/process-modules/modules/formalization',
    'formalization-process-module.ts',
    'freeze-acceptance-baseline',
    'sqlite-formalization-kernel.ts',
  ]) {
    assert.ok(text.includes(legacy), `the deletion set names ${legacy}`);
  }
  assert.ok(text.includes('NOT deleted'), 'the preserved set is explicit');
});

test('the driver reads no clock and no board (deterministic, replayable decisions)', () => {
  for (const file of packageFiles.filter((f) => f.endsWith('.ts'))) {
    const source = codeOf(file);
    for (const pattern of [/Date\.now/, /performance\.now/, /setTimeout/, /setInterval/, /process\.uptime/, /\bkanban/i, /\bboard\b/i, /\btask_status\b/i]) {
      assert.equal(pattern.test(source), false, `${basename(file)} must not read time or projections`);
    }
  }
});
