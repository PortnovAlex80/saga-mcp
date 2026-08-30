// M4 effect fitness: git integration as an authorized effect with an
// idempotency key and typed receipts. Proves §26 of the conveyor model:
//   1. crash AFTER the external change does not duplicate the effect
//   2. retry observes external state before repeating (already_applied)
//   3. typed conflict never erases accepted material
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-effect-'));
process.env.DB_PATH = path.join(dir, 'effect.db');
const repo = path.join(dir, 'repo');
mkdirSync(repo, { recursive: true });

// no shell: cmd.exe may be absent in constrained environments
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

git(repo, ['init', '-q', '-b', 'main']);
git(repo, ['config', 'user.email', 'saga5@test']);
git(repo, ['config', 'user.name', 'saga5']);

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { sweep } = await import('../dist/kernel/sweep.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

function claimAndSpawn(executionId) {
  const { lease } = claimExecution(db, executionId);
  const child = spawn(process.execPath, [WORKER, '--execution', executionId], {
    env: { ...process.env, SAGA_LEASE: lease },
    stdio: 'ignore',
  });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

function lastScheduledId(runId) {
  const scheduled = getEvents(db, runId).filter((e) => e.type === 'execution.scheduled');
  return JSON.parse(scheduled.at(-1).payload_json).execution_id;
}

function effectGraph(fileContent, extra = {}) {
  return JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text: fileContent } }] } },
      publish: {
        type: 'effect',
        parameters: {
          mode: 'git',
          repo,
          branch: 'main',
          message: 'apply desk material',
          files: [{ path: 'doc.md', field: 'text' }],
          ...extra,
        },
      },
    },
    connections: { source: { main: [[{ node: 'publish' }]] } },
  });
}

function gitLogCount() {
  return Number(git(repo, ['rev-list', '--count', 'main']));
}

test('git effect applies the desk material with a typed receipt', async () => {
  const run = runGraph(db, effectGraph('v1 content'), { name: 'effect-apply' });
  assert.equal(run.stop, 'waiting');

  const code = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(code, 0);

  assert.equal(resumeRun(db, run.runId).status, 'success');

  const receipted = JSON.parse(getEvents(db, run.runId).find((e) => e.type === 'effect.receipted').payload_json);
  assert.equal(receipted.outcome, 'applied');
  const row = db.prepare('SELECT status, receipt_json FROM effects').get();
  assert.equal(row.status, 'applied');
  const receipt = JSON.parse(row.receipt_json);
  assert.equal(git(repo, ['show', `${receipt.commit}:doc.md`]), 'v1 content');
  assert.match(git(repo, ['log', '--format=%B', '-1', receipt.commit]), /Effect-Key:/);
});

test('crash after the external change: retry settles already_applied, no duplicate commit', async () => {
  const before = gitLogCount();
  const run = runGraph(db, effectGraph('v2 content', {
    crash_after_effect: 1,
    timeouts: { heartbeat_s: 1, schedule_to_start_s: 5 },
    retry: { max_attempts: 2 },
  }), {
    name: 'effect-crash',
  });
  assert.equal(run.stop, 'waiting');

  const crashCode = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(crashCode, 1, 'crash after commit, before receipt');

  sweep(db, new Date(Date.now() + 8_000));
  const code = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(code, 0, 'attempt 2 observes external state and settles');

  assert.equal(resumeRun(db, run.runId).status, 'success');
  assert.equal(gitLogCount(), before + 1, 'exactly ONE commit — no duplicate effect');

  const receipted = getEvents(db, run.runId)
    .filter((e) => e.type === 'effect.receipted')
    .map((e) => JSON.parse(e.payload_json).outcome);
  assert.deepEqual(receipted, ['already_applied']);
});

test('typed conflict: key reuse with different content never erases accepted material', async () => {
  const before = gitLogCount();
  // reuse run1's key by requesting the same desired state as a DIFFERENT run:
  // same repo/branch but changed content under the SAME key is impossible via
  // derived keys (content is in the key), so force the collision directly.
  const run1Event = getEvents(db, db.prepare("SELECT id FROM runs WHERE id IN (SELECT run_id FROM events WHERE type='effect.receipted' LIMIT 1)").get().id)
    .find((e) => e.type === 'effect.receipted');
  const run1Key = JSON.parse(run1Event.payload_json).key;

  const run = runGraph(db, effectGraph('v1 content', {
    effect_key: run1Key,
    timeouts: { heartbeat_s: 1, schedule_to_start_s: 5 },
    retry: { max_attempts: 1 },
  }), { name: 'effect-conflict' });
  assert.equal(run.stop, 'waiting');
  const code = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(code, 1, 'typed conflict settles the attempt as failed');

  sweep(db, new Date(Date.now() + 8_000)); // retry budget 1 → exhausted
  assert.equal(resumeRun(db, run.runId).status, 'error');

  const attemptFailed = JSON.parse(eventsOf(run.runId, 'execution.failed').at(-1).payload_json);
  assert.equal(attemptFailed.error_type, 'effect_conflict', 'attempt-level failure is the typed conflict');
  assert.match(attemptFailed.message, /effect key reused/);
  const nodeFailed = JSON.parse(eventsOf(run.runId, 'node.failed').at(-1).payload_json);
  assert.match(nodeFailed.error, /activity failed after 1 attempt/);

  const row = db.prepare('SELECT status, receipt_json FROM effects WHERE idempotency_key = ?').get(run1Key);
  assert.equal(row.status, 'failed', 'conflict marks the ledger row failed');
  const lastEvent = JSON.parse(eventsOf(run.runId, 'effect.receipted').at(-1).payload_json);
  assert.equal(lastEvent.outcome, 'conflict');
  assert.equal(JSON.parse(lastEvent.receipt_json).reason, 'key_reuse_different_content');

  // the accepted material is untouched
  assert.equal(gitLogCount(), before, 'no new commits from a conflicting effect');
  assert.equal(git(repo, ['show', 'HEAD:doc.md']), 'v2 content');

  function eventsOf(id, type) {
    return getEvents(db, id).filter((e) => e.type === type);
  }
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
