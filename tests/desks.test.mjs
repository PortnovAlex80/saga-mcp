// Сборка стола: цех — это список столов, граф компилируется. И приёмка,
// которая опирается на ЗАПУСК программы, а не на обещание модели.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-desks-'));
process.env.DB_PATH = path.join(dir, 'desks.db');
const repo = path.join(dir, 'product-repo');
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { evaluateChecks } = await import('../dist/kernel/gate.js');
const { compileWorkshop } = await import('../dist/workshop-compiler.js');
const { BUILTIN_SKILLS } = await import('../dist/skills.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));
const SMOKE = fileURLToPath(new URL('../tools/smoke-static.mjs', import.meta.url));

async function driveWithRealWorkers(runId, budget = 8) {
  const claimed = new Set();
  for (let i = 0; i < budget; i++) {
    const result = resumeRun(db, runId);
    if (result.stop === 'terminal') return result.status;
    const queued = getEvents(db, runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json).execution_id)
      .filter((id) => !claimed.has(id));
    if (queued.length === 0) return resumeRun(db, runId).status;
    const { lease } = claimExecution(db, queued[0]);
    claimed.add(queued[0]);
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, '--execution', queued[0]], {
        env: { ...process.env, SAGA_LEASE: lease },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
  }
  throw new Error('run did not settle in budget');
}

test('цех компилируется из столов: топология выводится, а не рисуется', () => {
  const { graph, map } = compileWorkshop(
    {
      id: 'demo',
      title: 'Демо',
      desks: [
        { id: 'brief', title: 'Бриф', skill: 'brief', input: { kind: 'operator' }, publish: { path: 'b.md' } },
        { id: 'srs', title: 'SRS', skill: 'srs', input: { kind: 'desk', desk: 'brief' } },
      ],
    },
    { skills: BUILTIN_SKILLS }
  );

  assert.deepEqual(Object.keys(graph.nodes), ['brief_input', 'brief', 'brief_gate', 'brief_publish', 'srs', 'srs_gate']);
  assert.deepEqual(graph.connections.brief_gate.main[0].map((t) => t.node), ['brief_publish', 'srs']);
  assert.equal(map.brief.gate, 'brief_gate');

  // промпт собран из навыка; критерии приёмки — тоже из навыка
  assert.match(graph.nodes.brief.parameters.prompt, /ведущий аналитик/);
  assert.match(graph.nodes.brief.parameters.prompt, /Идея:\n\{\{text\}\}$/);
  assert.equal(
    graph.nodes.brief_gate.parameters.checks.length,
    BUILTIN_SKILLS.brief.checks.length
  );
});

test('гейт судит СОЮЗ: что воркер произвёл и что показал запуск', () => {
  const { graph } = compileWorkshop(
    {
      id: 'demo',
      title: 'Демо',
      desks: [{
        id: 'app',
        title: 'Приложение',
        skill: 'implement',
        input: { kind: 'operator' },
        hooks: { after: [{ kind: 'json_array' }, { kind: 'command', run: 'echo ok', workdir: 'items' }] },
      }],
    },
    { skills: BUILTIN_SKILLS }
  );
  // Команда подменяет содержимое стола доказательством, поэтому критерии
  // навыка проверять было бы не на чем — гейт читает и воркера, и команду.
  const gateInbound = Object.entries(graph.connections)
    .filter(([, conn]) => conn.main[0].some((target) => target.node === 'app_gate'))
    .map(([from]) => from)
    .sort();
  // материал, доказательство и то, что произвёл воркер
  assert.deepEqual(gateInbound, ['app', 'app_post1', 'app_post2']);
  const ops = graph.nodes.app_gate.parameters.checks.map((check) => check.op);
  assert.ok(ops.includes('files') && ops.includes('command_ok'));
});

