// M0 schema fitness: kernel tables exist, append-only/immutable triggers work,
// board status CHECKs accept the fork's eight task statuses and reject junk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_SQL } from '../dist/schema.js';

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga5-schema-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('SCHEMA_SQL creates all kernel and board tables', () => {
  const { db, cleanup } = makeDb();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((r) => r.name).sort();
    const expected = [
      // kernel
      'workflows', 'runs', 'events', 'materials', 'executions', 'effects', 'timers',
      // board
      'projects', 'epics', 'tasks', 'subtasks', 'task_dependencies',
      'comments', 'notes', 'activity_log', 'templates',
    ];
    for (const name of expected) {
      assert.ok(tables.includes(name), `missing table: ${name}`);
    }
    const unexpected = tables.filter((n) => !expected.includes(n) && n !== 'sqlite_sequence');
    assert.deepEqual(unexpected, [], 'no unlisted tables');
  } finally {
    cleanup();
  }
});

test('events are append-only: UPDATE and DELETE fail', () => {
  const { db, cleanup } = makeDb();
  try {
    db.prepare("INSERT INTO workflows (id, name, graph_json) VALUES ('wf1', 'demo', '{}')").run();
    db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES ('run1', 'wf1', 'new')").run();
    db.prepare("INSERT INTO events (run_id, seq, type) VALUES ('run1', 1, 'run.started')").run();

    assert.throws(() => {
      db.prepare("UPDATE events SET type = 'tampered' WHERE seq = 1").run();
    }, /append-only/);
    assert.throws(() => {
      db.prepare('DELETE FROM events WHERE seq = 1').run();
    }, /append-only/);
  } finally {
    cleanup();
  }
});

test('materials are immutable: UPDATE and DELETE fail', () => {
  const { db, cleanup } = makeDb();
  try {
    db.prepare("INSERT INTO materials (digest, schema_ref, content) VALUES ('d1', 'srs', 'hello')").run();
    assert.throws(() => {
      db.prepare("UPDATE materials SET content = 'evil'").run();
    }, /immutable/);
    assert.throws(() => {
      db.prepare('DELETE FROM materials').run();
    }, /immutable/);
  } finally {
    cleanup();
  }
});

test('task status CHECK accepts the fork statuses and rejects unknown ones', () => {
  const { db, cleanup } = makeDb();
  try {
    db.prepare("INSERT INTO projects (name) VALUES ('p')").run();
    db.prepare("INSERT INTO epics (project_id, name) VALUES (1, 'e')").run();
    const insert = db.prepare("INSERT INTO tasks (epic_id, title, status) VALUES (1, 't', ?)");

    for (const status of ['todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked', 'failed', 'cancelled']) {
      insert.run(status);
    }
    assert.throws(() => insert.run('deployed'), Error);
  } finally {
    cleanup();
  }
});

test('run status CHECK distinguishes waiting from crashable statuses', () => {
  const { db, cleanup } = makeDb();
  try {
    db.prepare("INSERT INTO workflows (id, name, graph_json) VALUES ('wf1', 'demo', '{}')").run();
    const insert = db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, 'wf1', ?)");
    for (const [i, status] of ['new', 'running', 'waiting', 'success', 'error', 'canceled', 'crashed'].entries()) {
      insert.run(`r${i}`, status);
    }
    assert.throws(() => insert.run('rX', 'paused'), Error);
    assert.throws(() => insert.run('rY', 'pending'), Error);
  } finally {
    cleanup();
  }
});
