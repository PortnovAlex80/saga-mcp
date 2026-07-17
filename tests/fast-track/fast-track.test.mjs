// Integration tests for AC-6 (#222): fast-track routing + escalation.
//
// SRS-004 §2b.5, AC-6. Drives the real `routeFastTrack` / `escalateFastTrack` /
// `canFastTrack` functions against a throwaway SQLite DB seeded with a project +
// epic + brief artifact, verifying the AC-6 DoD:
//
//   DoD 1: a tech-task of XS/S complexity (≤1 project, no risk-triggers) routes
//          DIRECTLY into kanban (no PRD/SRS/UC/AC created) and a trace edge
//          brief ← derived_from ← dev-task exists.
//   DoD 2: escalation flips decision fast-track → go and records a lesson.
//
// Plus: eligibility gate (canFastTrack) for every refusal condition; the
// multi-project topology-rule in validateBrief is re-asserted (it was activated
// by AC-1/#217; AC-6 re-verifies it stays active).
//
// Convention (matches tests/brief-ac1/*): import from compiled dist/.
// Run via:  npm run test  (builds dist/ then runs node:test)
//   or:     node tests/fast-track/fast-track.test.mjs
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const thisDir = dirname(fileURLToPath(import.meta.url));
const tmpDb = join(thisDir, '.tmp-fast-track.db');

// Fresh temp DB before importing anything that touches getDb.
for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(tmpDb + ext); } catch { /* */ }
}
process.env.DB_PATH = tmpDb;

// Seed schema + project + epic + a brief artifact. Raw connection controls the
// exact rows; the planner reuses the file via getDb().
const seed = new Database(tmpDb);
seed.pragma('journal_mode = WAL');
seed.pragma('foreign_keys = ON');
const { SCHEMA_SQL } = await import('../../dist/schema.js');
seed.exec(SCHEMA_SQL);
try { seed.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch {}
seed.prepare("INSERT INTO projects (name, description) VALUES ('builders', 'dev kanban')").run();
seed.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'REQ-005')").run(1);
// A registered brief artifact (the source of the derived_from edge). AC-1/#217
// created it via artifact_create; here we seed it directly to keep the test
// focused on the planner routing, not the brief-persistence path.
seed.prepare(
  `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status)
   VALUES (1, 1, 'brief', 'BRIEF-005', 'fast-track tech-task brief',
           'docs/requirements/REQ-005/brief.md', 'accepted')`,
).run();
seed.close();

// Import the planner functions under test (getDb reuses the seeded file).
const { canFastTrack, routeFastTrack, escalateFastTrack } =
  await import('../../dist/planner/fast-track.js');
const { getDb, closeDb } = await import('../../dist/db.js');
const { validateBrief } = await import('../../dist/validators/brief.js');

// ---------------------------------------------------------------------------
// Helpers — valid fast-track brief base + a non-fast variant.
// ---------------------------------------------------------------------------
const fastBase = {
  classification: 'tech-task',
  complexity: { tshirt: 'S', risk_triggers: [] },
  decision: 'fast-track',
  reasoning: 'rename a symbol across the module',
  affected_projects: [1],
  topology_hint: 'parallel-independent',
  scaffold_artifacts: [],
  shared_mutation_risk: false,
  completeness: 'high',
  degraded: false,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('canFastTrack — eligibility gate (AC-6 rule)', () => {
  it('accepts an eligible fast-track brief (tech-task, S, 1 project, no triggers)', () => {
    const e = canFastTrack(clone(fastBase));
    assert.equal(e.eligible, true);
    assert.equal(e.reason, undefined);
  });

  it('accepts XS complexity too', () => {
    const p = clone(fastBase); p.complexity.tshirt = 'XS';
    assert.equal(canFastTrack(p).eligible, true);
  });

  it('accepts zero affected projects', () => {
    const p = clone(fastBase); p.affected_projects = [];
    assert.equal(canFastTrack(p).eligible, true);
  });

  it('refuses: classification != tech-task', () => {
    const p = clone(fastBase); p.classification = 'product';
    const e = canFastTrack(p);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /tech-task/);
  });

  it('refuses: complexity M (too big for the fast channel)', () => {
    const p = clone(fastBase); p.complexity.tshirt = 'M';
    const e = canFastTrack(p);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /XS, S/);
  });

  it('refuses: affected_projects.length > 1 (multi-project must formalize)', () => {
    const p = clone(fastBase); p.affected_projects = [1, 2];
    const e = canFastTrack(p);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /affected_projects/);
  });

  it('refuses: active risk-triggers', () => {
    const p = clone(fastBase); p.complexity.risk_triggers = ['shared-mutation'];
    const e = canFastTrack(p);
    assert.equal(e.eligible, false);
    assert.match(e.reason, /risk-triggers/);
  });
});

