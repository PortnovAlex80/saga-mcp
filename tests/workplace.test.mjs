// ПУТЬ К ЦЕЛИ. Стол — это место, а не одна попытка: каталог переживает
// рабочего, и следующий приходит на него с трекером предшественника и
// замечаниями приёмки. Приёмка умеет только отвергнуть — направляет путь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  materializeWorkplace, workplaceDir, workplaceBriefing, trackerProgress,
  TRACKER, FEEDBACK, CHECKLIST, WORKPLACE_FILES,
} = await import('../dist/runtime/workplace.js');
const { compileWorkshop } = await import('../dist/workshop-compiler.js');
const { BUILTIN_SKILLS } = await import('../dist/skills.js');
const { WORKSHOP_SPECS } = await import('../dist/workshop-specs.js');

const basePlan = {
  workshop: 'Разработка',
  desk: 'Реализация задачи',
  goal: 'Сделать T3 так, чтобы файлы стыковались с соседними.',
  steps: ['Прочитай задачу.', 'Запиши файлы целиком.', 'Пройди самопроверку.'],
  checklist: ['Файлы созданы.', 'Ничего вне границы.'],
  owns: ['js/math3d.js'],
  round: 1,
  feedback: null,
};

test('место обустраивается: путь, самопроверка и граница записи', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga5-wp-'));
  materializeWorkplace(dir, basePlan);

  const tracker = readFileSync(path.join(dir, TRACKER), 'utf8');
  assert.match(tracker, /Сделать T3/, 'цель стола на месте');
  assert.match(tracker, /- \[ \] 1\. Прочитай задачу\./, 'шаги — отмечаемый путь, а не абзац');
  assert.match(tracker, /js\/math3d\.js/, 'граница записи названа');
  assert.match(tracker, /круг работы на этом месте: `1`/);

  assert.ok(existsSync(path.join(dir, CHECKLIST)), 'самопроверка лежит на столе');
  assert.ok(!existsSync(path.join(dir, FEEDBACK)), 'на первом круге замечаний нет');
  rmSync(dir, { recursive: true, force: true });
});

test('следующий рабочий приходит НА ТО ЖЕ место и находит замечания', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga5-wp-'));
  materializeWorkplace(dir, basePlan);
  materializeWorkplace(dir, {
    ...basePlan,
    round: 2,
    feedback: 'files — сдано файлов: 0, требуется не меньше 1',
  });

  const feedback = readFileSync(path.join(dir, FEEDBACK), 'utf8');
  assert.match(feedback, /сдано файлов: 0/, 'замечание приёмки доехало до места');
  assert.match(feedback, /круг 1 → 2/);
  assert.match(feedback, /не повод начинать с нуля/i, 'доработка, а не переделка с нуля');
  assert.match(readFileSync(path.join(dir, TRACKER), 'utf8'), /круг работы на этом месте: `2`/);

  // Замечания сняты — оставлять их значит врать следующему рабочему.
  materializeWorkplace(dir, { ...basePlan, round: 3, feedback: null });
  assert.ok(!existsSync(path.join(dir, FEEDBACK)));
  rmSync(dir, { recursive: true, force: true });
});

test('каталог места привязан к УЗЛУ, а не к попытке', () => {
  const first = workplaceDir('run-1', 'implement_tasks::3');
  const again = workplaceDir('run-1', 'implement_tasks::3');
  assert.equal(first, again, 'то же место у того же узла — иначе рабочий приходит на пустое');
  assert.notEqual(first, workplaceDir('run-1', 'implement_tasks::4'), 'у соседа своё место');
  assert.notEqual(first, workplaceDir('run-2', 'implement_tasks::3'), 'чужой прогон — чужое место');
  assert.ok(!/::/.test(path.basename(first)), 'имя узла веера пригодно для файловой системы');
});

test('промпт указывает на путь, а не пересказывает его', () => {
  const briefing = workplaceBriefing({ ...basePlan, round: 2, feedback: 'не принято' });
  assert.match(briefing, new RegExp(`СНАЧАЛА прочитай ${FEEDBACK}`), 'вслепую не переделывают');
  assert.match(briefing, new RegExp(TRACKER));
  assert.match(briefing, new RegExp(CHECKLIST));
  assert.match(briefing, /Граница записи — только: js\/math3d\.js/);
  // Путь лежит файлом: промпт не должен раздуваться шагами.
  assert.ok(!briefing.includes(basePlan.steps[1]), 'шаги живут в трекере, не в промпте');
});

test('обстановка стола принадлежит заводу и в продукт не едет', () => {
  assert.deepEqual([...WORKPLACE_FILES].sort(), [CHECKLIST, FEEDBACK, TRACKER].sort());
});

test('пройденные шаги видны заводу', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga5-wp-'));
  materializeWorkplace(dir, basePlan);
  assert.deepEqual(trackerProgress(dir), { done: 0, total: 3 });
  rmSync(dir, { recursive: true, force: true });
});

test('столы разработки объявляют свой путь, а не только задание', () => {
  const { graph } = compileWorkshop(WORKSHOP_SPECS.development, { skills: BUILTIN_SKILLS });
  const child = graph.nodes.implement_tasks.parameters.child.parameters;
  assert.ok(child.steps.length >= 3, 'у реализации есть путь');
  assert.ok(child.checklist.length >= 3, 'и самопроверка');
  assert.match(child.goal, /\{\{title\}\}/, 'цель конкретизируется задачей рабочего места');
  assert.equal(child.desk, 'Параллельная реализация задач');
  assert.match(child.workshop, /Development Desk/, 'рабочий знает, в каком цехе стоит');

  // Сборщик обязан ловить именно тот дефект, который уехал в продукт живьём.
  const assemble = graph.nodes.assemble.parameters;
  assert.match(assemble.checklist.join(' '), /не подключён и не используется/,
    'мёртвый файл — вопрос самопроверки сборщика, а не удача приёмки');
});
