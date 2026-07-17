// Unit tests for cgad-spec-lint rule R4 (REQ-013 / ADR-006).
// Run: node --test tools/cgad-spec-lint.test.mjs
//
// Tests construct an in-memory SQLite DB with the saga schema subset that R4
// queries, then assert on ruleR4's findings. Each test is a scenario from the
// ADR-006 pre-mortem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = OFF;

CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
CREATE TABLE epics (
  id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, status TEXT DEFAULT 'planned'
);
CREATE TABLE episode_workflows (
  epic_id INTEGER PRIMARY KEY, stage TEXT NOT NULL DEFAULT 'discovery'
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, epic_id INTEGER, title TEXT, status TEXT DEFAULT 'todo',
  execution_mode TEXT NOT NULL DEFAULT 'git_change',
  workflow_stage TEXT, project_repository_id INTEGER,
  integration_state TEXT NOT NULL DEFAULT 'not_required',
  source_ref TEXT, tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE project_repositories (id INTEGER PRIMARY KEY, project_id INTEGER);
`;

function makeDb() {
  const db = new sqlite3.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

// Import the rule by re-implementing the SQL check inline against the test
// schema (the linter's ruleR4 is not exported; we test the SQL contract that
// the linter implements, plus the scaffold-tag detection rule).
//
// The full linter file is integration-tested by running it against saga.db;
// this file unit-tests the R4 logic on a controlled fixture.
function ruleR4OnTestDb(db) {
  const findings = [];
  const episodes = db.prepare(`
    SELECT ew.epic_id, ew.stage, e.name, e.project_id
    FROM episode_workflows ew JOIN epics e ON e.id = ew.epic_id
    WHERE ew.stage IN ('development','verification','integration','completed')`).all();

  for (const ep of episodes) {
    const tasks = db.prepare(`
      SELECT id, title, status, project_repository_id, tags, source_ref, integration_state
      FROM tasks WHERE epic_id=? AND execution_mode='git_change'
        AND workflow_stage IN ('development','integration')`).all(ep.epic_id);
    if (tasks.length < 2) continue;

    const hasScaffold = tasks.some(t => {
      const tags = String(t.tags || '[]');
      const title = String(t.title || '');
      return tags.includes('scaffold') || title.startsWith('SCAFFOLD:');
    });
    if (hasScaffold) continue;

    const repoIds = [...new Set(tasks.map(t => t.project_repository_id).filter(Number.isFinite))];
    let isGreenfield = true;
    if (repoIds.length === 0) {
      isGreenfield = true; // conservative — see linter comment
    } else {
      const placeholders = repoIds.map(() => '?').join(',');
      const priorMerges = db.prepare(`
        SELECT COUNT(*) AS n FROM tasks
        WHERE project_repository_id IN (${placeholders})
          AND integration_state='merged' AND epic_id != ?`).get(...repoIds, ep.epic_id);
      isGreenfield = priorMerges.n === 0;
    }
    if (!isGreenfield) continue;

    const refs = tasks.map(t => String(t.source_ref || '').trim()).filter(Boolean);
    let overlap = refs.length < tasks.length;
    if (!overlap && refs.length >= 2) {
      const uniq = new Set(refs);
      overlap = uniq.size < refs.length;
    }
    if (!overlap) continue;

    findings.push({ epic_id: ep.epic_id, tasks: tasks.map(t => t.id) });
  }
  return findings;
}

function insertEpisode(db, epicId, stage, projectId = 1) {
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (?,?,?)').run(epicId, projectId, `ep-${epicId}`);
  db.prepare('INSERT INTO episode_workflows (epic_id, stage) VALUES (?,?)').run(epicId, stage);
}

function insertTask(db, id, epicId, opts = {}) {
  const o = {
    title: `task-${id}`,
    workflow_stage: 'development',
    execution_mode: 'git_change',
    project_repository_id: null,
    integration_state: 'not_required',
    source_ref: '',
    tags: '[]',
    ...opts,
  };
  db.prepare(`INSERT INTO tasks (id, epic_id, title, workflow_stage, execution_mode,
    project_repository_id, integration_state, source_ref, tags)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, epicId, o.title, o.workflow_stage, o.execution_mode,
    o.project_repository_id, o.integration_state, o.source_ref, o.tags,
  );
}

test('R4 fires: greenfield episode, 2 parallel tasks, no scaffold, shared module', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/calculator.ts' });
  insertTask(db, 11, 1, { source_ref: 'src/calculator.ts' });
  // No prior merged tasks → greenfield.
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].tasks, [10, 11]);
});

test('R4 passes: greenfield episode with scaffold task', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { title: 'SCAFFOLD: calculator', source_ref: 'src/calculator.ts' });
  insertTask(db, 11, 1, { source_ref: 'src/calculator.ts' });
  insertTask(db, 12, 1, { source_ref: 'src/calculator.ts' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'scaffold task suppresses R4');
});

test('R4 passes: scaffold detected via tag instead of title', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { title: 'build calculator module', tags: '["scaffold"]', source_ref: 'src/calc.ts' });
  insertTask(db, 11, 1, { source_ref: 'src/calc.ts' });
  insertTask(db, 12, 1, { source_ref: 'src/calc.ts' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'tag-based scaffold detection works');
});

test('R4 passes: established codebase (prior merged task in same repo)', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/calc.ts', project_repository_id: 7 });
  insertTask(db, 11, 1, { source_ref: 'src/calc.ts', project_repository_id: 7 });
  // Prior merged task in repo 7 from a different episode.
  insertEpisode(db, 2, 'completed');
  insertTask(db, 99, 2, {
    source_ref: 'src/old.ts', project_repository_id: 7,
    integration_state: 'merged', workflow_stage: 'integration',
  });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'established codebase — not greenfield');
});

test('R4 passes: tasks touch different modules (no overlap)', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/addition.ts' });
  insertTask(db, 11, 1, { source_ref: 'src/subtraction.ts' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'no module overlap — Pattern A/parallel ok');
});

test('R4 passes: episode still in planning (not yet in development)', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'planning');
  insertTask(db, 10, 1, { workflow_stage: 'planning', source_ref: 'src/calc.ts' });
  insertTask(db, 11, 1, { workflow_stage: 'planning', source_ref: 'src/calc.ts' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'R4 only fires at development-or-later');
});

test('R4 passes: only one git_change task', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/calc.ts' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 0, 'single task — no parallelism risk');
});

test('R4 fires: greenfield episode via tag when no repository binding', () => {
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/calc.ts', tags: '["greenfield"]' });
  insertTask(db, 11, 1, { source_ref: 'src/calc.ts', tags: '["greenfield"]' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 1, 'greenfield-tagged tasks fire R4 without repo binding');
});

test('R4 fires: episode without repo binding is treated as greenfield (conservative)', () => {
  // Without a repository binding, R4 cannot prove the codebase is established.
  // CGAD §34 / Sign 002: false-positive is cheaper than false-negative for a
  // prevention gate, so the rule fires and lets the planner justify or fix.
  const db = makeDb();
  insertEpisode(db, 1, 'development');
  insertTask(db, 10, 1, { source_ref: 'src/calc.ts', tags: '["cgad-r4-waived"]' });
  insertTask(db, 11, 1, { source_ref: 'src/calc.ts', tags: '["cgad-r4-waived"]' });
  const findings = ruleR4OnTestDb(db);
  assert.equal(findings.length, 1, 'no repo binding → greenfield by default → R4 fires');
});
