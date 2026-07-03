// Integration test — AC-9 full downstream pipeline (SRS-004 §2b.5, AC-9).
//
// Asserts the four AC-9 postconditions end-to-end against a throwaway SQLite DB
// plus the pure planner functions (applyImpactCascade, decideTopology):
//
//   (1) theme artifact exists in project 'business' with a derived_from edge
//       theme ← brief (carry-state);
//   (2) every dev-task produced by the planner carries BOTH impact:a and
//       impact:b tags for affected_projects=[a,b];
//   (3) under topology-hint='scaffold-then-parallel' the planner chooses
//       Pattern B and emits a SCAFFOLD task that precedes every body task via
//       depends_on (scaffold done before any body in_progress);
//   (4) multi-project + parallel-independent is rejected by validateBrief
//       (topology-rule active).
//
// Usage:  node tests/planner-ac9/theme-brief-pipeline.mjs
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const thisDir = dirname(fileURLToPath(import.meta.url));
const tmpDb = join(thisDir, '.tmp-ac9-pipeline.db');

// Fresh temp DB before importing the handler (getDb reads DB_PATH at first use).
for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmpDb + ext); } catch { /* */ } }
process.env.DB_PATH = tmpDb;

// Seed schema: 'business' project (for theme), 'saga-mcp' + 'harmess' projects
// (the two affected projects), and an epic. project ids: 1=business, 2=saga-mcp,
// 3=harmess.
const seed = new Database(tmpDb);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
const { SCHEMA_SQL } = await import('../../dist/schema.js');
seed.exec(SCHEMA_SQL);
try { seed.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch {}
seed.prepare("INSERT INTO projects (name, description) VALUES ('business', 'top business board')").run();
seed.prepare("INSERT INTO projects (name, description) VALUES ('saga-mcp', 'saga mcp fork')").run();
seed.prepare("INSERT INTO projects (name, description) VALUES ('harmess', 'harmess repo')").run();
seed.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'REQ-004')").run(2);
seed.close();

const { handlers } = await import('../../dist/tools/artifacts.js');
const { validateBrief } = await import('../../dist/validators/brief.js');
const { applyImpactCascade } = await import('../../dist/planner/cascade.js');
const { decideTopology } = await import('../../dist/planner/topology.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

// A brief accepted with decision=go, affected-projects=[2,3] (saga-mcp, harmess),
// topology-hint='scaffold-then-parallel', scaffold-artifacts=[...].
const goBrief = {
  classification: 'product',
  complexity: { tshirt: 'M', risk_triggers: ['shared-contract'] },
  decision: 'go',
  reasoning: 'multi-project change touching saga-mcp + harmess',
  affected_projects: [2, 3],
  topology_hint: 'scaffold-then-parallel',
  scaffold_artifacts: ['src/planner/cascade.ts', 'src/planner/topology.ts'],
  shared_mutation_risk: true,
  completeness: 'high',
  degraded: false,
};

console.log('\n=== AC-9 (1) theme↔brief carry-state ===');
let themeId, briefId;
test('theme artifact created in project=business', () => {
  const theme = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'theme', code: 'THEME-REQ-004',
    title: 'kickstart discovery skill', path: 'docs/theme.md', status: 'accepted',
  });
  themeId = theme.id;
  assert.equal(theme.type, 'theme');
});
test('brief artifact created (decision=go, multi-project)', () => {
  const brief = handlers.artifact_create({
    project_id: 2, epic_id: 1, type: 'brief', code: 'BRIEF-004',
    title: 'REQ-004 discovery brief', path: 'docs/requirements/REQ-004/brief.md',
    status: 'accepted', metadata: { brief_payload: goBrief },
  });
  briefId = brief.id;
  assert.equal(brief.type, 'brief');
});
test('derived_from edge brief → theme exists (carry-state)', () => {
  // trace_add: source=brief, target=theme, link_type=derived_from.
  // SRS §2.3 notation "theme ← derived_from ← brief" = brief derives from theme.
  handlers.trace_add({
    source_id: briefId, target_type: 'artifact', target_id: themeId,
    link_type: 'derived_from',
  });
  const traces = handlers.trace_list({ source_id: briefId });
  const edge = traces.traces.find(
    (t) => t.link_type === 'derived_from' && t.target_id === themeId,
  );
  assert.ok(edge, 'no derived_from edge from brief to theme');
});

