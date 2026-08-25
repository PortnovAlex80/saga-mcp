/**
 * ratchet.test.mjs - the EK-3 source ratchet (WP-06): zero production schema
 * alteration, zero conversion/backfill, zero parallel-read/write channel,
 * zero legacy adoption, sole-writer SQL locality, and no projection-authority
 * reads inside the kernel tree.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const repositoryRoot = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const kernelRoot = join(repositoryRoot, 'src', 'workflow-kernel');
const persistenceRoot = join(kernelRoot, 'persistence');

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) entries.push(...walk(path));
    else if (path.endsWith('.ts')) entries.push(path);
  }
  return entries;
}

const kernelFiles = walk(kernelRoot);
const persistenceFiles = walk(persistenceRoot);

test('the persistence tree contains no schema-alteration, conversion, backfill, parallel-channel or rescue-path vocabulary', () => {
  const forbidden = [
    /\bALTER\s+TABLE\b/i,
    /\bmigrat(e|es|ed|ion|ions)\b/i,
    /\bbackfill(s|ed)?\b/i,
    /\bdual[- ]?read(s)?\b/i,
    /\bdual[- ]?write(s)?\b/i,
    /\bfall\s?back\b/i,
    /\badopt(s|ed|ion)?\b/i,
  ];
  const violations = [];
  for (const file of persistenceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      if (match) violations.push(`${relative(repositoryRoot, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], 'the fresh-protocol tree is clean of every conversion/rescue vocabulary');
});

test('no schema DDL exists anywhere in the kernel except the one declarative bootstrap', () => {
  for (const file of kernelFiles) {
    const source = readFileSync(file, 'utf8');
    if (file === join(persistenceRoot, 'schema.ts')) continue;
    assert.equal(/\bCREATE\s+(TABLE|TRIGGER|INDEX|UNIQUE\s+INDEX)\b/i.test(source), false, `${basename(file)} must not create schema objects`);
    assert.equal(/\bALTER\s+TABLE\b/i.test(source), false, `${basename(file)} must not alter schema objects`);
    assert.equal(/\bDROP\s+(TABLE|TRIGGER|INDEX)\b/i.test(source), false, `${basename(file)} must not drop schema objects`);
  }
});

test('sole-writer SQL locality: aggregate-owned tables appear in SQL only inside their owning repository file', async () => {
  const { owningAggregateOfTable, AGGREGATE_TABLE_PREFIXES } = await import('../../../dist/workflow-kernel/persistence/schema.js');
  const ownerFileOf = (aggregate) => {
    const prefix = AGGREGATE_TABLE_PREFIXES[aggregate];
    return join(persistenceRoot, `${prefix.replace(/_/g, '-')}-repository.ts`);
  };

  // Extract SQL-looking string/template literals and the tables they touch.
  const literals = [];
  for (const file of kernelFiles) {
    const source = readFileSync(file, 'utf8');
    const pattern = /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const literal = match[1] ?? match[2] ?? '';
      if (/^\s*(select|insert|update|delete|with|replace)\b/i.test(literal)) {
        literals.push({ file, literal });
      }
    }
  }
  assert.ok(literals.length > 20, `the scan must see the kernel's SQL literals (found ${literals.length})`);

  const violations = [];
  for (const { file, literal } of literals) {
    const tablePattern = /\b(?:from|join|update|into)\s+([a-z_][a-z_0-9]*)/gi;
    let match;
    while ((match = tablePattern.exec(literal)) !== null) {
      const table = match[1];
      const owner = owningAggregateOfTable(table);
      if (owner === undefined) continue;
      if (file !== ownerFileOf(owner)) {
        violations.push(`${relative(repositoryRoot, file)} touches ${table} (owned by ${owner}) outside ${basename(ownerFileOf(owner))}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'every aggregate-owned SQL statement lives in its sole-writer repository file');
});

test('exactly one repository file per frozen aggregate (9 repositories)', async () => {
  const budget = (await import('../../../docs/refactoring/event-kernel/specs/complexity-budget.json', { with: { type: 'json' } })).default;
  const prefixes = budget.lawfulRepositoryConvention.aggregateTablePrefixes;
  for (const [aggregate, prefix] of Object.entries(prefixes)) {
    const expected = join(persistenceRoot, `${prefix.replace(/_/g, '-')}-repository.ts`);
    assert.ok(persistenceFiles.includes(expected), `${aggregate} repository file ${basename(expected)} exists`);
  }
  const repositoryFiles = persistenceFiles.filter((file) => basename(file).endsWith('-repository.ts'));
  assert.equal(repositoryFiles.length, 9, 'exactly nine sole-writer repository files');
});

test('the kernel never reads the Kanban projection as authority', async () => {
  const { PROJECTION_TABLES } = await import('../../../dist/workflow-kernel/persistence/schema.js');
  for (const file of kernelFiles) {
    const source = readFileSync(file, 'utf8');
    const pattern = /'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const literal = match[1] ?? match[2] ?? '';
      if (!/^\s*(select|insert|update|delete|with|replace)\b/i.test(literal)) continue;
      for (const table of PROJECTION_TABLES) {
        assert.equal(
          new RegExp(`\\b(?:from|join|update|into)\\s+${table}\\b`, 'i').test(literal),
          false,
          `${basename(file)} must not touch the disposable projection ${table} (the EK-7 projector owns it)`,
        );
      }
    }
  }
});

test('the pure domain still imports nothing from persistence (one direction of dependency)', () => {
  const domainFiles = walk(join(kernelRoot, 'domain'));
  for (const file of domainFiles) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/['"]\.\.\/persistence|['"]\.\.\/\.\.\/persistence|workflow-kernel\/persistence/.test(source), false, `${basename(file)} must stay pure of persistence`);
  }
});

test('the production entrypoint still does not reach the fresh bootstrap (pre-cutover isolation)', () => {
  // EK-8 performs the hard cutover; until then nothing outside
  // src/workflow-kernel/** may import the persistence layer.
  const srcRoot = join(repositoryRoot, 'src');
  for (const file of walk(srcRoot)) {
    if (file.startsWith(persistenceRoot)) continue;
    const source = readFileSync(file, 'utf8');
    assert.equal(/workflow-kernel\/persistence/.test(source), false, `${relative(repositoryRoot, file)} must not reach the fresh protocol before the EK-8 cutover`);
  }
});
