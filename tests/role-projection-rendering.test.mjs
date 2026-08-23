// tests/role-projection-rendering.test.mjs
//
// CC-GAP-10 — role projection clarity (rendering-only).
//
// Packet: docs/plans/CONFORMANCE-CLOSURE-PLAN.md (CC-00C, CC-GAP-10) and
// docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md.
//
// Frozen acceptance criteria this file enforces (blocking regression proofs):
//   1. A board or task-detail surface that omits or hides the author/reviewer
//      role for tasks sharing one Workplace ref FAILS projection.
//   2. Rendering reviewer projections as duplicate implementation work (or as
//      a second graph) FAILS projection — the honest "distinct role, not
//      duplicate implementation work" statement must be rendered.
//   3. A "fix" that deduplicates or rewrites the durable projections instead
//      of the rendering FAILS projection — every task over a Workplace ref
//      renders as its own card/row, one per durable row, roles never collapse
//      into one badge.
//
// The durable data is pre-existing (tasks.workplace_ref + tasks.metadata
// $.role). These tests perform NO writes to production state: they render
// through the real board/detail surfaces against a temp DB and a stubbed
// loadBoard, exactly like tests/worker-names-display.test.mjs.
//
// Hermetic: temp DB, no engine, no spawns, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../dist/schema.js';
import { initShared } from '../tracker-view/shared.mjs';
import {
  createBoardRenderApi,
  taskProjectionIdentity,
  shortWorkplaceRef,
} from '../tracker-view/board-render.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-cc-gap-10-'));

