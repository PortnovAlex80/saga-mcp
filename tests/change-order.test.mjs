// ЗАКАЗ НА ИЗМЕНЕНИЕ. Продукт уже есть; человек поправил спецификацию.
// Завод должен внести правку В СУЩЕСТВУЮЩЕЕ, а не выпустить продукт заново:
// иначе всё, что работало, переписывается вслепую при каждом уточнении.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-change-'));
process.env.DB_PATH = path.join(dir, 'change.db');

const { readDocument, saveDocument, listDocuments, productFiles } = await import('../dist/documents.js');
const { compileWorkshop } = await import('../dist/workshop-compiler.js');
const { BUILTIN_SKILLS } = await import('../dist/skills.js');
const { WORKSHOP_SPECS } = await import('../dist/workshop-specs.js');

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function repoWith(files) {
  const repo = mkdtempSync(path.join(dir, 'repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'factory@saga5'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'saga5'], { cwd: repo });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'development: assembled application'], { cwd: repo });
  return repo;
}

test('правка человека — версия документа, а не материал открытого прогона', () => {
  const repo = repoWith({
    'formalization/srs.md': '# SRS\n\nFR-1: корабль летит.\n',
    'js/ship.js': 'const ship = 1;\n',
  });

  const saved = saveDocument(repo, 'formalization/srs.md', '# SRS\n\nFR-1: корабль летит.\nFR-2: есть радар.\n', 'нужен радар');
  assert.equal(saved.changed, true);
  assert.ok(saved.commit.length > 0, 'правка стала версией документа');

  const log = execFileSync('git', ['log', '-1', '--format=%s%n%b'], { cwd: repo, encoding: 'utf8' });
  assert.match(log, /^operator: formalization\/srs\.md — нужен радар/m,
    'провенанс честный: по журналу видно, где кончился завод и начался человек');
  assert.match(log, /Author-Role: operator/);

  // Заводу нужна РАЗНИЦА, а не новая редакция: иначе любое уточнение
  // превращается в переписывание продукта заново.
  assert.match(saved.patch, /^\+FR-2: есть радар\./m);
  assert.ok(!/^\+FR-1/m.test(saved.patch), 'неизменившееся в заказ не попадает');

  assert.equal(readDocument(repo, 'formalization/srs.md').content.includes('FR-2'), true);
  assert.equal(saveDocument(repo, 'formalization/srs.md', readDocument(repo, 'formalization/srs.md').content).changed,
    false, 'сохранять нечего — версии не плодим');
});

test('редактор видит спецификации и не видит кода', () => {
  const repo = repoWith({
    'discovery/brief.md': '# Бриф\n',
    'formalization/srs.md': '# SRS\n',
    'README.md': '# Продукт\n',
    'js/ship.js': 'const ship = 1;\n',
    'index.html': '<html></html>',
  });
  const paths = listDocuments(repo).map((d) => d.path);
  assert.deepEqual(paths, ['README.md', 'discovery/brief.md', 'formalization/srs.md']);

  // Набор продукта завод обязан ВИДЕТЬ целиком: пока он умел только писать
  // файлы, файлы прошлых выпусков оставались сиротами.
  assert.ok(productFiles(repo).includes('js/ship.js'));
  assert.equal(productFiles(repo, ['js/']).includes('js/ship.js'), false);
});

test('правка не пишется поверх незавершённой работы завода', () => {
  const repo = repoWith({ 'formalization/srs.md': '# SRS\n' });
  mkdirSync(path.join(repo, 'js'), { recursive: true });
  writeFileSync(path.join(repo, 'js/dirty.js'), 'x');
  assert.throws(
    () => saveDocument(repo, 'formalization/srs.md', '# SRS\n\nновое\n'),
    /DOCUMENT_REPO_DIRTY/,
    'коммитить чужие незакоммиченные изменения нельзя'
  );
});

test('за пределы репозитория документ не пишется', () => {
  const repo = repoWith({ 'formalization/srs.md': '# SRS\n' });
  assert.throws(() => saveDocument(repo, '../../evil.md', 'нет'), /DOCUMENT_PATH_INVALID/);
});

test('цех изменений: продукт лежит на СТОЛЕ, а приёмка судит продукт с заплаткой', () => {
  const { graph } = compileWorkshop(WORKSHOP_SPECS.change, { skills: BUILTIN_SKILLS });

  // Все три стола видят существующий продукт: без него «внести правку»
  // неизбежно вырождается в «написать заново».
  assert.equal(graph.nodes.change_plan.parameters.worktree, true);
  assert.equal(graph.nodes.revise_tasks.parameters.child.parameters.worktree, true);
  assert.equal(graph.nodes.change_assemble.parameters.worktree, true);

  // Исполнитель правит на месте и отдаёт только изменённое.
  assert.equal(graph.nodes.revise_tasks.parameters.child.parameters.produces, 'files');

  // Заплатку в отрыве от продукта запустить нельзя — значит и судить нечего.
  for (const node of ['change_assemble_post2', 'change_assemble_post3']) {
    assert.equal(graph.nodes[node].type, 'command');
    assert.equal(graph.nodes[node].parameters.workdir, 'worktree',
      'проверка судит продукт С ПРИМЕНЁННЫМ изменением, а не одну заплатку');
  }

  // Не приняли — претензия идёт вверх по цеху, а не человеку.
  assert.equal(graph.nodes.change_assemble_gate.parameters.escalate_to, 'revise_tasks');
  assert.equal(graph.nodes.revise_gate.parameters.escalate_to, 'change_plan');
});

test('навык изменения требует минимальной правки, а не переписывания', () => {
  const revise = BUILTIN_SKILLS.revise;
  assert.equal(revise.worktree, true);
  assert.equal(revise.produces, 'files');
  assert.match(revise.instruction, /НА МЕСТЕ/);
  assert.match(revise.checklist.join(' '), /не переписывал то, чего задача не касается/);

  const planner = BUILTIN_SKILLS['change-plan'];
  assert.equal(planner.worktree, true);
  assert.match(planner.instruction, /Не план продукта заново/);
  assert.match(planner.checklist.join(' '), /Ни одна задача не переписывает то, чего правка не касается/);
});

test('принятая работа умеет УБРАТЬ файл, а не только записать', async () => {
  const repo = repoWith({ 'index.html': '<html></html>', 'js/live.js': 'ok', 'js/orphan.js': 'мёртвый' });
  process.env.DB_PATH = path.join(dir, 'delete.db');
  const { getDb, closeDb } = await import('../dist/db.js');
  const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
  const { claimExecution, completeActivity } = await import('../dist/kernel/executions.js');
  const { getEvents } = await import('../dist/events.js');
  const db = getDb();

  const graph = JSON.stringify({
    nodes: {
      work: { type: 'llm', parameters: { mode: 'echo' } },
      publish: {
        type: 'effect',
        parameters: { mode: 'git', repo, branch: 'main', files_from: 'items', message: 'change: applied' },
      },
    },
    connections: { work: { main: [[{ node: 'publish' }]] } },
  });
  const run = runGraph(db, graph, { name: 'delete-orphan' });
  const scheduled = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json))[0];
  const { lease } = claimExecution(db, scheduled.execution_id);
  // Сборщик видел весь продукт и НЕ ОСТАВИЛ сироту — это его решение.
  completeActivity(db, scheduled.execution_id, lease, [
    { json: { path: 'js/live.js', content: 'ok, изменён' } },
    { json: { path: 'js/orphan.js', deleted: true } },
  ]);

  // Эффект — activity: его тоже кто-то должен исполнить.
  let guard = 0;
  while (resumeRun(db, run.runId).status === 'running' && guard++ < 10) {
    const next = getEvents(db, run.runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json))
      .find((p) => db.prepare('SELECT status FROM executions WHERE id = ?').get(p.execution_id)?.status === 'new');
    if (!next) break;
    const { spawnSync } = await import('node:child_process');
    const claim = claimExecution(db, next.execution_id);
    const done = spawnSync(process.execPath, ['dist/runtime/worker.js', '--execution', next.execution_id], {
      env: { ...process.env, SAGA_LEASE: claim.lease }, encoding: 'utf8',
    });
    assert.equal(done.status, 0, done.stderr);
  }
  assert.equal(readFileSync(path.join(repo, 'js/live.js'), 'utf8'), 'ok, изменён');
  assert.equal(existsSync(path.join(repo, 'js/orphan.js')), false,
    'сирота убран из продукта: завод знает НАБОР, а не только то, что сам пишет');
  assert.equal(existsSync(path.join(repo, 'index.html')), true,
    'то, чего изменение не касается, остаётся нетронутым');
  closeDb();
});
