// Эскалация: исчерпав ремонт на своём уровне, стол идёт НЕ к человеку, а к
// столу-поставщику — с замечаниями. «Задачу не удаётся сделать» — претензия
// к плану, а не к рабочему. Человек остаётся последним, а не первым адресатом.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-escalation-'));
process.env.DB_PATH = path.join(dir, 'escalation.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution, completeActivity } = await import('../dist/kernel/executions.js');
const { getMaterial } = await import('../dist/materials.js');

const db = getDb();
after(() => {
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

const payloads = (runId, type) =>
  getEvents(db, runId).filter((e) => e.type === type).map((e) => JSON.parse(e.payload_json));

const GRAPH = JSON.stringify({
  nodes: {
    plan: { type: 'llm', parameters: { mode: 'echo', prompt: 'план работ' } },
    impl: { type: 'llm', parameters: { mode: 'echo', prompt: 'делаю: {{text}}' } },
    quality: {
      type: 'gate',
      parameters: {
        checks: [{ op: 'contains', field: 'text', value: 'ГОТОВО' }],
        repair_target: 'impl',
        max_repairs: 1,
        escalate_to: 'plan',
        title: 'Демо: Реализация',
      },
    },
  },
  connections: { plan: { main: [[{ node: 'impl' }]] }, impl: { main: [[{ node: 'quality' }]] } },
});

/** Прогоняет конвейер, отдавая каждому нанятому рабочему заранее решённый
 *  ответ. Возвращает узлы, которые успели поработать. */
function turn(runId, answer = (node) => `работа ${node}`) {
  const worked = [];
  for (let guard = 0; guard < 40; guard += 1) {
    resumeRun(db, runId);
    const pending = payloads(runId, 'execution.scheduled')
      .find((p) => {
        const row = db.prepare('SELECT status FROM executions WHERE id = ?').get(p.execution_id);
        return row?.status === 'new';
      });
    if (!pending) break;
    const { lease } = claimExecution(db, pending.execution_id);
    completeActivity(db, pending.execution_id, lease, [{ json: { text: answer(pending.node_id) } }]);
    worked.push(pending.node_id);
  }
  resumeRun(db, runId);
  return worked;
}

test('исчерпав ремонт, стол предъявляет претензию поставщику, а не человеку', () => {
  const run = runGraph(db, GRAPH, { name: 'escalation' });
  turn(run.runId);

  const escalations = payloads(run.runId, 'escalation.requested');
  assert.ok(escalations.length > 0, 'претензия ушла на уровень выше');
  assert.equal(escalations[0].node_id, 'quality');
  assert.equal(escalations[0].target, 'plan', 'адресат — стол, давший вход');

  // Претензия переведена на уровень адресата: не «нет строки ГОТОВО»,
  // а «работу не удалось довести до приёмки, переделай свою часть».
  const claim = payloads(run.runId, 'repair.requested').find((p) => p.target === 'plan');
  assert.ok(claim, 'наверх поехал обычный заказ на переделку — с обратной связью');
  assert.equal(claim.escalated, true);
  assert.match(claim.reasons.join('\n'), /не удалось довести до приёмки/);
  assert.match(claim.reasons.join('\n'), /Демо: Реализация/, 'сказано, ГДЕ не получилось');
  assert.match(claim.reasons.join('\n'), /ГОТОВО/, 'и что именно не сошлось');

  // Принятый наверху материал отозван — иначе поставщик «переделал бы»,
  // оставив старое лежать на столе рядом с новым.
  const superseded = payloads(run.runId, 'material.superseded')
    .filter((p) => (p.members ?? []).some((m) => m.node === 'plan'));
  assert.equal(superseded.length, escalations.length,
    'каждая эскалация снимает со стола устаревший план — иначе он лежал бы рядом с новым');

  // Поставщик действительно снова работал.
  const planRuns = payloads(run.runId, 'execution.scheduled').filter((p) => p.node_id === 'plan');
  assert.ok(planRuns.length >= 2, 'на столе плана нанят следующий рабочий');
  assert.equal(planRuns[1].round, 2, 'это новый круг, а не новая попытка того же');
  assert.equal(planRuns[1].attempt, 1, 'у нанятого свой бюджет падений');
});

test('переделанный сверху вход обязан заново пройти вниз по конвейеру', () => {
  const run = runGraph(db, GRAPH, { name: 'stale-downstream' });
  turn(run.runId);

  // Реализация исполнялась и до эскалации, и после: иначе эскалация была бы
  // жестом — наверху переделали, а внизу лежит работа по старому входу.
  const restarts = payloads(run.runId, 'node.restarted');
  assert.ok(restarts.some((p) => p.node_id === 'impl'), 'устаревшая реализация переоткрыта');
  assert.equal(restarts[0].reason, 'stale_input');

  const implRuns = payloads(run.runId, 'execution.scheduled').filter((p) => p.node_id === 'impl');
  assert.ok(implRuns.length >= 3, 'реализация переделана после нового плана');
});

test('эскалация ограничена: качаться между уровнями бесконечно нельзя', () => {
  const run = runGraph(db, GRAPH, { name: 'bounded' });
  turn(run.runId);

  const escalations = payloads(run.runId, 'escalation.requested');
  assert.equal(escalations.length, 3, 'потолок эскалаций на прогон');
  assert.deepEqual(escalations.map((e) => e.hop), [1, 2, 3]);

  // Адресаты кончились — вот теперь человек. Это последний адресат, а не первый.
  const verdicts = payloads(run.runId, 'gate.decided').map((g) => g.verdict);
  assert.equal(verdicts.at(-1), 'human_required');
  assert.ok(
    verdicts.filter((v) => v === 'escalated').length === 3,
    'до человека завод трижды пробовал решить это сам'
  );
});

test('стол, чей вход дал оператор, эскалировать некуда — там и правда человек', () => {
  const graph = JSON.stringify({
    nodes: {
      idea: { type: 'emit', parameters: { items: [{ json: { text: 'идея' } }] } },
      make: { type: 'llm', parameters: { mode: 'echo', prompt: '{{text}}' } },
      quality: {
        type: 'gate',
        parameters: {
          checks: [{ op: 'contains', field: 'text', value: 'ГОТОВО' }],
          repair_target: 'make',
          max_repairs: 0,
        },
      },
    },
    connections: { idea: { main: [[{ node: 'make' }]] }, make: { main: [[{ node: 'quality' }]] } },
  });
  const run = runGraph(db, graph, { name: 'no-supplier' });
  turn(run.runId);
  assert.equal(payloads(run.runId, 'escalation.requested').length, 0);
  assert.equal(payloads(run.runId, 'gate.decided').at(-1).verdict, 'human_required');
});