test('склейка: исполнитель шлёт только изменённое, база переносится сама', async () => {
  const base = [
    { json: { path: 'index.html', content: '<html><script src="app.js"></script></html>' } },
    { json: { path: 'style.css', content: 'body{}' } },
  ];
  const patch = [{ json: { path: 'app.js', content: 'console.log(1)' } }];
  const graph = JSON.stringify({
    nodes: {
      base: { type: 'emit', parameters: { items: base } },
      patch: { type: 'emit', parameters: { items: patch } },
      merged: { type: 'overlay', parameters: { key: 'path' } },
    },
    // порядок объявления задаёт порядок склейки: поздний побеждает
    connections: { base: { main: [[{ node: 'merged' }]] }, patch: { main: [[{ node: 'merged' }]] } },
  });
  const run = runGraph(db, graph, { name: 'overlay' });
  assert.equal(run.status, 'success');

  const { getMaterial } = await import('../dist/materials.js');
  const completed = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .find((p) => p.node_id === 'merged');
  const items = JSON.parse(getMaterial(db, completed.output_digest).content);

  assert.deepEqual(items.map((item) => item.json.path).sort(), ['app.js', 'index.html', 'style.css'],
    'заплатка добавилась, база не потерялась');
  assert.equal(items.find((item) => item.json.path === 'index.html').json.content,
    '<html><script src="app.js"></script></html>', 'нетронутый файл перенесён байт в байт');
});

test('склейка: поздний item побеждает раннего по ключу', async () => {
  const graph = JSON.stringify({
    nodes: {
      base: { type: 'emit', parameters: { items: [{ json: { path: 'a.js', content: 'старое' } }] } },
      patch: { type: 'emit', parameters: { items: [{ json: { path: 'a.js', content: 'новое' } }] } },
      merged: { type: 'overlay', parameters: { key: 'path' } },
    },
    connections: { base: { main: [[{ node: 'merged' }]] }, patch: { main: [[{ node: 'merged' }]] } },
  });
  const run = runGraph(db, graph, { name: 'overlay-wins' });
  const { getMaterial } = await import('../dist/materials.js');
  const completed = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .find((p) => p.node_id === 'merged');
  const items = JSON.parse(getMaterial(db, completed.output_digest).content);
  assert.equal(items.length, 1);
  assert.equal(items[0].json.content, 'новое');
});

test('негодный член веера вытесняется, работа соседей не пропадает', async () => {
  // Ровно тот сбой, что случился на Элите: один воркер вернул не ответ, а
  // служебный поток. Гейт с «достаточно одного» это пропускал, и разбор ниже
  // ронял весь прогон.
  const { evaluateDesk } = await import('../dist/kernel/gate.js');
  const good = (name) => ({
    node: 'impl',
    digest: `d-${name}`,
    items: [{ json: { text: `[{"path":"${name}.js","content":"ok"}]` } }],
  });
  const garbage = {
    node: 'impl',
    digest: 'd-bad',
    items: [{ json: { text: '{"type":"step_start","sessionID":"ses_x"}\n{"type":"text"}' } }],
  };

  const checks = [{ op: 'each_json_array', field: 'text', min_count: 1 }];
  const outcome = evaluateDesk(checks, [good('a'), garbage, good('b')]);

  assert.deepEqual(outcome.tainted.map((entry) => entry.digest), ['d-bad'],
    'со стола уходит именно негодный член');
  assert.deepEqual(outcome.survivors.map((member) => member.digest), ['d-a', 'd-b'],
    'работа соседей остаётся');
  assert.equal(outcome.verdict, 'repair_required');
  assert.match(outcome.reasons[0], /each_json_array/);

  // а когда все члены годные — стол принимается целиком
  assert.equal(evaluateDesk(checks, [good('a'), good('b')]).verdict, 'accepted');
});

test('компилятор отказывается собирать бессмысленный стол', () => {
  const compile = (desks) => compileWorkshop({ id: 'x', title: 'x', desks }, { skills: BUILTIN_SKILLS });

  assert.throws(
    () => compile([{ id: 'a', title: 'a', input: { kind: 'operator' } }]),
    /DESK_EMPTY/,
    'стол без навыка и без хука ничего не производит'
  );
  assert.throws(
    () => compile([{ id: 'a', title: 'a', skill: 'нет-такого', input: { kind: 'operator' } }]),
    /SKILL_UNKNOWN/
  );
  assert.throws(
    () => compile([
      { id: 'a', title: 'a', skill: 'brief', input: { kind: 'desk', desk: 'b' } },
      { id: 'b', title: 'b', skill: 'srs', input: { kind: 'operator' } },
    ]),
    /DESK_ORDER_INVALID/
  );
  assert.throws(
    () => compile([
      { id: 'a', title: 'a', skill: 'brief', input: { kind: 'operator' } },
      { id: 'b', title: 'b', skill: 'srs', input: { kind: 'publish', desk: 'a' } },
    ]),
    /DESK_INPUT_INVALID/,
    'нельзя ждать публикацию стола, который ничего не публикует'
  );
});

