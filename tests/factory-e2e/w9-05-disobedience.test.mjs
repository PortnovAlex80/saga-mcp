// tests/factory-e2e/w9-05-disobedience.test.mjs
//
// Stage-6 G2 — turn model-compliance assumptions into negative tests.
//
// Each scenario spawns the standalone drive (w9-05-disobedience-drive.mjs)
// in an isolated process and asserts its JSON evidence bundle. The drives
// run the REAL production machinery (finalizer, reaper, crash repair,
// requeue); only the worker's half of the protocol is scripted-disobedient.
//
// Proven per scenario:
//   silent-worker      — liveness is mechanical: a running row with a dead
//                        pid, expired lease, stale heartbeat and no receipt
//                        is reaped lost, its card released, authority heads
//                        untouched.
//   exit-without-done  — real work + exit 0 is NOT completion: lost
//                        execution, crash repair, a later obedient execution
//                        completes the task, no downstream from the fake.
//   fake-done-file     — worker-done-call.json on disk is not a tool call:
//                        file exists, factory ignores it, same lost/repair
//                        convergence as above.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRIVE_SCRIPT = path.join(REPO_ROOT, 'tests/factory-e2e/w9-05-disobedience-drive.mjs');

function runDrive(scenario, label) {
  const proc = spawnSync('node', [DRIVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, W9_SCENARIO: scenario, W9_DRIVE_LABEL: label },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  assert.equal(proc.status, 0, `drive ${label} failed:\nSTDOUT:${proc.stdout?.slice(-4000)}\nSTDERR:${proc.stderr?.slice(-4000)}`);
  const lines = proc.stdout.trim().split(/\r?\n/);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

test('G2.1 — a worker that never signals liveness is reaped mechanically', () => {
  const evidence = runDrive('silent-worker', 'd1');
  assert.equal(evidence.scenario, 'silent-worker');
  assert.equal(evidence.reapedLost, true, `execution should be reaped lost, got ${evidence.reapAction}: ${evidence.reapReason}`);
  assert.ok(typeof evidence.reapReason === 'string' && evidence.reapReason.length > 0,
    'the reap must carry the policy reason string');
  assert.equal(evidence.cardReleased, true, 'the claim fence must be released so the card can re-queue');
  assert.equal(evidence.headsUnchanged, true, 'accepted-authority heads must not advance through a silent execution');
  assert.equal(evidence.strandedActiveExecutions, 0);
  assert.equal(evidence.devOutcome, 'verified', 'the cohort still converges after the reap');
});

test('G2.2 — completing work and exiting 0 without worker_done is NOT completion', () => {
  const evidence = runDrive('exit-without-done', 'd1');
  assert.equal(evidence.scenario, 'exit-without-done');
  assert.ok(evidence.disobedientLostCount >= 1, 'the disobedient execution must be classified lost');
  assert.ok(evidence.disobedientExitCodeZero, 'the disobedient execution exited code 0 — and was still not completed');
  assert.equal(evidence.disobedientAcceptedReceipts, 0, 'no accepted worker_done receipt may exist for it');
  assert.equal(evidence.disobedientDownstreamProducts, 0, 'no downstream submission may be created from it');
  assert.equal(evidence.taskCompletedByLaterExecution, true, 'the task must be completed by a later, obedient execution');
  assert.equal(evidence.devOutcome, 'verified', 'the cohort converges through genuine work only');
});

test('G2.3 — writing worker-done-call.json is not a tool call', () => {
  const evidence = runDrive('fake-done-file', 'd1');
  assert.equal(evidence.scenario, 'fake-done-file');
  assert.equal(evidence.fakeFileExists, true, 'the forged file must exist on disk');
  assert.ok(evidence.fakeFileContent && evidence.fakeFileContent.includes('worker_done'),
    'the forgery must be plausible (template-shaped payload)');
  assert.ok(evidence.disobedientLostCount >= 1, 'the faking execution must be classified lost');
  assert.equal(evidence.disobedientAcceptedReceipts, 0, 'the factory must not recognize the file as completion');
  assert.equal(evidence.taskCompletedByLaterExecution, true, 'convergence only through a genuine second execution');
  assert.equal(evidence.devOutcome, 'verified');
});
