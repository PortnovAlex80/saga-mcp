// tests/factory-proof/w1-4-two-lifecycles.test.mjs
//
// W1-4 — the ADR-078 two-lifecycle composition proof, blocking form.
//
// One drive: run A (W9 happy material) to its lifecycle terminal, then run B
// (material B + an accepted decoy authored by B's product-contract cell) on a
// NEW production launch of the SAME epic, stopped when B's Formalization
// stage settles. The assertions pin the two authority semantics the drive
// evidences:
//
//   F-1  WITHIN-LIFECYCLE CONSERVATION — capsule B seals every accepted AC
//        authored during lifecycle B, including the decoy (fail-closed: no
//        accepted AC escapes the frozen contract; §D2 must decompose it).
//   F-2  CROSS-LIFECYCLE ISOLATION — A's material is immutable across B and
//        is never swept into B's capsule.
//
// Both lifecycles must settle their Formalization stage with zero stranded
// worker executions. If F-1 is ever ruled a defect by the architecture, the
// capsule-B assertion TIGHTENS to exclude AC-DECOY — it must never be relaxed
// into silence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/w1-4-two-lifecycles-drive.mjs');

let evidence = null;

function driveOnce() {
  const result = spawnSync(process.execPath, [DRIVE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.status !== 0) {
    throw new Error(`w1-4 drive exited ${result.status}\n`
      + `stderr: ${(result.stderr || '').slice(-2500)}\nstdout: ${(result.stdout || '').slice(-800)}`);
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('W1-4: both Formalization lifecycles settle on one epic', () => {
  evidence = driveOnce();
  assert.equal(evidence.runA.stage, 'formalized', 'run A must settle Formalization');
  assert.equal(evidence.runA.terminalReason, 'completed', 'run A must reach its lifecycle terminal');
  assert.equal(evidence.runA.lifecycle.terminal_status, 'runnable-local');
  assert.equal(evidence.runB.stage, 'formalized', 'run B must settle Formalization');
  assert.equal(
    evidence.runB.stoppedByStageOutcome, true,
    'run B must stop because the Formalization outcome was observed — not a cycle bound',
  );
  assert.equal(evidence.stranded, 0, 'no stranded worker executions');
});

test('W1-4 F-2: cross-lifecycle isolation — A is immutable and never adopted by B', () => {
  assert.ok(evidence, 'first test must have run');
  const { immutability, runA, runB } = evidence;
  assert.match(immutability.capsuleABefore, /^[0-9a-f]{64}$/, 'A capsule hash must be sha256');
  assert.equal(immutability.unchanged, true, 'A baseline hash must be byte-identical after run B');
  assert.deepEqual(runA.capsule.codes, ['AC-1', 'AC-2']);
  const overlap = runA.capsule.codes.filter(code => runB.capsule.codes.includes(code));
  assert.deepEqual(overlap, [], "run B's capsule must contain none of run A's criteria");
});

test('W1-4 F-1: within-lifecycle conservation — capsule B seals every accepted AC of run B', () => {
  assert.ok(evidence, 'first test must have run');
  const { runB, decoy } = evidence;
  assert.deepEqual(
    runB.capsule.codes,
    ['AC-B1', 'AC-B2', 'AC-B3', 'AC-DECOY'],
    'capsule B = material B + the decoy its product-contract cell accepted (pinned conservation)',
  );
  assert.equal(decoy.rows, 1, 'exactly one decoy artifact exists');
  assert.equal(decoy.inCapsuleA, false, 'the decoy is newer than A — it cannot widen A');
  assert.equal(decoy.inCapsuleB, true, 'F-1: the decoy is conserved into B (fail-closed sweep)');
});
