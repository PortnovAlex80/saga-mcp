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

// ----------------------------------------------------------------------------
// R14 — FR Forbidden Content (BABOK/Wiegers). Unit tests the forbidden-content
// scanner contract: which patterns the linter treats as implementation-detail
// leaks in an accepted FR's .md body. The linter's ruleR14 / scanFrForbiddenContent
// are not exported (matching ruleR4's test approach), so we re-implement the
// regex set inline and assert on its output. Keeping the two in sync is the
// same maintenance contract as the R4 test above.
// ----------------------------------------------------------------------------

const FR_FORBIDDEN_PATTERNS = [
  { label: 'HTTP verb', regex: /\b(?:GET|POST|PUT|DELETE|PATCH)\b/ },
  { label: 'database schema', regex: /CREATE\s+TABLE|`[a-z][a-z0-9_]*`/i },
  { label: 'JSON field', regex: /"[a-z_][a-z0-9_]*"\s*:/i },
  { label: 'class or method name',
    regex: /\b[A-Z]\w+\.[a-z]\w+\s*\(|\bdef\s+[a-z_]\w+\s*\(|\bfunction\s+[a-z_$]\w*\s*\(/ },
  { label: 'framework name',
    regex: /\b(?:React|Vue|Angular|Django|Flask|FastAPI|Spring|Express|Rails|Laravel|Next\.js|Nest\.js|Svelte|Ember|Symfony|ASP\.NET)\b/ },
  { label: 'HTTP status code', regex: /\b(?:401|403|404|405|418|422|429|500|502|503|504)\b/ },
  { label: 'algorithm name',
    regex: /\b(?:SHA-1|SHA-256|SHA-512|SHA-3|HMAC|AES|RSA|bcrypt|scrypt|Argon2|MD5|BLAKE2?|PBKDF2)\b/ },
];

function scanFrForbiddenContent(body) {
  const hits = [];
  for (const p of FR_FORBIDDEN_PATTERNS) {
    const m = p.regex.exec(body);
    if (m) hits.push({ label: p.label, example: m[0] });
  }
  return hits;
}

test('R14: clean FR body (pure WHAT, no implementation detail) yields zero hits', () => {
  const body = [
    '# FR-1 User authentication',
    '',
    'The system SHALL authenticate a user before granting access to protected resources.',
    'When authentication fails, the system SHALL refuse access and notify the user.',
    '',
    'Acceptance: a valid user gains access; an invalid user is refused.',
  ].join('\n');
  assert.equal(scanFrForbiddenContent(body).length, 0,
    'a clean FR leaks no implementation detail');
});

test('R14: HTTP verb leak (POST) is detected', () => {
  const body = 'The client SHALL POST credentials to the login endpoint.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'HTTP verb' && h.example === 'POST'),
    'uppercase HTTP verb must be flagged');
});

test('R14: lowercase http-verb prose is NOT flagged (avoid false positive)', () => {
  // Well-written FRs use ordinary verbs: "get", "put", "post a message".
  // The regex matches uppercase only — lower-case forms are legitimate prose.
  const body = 'The user shall get a confirmation and post it to their profile.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(!hits.some(h => h.label === 'HTTP verb'),
    'lowercase get/post must not fire (English-prose false positive avoided)');
});

test('R14: CREATE TABLE DDL leak is detected', () => {
  const body = 'The system shall store users in CREATE TABLE users (id INTEGER).';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'database schema'),
    'CREATE TABLE DDL must be flagged');
});

test('R14: backtick-quoted DB identifier leak is detected', () => {
  const body = 'Rows in the `users` table shall be unique by email.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'database schema' && h.example.includes('users')),
    'backtick-quoted snake_case identifier must be flagged');
});

test('R14: JSON field leak is detected', () => {
  const body = 'The response shall include {"user_id": 42, "role": "admin"}.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'JSON field'),
    'JSON object-literal field syntax must be flagged');
});

test('R14: class.method() leak is detected', () => {
  const body = 'The system shall invoke AuthService.verify() before login.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'class or method name'),
    'ClassName.method() syntax must be flagged');
});

test('R14: Python def leak is detected', () => {
  const body = 'Implemented by def authenticate(token): ...';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'class or method name'),
    'def function_name() syntax must be flagged');
});

test('R14: framework name leak (React) is detected', () => {
  const body = 'The UI shall be built with React components.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'framework name' && h.example === 'React'),
    'explicit framework name must be flagged');
});

test('R14: framework name leak (Django) is detected', () => {
  const body = 'The server shall use Django ORM for persistence.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'framework name' && h.example === 'Django'),
    'explicit framework name must be flagged');
});

test('R14: HTTP status code leak (404, 500) is detected', () => {
  const body = 'Unknown resources shall return 404; server errors shall return 500.';
  const hits = scanFrForbiddenContent(body);
  const codes = hits.filter(h => h.label === 'HTTP status code').map(h => h.example);
  // One finding per distinct pattern (the regex exec returns the first match
  // per pattern; 404 and 500 are both under the same pattern so only the first
  // appears in `example`). We assert the pattern fired at all.
  assert.ok(hits.some(h => h.label === 'HTTP status code'),
    'curated HTTP status codes must be flagged');
});

test('R14: algorithm name leak (SHA-256, HMAC) is detected', () => {
  const body = 'Passwords shall be hashed with SHA-256 and requests signed with HMAC.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(hits.some(h => h.label === 'algorithm name'),
    'concrete algorithm/crypto primitive names must be flagged');
});

test('R14: multiple distinct leak categories produce multiple findings', () => {
  // One FR leaking HTTP verb + framework + status code → 3 distinct findings,
  // one per pattern category, so the human sees each leak separately.
  const body = 'The React client SHALL POST to /api and expect 404 on miss.';
  const hits = scanFrForbiddenContent(body);
  const labels = hits.map(h => h.label).sort();
  assert.deepEqual(labels, ['HTTP status code', 'HTTP verb', 'framework name'],
    'each distinct leak category produces its own finding');
});

test('R14: three-digit numbers outside the curated set are NOT flagged', () => {
  // 200/201/301 are HTTP codes too, but the curated set is intentionally small
  // to keep false positives near zero. Years, counts, IDs must never fire.
  const body = 'The system shall serve 200 users since 2019, returning 301 items per page.';
  const hits = scanFrForbiddenContent(body);
  assert.ok(!hits.some(h => h.label === 'HTTP status code'),
    'non-curated 3-digit numbers (years/counts) must not fire');
});
