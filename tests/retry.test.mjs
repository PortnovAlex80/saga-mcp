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

test('доска не называет «очередью» то, что стоит из-за отказа', () => {
  const runId = board(db, {}).runs[0].run_id;
  const data = board(db, { run_id: runId });

  // publish ниже упавшего brief: он не в очереди — он не поедет, пока не починят
  const publish = data.columns.flatMap((c) => c.cards).find((c) => c.node_id === 'publish');
  assert.equal(publish.status, 'todo');
  assert.equal(publish.queued, false, 'исполнение ему никто не назначал');
  assert.equal(publish.blocked_by, 'brief', 'виновник назван прямо на карточке');

  assert.equal(data.summary.stranded, 1);
  assert.equal(data.summary.queued, 0, 'в очереди на воркера — никого');
  assert.deepEqual(data.summary.culprits, ['brief'],
    'починка этого узла сдвинет весь застрявший хвост');
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

test('ребёнок веера тоже возвращается в работу — иначе у него нет пути назад', () => {
  const graph = JSON.stringify({
    nodes: {
      plan: {
        type: 'emit',
        parameters: { items: [{ json: { title: 'T1' } }, { json: { title: 'T2' } }] },
      },
      tasks: {
        type: 'split',
        parameters: {
          child: {
            type: 'llm',
            parameters: {
              mode: 'echo',
              prompt: 'делаю {{title}}',
              timeouts: { heartbeat_s: 30, schedule_to_start_s: 60, start_to_close_s: 120 },
              retry: { max_attempts: 1 },
            },
          },
        },
      },
      merge: { type: 'join', parameters: {} },
    },
    connections: { plan: { main: [[{ node: 'tasks' }]] }, tasks: { main: [[{ node: 'merge' }]] } },
  });
  const run = runGraph(db, graph, { name: 'fanout-outage' });

  // первый ребёнок отработал, второй — упал без сети
  for (const child of ['tasks::1', 'tasks::2']) {
    resumeRun(db, run.runId);
    const exec = getEvents(db, run.runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json))
      .find((p) => p.node_id === child && getExecution(db, p.execution_id).status === 'new');
    const { lease } = claimExecution(db, exec.execution_id);
    if (child === 'tasks::1') {
      completeActivity(db, exec.execution_id, lease, [{ json: { text: 'T1 готово' } }]);
    } else {
      failActivity(db, exec.execution_id, lease, 'llm_error', 'сеть недоступна');
      sweep(db);
    }
  }
  assert.equal(resumeRun(db, run.runId).status, 'error');
  assert.equal(cardFor(run.runId, 'tasks::2').status, 'failed');
  assert.equal(cardFor(run.runId, 'merge').blocked_by, 'tasks::2', 'join стоит из-за упавшего ребёнка');

  // повтор возвращает ИМЕННО его; сосед не переисполняется
  retryNode(db, run.runId, 'tasks::2', 'сеть вернулась');
  const retryExec = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json))
    .at(-1);
  assert.equal(retryExec.node_id, 'tasks::2');

  const { lease } = claimExecution(db, retryExec.execution_id);
  completeActivity(db, retryExec.execution_id, lease, [{ json: { text: 'T2 готово' } }]);
  assert.equal(resumeRun(db, run.runId).status, 'success', 'join дождался обоих и веер закрылся');

  const completed = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json).node_id);
  assert.equal(completed.filter((node) => node === 'tasks::1').length, 1,
    'успешный сосед не переделывался');
});

