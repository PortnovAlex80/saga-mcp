// Unit tests for decideTopology (SRS-004 §2b.5, AC-9).
//
// Pure unit test — no database. Verifies the deterministic switch on
// brief.topology_hint (sequence → A, scaffold-then-parallel → B + scaffold_task,
// parallel-independent → parallel) and the scaffold-task title/artifacts
// construction (SRS §2b.5 "Контракт SCAFFOLD-задачи"). Run against compiled JS.
//
// Usage:  node --test tests/planner-ac9/topology.test.mjs
import { decideTopology } from '../../dist/planner/topology.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseBrief = {
  classification: 'product',
  complexity: { tshirt: 'M', risk_triggers: ['r1'] },
  decision: 'go',
  reasoning: 'cross-project change',
  affected_projects: [1, 2],
  topology_hint: 'sequence',
  scaffold_artifacts: ['docs/x.md'],
  shared_mutation_risk: false,
  completeness: 'high',
  degraded: false,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

test("topology_hint='sequence' → Pattern A-sequence (no scaffold_task)", () => {
  const d = decideTopology(clone(baseBrief));
  assert.equal(d.pattern, 'A-sequence');
  assert.equal(d.scaffold_task, undefined);
});

test("topology_hint='parallel-independent' → Pattern parallel (no scaffold_task)", () => {
  const b = clone(baseBrief); b.topology_hint = 'parallel-independent';
  const d = decideTopology(b);
  assert.equal(d.pattern, 'parallel');
  assert.equal(d.scaffold_task, undefined);
});

test("topology_hint='scaffold-then-parallel' → Pattern B with scaffold_task", () => {
  const b = clone(baseBrief);
  b.topology_hint = 'scaffold-then-parallel';
  b.scaffold_artifacts = ['src/planner/cascade.ts', 'src/planner/topology.ts'];
  const d = decideTopology(b);
  assert.equal(d.pattern, 'B-scaffold-then-parallel');
  assert.ok(d.scaffold_task, 'scaffold_task missing for Pattern B');
  assert.equal(
    d.scaffold_task.title,
    'SCAFFOLD: src/planner/cascade.ts, src/planner/topology.ts',
  );
  assert.deepEqual(d.scaffold_task.scaffold_artifacts, [
    'src/planner/cascade.ts', 'src/planner/topology.ts',
  ]);
});

test('Pattern B scaffold title = "SCAFFOLD: " + artifacts.join(", ")', () => {
  const b = clone(baseBrief);
  b.topology_hint = 'scaffold-then-parallel';
  b.scaffold_artifacts = ['a.md', 'b.md', 'c.md'];
  const d = decideTopology(b);
  assert.equal(d.scaffold_task.title, 'SCAFFOLD: a.md, b.md, c.md');
});

test('Pattern B carries scaffold_artifacts verbatim (does not synthesise paths)', () => {
  const b = clone(baseBrief);
  b.topology_hint = 'scaffold-then-parallel';
  b.scaffold_artifacts = ['only.md'];
  const d = decideTopology(b);
  assert.deepEqual(d.scaffold_task.scaffold_artifacts, ['only.md']);
});

test('Pattern B tolerates missing/empty scaffold_artifacts (carries [] through)', () => {
  const b = clone(baseBrief);
  b.topology_hint = 'scaffold-then-parallel';
  b.scaffold_artifacts = [];
  const d = decideTopology(b);
  assert.equal(d.pattern, 'B-scaffold-then-parallel');
  assert.deepEqual(d.scaffold_task.scaffold_artifacts, []);
  assert.equal(d.scaffold_task.title, 'SCAFFOLD: ');
});

test('decideTopology is deterministic: same brief → same decision', () => {
  const b = clone(baseBrief); b.topology_hint = 'scaffold-then-parallel';
  const d1 = decideTopology(b);
  const d2 = decideTopology(b);
  assert.deepEqual(d1, d2);
});

test('decideTopology is pure: does not mutate the brief', () => {
  const b = clone(baseBrief);
  b.topology_hint = 'scaffold-then-parallel';
  const before = JSON.stringify(b);
  decideTopology(b);
  assert.equal(JSON.stringify(b), before, 'brief was mutated');
});

test('null brief throws an explicit error (no silent fallback)', () => {
  assert.throws(() => decideTopology(null), /brief must be a non-null object/);
});

test('non-object brief throws', () => {
  assert.throws(() => decideTopology('x'), /brief must be a non-null object/);
});

test('missing topology_hint throws (must come from the brief)', () => {
  const b = clone(baseBrief); delete b.topology_hint;
  assert.throws(() => decideTopology(b), /topology_hint must be a string/);
});

test('unknown topology_hint literal throws loudly', () => {
  const b = clone(baseBrief); b.topology_hint = 'inverted-helix';
  assert.throws(() => decideTopology(b), /unknown topology_hint 'inverted-helix'/);
});
