// Integration tests for artifact_create(type:'brief'/'theme') — SRS §2b.3, AC-1.
//
// Drives the real handleArtifactCreate handler against a throwaway SQLite DB,
// verifying: brief validation gate + payload persistence; theme business-project
// guard; upsert-by-(epic_id,code,type) idempotency; artifact_list(type:'brief').
//
// Usage:  node tests/brief-ac1/artifact-create.mjs
//   (DB_PATH is pointed at a temp file via process.env before importing db.js)
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const thisDir = dirname(fileURLToPath(import.meta.url));
const tmpDb = join(thisDir, '.tmp-artifact-create.db');

// Fresh temp DB before importing the handler (getDb reads DB_PATH at first use).
for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmpDb + ext); } catch { /* */ } }
process.env.DB_PATH = tmpDb;

// Seed schema + a 'business' project + a non-business project + an epic.
// Done with a raw connection so we control the business project name exactly.
const seed = new Database(tmpDb);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
const { SCHEMA_SQL } = await import('../../dist/schema.js');
seed.exec(SCHEMA_SQL);
try { seed.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch {}
seed.prepare("INSERT INTO projects (name, description) VALUES ('business', 'top business board')").run();
seed.prepare("INSERT INTO projects (name, description) VALUES ('builders', 'dev kanban')").run();
seed.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'REQ-004')").run(1);
seed.close();

// Now import the handler — getDb will reuse the seeded file.
const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/artifacts.js');
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}
const validBrief = {
  classification: 'product',
  complexity: { tshirt: 'M', risk_triggers: ['r1'] },
  hypotheses: ['h1'],
  quality_gate_checklist: ['q1'],
  open_questions: ['o1'],
  decision_matrix: { criteria: ['c1'], variants: [{ name: 'v1', scores: { c1: 3 } }] },
  decision: 'go',
  reasoning: 'because the market exists',
  affected_projects: [1, 2],
  topology_hint: 'sequence',
  scaffold_artifacts: ['docs/x.md'],
  shared_mutation_risk: false,
  completeness: 'high',
  degraded: false,
};

console.log('\n=== artifact_create — type:brief ===');
test('accepted brief persists all 12 sections at metadata.brief_payload', () => {
  const art = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'brief', code: 'BRIEF-004',
    title: 'REQ-004 brief', path: 'docs/requirements/REQ-004/brief.md', status: 'accepted',
    metadata: { brief_payload: validBrief },
  });
  assert.equal(art.type, 'brief');
  const meta = JSON.parse(art.metadata);
  assert.ok(meta.brief_payload, 'brief_payload missing from persisted metadata');
  // AC-1: all 12 mandatory sections must be present.
  for (const key of [
    'classification', 'complexity', 'hypotheses', 'quality_gate_checklist',
    'open_questions', 'decision_matrix', 'decision', 'reasoning',
    'affected_projects', 'topology_hint', 'scaffold_artifacts', 'shared_mutation_risk',
  ]) {
    assert.ok(key in meta.brief_payload, `section '${key}' missing from persisted brief`);
  }
  assert.equal(meta.brief_payload.decision, 'go');
});

test('invalid brief (bad decision) throws — not persisted', () => {
  const bad = { ...validBrief, decision: 'maybe' };
  assert.throws(
    () => handlers.artifact_create({
      project_id: 1, epic_id: 1, type: 'brief', code: 'BAD-BRIEF',
      title: 'bad', path: 'docs/bad.md', metadata: { brief_payload: bad },
    }),
    /brief validation failed/,
  );
  // not persisted
  const list = handlers.artifact_list({ epic_id: 1, type: 'brief' });
  assert.ok(!list.artifacts.some((a) => a.code === 'BAD-BRIEF'), 'rejected brief leaked into DB');
});

