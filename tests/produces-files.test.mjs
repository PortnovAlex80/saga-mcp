// Работа кодом сдаётся ФАЙЛАМИ, а не JSON-строкой в ответе модели.
// Тест закрепляет сам договор: стол объявляет produces:'files', воркер
// получает это в параметрах, а приёмка судит файлы, а не разбираемость JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { compileWorkshop } = await import('../dist/workshop-compiler.js');
const { BUILTIN_SKILLS } = await import('../dist/skills.js');
const { evaluateChecks } = await import('../dist/kernel/gate.js');
const { WORKSHOP_SPECS } = await import('../dist/workshop-specs.js');

test('стол, производящий код, заказывает файлы, а не текст ответа', () => {
  const { graph } = compileWorkshop(WORKSHOP_SPECS.development, { skills: BUILTIN_SKILLS });
  assert.equal(graph.nodes.implement_tasks.parameters.child.parameters.produces, 'files');
  assert.equal(graph.nodes.assemble.parameters.produces, 'files');
  // Разбор JSON-массива после воркера больше не нужен: он и был тем местом,
  // где обрыв ответа обнулял всю задачу.
  assert.equal(graph.nodes.assemble_post1.type, 'overlay');
  const ops = graph.nodes.implement_gate.parameters.checks.map((c) => c.op);
  assert.ok(ops.includes('files'), 'приёмка судит сданные файлы');
  assert.ok(!ops.includes('each_json_array'), 'разбираемость JSON больше не критерий приёмки');

  // Навык-текст остался текстовым: смена договора касается только кода.
  assert.equal(graph.nodes.plan.parameters.produces, undefined);
});

test('файл засчитан, когда у него есть имя и непустое тело', () => {
  const checks = [{ op: 'files', min_count: 2 }];
  const ok = evaluateChecks(checks, [
    { json: { path: 'index.html', content: '<html></html>' } },
    { json: { path: 'js/app.js', content: 'const a = 1;' } },
  ]);
  assert.equal(ok.verdict, 'accepted');

  // Заглушка с правильным путём — не работа.
  const stub = evaluateChecks(checks, [
    { json: { path: 'index.html', content: '<html></html>' } },
    { json: { path: 'js/app.js', content: '   ' } },
  ]);
  assert.equal(stub.verdict, 'repair_required');
  assert.match(stub.reasons.join(' '), /сдано файлов: 1/);
});