test.after(() => {
  // Windows: AV/indexer can hold a temp file briefly — bounded retries.
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// Fixture: the Elite-6 shape — one Workplace, an author projection (#15) and
// a reviewer projection (#26) over the SAME durable workplace_ref, plus a
// plain tracker task (#99) that owns no projection identity.
// ---------------------------------------------------------------------------

const WORKPLACE_REF =
  'workplace/9/solution-development@1.4.4/impl/galaxy-ship-foundation';
const WORKPLACE_SHORT = 'impl/galaxy-ship-foundation';

function projectionMetadata(role) {
  return JSON.stringify({
    role,
    workplace_ref: WORKPLACE_REF,
    production_cell_id: 'impl',
    work_key: 'galaxy-ship-foundation',
    process_run_id: 9,
  });
}

const AUTHOR_TASK = {
  id: 15, epic_id: 1, status: 'done', priority: 'high',
  title: 'Implement galaxy ship foundation',
  tags: '[]', metadata: projectionMetadata('author'),
  workplace_ref: WORKPLACE_REF,
  task_kind: 'development.implement', workflow_stage: 'solution-development',
};
// Same column as the author projection: a finished cell leaves BOTH durable
// projections side by side — exactly the board state that gets misread as
// "duplicate implementation work" when role is not displayed.
const REVIEWER_TASK = {
  id: 26, epic_id: 1, status: 'done', priority: 'high',
  title: 'Review galaxy ship foundation',
  tags: '[]', metadata: projectionMetadata('reviewer'),
  workplace_ref: WORKPLACE_REF,
  task_kind: 'development.review', workflow_stage: 'solution-development',
};
const PLAIN_TASK = {
  id: 99, epic_id: 1, status: 'todo', priority: 'medium',
  title: 'Plain tracker task without projection identity',
  tags: '[]', metadata: '{}', workplace_ref: null,
  task_kind: null, workflow_stage: null,
};

const theme = {
  COLS: [
    { key: 'todo', label: 'Backlog' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'review', label: 'Review (queue)' },
    { key: 'review_in_progress', label: 'Reviewing' },
    { key: 'done', label: 'Done' },
    { key: 'blocked', label: 'Blocked' },
  ],
  PROJECT_COLORS: ['#123456'], PRIO: { high: '#f85149', medium: '#f1c40f' },
  TYPE_COLORS: {}, TYPE_LABEL: {}, STATUS_LABEL: {},
  STATUS_COLOR: {}, LINK_COLORS: {}, LINK_GLYPH: {},
};

function makeBoardApi(tasks) {
  return createBoardRenderApi({
    RELOAD_SEC: 5,
    loadBoard: () => ({
      epicById: { 1: { id: 1, name: 'CC-GAP-10 Epic' } },
      tasks,
    }),
    theme,
    modelApi: { ZAI_MODELS: [], LMSTUDIO_MODELS: [], LMSTUDIO_ONLINE: false },
    runtimeConfig: {},
  });
}

/** Slice of the board HTML covering exactly one card (cards render in task
 *  order inside a column; the slice ends where the next card starts). */
function cardSlice(html, taskId) {
  const marker = `data-task="${taskId}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `card #${taskId} must render on the board`);
  const next = html.indexOf('data-task="', start + marker.length);
  return html.slice(start, next < 0 ? html.length : next);
}

// ---------------------------------------------------------------------------
// Proof 1 + 3 (board): the role is displayed per card, roles do not collapse,
// the shared Workplace identity is displayed on both cards, and every durable
// task renders as its own card — no deduplication.
// ---------------------------------------------------------------------------

test('renderBoard: author and reviewer projections over one Workplace each keep their own card and distinct role badges', () => {
  const dbPath = path.join(temp, 'board.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.close();
  initShared({ dbPath, Database, workerLogRoots: [] });

  const html = makeBoardApi([AUTHOR_TASK, REVIEWER_TASK, PLAIN_TASK])
    .renderBoard(1, [{ id: 1, name: 'cc-gap-10', color: '#123456', total: 3 }]);

  // Proof 3 — no deduplication: all three durable tasks render their own card.
  for (const id of [15, 26, 99]) {
    assert.ok(html.includes(`data-task="${id}"`),
      `task #${id} must render as its own card (no dedup)`);
  }

  const authorCard = cardSlice(html, 15);
  const reviewerCard = cardSlice(html, 26);
  const plainCard = cardSlice(html, 99);

  // Proof 1 — role displayed on the board, roles never collapse. (The badge
  // carries a title attribute between class and text — match structurally.)
  assert.ok(/class="task-badge role role-author"[^>]*>author<\/span>/.test(authorCard),
    'author card must display the author role badge');
  assert.ok(/class="task-badge role role-reviewer"[^>]*>reviewer<\/span>/.test(reviewerCard),
    'reviewer card must display the reviewer role badge');
  assert.ok(!authorCard.includes('role-reviewer'),
    'the author projection must not be badged as reviewer (roles do not collapse)');
  assert.ok(!reviewerCard.includes('role-author'),
    'the reviewer projection must not be badged as author (roles do not collapse)');

  // The shared Workplace identity is displayed ALONGSIDE the role on both
  // cards (CC-GAP-10: role alongside the shared Workplace identity).
  const wpBadge = `wp:${WORKPLACE_SHORT}`;
  assert.ok(authorCard.includes(wpBadge),
    'author card must display the shared Workplace identity');
  assert.ok(reviewerCard.includes(wpBadge),
    'reviewer card must display the shared Workplace identity');
  assert.ok(authorCard.includes(`data-workplace="${WORKPLACE_REF}"`),
    'author card carries the exact durable workplace ref');
  assert.ok(reviewerCard.includes(`data-workplace="${WORKPLACE_REF}"`),
    'reviewer card carries the exact durable workplace ref');
  assert.equal((html.match(new RegExp(`data-workplace="${WORKPLACE_REF.replace(/[/@.]/g, (c) => `\\${c}`)}"`, 'g')) || []).length, 2,
    'exactly one card per durable task over the Workplace — a dedup "fix" drops this to 1 and fails');

  // Proof 2 — honest rendering: the reviewer badge states the projection
  // truth; a "duplicate of #15" reading must be impossible.
  assert.ok(reviewerCard.includes('not duplicate implementation work'),
    'the reviewer badge must carry the honest projection note');
  assert.ok(authorCard.includes('author projection'),
    'the author badge must carry the honest projection note');
  assert.ok(!reviewerCard.includes('duplicate of'),
    'no surface may label a reviewer projection as a duplicate task');
});

test('renderBoard: a task without durable projection identity renders no role badge (never a fabricated role)', () => {
  const dbPath = path.join(temp, 'board-plain.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.close();
  initShared({ dbPath, Database, workerLogRoots: [] });

  const html = makeBoardApi([PLAIN_TASK])
    .renderBoard(1, [{ id: 1, name: 'cc-gap-10', color: '#123456', total: 1 }]);
  const plainCard = cardSlice(html, 99);
  assert.ok(!plainCard.includes('task-badge role role-author'),
    'no author badge may be fabricated');
  assert.ok(!plainCard.includes('task-badge role role-reviewer'),
    'no reviewer badge may be fabricated');
  assert.ok(!plainCard.includes('data-role="author"') && !plainCard.includes('data-role="reviewer"'),
    'data-role stays empty when the durable record carries no role');
});

// ---------------------------------------------------------------------------
// Proof 1 + 2 + 3 (task detail): role + Workplace rows, the sibling
// projections over the same Workplace listed with their roles, and the honest
// distinct-role note — one row per durable task, never merged.
// ---------------------------------------------------------------------------

function seedDetailDb() {
  const dbPath = path.join(temp, `detail-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'cc-gap-10')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'CC-GAP-10 Epic')").run();
  const insert = db.prepare(`
    INSERT INTO tasks (id,epic_id,title,status,priority,workplace_ref,metadata,task_kind,workflow_stage)
    VALUES (@id,1,@title,@status,'high',@workplace_ref,@metadata,@task_kind,'solution-development')`);
  insert.run({
    id: 15, title: AUTHOR_TASK.title, status: 'done',
    workplace_ref: WORKPLACE_REF, metadata: projectionMetadata('author'),
    task_kind: 'development.implement',
  });
  insert.run({
    id: 26, title: REVIEWER_TASK.title, status: 'review_in_progress',
    workplace_ref: WORKPLACE_REF, metadata: projectionMetadata('reviewer'),
    task_kind: 'development.review',
  });
  insert.run({
    id: 99, title: PLAIN_TASK.title, status: 'todo',
    workplace_ref: null, metadata: '{}', task_kind: null,
  });
  db.close();
  initShared({ dbPath, Database, workerLogRoots: [] });
  return makeBoardApi([]);
}

test('renderTaskView: reviewer detail shows role + Workplace and lists the author projection as a sibling role, not duplicate work', () => {
  const boardApi = seedDetailDb();
  const projects = [{ id: 1, name: 'cc-gap-10', color: '#123456', total: 3 }];
  const html = boardApi.renderTaskView(26, projects);

  // Proof 1 — the detail surface displays the role and the Workplace identity.
  assert.ok(html.includes('Workplace projection'),
    'the detail card must carry the Workplace projection section');
  assert.ok(/class="task-badge role role-reviewer"[^>]*>reviewer<\/span>/.test(html),
    'the reviewer detail must display the reviewer role badge');
  assert.ok(html.includes(`title="${WORKPLACE_REF}"`),
    'the full durable workplace ref must be present for exact correlation');

  // Proof 3 — sibling durable rows are listed ONE PER TASK with their own
  // role badges: the author projection stays a distinct row/card.
  assert.ok(html.includes('#15'),
    'the sibling author projection must be listed on the reviewer detail');
  assert.ok(/class="task-badge role role-author"[^>]*>author<\/span>/.test(html),
    'the sibling row must display the author role badge');
  assert.ok(html.includes('(this task)'),
    'the current task is marked as its own projection row');

  // Proof 2 — the honest statement rides along; a duplicate-work reading
  // must be impossible on this surface.
  assert.ok(html.includes('not duplicate implementation work'),
    'the detail note must state reviewer projections are not duplicate implementation work');
  assert.ok(!html.includes('duplicate of'),
    'no surface may label a reviewer projection as a duplicate task');
});

test('renderTaskView: author detail symmetric — lists the reviewer projection sibling with its role', () => {
  const boardApi = seedDetailDb();
  const projects = [{ id: 1, name: 'cc-gap-10', color: '#123456', total: 3 }];
  const html = boardApi.renderTaskView(15, projects);
  assert.ok(/class="task-badge role role-author"[^>]*>author<\/span>/.test(html),
    'the author detail must display the author role badge');
  assert.ok(html.includes('#26'),
    'the sibling reviewer projection must be listed on the author detail');
  assert.ok(/class="task-badge role role-reviewer"[^>]*>reviewer<\/span>/.test(html),
    'the sibling row must display the reviewer role badge');
  assert.ok(html.includes('not duplicate implementation work'),
    'the honest projection note must be rendered on the author detail too');
});

test('renderTaskView: a task without projection identity renders no role and no Workplace projection section', () => {
  const boardApi = seedDetailDb();
  const projects = [{ id: 1, name: 'cc-gap-10', color: '#123456', total: 3 }];
  const html = boardApi.renderTaskView(99, projects);
  assert.ok(!html.includes('Workplace projection'),
    'no projection section may be fabricated without durable identity');
  assert.ok(!html.includes('task-badge role role-author')
    && !html.includes('task-badge role role-reviewer'),
    'no role badge may be fabricated');
});

// ---------------------------------------------------------------------------
// Pure helper contracts (identity reading is honest, never a guess).
// ---------------------------------------------------------------------------

test('taskProjectionIdentity: reads the durable identity or returns nulls — never guesses', () => {
  assert.deepEqual(
    taskProjectionIdentity({ metadata: '{"role":"author","workplace_ref":"w"}' }),
    { role: 'author', workplaceRef: 'w' });
  assert.deepEqual(
    taskProjectionIdentity({ metadata: '{"role":"reviewer"}', workplace_ref: 'w2' }),
    { role: 'reviewer', workplaceRef: 'w2' });
  // Garbage metadata falls back to nulls / the workplace_ref column.
  assert.deepEqual(
    taskProjectionIdentity({ metadata: 'not-json', workplace_ref: 'w3' }),
    { role: null, workplaceRef: 'w3' });
  // An unknown role value is NOT coerced into a badge.
  assert.deepEqual(
    taskProjectionIdentity({ metadata: '{"role":"verifier"}' }),
    { role: null, workplaceRef: null });
  // metadata.workplace_ref is used only when the column is absent/empty.
  assert.deepEqual(
    taskProjectionIdentity({ metadata: '{"workplace_ref":"w4"}', workplace_ref: '' }),
    { role: null, workplaceRef: 'w4' });
  assert.deepEqual(taskProjectionIdentity({}), { role: null, workplaceRef: null });
  assert.deepEqual(taskProjectionIdentity(null), { role: null, workplaceRef: null });
});

test('shortWorkplaceRef: cell/workKey display form; passthrough for non-workplace strings', () => {
  assert.equal(shortWorkplaceRef(WORKPLACE_REF), WORKPLACE_SHORT);
  assert.equal(shortWorkplaceRef('workplace/1/m/c/k/with/slashes'), 'c/k/with/slashes');
  assert.equal(shortWorkplaceRef('some/other/string'), 'some/other/string');
  assert.equal(shortWorkplaceRef('plain'), 'plain');
});
