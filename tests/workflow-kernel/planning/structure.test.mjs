/**
 * structure.test.mjs - the EK-6 hard laws of the planning layer (WP-09):
 *
 *   HARD LAW: no planning or settlement decision reads Kanban/task
 *   projection state - structurally (no import, no reference, no SQL).
 *   The layer owns exactly its nine modules, only frozen command ids,
 *   no planner special-casing, no scheduler naming, no direct SQL and no
 *   workshop-name literals (the kernel complexity budget's binding scan).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const planningRoot = fileURLToPath(new URL('../../../src/workflow-kernel/planning/', import.meta.url));
function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) entries.push(...walk(path));
    else if (path.endsWith('.ts')) entries.push(path);
  }
  return entries;
}
const planningFiles = walk(planningRoot);

/** Source with comments stripped: guards scan CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the planning layer owns exactly its nine modules', () => {
  assert.deepEqual(
    planningFiles.map((file) => basename(file)).sort(),
    ['bindings.ts', 'conveyor.ts', 'facts.ts', 'index.ts', 'observed-graphs.ts', 'plan-graph.ts', 'planner-admission.ts', 'readiness.ts', 'settlement.ts'],
  );
});

test('HARD LAW: no planning or settlement decision reads Kanban/task projection state', () => {
  const forbidden = [
    /\bkanban/i,
    /\bcard_id\b/i,
    /\blane\b/i,
    /\bboard\b/i,
    /\btask_status\b/i,
    /\bprojection_table/i,
    /PROJECTION_TABLES/,
    /\btasks\s*\./i,
  ];
  const violations = [];
  for (const file of planningFiles) {
    const source = codeOf(file);
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      if (match) violations.push(`${basename(file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], 'planning and settlement read only kernel ledger facts, never a projection');
});

test('the planning layer contains no SQL at all: reads go through repository public surfaces and the hydrated ledger', () => {
  for (const file of planningFiles) {
    const source = codeOf(file);
    assert.equal(/\bprepare\s*\(/.test(source), false, `${basename(file)} must not prepare SQL statements`);
    assert.equal(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(source), false, `${basename(file)} must not contain SQL statements`);
    assert.equal(/\.db\b/.test(source), false, `${basename(file)} must not touch a raw database handle`);
  }
});

test('the frozen command universe is closed: the layer composes only declared command ids', async () => {
  const { COMMAND_NAMES } = await import('../../../dist/workflow-kernel/domain/universe.js');
  const declared = new Set(COMMAND_NAMES);
  // Every quoted command-like string in the planning sources must be declared.
  const commandLike = /['"]([a-zA-Z]+\.[a-zA-Z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*)*)['"]/g;
  const knownStems = new Set(['workplace.materialize', 'settle.record-node-terminal']);
  for (const file of planningFiles) {
    const source = readFileSync(file, 'utf8');
    let match;
    while ((match = commandLike.exec(source)) !== null) {
      const candidate = match[1];
      // Ignore non-command dotted strings (evidence refs, keys, digests...).
      if (!/^(factoryRun|lifecycleRun|stageRun|processRun|nodeRun|workplace|activityAttempt|workItem|cognition)\./.test(candidate)) continue;
      if (knownStems.has(candidate)) continue;
      assert.ok(
        declared.has(candidate),
        `${basename(file)} references "${candidate}" which is not in the frozen 53-command universe`,
      );
    }
  }
});

test('no planner special-casing anywhere in the planning layer', () => {
  for (const file of planningFiles) {
    const source = codeOf(file);
    assert.equal(/profile\s*===/.test(source), false, `${basename(file)}: no profile equality branch`);
    assert.equal(/plannerBudget|plannerLimits|plannerRelief/.test(source), false, `${basename(file)}: no planner relief vocabulary`);
  }
});

test('no scheduler/flow-engine naming and no workshop-name literals (kernel complexity budget scans)', () => {
  for (const file of planningFiles) {
    const raw = readFileSync(file, 'utf8');
    assert.equal(/(scheduler|flow-executor|flow-engine|handler-registry)/i.test(basename(file)), false, `${basename(file)}: forbidden scheduler stem`);
    const workshopLiterals = raw.match(/['"`](discovery|formalization|development|delivery|documentation)['"`]/g) ?? [];
    assert.deepEqual(workshopLiterals, [], `${basename(file)}: no quoted workshop-name literals (workshops.nameBranchLiterals is binding)`);
  }
});

test('planning and settlement never read a clock or timer (deterministic, replayable decisions)', () => {
  for (const file of planningFiles) {
    const source = codeOf(file);
    for (const pattern of [/Date\.now/, /performance\.now/, /setTimeout/, /setInterval/, /process\.uptime/]) {
      assert.equal(pattern.test(source), false, `${basename(file)} must not read time`);
    }
  }
});
