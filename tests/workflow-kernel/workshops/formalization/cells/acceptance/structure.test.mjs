/**
 * structure.test.mjs - the FRF-WP06 acceptance-cell structural fences:
 *   - TEST-ONLY REACHABLE: no compiled production module (no .ts under
 *     src) imports the cells package, and dist/ contains no cell
 *     output; the installed workshop's eleven-module enumeration is
 *     unchanged (the FRF-WP11 cutover installs the cells package);
 *   - PURITY: the cell modules contain no SQL, no clock, no board
 *     reads, no persistence imports;
 *   - NO bare quoted workshop-name literal enters the cell sources
 *     (the complexity dimension stays 0);
 *   - the closed vocabularies equal the frozen WP03 schema enums;
 *   - the installed package is byte-unchanged by this work package
 *     (WP06 owns ONLY the cells/acceptance subtree).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const CELL_SRC = join(ROOT, 'src/workflow-kernel/workshops/formalization/cells/acceptance');
const INSTALLED_SRC = join(ROOT, 'src/workflow-kernel/workshops/formalization');
const DOCS_CONTRACTS = join(ROOT, 'docs/refactoring/formalization-frf/contracts');

function walk(dir, filter = () => true) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) entries.push(...walk(path, filter));
    else if (filter(path)) entries.push(path);
  }
  return entries;
}

const cellFiles = walk(CELL_SRC, (p) => p.endsWith('.mjs'));
const expectedModules = [
  'check-plan.mjs', 'closure.mjs', 'gate.mjs', 'index.mjs', 'protocol.mjs',
  'reconciliation.mjs', 'reviewer.mjs', 'desk-roles.mjs', 'skill.mjs',
  'template.mjs', 'wp03-seam.mjs',
];
const README = 'README.md';

test('the cell owns exactly its eleven modules plus the seam README', () => {
  const names = walk(CELL_SRC).map((p) => p.slice(CELL_SRC.length + 1)).sort();
  assert.deepEqual(names, [...expectedModules, README].sort());
});

test('TEST-ONLY REACHABLE: no production .ts module imports the cells package', () => {
  const offenders = [];
  for (const file of walk(join(ROOT, 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
    const source = readFileSync(file, 'utf8');
    if (source.includes('cells/acceptance') || source.includes('cells\\acceptance')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'the cells package is reachable only from focused tests until the FRF-WP11 cutover');
  // And the compiler emits nothing for it: dist has no cells subtree.
  assert.equal(existsSync(join(ROOT, 'dist/workflow-kernel/workshops/formalization/cells/acceptance')), false, 'dist must contain no ACCEPTANCE cell output (the .mjs cell never compiles; the sibling .ts cells compile test-only until FRF-WP11)');
  assert.equal(existsSync(join(ROOT, 'dist/workflow-kernel/workshops/formalization/cells/what-freeze')), false, 'the what-freeze .mjs cell never compiles');
});

test('the installed workshop enumeration is unchanged (the eleven modules)', () => {
  // The pinned law of the installed structure test, restated for this
  // package's blast radius: WP06 adds ONLY the cells/acceptance subtree.
  const installed = readdirSync(INSTALLED_SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name)
    .sort();
  assert.deepEqual(installed, [
    'actors.ts', 'contribution.ts', 'driver.ts', 'effects.ts', 'envelope.ts',
    'gates.ts', 'index.ts', 'ingress.ts', 'manifest.ts', 'products.ts', 'roles.ts',
  ]);
});

test('PURITY: no SQL, no clock, no board, no persistence in the cell modules', () => {
  const codeOf = (file) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const file of cellFiles) {
    const source = codeOf(file);
    for (const pattern of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+[a-z_]+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /CREATE\s+TABLE/i,
      /from\s+'\.\.+\/(?:\.\.+\/)*persistence/,
      /KernelPersistenceSession/,
      /openKernelDatabase/,
      /Date\.now/,
      /performance\.now/,
      /setTimeout/,
      /setInterval/,
      /process\.uptime/,
      /\bkanban/i,
      /\btask_status\b/i,
    ]) {
      const match = source.match(pattern);
      assert.equal(match, null, `${file}: forbidden surface ${pattern} (${match?.[0]})`);
    }
  }
});

test('no bare quoted workshop-name literal in the cell sources', () => {
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/g;
  for (const file of cellFiles) {
    const hits = readFileSync(file, 'utf8').match(rx) ?? [];
    assert.deepEqual(hits, [], `${file}: a bare workshop-name literal (complexity dimension red)`);
  }
});

test('the closed vocabularies equal the frozen WP03 schema enums', async () => {
  const schema = JSON.parse(readFileSync(join(DOCS_CONTRACTS, 'schemas/ac-binding.schema.json'), 'utf8'));
  const evidenceEnum = schema.properties.evidence.properties.evidenceKind.enum;
  const moduleImport = (path) => import(pathToFileURL(path).href);
  const protocol = await moduleImport(join(CELL_SRC, 'protocol.mjs'));
  assert.deepEqual([...protocol.EVIDENCE_KINDS], [...evidenceEnum].sort());
  const closure = await moduleImport(join(CELL_SRC, 'closure.mjs'));
  assert.deepEqual([...closure.REFUSAL_REASONS].sort(), [
    'COVERAGE_GAP', 'DRIFT_DETECTED', 'FOREIGN_LINEAGE', 'MALFORMED_PRODUCT',
    'MISSING_LINEAGE', 'SCOPE_VIOLATION', 'STALE_LINEAGE',
  ]);
});