test('узел command выполняет объявленную команду и делает исход материалом', async () => {
  const graph = JSON.stringify({
    nodes: {
      seed: { type: 'emit', parameters: { items: [{ json: { text: 'go' } }] } },
      check: {
        type: 'command',
        parameters: {
          run: 'node -e "console.log(\'все на месте\')"',
          repo,
          label: 'проверка',
          timeout_s: 30,
          timeouts: { heartbeat_s: 20, schedule_to_start_s: 30 },
        },
      },
    },
    connections: { seed: { main: [[{ node: 'check' }]] } },
  });
  const run = runGraph(db, graph, { name: 'command-ok' });
  assert.equal(await driveWithRealWorkers(run.runId), 'success');

  const completed = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .find((p) => p.node_id === 'check');
  const { getMaterial } = await import('../dist/materials.js');
  const [item] = JSON.parse(getMaterial(db, completed.output_digest).content);
  assert.equal(item.json.ok, true);
  assert.equal(item.json.exit_code, 0);
  assert.match(item.json.output, /все на месте/);
});

test('провал команды — это материал, а не отказ: вывод уезжает в причину гейта', async () => {
  const graph = JSON.stringify({
    nodes: {
      seed: { type: 'emit', parameters: { items: [{ json: { text: 'go' } }] } },
      check: {
        type: 'command',
        parameters: {
          run: 'node -e "console.error(\'ReferenceError: renderChart is not defined\'); process.exit(1)"',
          repo,
          label: 'smoke',
          timeout_s: 30,
          timeouts: { heartbeat_s: 20, schedule_to_start_s: 30 },
          retry: { max_attempts: 1 },
        },
      },
      quality: {
        type: 'gate',
        parameters: { checks: [{ op: 'command_ok', field: 'ok' }], max_repairs: 0 },
      },
    },
    connections: {
      seed: { main: [[{ node: 'check' }]] },
      check: { main: [[{ node: 'quality' }]] },
    },
  });
  const run = runGraph(db, graph, { name: 'command-fail' });
  await driveWithRealWorkers(run.runId);

  const decision = JSON.parse(
    getEvents(db, run.runId).filter((e) => e.type === 'gate.decided').at(-1).payload_json
  );
  assert.equal(decision.verdict, 'human_required', 'бюджет 0 → решает человек');
  assert.match(decision.reasons[0], /command_ok/);
  assert.match(decision.reasons[0], /renderChart is not defined/, 'воркер получит текст ошибки, а не «что-то пошло не так»');
});

test('command_ok требует доказательства: без исхода команды приёмки нет', () => {
  assert.equal(evaluateChecks([{ op: 'command_ok', field: 'ok' }], [{ json: { ok: true, exit_code: 0 } }]).verdict, 'accepted');
  const missing = evaluateChecks([{ op: 'command_ok', field: 'ok' }], [{ json: { text: 'я всё проверил, честно' } }]);
  assert.equal(missing.verdict, 'repair_required');
  assert.match(missing.reasons[0], /не выполнялась/);
});

test('дымовая проверка ловит то, из-за чего страница не откроется', () => {
  const app = path.join(dir, 'app');
  mkdirSync(app, { recursive: true });
  const smoke = () => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SMOKE, app], { encoding: 'utf8' }) };
    } catch (error) {
      return { code: error.status, out: String(error.stdout ?? '') + String(error.stderr ?? '') };
    }
  };

  assert.equal(smoke().code, 1, 'без index.html запускать нечего');

  writeFileSync(path.join(app, 'index.html'),
    '<!DOCTYPE html><html><body><script src="app.js"></script></body></html>');
  assert.match(smoke().out, /app\.js: файл не найден/);

  writeFileSync(path.join(app, 'app.js'), 'function broken( {\n');
  assert.match(smoke().out, /синтаксическая ошибка JavaScript/);

  writeFileSync(path.join(app, 'app.js'), 'document.title = "ok";\n');
  const good = smoke();
  assert.equal(good.code, 0);
  assert.match(good.out, /приложение собрано и запускается/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
