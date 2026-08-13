// tests/factory-e2e/w9-02-happy-path.test.mjs
//
// W9-02 — Run the clean scripted happy path to runnable-local.
//
// Drives the `w9-02-happy-full-lifecycle` scenario through the fresh harness
// with REAL per-module scripted handlers (Discovery, Formalization, Development)
// so the cohort converges to runnable-local: Development reaches the `verified`
// terminal decision WITH a passed local-readiness receipt for the exact sealed
// integrated candidate (the LR-07 binding), no authority hacks, fresh state,
// concurrency ≤ 2.
//
// Determinism: each drive runs in an ISOLATED child process (the companion
// w9-02-single-drive.mjs script) to avoid cross-drive module-level state
// contamination (product-tool caches, composition-root singletons). The test
// invokes the drive twice and asserts both produce identical-shaped evidence.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const DRIVE_SCRIPT = path.resolve(REPO_ROOT, 'tests/factory-e2e/w9-02-single-drive.mjs');

/**
 * Run ONE isolated drive of the W9-02 happy scenario and return its evidence.
 * @param {string} label  Drive label for determinism comparison.
 * @returns {object}  The parsed JSON evidence bundle.
 */
function runIsolatedDrive(label) {
  const result = spawnSync('node', [DRIVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, W9_DRIVE_LABEL: label },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(
      `${label}: isolated drive exited ${result.status}\n`
      + `stderr: ${stderr.slice(-1500)}\nstdout: ${stdout.slice(-500)}`,
    );
  }
  // The script prints one JSON line on stdout.
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  assert.ok(jsonLine, `${label}: drive produced no evidence output`);
  return JSON.parse(jsonLine);
}

test('W9-02 happy path #1: cohort converges to runnable-local (verified + passed LR receipt)', () => {
  const evidence = runIsolatedDrive('drive-1');
  assert.equal(evidence.reachedRunnableLocal, true,
    'drive-1: must reach runnable-local (verified + passed LR receipt)');
  assert.equal(evidence.devOutcome, 'verified', 'drive-1: development outcome=verified');
  assert.equal(evidence.lrReceiptOutcome, 'passed', 'drive-1: LR receipt=passed');
  assert.equal(evidence.readinessKind, 'static', 'drive-1: readiness profile kind=static');
  assert.equal(evidence.candidateSealed, true, 'drive-1: integrated candidate sealed as member');
  assert.equal(evidence.strandedActiveExecutions, 0, 'drive-1: no stranded executions');
  assert.ok(evidence.effectiveConcurrency <= 2, 'drive-1: concurrency ≤ 2');
  assert.deepEqual(evidence.invariantsDeclared.includes('no-authority-hacks'), true,
    'drive-1: no-authority-hacks invariant declared');
});

test('W9-02 happy path #2: identical inputs → identical outcome (deterministic, not flaky)', () => {
  const evidence = runIsolatedDrive('drive-2');
  assert.equal(evidence.reachedRunnableLocal, true,
    'drive-2: must reach runnable-local (verified + passed LR receipt)');
  assert.equal(evidence.devOutcome, 'verified', 'drive-2: development outcome=verified');
  assert.equal(evidence.lrReceiptOutcome, 'passed', 'drive-2: LR receipt=passed');
  assert.equal(evidence.readinessKind, 'static', 'drive-2: readiness profile kind=static');
});

test('W9-02 determinism: both drives reach the same terminal shape', () => {
  const e1 = runIsolatedDrive('det-1');
  const e2 = runIsolatedDrive('det-2');
  assert.equal(e1.devOutcome, e2.devOutcome, 'devOutcome is deterministic');
  assert.equal(e1.lrReceiptOutcome, e2.lrReceiptOutcome, 'LR receipt outcome is deterministic');
  assert.equal(e1.readinessKind, e2.readinessKind, 'readiness kind is deterministic');
});