describe('routeFastTrack — fast-track routing into kanban (AC-6 DoD 1)', () => {
  it('creates a dev task directly in kanban, no formalization artifacts', () => {
    const db = getDb();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE type IN ('PRD','SRS','UC','AC')")
      .get().n;

    const r = routeFastTrack(1, 1, clone(fastBase), db);

    assert.equal(typeof r.dev_task_id, 'number');
    assert.equal(r.brief_artifact_id, 1);
    assert.equal(typeof r.trace_id, 'number');

    // DoD: NO formalization artifacts were created by the routing.
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE type IN ('PRD','SRS','UC','AC')")
      .get().n;
    assert.equal(after, before, 'routeFastTrack must not create PRD/SRS/UC/AC artifacts');

    // The dev task exists, status todo, in the seeded epic.
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.dev_task_id);
    assert.equal(task.status, 'todo');
    assert.equal(task.epic_id, 1);
    assert.match(task.title, /\[fast-track\]/);
  });

  it('creates a trace edge brief ← derived_from ← dev-task', () => {
    const db = getDb();
    const r = routeFastTrack(1, 1, clone(fastBase), db);

    const trace = db
      .prepare(
        `SELECT * FROM artifact_traces
         WHERE source_id = ? AND target_type = 'task' AND target_id = ? AND link_type = 'derived_from'`,
      )
      .get(1, r.dev_task_id);
    assert.ok(trace, 'derived_from trace from brief to dev task must exist');
    assert.equal(trace.link_type, 'derived_from');
  });

  it('stamps impact:<pid> tags from affected_projects on the dev task', () => {
    const db = getDb();
    const p = clone(fastBase); p.affected_projects = [42];
    const r = routeFastTrack(1, 1, p, db);
    const task = db.prepare('SELECT tags FROM tasks WHERE id = ?').get(r.dev_task_id);
    assert.deepEqual(JSON.parse(task.tags), ['impact:42']);
  });

  it('refuses an ineligible brief even if decision is forced to fast-track', () => {
    const db = getDb();
    const p = clone(fastBase);
    p.complexity.tshirt = 'L'; // too big — not eligible
    p.decision = 'fast-track';
    assert.throws(
      () => routeFastTrack(1, 1, p, db),
      /not eligible for fast-track/,
    );
  });

  it('refuses if the source artifact is not a brief', () => {
    const db = getDb();
    // Seed a non-brief artifact.
    db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, title, path)
       VALUES (1, 1, 'PRD', 'not a brief', 'docs/x.md')`,
    ).run();
    assert.throws(
      () => routeFastTrack(/* non-brief artifact id */ 2, 1, clone(fastBase), db),
      /expected 'brief'/,
    );
  });

  it('refuses if the brief artifact does not exist', () => {
    const db = getDb();
    assert.throws(
      () => routeFastTrack(99999, 1, clone(fastBase), db),
      /not found/,
    );
  });

  it('is idempotent for the brief route', () => {
    const db = getDb();
    const r1 = routeFastTrack(1, 1, clone(fastBase), db);
    const r2 = routeFastTrack(1, 1, clone(fastBase), db);
    assert.equal(r1.dev_task_id, r2.dev_task_id);
    assert.equal(r1.trace_id, r2.trace_id);
  });
});

describe('escalateFastTrack — fast-track → go with a lesson (AC-6 DoD 2)', () => {
  it('flips decision fast-track → go and appends a lesson', () => {
    const { brief, escalated } = escalateFastTrack(clone(fastBase), 'second affected-project surfaced');
    assert.equal(escalated, true);
    assert.equal(brief.decision, 'go');
    assert.match(brief.reasoning, /lesson/);
    assert.match(brief.reasoning, /second affected-project surfaced/);
  });

  it('is a no-op on a non-fast-track brief (escalation never widens another decision)', () => {
    const goBrief = clone(fastBase); goBrief.decision = 'go';
    const { brief, escalated } = escalateFastTrack(goBrief, 'trigger');
    assert.equal(escalated, false);
    assert.equal(brief.decision, 'go'); // unchanged
    assert.equal(brief.reasoning, goBrief.reasoning); // no lesson appended
  });

  it('does not mutate the input brief (pure function)', () => {
    const input = clone(fastBase);
    escalateFastTrack(input, 'trigger');
    assert.equal(input.decision, 'fast-track', 'input must not be mutated');
  });

  it('round-trips through validateBrief: escalated brief is still valid', () => {
    const { brief } = escalateFastTrack(clone(fastBase), 'underestimated complexity');
    // After escalation decision=go; with completeness=high this is valid.
    const r = validateBrief(brief);
    assert.equal(r.ok, true, `escalated brief should validate: ${JSON.stringify(r.errors)}`);
  });
});

describe('AC-6 topology-rule re-verification (activated by AC-1/#217)', () => {
  // AC-6's description asks to "check the multi-project topology-rule in
  // validators/brief.ts". That rule was implemented by AC-1 (#217). We re-assert
  // it here so AC-6's DoD ("the rule is active") is independently verified and
  // a future regression is caught.

  it('rejects affected_projects.length>1 with topology_hint=parallel-independent', () => {
    const p = clone(fastBase);
    p.affected_projects = [1, 2];
    p.topology_hint = 'parallel-independent';
    const r = validateBrief(p);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('multi-project requires sequence or scaffold-then-parallel')),
      `expected topology error, got: ${JSON.stringify(r.errors)}`,
    );
  });

  it('accepts affected_projects.length>1 with topology_hint=sequence', () => {
    const p = clone(fastBase);
    p.affected_projects = [1, 2];
    p.topology_hint = 'sequence';
    p.decision = 'go'; // multi-project must go through formalization, not fast-track
    const r = validateBrief(p);
    assert.equal(r.ok, true, `unexpected errors: ${JSON.stringify(r.errors)}`);
  });
});

// Clean up the temp DB (leave it if tests fail, for inspection).
import { after } from 'node:test';
after(() => {
  try { closeDb(); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(tmpDb + ext); } catch { /* */ }
  }
});
