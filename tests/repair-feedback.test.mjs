// Repair feedback fitness: gate rejection reasons travel into the retry
// attempt's prompt — the worker fixes WHAT failed, not just rolls again.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-feedback-'));
process.env.DB_PATH = path.join(dir, 'feedback.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { getMaterial } = await import('../dist/materials.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

function claimAndSpawn(executionId) {
  const { lease } = claimExecution(db, executionId);
  const child = spawn(process.execPath, [WORKER, '--execution', executionId], {
    env: { ...process.env, SAGA_LEASE: lease },
    stdio: 'ignore',
  });
  return new Promise((resolve) => child.on('exit', resolve));
}

test('gate reasons reach the repair attempt prompt', async () => {
  const graph = JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text: 'hello' } }] } },
      brain: { type: 'llm', parameters: {
        mode: 'echo',
        prompt: 'make {{text}}',
        timeouts: { heartbeat_s: 2, schedule_to_start_s: 5 },
        retry: { max_attempts: 2 },
      } },
      quality: { type: 'gate', parameters: {
        // regex with digits: the REASON text ('/X[0-9]{3}/ not matched') does
        // not itself satisfy the check, so attempt 2 fails again honestly
        checks: [{ op: 'regex', pattern: 'X[0-9]{3}' }],
        repair_target: 'brain',
        max_repairs: 1,
      } },
    },
    connections: {
      source: { main: [[{ node: 'brain' }]] },
      brain: { main: [[{ node: 'quality' }]] },
    },
  });

  const run = runGraph(db, graph, { name: 'feedback' });
  assert.equal(run.stop, 'waiting');

  // attempt 1: echo produces text without 'X' → gate fails with a reason
  let code = await claimAndSpawn(JSON.parse(
    getEvents(db, run.runId).filter((e) => e.type === 'execution.scheduled').at(-1).payload_json
  ).execution_id);
  assert.equal(code, 0);
  resumeRun(db, run.runId);
  const requested = JSON.parse(
    getEvents(db, run.runId).filter((e) => e.type === 'repair.requested').at(-1).payload_json
  );
  assert.match(requested.reasons[0], /regex:text/);
  assert.match(requested.reasons[0], /not matched/);

  // attempt 2: echo text must CARRY the gate's rejection reasons
  code = await claimAndSpawn(JSON.parse(
    getEvents(db, run.runId).filter((e) => e.type === 'execution.scheduled').at(-1).payload_json
  ).execution_id);
  assert.equal(code, 0);

  const brainCompletions = getEvents(db, run.runId)
    .filter((e) => e.type === 'node.completed' && JSON.parse(e.payload_json).node_id === 'brain');
  assert.equal(brainCompletions.length, 2, 'brain executed twice');
  const lastDigest = JSON.parse(brainCompletions.at(-1).payload_json).output_digest;
  const repairText = JSON.parse(getMaterial(db, lastDigest).content)[0].json.text;
  assert.match(repairText, /не прошла приёмку/);
  assert.match(repairText, /not matched/, 'gate reason present in the retry prompt');

  // budget exhausted → honest human gate (scripted echo cannot ever satisfy
  // the numeric pattern — its own reason does not match it)
  const settled = resumeRun(db, run.runId);
  assert.equal(settled.stop, 'waiting');
  const verdicts = getEvents(db, run.runId)
    .filter((e) => e.type === 'gate.decided')
    .map((e) => JSON.parse(e.payload_json).verdict);
  assert.deepEqual(verdicts, ['repair_required', 'human_required']);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
