/**
 * structure.test.mjs - WP-08 deliverable 9: the structural fences.
 *   - The actors module (scripted/replay/real) imports NO persistence
 *     surface, executes no SQL, and cannot write factory tables, fabricate
 *     receipts or skip ingress.
 *   - The new vertical is reachable ONLY from focused tests: no production
 *     entrypoint outside src/workflow-kernel imports it.
 *   - The sole-writer law: the development layer executes no aggregate-owned
 *     SQL writes (its only direct SQL is the read-only receipt lookup).
 *   - The EK-8 deletion set is documented in the owned paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImporters } from '../support/import-scan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEVELOPMENT_SRC = join(REPO_ROOT, 'src', 'workflow-kernel', 'development');

/** Source with comments stripped: the guard scans CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function developmentFiles() {
  return readdirSync(DEVELOPMENT_SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(DEVELOPMENT_SRC, name));
}

test('the cognition actors import no persistence surface and execute no SQL', () => {
  for (const file of [join(DEVELOPMENT_SRC, 'actors.ts'), join(DEVELOPMENT_SRC, 'envelope-assembly.ts'), join(DEVELOPMENT_SRC, 'role-contract-runtime.ts')]) {
    const source = codeOf(file);
    const forbidden = [
      /from\s+'\.\.\/persistence/,
      /from\s+'\.\.\/\.\.\/persistence/,
      /\bprepare\s*\(/,
      /\bINSERT\b/i,
      /\bUPDATE\b\s+\w+/i,
      /\bDELETE\b\s+FROM/i,
      /KernelPersistenceSession/,
      /\bdb\b\s*\./,
      /openKernelDatabase/,
    ];
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      assert.equal(match, null, `${file}: forbidden surface ${pattern} (${match?.[0]})`);
    }
  }
});

test('the development layer never writes aggregate-owned SQL (zero direct SQL anywhere)', () => {
  for (const file of developmentFiles()) {
    const source = codeOf(file);
    assert.equal(source.match(/\bINSERT\s+INTO\b/i), null, `${file} contains an aggregate-table write`);
    assert.equal(source.match(/\bUPDATE\s+[a-z_]+\s+SET\b/i), null, `${file} contains an UPDATE write`);
    assert.equal(source.match(/\bDELETE\s+FROM\b/i), null, `${file} contains a DELETE write`);
    assert.equal(source.match(/CREATE\s+TABLE/i), null, `${file} creates schema (fresh-protocol-only violation)`);
    // The WP-06 sole-writer SQL-locality ratchet forbids aggregate-owned
    // tables in ANY SQL outside the owning repository file (reads included):
    // the development layer therefore holds ZERO SQL string literals.
    const literals = source.match(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g) ?? [];
    const sqlLiterals = literals.filter((literal) => /^\s*['"`]?\s*(select|insert|update|delete|with|replace)\b/i.test(literal));
    assert.deepEqual(sqlLiterals, [], `${file} must not contain SQL literals (the owning repositories own all SQL)`);
  }
});

test('the vertical is reachable ONLY from focused tests: no production entrypoint imports it', () => {
  const developmentFilesSet = new Set(developmentFiles());
  // EK-8 cutover (WP-12): resolver-based importer scan (support/import-scan.mjs)
  // - strictly stronger than the pre-cutover absolute-path regex.
  const offenders = findImporters([
    { dir: join(REPO_ROOT, 'src'), extensions: ['.ts'] },
    { dir: join(REPO_ROOT, 'tools'), extensions: ['.mjs'] },
  ], 'src/workflow-kernel/development');
  // Only the development package's own index may re-export it.
  const allowed = [...developmentFilesSet].map((file) => file.replaceAll('\\', '/'));
  // EK-8 cutover repin: pre-cutover the vertical was test-only reachable
  // (zero production importers outside tests). Post-cutover the law is:
  // NOTHING outside src/workflow-kernel/** may import the vertical (the
  // legacy entrypoints are deleted), and the ONE production composition
  // does import it. Intra-kernel consumers (e.g. the projection adapters
  // taking the RoleContractRuntime) are kernel structure, governed by the
  // dependency-direction ratchets, not by this entrypoint law - and the
  // resolver-based scan now SEES them, which the old regex never did.
  for (const offender of offenders) {
    const normalized = offender.replaceAll('\\', '/');
    assert.ok(normalized.includes('/src/workflow-kernel/'),
      `production path outside the kernel imports the vertical: ${offender}`);
  }
  assert.ok(offenders.some((offender) => offender.replaceAll('\\', '/').includes('/src/workflow-kernel/composition/')), 'the composition must import the vertical (the cutover landed)');
});

test('the EK-8 legacy deletion set is documented in the owned paths', () => {
  const doc = join(DEVELOPMENT_SRC, 'EK8-DELETION-SET.md');
  assert.equal(existsSync(doc), true, 'src/workflow-kernel/development/EK8-DELETION-SET.md exists');
  const text = readFileSync(doc, 'utf8');
  for (const legacy of [
    'src/modules/development',
    'src/process-modules/modules/development',
    'sqlite-author-candidate-carry-forward.ts',
    'sqlite-production-cell-integration.ts',
    'claude-worker-executor-factory.ts',
  ]) {
    assert.ok(text.includes(legacy), `the deletion set names ${legacy}`);
  }
  assert.ok(text.includes('NOT deleted'), 'the preserved set is explicit');
});

test('the corpus fixture owns its acceptance contract surfaces', async () => {
  const acceptance = await import('../../../dist/workflow-kernel/development/product-acceptance.js');
  const loaded = acceptance.loadAcceptanceContract(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server'));
  assert.equal(loaded.refused, undefined);
  assert.deepEqual(acceptance.missingIntegrationSurfaces(join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server'), loaded.contract), []);
});
