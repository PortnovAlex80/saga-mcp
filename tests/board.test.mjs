// M0 board fitness: the upstream board model works on the saga5 schema —
// hierarchy, dependency auto-block, dashboard aggregation. These are the real
// MCP tool handlers; DB_PATH points at a throwaway database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-board-'));
process.env.DB_PATH = path.join(dir, 'board.db');

const projects = await import('../dist/tools/projects.js');
const epics = await import('../dist/tools/epics.js');
const tasks = await import('../dist/tools/tasks.js');
const subtasks = await import('../dist/tools/subtasks.js');
const dashboard = await import('../dist/tools/dashboard.js');
const comments = await import('../dist/tools/comments.js');
const notes = await import('../dist/tools/notes.js');
const { closeDb } = await import('../dist/db.js');

test('board lifecycle: project → epic → tasks → dependency auto-block', () => {
  const proj = projects.handlers.project_create({ name: 'Saga5 Demo' });
  assert.ok(proj.id, 'project_create returns the row');

  const epic = epics.handlers.epic_create({ project_id: proj.id, name: 'Milestone 0' });
  assert.ok(epic.id, 'epic_create returns the row');

  const a = tasks.handlers.task_create({ epic_id: epic.id, title: 'Build kernel' });
  const b = tasks.handlers.task_create({ epic_id: epic.id, title: 'Wire LLM worker', depends_on: [a.id] });

  // b depends on a, and a is not done → b must be auto-blocked.
  assert.equal(tasks.handlers.task_get({ id: b.id }).status, 'blocked');

  // finish a → b unblocks back to todo
  tasks.handlers.task_update({ id: a.id, status: 'done' });
  assert.equal(tasks.handlers.task_get({ id: b.id }).status, 'todo');
});

test('subtasks, comments and notes attach to tasks', () => {
  const epic = epics.handlers.epic_list({ project_id: undefined }).at(-1);
  const t = tasks.handlers.task_list({}).at(-1);

  const sub = subtasks.handlers.subtask_create({ task_id: t.id, titles: ['Event log'] });
  assert.ok(sub.id);

  comments.handlers.comment_add({ task_id: t.id, author: 'operator', content: 'looks good' });
  const list = comments.handlers.comment_list({ task_id: t.id });
  assert.equal(list.length, 1);

  notes.handlers.note_save({ title: 'Decision', content: 'Keep events append-only', note_type: 'decision' });
  const found = notes.handlers.note_search({ query: 'append-only' });
  assert.ok(found.length >= 1);
});

test('dashboard aggregates the board', () => {
  const stats = dashboard.handlers.tracker_dashboard({});
  const text = JSON.stringify(stats);
  assert.ok(text.includes('Saga5 Demo'), 'project name visible in dashboard');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
