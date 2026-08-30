// The worker monitor and the operator throttle. The monitor is a READ of the
// executions header; the live text is operational and never a decision input.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-workers-'));
process.env.DB_PATH = path.join(dir, 'workers.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph } = await import('../dist/kernel/runner.js');
const { claimExecution, heartbeatExecution, completeActivity } = await import('../dist/kernel/executions.js');
const { liveWorkers, recentWorkers, workerStats } = await import('../dist/kernel/workers.js');
const { readLimits, writeLimits, limitsPath, DEFAULT_LIMITS } = await import('../dist/limits.js');
const { getEvents } = await import('../dist/events.js');

const db = getDb();

const GRAPH = JSON.stringify({
  nodes: {
    idea: { type: 'emit', parameters: { items: [{ json: { text: 'счётчик' } }] } },
    brief: {
      type: 'llm',
      parameters: {
        mode: 'echo',
        model: 'zai-coding-plan/glm-5.3-flash',
        prompt: 'сделай бриф по {{text}}',
        timeouts: { heartbeat_s: 15, schedule_to_start_s: 30, start_to_close_s: 180 },
      },
    },
  },
  connections: { idea: { main: [[{ node: 'brief' }]] } },
});

test('a queued activity is a hired-but-waiting worker, with its model and task visible', () => {
  const run = runGraph(db, GRAPH, { name: 'monitor' });
  assert.equal(run.stop, 'waiting');

  const [worker] = liveWorkers(db);
  assert.equal(worker.node_id, 'brief');
  assert.equal(worker.status, 'new');
  assert.equal(worker.model, 'zai-coding-plan/glm-5.3-flash', 'the model comes from the declared graph');
  assert.equal(worker.mode, 'echo');
  assert.match(worker.prompt_preview, /сделай бриф/);
  assert.equal(worker.schedule_to_start_s, 30);
  assert.equal(worker.heartbeat_age_s, null, 'nothing to prove while still queued');
  assert.equal(worker.stale, false);

  assert.deepEqual(workerStats(db), { running: 0, queued: 1, stale: 0, succeeded: 0, failed: 0 });
});

test('a heartbeat carries the replayable fact; the live text stays operational', () => {
  const worker = liveWorkers(db).find((w) => w.status === 'new');
  const { lease } = claimExecution(db, worker.execution_id);

  const partial = 'Суть продукта: сч';
  const full = 'Суть продукта: счётчик тренировок';
  heartbeatExecution(db, worker.execution_id, lease, { progress: partial });
  heartbeatExecution(db, worker.execution_id, lease, { progress: full });

  const live = liveWorkers(db).find((w) => w.execution_id === worker.execution_id);
  assert.equal(live.status, 'running');
  assert.equal(live.progress, full, 'the window shows the latest tail only');
  assert.equal(live.progress_chars, full.length);

  const beats = getEvents(db, worker.run_id)
    .filter((event) => event.type === 'execution.heartbeat')
    .map((event) => JSON.parse(event.payload_json));
  assert.deepEqual(beats.map((beat) => beat.progress_chars), [partial.length, full.length],
    'the log keeps how much had arrived, not the text');
  assert.ok(beats.every((beat) => beat.progress === undefined), 'no live text leaks into the authority');

  completeActivity(db, worker.execution_id, lease, [{ json: { text: full } }]);
});

test('a settled attempt reports its duration, not its age', () => {
  const [finished] = recentWorkers(db, 5);
  assert.equal(finished.status, 'success');
  assert.equal(finished.stale, false);
  assert.ok(finished.elapsed_s < 60, 'duration of a sub-second attempt is not "seconds since it ended"');
  assert.equal(workerStats(db).succeeded, 1);
});

test('limits live beside the database, are clamped, and survive a reread', () => {
  assert.deepEqual(readLimits(), DEFAULT_LIMITS, 'no file yet → documented defaults');
  assert.equal(existsSync(limitsPath()), false, 'reading never creates the file');

  const saved = writeLimits({ max_workers: 2, min_spawn_interval_ms: 1500 });
  assert.deepEqual(saved, { max_workers: 2, min_spawn_interval_ms: 1500 });
  assert.deepEqual(readLimits(), saved, 'the file is the source of truth across processes');

  assert.equal(writeLimits({ max_workers: 0 }).max_workers, 1, 'zero workers would stop the factory');
  assert.equal(writeLimits({ max_workers: 999 }).max_workers, 64);
  assert.equal(writeLimits({ min_spawn_interval_ms: -5 }).min_spawn_interval_ms, 0);
  assert.equal(writeLimits({}).max_workers, 64, 'an omitted field keeps its value');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