test('invalid brief (empty reasoning) throws', () => {
  const bad = { ...validBrief, reasoning: '   ' };
  assert.throws(
    () => handlers.artifact_create({
      project_id: 1, epic_id: 1, type: 'brief', code: 'BAD-REASON',
      title: 'bad', path: 'docs/bad.md', metadata: { brief_payload: bad },
    }),
    /brief validation failed/,
  );
});

console.log('\n=== artifact_create — upsert by (epic_id, code, type) ===');
test('repeat create with same code updates, does not duplicate', () => {
  const before = handlers.artifact_list({ epic_id: 1, type: 'brief' });
  const countBefore = before.count;
  const updated = { ...validBrief, reasoning: 'revised rationale', decision: 'clarify' };
  const art = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'brief', code: 'BRIEF-004',
    title: 'REQ-004 brief v2', path: 'docs/requirements/REQ-004/brief.md', status: 'accepted',
    metadata: { brief_payload: updated },
  });
  // Same code within (epic,type) → same row id, updated fields.
  assert.equal(art.code, 'BRIEF-004');
  assert.equal(art.title, 'REQ-004 brief v2');
  const meta = JSON.parse(art.metadata);
  assert.equal(meta.brief_payload.decision, 'clarify');
  // No duplicate: count unchanged.
  const after = handlers.artifact_list({ epic_id: 1, type: 'brief' });
  assert.equal(after.count, countBefore, 'upsert created a duplicate row');
});

test('same code different type does NOT collide (separate rows)', () => {
  // 'AC' with code AC-1 is unrelated to 'brief' with the same code.
  handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'AC', code: 'AC-1',
    title: 'criterion', path: 'docs/ac.md',
  });
  handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'brief', code: 'AC-1',
    title: 'brief named AC-1', path: 'docs/b.md', status: 'accepted',
    metadata: { brief_payload: validBrief },
  });
  const list = handlers.artifact_list({ epic_id: 1 });
  const ac1 = list.artifacts.filter((a) => a.code === 'AC-1');
  assert.equal(ac1.length, 2, 'code shared across types should produce 2 rows');
});

console.log('\n=== artifact_create — type:theme ===');
test('theme in business project succeeds', () => {
  const art = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'theme', code: 'THEME-1',
    title: 'colonize Mars', path: 'docs/theme.md', status: 'accepted',
  });
  assert.equal(art.type, 'theme');
});
test('theme in non-business project throws', () => {
  // project_id 2 = 'builders'
  assert.throws(
    () => handlers.artifact_create({
      project_id: 2, epic_id: 1, type: 'theme', code: 'THEME-BAD',
      title: 'wrong board', path: 'docs/theme.md',
    }),
    /theme requires project_id=business/,
  );
});
test('theme for unknown project id throws', () => {
  assert.throws(
    () => handlers.artifact_create({
      project_id: 999, epic_id: 1, type: 'theme', code: 'THEME-X',
      title: 'no board', path: 'docs/theme.md',
    }),
    /theme requires project_id=business/,
  );
});

console.log('\n=== artifact_list({type:"brief"}) visibility ===');
test('created briefs are visible via artifact_list(type:brief)', () => {
  const list = handlers.artifact_list({ epic_id: 1, type: 'brief' });
  assert.ok(list.count >= 1);
  assert.ok(list.artifacts.every((a) => a.type === 'brief'));
});

console.log('\n=== artifact type enum ===');
test("brief/theme accepted as artifact types (not rejected as bad type)", () => {
  // If the enum were not extended, this would throw "type must be one of ...".
  // (brief payload validated separately; theme needs business project.)
  const a = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'theme', code: 'THEME-ENUM',
    title: 'enum check', path: 'docs/t.md',
  });
  assert.equal(a.type, 'theme');
});

console.log(`\n=== artifact-create: ${passed} passed, ${failed} failed ===\n`);

// cleanup
closeDb();
for (const ext of ['', '-wal', '-shm']) { try { rmSync(tmpDb + ext); } catch { /* */ } }
process.exit(failed === 0 ? 0 : 1);