test('опоздавший приговор не переголосовывает оператора', () => {
  // бюджет в одну попытку: её провал — это сразу «исчерпано», то есть тот
  // самый приговор, который может опоздать
  const run = runGraph(db, JSON.stringify({
    nodes: {
      idea: { type: 'emit', parameters: { items: [{ json: { text: 'таймер' } }] } },
      brief: {
        type: 'llm',
        parameters: {
          mode: 'echo',
          timeouts: { heartbeat_s: 30, schedule_to_start_s: 60, start_to_close_s: 120 },
          retry: { max_attempts: 1 },
        },
      },
    },
    connections: { idea: { main: [[{ node: 'brief' }]] } },
  }), { name: 'late-verdict' });

  // попытка в полёте: воркер её взял и ещё не сдал
  resumeRun(db, run.runId);
  const exec = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json))
    .find((p) => p.node_id === 'brief');
  const { lease } = claimExecution(db, exec.execution_id);

  // оператор уже сказал «повтори», пока попытка висела
  retryNode(db, run.runId, 'brief', 'сеть вернулась, старая попытка ещё висит');

  // и только теперь старая попытка доваливается по своему бюджету
  failActivity(db, exec.execution_id, lease, 'llm_error', 'таймаут старого бюджета');
  const decisions = sweep(db).decisions.filter((d) => d.nodeId === 'brief');

  assert.ok(decisions.some((d) => d.decision === 'reopened'),
    'свип видит, что решение оператора старше приговора');
  assert.equal(cardFor(run.runId, 'brief').status !== 'failed', true,
    'узел остаётся в работе, а не убит задним числом');
  assert.equal(
    getEvents(db, run.runId).filter((e) => e.type === 'node.failed').length,
    0,
    'приговор не выносился вовсе'
  );
});

test('повтор ребёнка веера доходит до соединения и до приёмки', async () => {
  const { getMaterial } = await import('../dist/materials.js');
  const graph = JSON.stringify({
    nodes: {
      plan: { type: 'emit', parameters: { items: [{ json: { title: 'T1' } }, { json: { title: 'T2' } }] } },
      tasks: {
        type: 'split',
        parameters: {
          child: {
            type: 'llm',
            parameters: {
              mode: 'echo', prompt: 'делаю {{title}}',
              timeouts: { heartbeat_s: 30, schedule_to_start_s: 60 },
              retry: { max_attempts: 1 },
            },
          },
        },
      },
      merge: { type: 'join', parameters: {} },
      quality: {
        type: 'gate',
        parameters: { checks: [{ op: 'contains', field: 'text', value: 'ГОТОВО' }], max_repairs: 0 },
      },
    },
    connections: {
      plan: { main: [[{ node: 'tasks' }]] },
      tasks: { main: [[{ node: 'merge' }]] },
      merge: { main: [[{ node: 'quality' }]] },
    },
  });
  const run = runGraph(db, graph, { name: 'fanout-refresh' });

  // оба ребёнка сдают материал, который приёмку НЕ проходит
  for (const child of ['tasks::1', 'tasks::2']) {
    resumeRun(db, run.runId);
    const exec = getEvents(db, run.runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json))
      .find((p) => p.node_id === child && getExecution(db, p.execution_id).status === 'new');
    const { lease } = claimExecution(db, exec.execution_id);
    completeActivity(db, exec.execution_id, lease, [{ json: { text: `черновик ${child}` } }]);
  }
  resumeRun(db, run.runId);
  assert.equal(cardFor(run.runId, 'quality').status, 'blocked', 'бюджет 0 → решает человек');

  // оператор возвращает в работу ОДНОГО ребёнка, и тот сдаёт годный материал
  retryNode(db, run.runId, 'tasks::2', 'переделай');
  const retryExec = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json))
    .at(-1);
  assert.equal(retryExec.node_id, 'tasks::2');
  const { lease } = claimExecution(db, retryExec.execution_id);
  completeActivity(db, retryExec.execution_id, lease, [{ json: { text: 'ГОТОВО tasks::2' } }]);

  const settled = resumeRun(db, run.runId);
  assert.equal(settled.status, 'success', 'соединение пересобралось, приёмка пересмотрела решение');

  // союз включает и старую работу соседа, и новую работу переделанного
  const mergeDigest = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .filter((p) => p.node_id === 'merge')
    .at(-1).output_digest;
  const texts = JSON.parse(getMaterial(db, mergeDigest).content).map((item) => item.json.text);
  assert.ok(texts.some((t) => t.includes('черновик tasks::1')), 'работа соседа не пропала');
  assert.ok(texts.some((t) => t === 'ГОТОВО tasks::2'), 'переделанная работа попала в союз');
  assert.ok(!texts.includes('черновик tasks::2'),
    '«повтори» значит ПЕРЕДЕЛАЙ: забракованный материал ушёл со стола, а не лёг рядом');
});

