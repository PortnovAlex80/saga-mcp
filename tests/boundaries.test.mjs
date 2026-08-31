// Шесть запретов как исполнимые тесты. Это границы владения: если они
// держатся, saga5 не может незаметно стать saga4, где каждый разумный слой был
// разумен по отдельности. См. docs/architecture/SAGA5-BORROWING-BOUNDARIES.md
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-boundaries-'));
process.env.DB_PATH = path.join(dir, 'boundaries.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph } = await import('../dist/kernel/runner.js');
const { board } = await import('../dist/kernel/board.js');
const { projectRun } = await import('../dist/kernel/projection.js');
const { claimExecution, completeActivity, heartbeatExecution } = await import('../dist/kernel/executions.js');
const { getEvents } = await import('../dist/events.js');
const { materialDigest } = await import('../dist/materials.js');
const { DEFAULT_WORKSHOPS } = await import('../dist/workshops.js');

const db = getDb();
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dirPath = SRC) {
  const out = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const GRAPH = JSON.stringify({
  nodes: {
    seed: { type: 'emit', parameters: { items: [{ json: { text: 'материал' } }] } },
    worker: {
      type: 'llm',
      parameters: { mode: 'echo', model: 'qwen/qwen3.6-27b', prompt: '{{text}}', timeouts: { heartbeat_s: 30, schedule_to_start_s: 60 } },
    },
    quality: { type: 'gate', parameters: { checks: [{ op: 'nonempty', field: 'text' }] } },
  },
  connections: { seed: { main: [[{ node: 'worker' }]] }, worker: { main: [[{ node: 'quality' }]] } },
});

test('1. доска не решает, что запускать: у неё нет пути записи, кроме решения оператора', () => {
  const run = runGraph(db, GRAPH, { name: 'boundaries' });
  const cards = board(db, { run_id: run.runId }).columns.flatMap((column) => column.cards);
  assert.ok(cards.length > 0);

  // единственное действие карточки — решение на человеческом гейте
  const actions = new Set(cards.map((card) => card.action));
  assert.ok([...actions].every((action) => action === undefined || action === 'operator_decision'));

  // проекция не пишет в ядро: в её модуле нет ни INSERT, ни UPDATE
  for (const file of ['kernel/projection.ts', 'kernel/board.ts', 'kernel/artifacts.ts', 'kernel/workers.ts']) {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotMatch(text, /\b(INSERT|UPDATE|DELETE)\b/, `${file} — читатель, а не писатель`);
  }
});

test('2. воркер не выбирает следующий узел: он видит только СВОЮ попытку', () => {
  const worker = readFileSync(path.join(SRC, 'runtime/worker.ts'), 'utf8');
  // воркер не вызывает интерпретатор и не трогает граф прогона
  assert.doesNotMatch(worker, /\brunGraph\b|\bresumeRun\b|\bappendEvent\b/,
    'воркер не двигает прогон и не пишет события напрямую');
  // ему позволено только: прочитать свои входы и узнать своё определение
  assert.match(worker, /readActivityInputs/);
  assert.match(worker, /nodeDefinitionFor/);
});

test('3. модель не пишет состояние прогона: чужой lease не settlит ничего', () => {
  const run = runGraph(db, GRAPH, { name: 'boundaries-lease' });
  const scheduled = getEvents(db, run.runId)
    .filter((event) => event.type === 'execution.scheduled')
    .map((event) => JSON.parse(event.payload_json).execution_id);
  const executionId = scheduled.at(-1);
  const { lease } = claimExecution(db, executionId);

  assert.throws(
    () => completeActivity(db, executionId, 'подделанный-lease', [{ json: { text: 'взлом' } }]),
    /EXECUTION_LEASE_INVALID/
  );
  assert.throws(
    () => heartbeatExecution(db, executionId, 'подделанный-lease'),
    /EXECUTION_LEASE_INVALID/
  );
  completeActivity(db, executionId, lease, [{ json: { text: 'честный материал' } }]);
});

test('4. граф не хранит runtime-состояние: позиции узлов ядро не читает', () => {
  const withPositions = JSON.stringify({
    nodes: {
      a: { type: 'emit', parameters: { items: [{ json: { text: 'x' } }] }, position: [10, 20] },
      b: { type: 'template', parameters: { template: 'y {{text}}' }, position: [300, 20] },
    },
    connections: { a: { main: [[{ node: 'b' }]] } },
  });
  const withoutPositions = withPositions.replace(/,"position":\[\d+,\d+\]/g, '');

  const first = runGraph(db, withPositions, { name: 'pos-a' });
  const second = runGraph(db, withoutPositions, { name: 'pos-b' });
  const digestOf = (runId) => JSON.parse(
    getEvents(db, runId).filter((e) => e.type === 'node.completed').at(-1).payload_json
  ).output_digest;
  assert.equal(digestOf(first.runId), digestOf(second.runId), 'раскладка не влияет на материал');

  // в графе нет полей исполнения
  const graph = JSON.stringify(DEFAULT_WORKSHOPS.factory.graph);
  for (const forbidden of ['"status"', '"run_id"', '"execution_id"', '"attempt"']) {
    assert.ok(!graph.includes(forbidden), `в декларации не место полю ${forbidden}`);
  }
});

test('5. исполнение не является материалом: идентичность — это содержимое', () => {
  const content = JSON.stringify([{ json: { text: 'один и тот же результат' } }]);
  assert.equal(materialDigest('node_output', content), materialDigest('node_output', content),
    'дайджест не зависит от того, какая попытка его произвела');

  // ни один потребитель не выбирает материал по исполнению или «последнему»
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /WHERE\s+execution_id|ORDER BY\s+created_at\s+DESC\s+LIMIT 1\s*"?\s*\)?\s*;?\s*--\s*latest/i,
      `${path.relative(SRC, file)} — материал не выбирается по исполнению`);
  }
});

test('6. решение не ветвится по модели, но провенанс записан', () => {
  // провенанс есть: модель попадает в item, расход — в событие попытки
  const run = projectRun(db, board(db, {}).runs[0].run_id);
  assert.ok(run.nodes.length > 0);

  const kernelFiles = sourceFiles(path.join(SRC, 'kernel'));
  for (const file of kernelFiles) {
    const text = readFileSync(file, 'utf8');
    // ядро не знает названий моделей и провайдеров
    assert.doesNotMatch(text, /glm-|qwen|claude-|gpt-|opencode/i,
      `${path.basename(file)} — ядро не должно знать про конкретные модели`);
  }
  // и не знает названий цехов
  for (const file of kernelFiles) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /'discovery'|'formalization'|"discovery"|"formalization"/,
      `${path.basename(file)} — ядро не ветвится по имени цеха`);
  }
});

test('бюджет ядра: интерпретатор остаётся маленьким', () => {
  const kernel = sourceFiles(path.join(SRC, 'kernel'))
    .concat([path.join(SRC, 'events.ts'), path.join(SRC, 'materials.ts'), path.join(SRC, 'schema.ts')]);
  // Ратчет, а не «когда-нибудь потом»: планка стоит чуть выше текущего
  // размера, поэтому следующая сотня строк в ядре требует осознанного шага.
  // Бюджет плана (§5) — 10 000 строк на ядро вместе с MCP-поверхностью.
  const lines = kernel.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length, 0);
  assert.ok(lines < 3400, `ядро выросло до ${lines} строк — повод для ADR, а не для исключения`);
  assert.ok(statSync(path.join(SRC, 'schema.ts')).size > 0);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