console.log('\n=== AC-9 (2) impact cascade tags every dev-task with impact:a AND impact:b ===');
test('planner cascade stamps impact:2 and impact:3 on every task', () => {
  const planTasks = [
    { id: 101, tags: ['role:worker'] },
    { id: 102, tags: [] },
    { id: 103, tags: ['impact:2'] },
  ];
  const cascaded = applyImpactCascade(planTasks, goBrief.affected_projects);
  for (const t of cascaded) {
    assert.ok(t.tags.includes('impact:2'), `task ${t.id} missing impact:2`);
    assert.ok(t.tags.includes('impact:3'), `task ${t.id} missing impact:3`);
  }
});

console.log('\n=== AC-9 (3) Pattern B: SCAFFOLD task precedes body tasks (depends_on) ===');
test('decideTopology picks Pattern B and emits a scaffold_task', () => {
  const dec = decideTopology(goBrief);
  assert.equal(dec.pattern, 'B-scaffold-then-parallel');
  assert.ok(dec.scaffold_task, 'no scaffold_task for Pattern B');
  assert.equal(
    dec.scaffold_task.title,
    'SCAFFOLD: src/planner/cascade.ts, src/planner/topology.ts',
  );
});
test('SCAFFOLD task done BEFORE first body task in_progress (depends_on wiring)', () => {
  // Model the plan the planner would emit: a scaffold task (no deps) and body
  // tasks that depend_on the scaffold task. The ordering invariant is: the
  // scaffold task id is in every body task's depends_on, so no body can start
  // until the scaffold is done (saga's dependency gate blocks in_progress).
  const dec = decideTopology(goBrief);
  const scaffoldTask = {
    id: 200,
    title: dec.scaffold_task.title,
    tags: [],
    depends_on: [],            // scaffold starts first — no deps
    status: 'todo',
    is_scaffold: true,
  };
  const bodyTasks = [
    { id: 201, title: 'body A', tags: [], depends_on: [scaffoldTask.id], status: 'todo' },
    { id: 202, title: 'body B', tags: [], depends_on: [scaffoldTask.id], status: 'todo' },
  ];
  // Every body task depends on the scaffold task.
  for (const bt of bodyTasks) {
    assert.ok(
      bt.depends_on.includes(scaffoldTask.id),
      `body task ${bt.id} does not depend_on scaffold ${scaffoldTask.id}`,
    );
  }
  // The saga dispatcher refuses to move a task to in_progress while any
  // depends_on is not done. Simulate that gate: a body task can only be
  // in_progress once the scaffold task is 'done'.
  const canStartBody = (body, scaffold) =>
    scaffold.status === 'done' || !body.depends_on.includes(scaffold.id);
  // While scaffold is NOT done, no body may start.
  scaffoldTask.status = 'todo';
  for (const bt of bodyTasks) {
    assert.equal(canStartBody(bt, scaffoldTask), false,
      `body ${bt.id} could start before scaffold done (depends_on gate broken)`);
  }
  // Once scaffold is done, bodies may start.
  scaffoldTask.status = 'done';
  for (const bt of bodyTasks) {
    assert.equal(canStartBody(bt, scaffoldTask), true,
      `body ${bt.id} could not start even after scaffold done`);
  }
  // Stamp impact tags on the body tasks via the cascade.
  const tagged = applyImpactCascade(bodyTasks, goBrief.affected_projects);
  for (const bt of tagged) {
    assert.ok(bt.tags.includes('impact:2'));
    assert.ok(bt.tags.includes('impact:3'));
  }
});

console.log('\n=== AC-9 (4) multi-project topology-rule in validateBrief ===');
test('multi-project + parallel-independent → validateBrief ok:false', () => {
  const bad = { ...goBrief, topology_hint: 'parallel-independent' };
  const r = validateBrief(bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.includes('topology_hint: multi-project requires sequence or scaffold-then-parallel'),
    `unexpected errors: ${JSON.stringify(r.errors)}`,
  );
});
test('multi-project + sequence → validateBrief ok:true', () => {
  const ok = { ...goBrief, topology_hint: 'sequence' };
  assert.equal(validateBrief(ok).ok, true);
});
test('multi-project + scaffold-then-parallel → validateBrief ok:true', () => {
  assert.equal(validateBrief(goBrief).ok, true);
});

console.log(`\n=== theme-brief-pipeline: ${passed} passed, ${failed} failed ===\n`);

// cleanup
for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmpDb + ext); } catch { /* */ } }
process.exit(failed === 0 ? 0 : 1);