test('стол = рабочее место: не принято — нанимают следующего НА ТО ЖЕ место', async () => {
  const { getMaterial } = await import('../dist/materials.js');
  const graph = JSON.stringify({
    nodes: {
      plan: { type: 'emit', parameters: { items: [{ json: { title: 'T1' } }, { json: { title: 'T2' } }] } },
      tasks: {
        type: 'split',
        parameters: {
          child: {
            type: 'llm',
            parameters: {
              mode: 'echo', prompt: 'делаю {{title}}',
              timeouts: { heartbeat_s: 30, schedule_to_start_s: 60 },
              retry: { max_attempts: 1 },
            },
          },
        },
      },
      merge: { type: 'join', parameters: {} },
      quality: {
        type: 'gate',
        parameters: {
          checks: [{ op: 'contains', field: 'text', value: 'ГОТОВО' }],
          repair_target: 'tasks',
          max_repairs: 2,
        },
      },
    },
    connections: {
      plan: { main: [[{ node: 'tasks' }]] },
      tasks: { main: [[{ node: 'merge' }]] },
      merge: { main: [[{ node: 'quality' }]] },
    },
  });
  const run = runGraph(db, graph, { name: 'desk-as-workplace' });

  // первый рабочий сделал годное, второй — брак
  const settle = (child, text) => {
    resumeRun(db, run.runId);
    const exec = getEvents(db, run.runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json))
      .find((p) => p.node_id === child && getExecution(db, p.execution_id).status === 'new');
    if (!exec) return null;
    const { lease } = claimExecution(db, exec.execution_id);
    completeActivity(db, exec.execution_id, lease, [{ json: { text } }]);
    return exec;
  };
  settle('tasks::1', 'ГОТОВО T1');
  settle('tasks::2', 'черновик T2');
  resumeRun(db, run.runId);

  // приёмка вернула в работу ИМЕННО второе рабочее место, с замечаниями
  const repairs = getEvents(db, run.runId)
    .filter((e) => e.type === 'repair.requested')
    .map((e) => JSON.parse(e.payload_json));
  assert.deepEqual(repairs.map((r) => r.target), ['tasks::2'],
    'сосед со своей годной работой не переделывает ничего');
  assert.match(repairs[0].reasons.join(' '), /ГОТОВО/, 'замечания приёмки поехали к рабочему');

  // на то же место нанят следующий рабочий — и он сдал годное
  const second = settle('tasks::2', 'ГОТОВО T2');
  assert.ok(second, 'на освободившееся рабочее место назначена новая попытка');
  assert.equal(second.node_id, 'tasks::2', 'нанят НА ТО ЖЕ рабочее место');
  // Счётчики разнесены: «работа не принята» — это ВТОРОЙ КРУГ на том же
  // рабочем месте, а нанятый рабочий свои попытки начинает с первой. Иначе
  // брак приёмки съедал бы бюджет падений и место закрывалось бы досрочно.
  assert.equal(second.round, 2, 'не принято — следующий круг на том же месте');
  assert.equal(second.attempt, 1, 'у нанятого рабочего свой счёт падений, с нуля');
  assert.equal(
    getEvents(db, run.runId).filter((e) => {
      const p = JSON.parse(e.payload_json);
      return e.type === 'execution.scheduled' && p.node_id === 'tasks::1';
    }).length,
    1,
    'соседнее рабочее место не переоткрывалось'
  );
  assert.equal(resumeRun(db, run.runId).status, 'success');

  const mergeDigest = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .filter((p) => p.node_id === 'merge')
    .at(-1).output_digest;
  const texts = JSON.parse(getMaterial(db, mergeDigest).content).map((item) => item.json.text);
  assert.deepEqual(texts.sort(), ['ГОТОВО T1', 'ГОТОВО T2'],
    'на столе осталась только принятая работа: брак вытеснен, годное соседа сохранено');
});

test('повторять успешный прогон нечего', () => {
  const runId = board(db, {}).runs.find((r) => r.status === 'success').run_id;
  assert.throws(() => retryNode(db, runId, 'brief'), /RUN_SEALED/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
