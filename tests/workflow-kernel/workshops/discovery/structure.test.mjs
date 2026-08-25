/**
 * structure.test.mjs - WP-11D structural fences:
 *   - no workshop-name literals, no scheduler stems (the kernel complexity
 *     budget's binding scans cover this package too);
 *   - the cognition surface imports no persistence surface and executes no
 *     SQL; the driver holds zero SQL string literals (sole-writer law);
 *   - only frozen command ids are composed (the 53-command universe is
 *     closed);
 *   - module/package identity lives ONLY in the installed manifest data -
 *     no code branches on it;
 *   - the package is reachable ONLY from focused tests (no production
 *     entrypoint imports it);
 *   - the EK-8 cutover notes are documented in the owned paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PACKAGE_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'discovery');

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
    else if (path.endsWith('.ts')) entries.push(path);
  }
  return entries;
}
const packageFiles = walk(PACKAGE_SRC);

/** Source with comments stripped: guards scan CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('no workshop-name literals and no scheduler stems (kernel complexity scans)', () => {
  for (const file of packageFiles) {
    const raw = readFileSync(file, 'utf8');
    const workshopLiterals = raw.match(/['"`](discovery|formalization|development|delivery|documentation)['"`]/g) ?? [];
    assert.deepEqual(workshopLiterals, [], `${basename(file)}: no quoted workshop-name literals (workshops.nameBranchLiterals is binding)`);
    assert.equal(/(scheduler|flow-executor|flow-engine|handler-registry)/i.test(basename(file)), false, `${basename(file)}: forbidden scheduler stem`);
  }
});

test('the cognition surface imports no persistence surface and executes no SQL', () => {
  for (const file of [join(PACKAGE_SRC, 'cognition.ts'), join(PACKAGE_SRC, 'products.ts'), join(PACKAGE_SRC, 'checkplans.ts'), join(PACKAGE_SRC, 'contributions.ts'), join(PACKAGE_SRC, 'waits.ts'), join(PACKAGE_SRC, 'role-bindings.ts'), join(PACKAGE_SRC, 'installed-manifest.ts')]) {
    const source = codeOf(file);
    for (const pattern of [
      /from\s+'\.\.\/\.\.\/\.\.\/persistence/,
      /from\s+'\.\.\/\.\.\/persistence/,
      /\bprepare\s*\(/,
      /\bINSERT\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /KernelPersistenceSession/,
      /\bdb\b\s*\./,
      /openKernelDatabase/,
    ]) {
      const match = source.match(pattern);
      assert.equal(match, null, `${basename(file)}: forbidden surface ${pattern} (${match?.[0]})`);
    }
  }
});

test('the driver holds ZERO SQL string literals (sole-writer SQL locality)', () => {
  for (const file of packageFiles) {
    const source = codeOf(file);
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    const sqlLiterals = literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal));
    assert.deepEqual(sqlLiterals, [], `${basename(file)} must not contain SQL literals (the owning repositories own all SQL)`);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${basename(file)} contains a table write`);
    assert.equal(source.match(/CREATE\s+TABLE/i), null, `${basename(file)} creates schema`);
  }
});

test('the 53-command universe is closed: only declared command ids are composed', async () => {
  const { COMMAND_NAMES } = await import('../../../../dist/workflow-kernel/domain/universe.js');
  const declared = new Set(COMMAND_NAMES);
  const commandLike = /['"]([a-zA-Z]+\.[a-zA-Z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*)*)['"]/g;
  for (const file of packageFiles) {
    const source = readFileSync(file, 'utf8');
    let match;
    while ((match = commandLike.exec(source)) !== null) {
      const candidate = match[1];
      if (!/^(factoryRun|lifecycleRun|stageRun|processRun|nodeRun|workplace|activityAttempt|workItem|cognition)\./.test(candidate)) continue;
      assert.ok(declared.has(candidate), `${basename(file)} references "${candidate}" which is not in the frozen 53-command universe`);
    }
  }
});

test('module/package identity lives ONLY in the installed manifest: no code branch on identity', () => {
  for (const file of packageFiles) {
    const source = codeOf(file);
    // No equality/switch branch on the manifest's identity fields.
    assert.equal(source.match(/(moduleId|packageName|moduleVersion)\s*===/), null, `${basename(file)}: identity must never be branched on`);
    assert.equal(source.match(/===\s*['"`](saga\.|process-module:)/), null, `${basename(file)}: no identity literal comparison`);
  }
  // The identity values exist exactly once, in the manifest data document.
  const manifestSource = readFileSync(join(PACKAGE_SRC, 'installed-manifest.ts'), 'utf8');
  assert.ok(manifestSource.includes('moduleId'), 'the manifest declares the module identity');
});

test('the package is reachable ONLY from focused tests: no production entrypoint imports it', () => {
  const offenders = [];
  const scan = (dir, extensions) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, extensions);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const source = codeOf(full);
      if (/workflow-kernel\/workshops\/discovery/.test(source)) {
        offenders.push(full);
      }
    }
  };
  scan(join(REPO_ROOT, 'src'), ['.ts']);
  scan(join(REPO_ROOT, 'tracker-view'), ['.mjs']);
  scan(join(REPO_ROOT, 'tools'), ['.mjs']);
  const allowed = packageFiles.map((file) => file.replaceAll('\\', '/'));
  for (const offender of offenders) {
    const normalized = offender.replaceAll('\\', '/');
    assert.ok(allowed.some((allowedPath) => normalized.endsWith(allowedPath.slice(allowedPath.indexOf('discovery/')))),
      `production path imports the focused-test package: ${offender}`);
  }
});

test('the EK-8 cutover notes are documented in the owned paths', () => {
  const doc = join(PACKAGE_SRC, 'EK8-CUTOVER-NOTES.md');
  assert.equal(existsSync(doc), true, 'src/workflow-kernel/workshops/discovery/EK8-CUTOVER-NOTES.md exists');
  const text = readFileSync(doc, 'utf8');
  for (const legacy of ['src/modules/discovery', 'src/process-modules/modules/discovery', 'discovery-check-providers.ts']) {
    assert.ok(text.includes(legacy), `the cutover notes name ${legacy}`);
  }
  assert.ok(text.includes('NOT deleted'), 'the preserved set is explicit');
});

test('no clock or randomness in the pure decision modules (deterministic, replayable)', () => {
  for (const file of packageFiles) {
    if (basename(file) === 'driver.ts' || basename(file) === 'idea-intake.ts' || basename(file) === 'cognition.ts') continue;
    const source = codeOf(file);
    for (const pattern of [/Date\.now/, /performance\.now/, /setTimeout/, /setInterval/, /Math\.random/]) {
      assert.equal(pattern.test(source), false, `${basename(file)} must not read time or randomness`);
    }
  }
});
