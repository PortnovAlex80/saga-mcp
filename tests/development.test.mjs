// Development fan-out mechanics (hermetic): split spawns one child per task,
// children run as real worker processes (parallel), join waits for all,
// json_parse extracts files, the git effect commits the dynamic file set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-split-'));
process.env.DB_PATH = path.join(dir, 'split.db');
const repo = path.join(dir, 'repo');
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'dev@test'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'dev'], { cwd: repo });

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { sweep } = await import('../dist/kernel/sweep.js');
const { evaluateChecks } = await import('../dist/kernel/gate.js');
const { startWorkshop, DEFAULT_WORKSHOPS } = await import('../dist/workshops.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

async function driveWithRealWorkers(runId) {
  const claimed = new Set();
  for (let i = 0; i < 30; i++) {
    const result = resumeRun(db, runId);
    if (result.stop === 'terminal') return result.status;
    const queued = getEvents(db, runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json).execution_id)
      .filter((id) => !claimed.has(id));
    if (queued.length === 0) { sweep(db); continue; } // typed wait for the retry decision (the bridge does this)
    // параллельно: claim + spawn всех незанятых
    await Promise.all(queued.map(async (id) => {
      const claim = claimExecution(db, id);
      if (!claim) return;
      claimed.add(id);
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [WORKER, '--execution', id], {
          env: { ...process.env, SAGA_LEASE: claim.lease },
          stdio: 'ignore',
        });
        child.on('exit', resolve);
      });
    }));
  }
  throw new Error('run did not settle in budget');
}

function eventsOf(runId, type) {
  return getEvents(db, runId).filter((e) => e.type === type);
}

test('json_array gate check validates planner structure', () => {
  const bad = evaluateChecks([{ op: 'json_array', min_count: 2 }], [{ json: { text: 'не JSON' } }]);
  assert.equal(bad.verdict, 'repair_required');
  assert.match(bad.reasons[0], /not valid JSON/);
  const short = evaluateChecks([{ op: 'json_array', min_count: 2 }], [{ json: { text: '[{"id":"T1"}]' } }]);
  assert.match(short.reasons[0], /need ≥2/);
  const good = evaluateChecks([{ op: 'json_array', min_count: 2 }], [{ json: { text: '[{"id":"T1"},{"id":"T2"}]' } }]);
  assert.equal(good.verdict, 'accepted');
});

test('split → parallel children → join → parse → dynamic git effect', async () => {
  const filesJson = (name) => JSON.stringify([{ path: `${name}.html`, content: `<!DOCTYPE html><html><body>${name}</body></html>` }]);
  const graph = JSON.stringify({
    nodes: {
      input: {
        type: 'emit',
        parameters: {
          items: [
            { json: { title: 'T1', files_json: filesJson('page1') } },
            { json: { title: 'T2', files_json: filesJson('page2') } },
          ],
        },
      },
      tasks: {
        type: 'split',
        parameters: {
          child: {
            type: 'llm',
            parameters: { mode: 'echo', prompt: '{{files_json}}', timeouts: { heartbeat_s: 5, schedule_to_start_s: 30 } },
          },
        },
      },
      merge: { type: 'join', parameters: {} },
      parse_files: { type: 'json_parse', parameters: {} },
      integrate: {
        type: 'effect',
        parameters: { mode: 'git', repo, branch: 'main', message: 'dev: tasks', files_from: 'items' },
      },
    },
    connections: {
      input: { main: [[{ node: 'tasks' }]] },
      tasks: { main: [[{ node: 'merge' }]] },
      merge: { main: [[{ node: 'parse_files' }]] },
      parse_files: { main: [[{ node: 'integrate' }]] },
    },
  });

  const run = runGraph(db, graph, { name: 'split-echo' });
  const status = await driveWithRealWorkers(run.runId);
  assert.equal(status, 'success');

  // spawned topology in the log: BOTH children, atomically
  const spawned = JSON.parse(eventsOf(run.runId, 'nodes.spawned')[0].payload_json);
  assert.equal(spawned.parent, 'tasks');
  assert.deepEqual(spawned.children.map((c) => c.id), ['tasks::1', 'tasks::2']);
  assert.equal(spawned.children[0].item.json.title, 'T1');

  // each child completed exactly once; join waited for both
  const completed = eventsOf(run.runId, 'node.completed').map((e) => JSON.parse(e.payload_json).node_id);
  assert.ok(completed.includes('tasks::1'));
  assert.ok(completed.includes('tasks::2'));
  assert.ok(completed.indexOf('tasks::1') < completed.indexOf('merge'), 'join after children');

  // dynamic file set committed
  assert.equal(readFileSync(path.join(repo, 'page1.html'), 'utf8'), '<!DOCTYPE html><html><body>page1</body></html>');
  assert.equal(readFileSync(path.join(repo, 'page2.html'), 'utf8'), '<!DOCTYPE html><html><body>page2</body></html>');
  assert.equal(JSON.parse(eventsOf(run.runId, 'effect.receipted')[0].payload_json).outcome, 'applied');
});

