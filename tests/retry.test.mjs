// Операторский повтор: исчерпанный бюджет ретраев — утверждение о ВОРКЕРЕ,
// а не о мире. Когда внешняя причина ушла, узел должен продолжаться с того
// места, где встал, не теряя принятый выше материал.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-retry-'));
process.env.DB_PATH = path.join(dir, 'retry.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution, completeActivity, failActivity, getExecution } = await import('../dist/kernel/executions.js');
const { sweep } = await import('../dist/kernel/sweep.js');
const { retryNode } = await import('../dist/operator.js');
const { board } = await import('../dist/kernel/board.js');

const db = getDb();
const eventsOf = (runId, type) => getEvents(db, runId).filter((e) => e.type === type);
const cardFor = (runId, node) =>
  board(db, { run_id: runId }).columns.flatMap((c) => c.cards).find((c) => c.node_id === node);

const GRAPH = JSON.stringify({
  nodes: {
    idea: { type: 'emit', parameters: { items: [{ json: { text: 'таймер' } }] } },
    brief: {
      type: 'llm',
      parameters: {
        mode: 'echo',
        prompt: 'бриф по {{text}}',
        timeouts: { heartbeat_s: 30, schedule_to_start_s: 60, start_to_close_s: 120 },
        retry: { max_attempts: 2 },
      },
    },
    publish: { type: 'template', parameters: { template: 'опубликовано: {{text}}' } },
  },
  connections: {
    idea: { main: [[{ node: 'brief' }]] },
    brief: { main: [[{ node: 'publish' }]] },
  },
});

/** Все попытки узла падают так, как падал бы воркер без сети. */
function exhaustWithOutage(runId, node) {
  for (let i = 0; i < 6; i++) {
    const queued = getEvents(db, runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json))
      .filter((p) => p.node_id === node)
      .map((p) => p.execution_id)
      .filter((id) => getExecution(db, id).status === 'new');
    if (queued.length === 0) break;
    const { lease } = claimExecution(db, queued[0]);
    failActivity(db, queued[0], lease, 'llm_error', 'opencode exited null: сеть недоступна');
    sweep(db);
  }
}

test('внешний отказ доводит прогон до error — честно, но не навсегда', () => {
  const run = runGraph(db, GRAPH, { name: 'outage' });
  exhaustWithOutage(run.runId, 'brief');

  assert.equal(resumeRun(db, run.runId).status, 'error', 'бюджет исчерпан → прогон терминален');
  assert.equal(eventsOf(run.runId, 'execution.retry_exhausted').length, 1);
  assert.equal(cardFor(run.runId, 'brief').status, 'failed');
  assert.equal(cardFor(run.runId, 'idea').status, 'done', 'принятый выше материал цел');
});

test('оператор повторяет узел: прогон продолжается с того места, где встал', () => {
  const runId = board(db, {}).runs[0].run_id;
  const attemptsBefore = eventsOf(runId, 'execution.scheduled').length;

  const result = retryNode(db, runId, 'brief', 'сеть вернулась');
  assert.equal(result.stop, 'waiting', 'узел снова в работе, а не в отказе');

  // повтор — это durable-событие, а не правка состояния руками
  assert.equal(eventsOf(runId, 'operator.retry_requested').length, 1);
  assert.equal(eventsOf(runId, 'operator.reopened').length, 1,
    'терминальный прогон переоткрыт явно');
  assert.equal(eventsOf(runId, 'execution.scheduled').length, attemptsBefore + 1);

  // и узлу выдан свежий бюджет автоматических попыток
  const fresh = eventsOf(runId, 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json))
    .at(-1);
  const policy = JSON.parse(getExecution(db, fresh.execution_id).retry_json);
  assert.ok(policy.max_attempts > fresh.attempt, `бюджет ${policy.max_attempts} > попытки ${fresh.attempt}`);

  // доводим до конца: воркер отработал — прогон дошёл до успеха
  const { lease } = claimExecution(db, fresh.execution_id);
  completeActivity(db, fresh.execution_id, lease, [{ json: { text: 'бриф готов' } }]);
  assert.equal(resumeRun(db, runId).status, 'success');

  // ничего не переделано заново: emit остался одной попыткой
  const completed = eventsOf(runId, 'node.completed').map((e) => JSON.parse(e.payload_json).node_id);
  assert.equal(completed.filter((node) => node === 'idea').length, 1,
    'верхний узел не переисполнялся');
  assert.ok(completed.includes('publish'), 'ниже по конвейеру работа поехала дальше');
});

test('повторять успешный прогон нечего', () => {
  const runId = board(db, {}).runs.find((r) => r.status === 'success').run_id;
  assert.throws(() => retryNode(db, runId, 'brief'), /RUN_SEALED/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
