// Сброс завода: прогон встал, и оператор распускает смену. Проверяем, что
// сброс — это событие (журнал остаётся властью), что карточки перестают
// висеть и что живой рабочий уже ничего не допишет.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-abandon-'));
process.env.DB_PATH = path.join(dir, 'abandon.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents, getRun } = await import('../dist/events.js');
const { claimExecution, completeActivity, getExecution } = await import('../dist/kernel/executions.js');
const { abandonRun, abandonAllRuns } = await import('../dist/operator.js');
const { board } = await import('../dist/kernel/board.js');

const db = getDb();
after(() => {
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

const GRAPH = JSON.stringify({
  nodes: {
    idea: { type: 'emit', parameters: { items: [{ json: { text: 'таймер' } }] } },
    build: { type: 'llm', parameters: { mode: 'echo', prompt: 'сделай' } },
    ship: { type: 'llm', parameters: { mode: 'echo', prompt: 'выпусти' } },
  },
  connections: { idea: { main: [[{ node: 'build' }]] }, build: { main: [[{ node: 'ship' }]] } },
});

const cards = (runId) => board(db, { run_id: runId }).columns.flatMap((c) => c.cards);

test('распустить смену: карточки не висят, а прогон не стирается', () => {
  const run = runGraph(db, GRAPH, { name: 'abandon' });
  const scheduled = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json));
  const { lease } = claimExecution(db, scheduled[0].execution_id);

  const result = abandonRun(db, run.runId, 'встали, начинаем заново');
  assert.equal(result.status, 'canceled');
  assert.equal(result.canceled, 1, 'исполнение в работе распущено вместе со сменой');

  assert.equal(getRun(db, run.runId).status, 'canceled');
  assert.equal(
    eventsOfType(run.runId, 'run.abandoned').length, 1,
    'сброс записан событием — журнал остаётся единственной властью'
  );
  assert.ok(
    getEvents(db, run.runId).length > 1,
    'сброс НЕ стирает историю: по ней потом и разбираются, почему встали'
  );

  const open = cards(run.runId).filter((c) => !['done', 'failed'].includes(c.status));
  assert.deepEqual(open, [], 'на стене не осталось висящих карточек');
  const build = cards(run.runId).find((c) => c.node_id === 'build');
  assert.match(build.reasons.join(' '), /распущен оператором: встали/,
    'карточка говорит, что её закрыл оператор, а не что она сломалась');

  // Гонка со сбросом закрыта самой арендой: settle требует статуса running.
  assert.throws(
    () => completeActivity(db, scheduled[0].execution_id, lease, [{ json: { text: 'поздно' } }]),
    /.*/,
    'рабочий распущенной смены дописать результат не может'
  );
  assert.equal(getExecution(db, scheduled[0].execution_id).status, 'canceled');
});

test('сброс завода распускает вставшие прогоны и не трогает успешные', () => {
  const stuck = runGraph(db, GRAPH, { name: 'stuck' });
  const done = runGraph(db, JSON.stringify({
    nodes: { only: { type: 'emit', parameters: { items: [{ json: { text: 'готово' } }] } } },
    connections: {},
  }), { name: 'done' });
  assert.equal(getRun(db, done.runId).status, 'success');

  const reset = abandonAllRuns(db, 'сброс завода');
  const touched = reset.map((r) => r.run_id);
  assert.ok(touched.includes(stuck.runId), 'вставший прогон распущен');
  assert.ok(!touched.includes(done.runId), 'успешный прогон не трогаем — артефакт принят');
  assert.equal(getRun(db, done.runId).status, 'success');

  assert.throws(() => abandonRun(db, done.runId), /RUN_SEALED/);
  // Повторный сброс — не ошибка и не второе событие.
  assert.equal(abandonRun(db, stuck.runId).canceled, 0);
  assert.equal(eventsOfType(stuck.runId, 'run.abandoned').length, 1);
});

function eventsOfType(runId, type) {
  return getEvents(db, runId).filter((e) => e.type === type);
}