test('development is compiled from desks and ends with a RUN, not a promise', () => {
  const workshop = DEFAULT_WORKSHOPS.development;
  assert.deepEqual(workshop.spec.desks.map((desk) => desk.id),
    ['plan', 'implement', 'review', 'assemble', 'smoke']);

  const nodes = workshop.graph.nodes;
  assert.equal(nodes.implement_tasks.type, 'split');
  assert.equal(nodes.implement_merge.type, 'join');
  assert.equal(nodes.review_gate.type, 'gate');

  // каждый воркер веера знает, что делают соседи — иначе сборка разъезжается
  assert.equal(nodes.implement_pre2.type, 'siblings');

  // кандидат проверяется ЗАПУСКОМ до публикации: команда судит временный
  // каталог, а гейт пускает эффект только после её успеха
  // заплатка сборщика ложится на исходный набор, и только потом — запуск
  assert.equal(nodes.assemble_post2.type, 'overlay');
  // ДВЕ проверки, и обе судят МАТЕРИАЛ, а не вывод предыдущей команды
  assert.equal(nodes.assemble_post3.type, 'command');
  assert.equal(nodes.assemble_post4.type, 'command');
  assert.match(nodes.assemble_post4.parameters.run, /smoke-browser/);
  for (const evidence of ['assemble_post3', 'assemble_post4']) {
    assert.equal(nodes[evidence].parameters.workdir, 'items');
    const inbound = Object.entries(workshop.graph.connections)
      .filter(([, conn]) => conn.main[0].some((target) => target.node === evidence))
      .map(([from]) => from);
    assert.deepEqual(inbound, ['assemble_post2'], `${evidence} судит материал, а не соседнюю проверку`);
  }
  assert.ok(nodes.assemble_gate.parameters.checks.some((check) => check.op === 'command_ok'));

  // публикуется СОБРАННЫЙ материал (команда — доказательство, а не материал):
  // эффект зависит и от приёмки (порядок), и от разобранных файлов (содержимое)
  assert.equal(nodes.assemble_publish.parameters.files_from, 'items');
  const publishInbound = Object.entries(workshop.graph.connections)
    .filter(([, conn]) => conn.main[0].some((target) => target.node === 'assemble_publish'))
    .map(([from]) => from)
    .sort();
  assert.deepEqual(publishInbound, ['assemble_gate']);

  // последний стол — приёмка без модели: запускаем то, что реально легло в репо
  assert.equal(nodes.smoke_post1.type, 'command');
  assert.match(nodes.smoke_post1.parameters.run, /smoke-static/);
  assert.equal(nodes.smoke_post1.parameters.workdir, undefined, 'финальная проверка судит репозиторий');
  assert.deepEqual(nodes.smoke_gate.parameters.checks.map((check) => check.op), ['command_ok']);

  // стол = рабочее место: не принято — нанимают следующего рабочего НА ТО ЖЕ
  // место, с замечаниями приёмки; сосед свою годную работу не переделывает
  assert.equal(nodes.implement_gate.parameters.max_repairs, 2);

  // no SRS artifact in a fresh repo → honest failure
  const fresh = path.join(dir, 'fresh');
  mkdirSync(fresh, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
  assert.throws(() => startWorkshop(db, 'development', { repo: fresh }), /PLAN_MISSING/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
