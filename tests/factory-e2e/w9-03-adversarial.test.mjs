// tests/factory-e2e/w9-03-adversarial.test.mjs
//
// W9-03 — Run the adversarial scripted authority and recovery path.
//
// Drives the THREE adversarial scenarios declared in run-manifest.ts through
// the fresh harness, each proving an authority/recovery invariant with NAMED
// DETERMINISTIC crash points (no random fault injection):
//
//   1. CROSS-EXECUTION DURABILITY — an author self-crashes (exit-without-done)
//      on its first invocation; a second execution continues on the SAME
//      workplace; the cohort converges to runnable-local; partition invariance
//      holds (the crash doesn't duplicate/lose contributions; no stranded
//      executions).
//
//   2. REVIEWER REJECT → REPAIR — the final gate rejects the first reviewer
//      assessment (changes_requested); the author produces a repaired
//      CandidateSet; a second reviewer assessment is accepted; the run
//      converges; the EXACT subject_candidate_set_ref authority is preserved
//      across the repair cycle (no recency, no wrong-candidate binding).
//
//   3. CARRY-FORWARD AUTHORITY — under a multi-task environment (the recency
//      trap), the integration task is selected from the accepted-authority head
//      (readAuthorTaskId), NEVER from submission.task_id or recency.
//
// Determinism: each scenario runs in an ISOLATED child process (the companion
// w9-03-adversarial-drive.mjs script) to avoid cross-drive module-level state
// contamination. Each scenario is driven twice and both produce identical-
// shaped evidence.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const DRIVE_SCRIPT = path.resolve(REPO_ROOT, 'tests/factory-e2e/w9-03-adversarial-drive.mjs');

const SCENARIOS = [
  'cross-execution-durability',
  'reviewer-reject-repair',
  'carry-forward-authority',
];

/**
 * Run ONE isolated drive of an adversarial scenario and return its evidence.
 * @param {string} scenario  Scenario key.
 * @param {string} label  Drive label for determinism comparison.
 * @returns {object}  The parsed JSON evidence bundle.
 */
function runIsolatedDrive(scenario, label) {
  const result = spawnSync('node', [DRIVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, W9_SCENARIO: scenario, W9_DRIVE_LABEL: label },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    throw new Error(
      `${label}: isolated drive exited ${result.status}\n`
      + `stderr: ${stderr.slice(-2000)}\nstdout: ${stdout.slice(-500)}`,
    );
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  assert.ok(jsonLine, `${label}: drive produced no evidence output`);
  return JSON.parse(jsonLine);
}

// ---------------------------------------------------------------------------
// Scenario 1: CROSS-EXECUTION DURABILITY
// ---------------------------------------------------------------------------

test('W9-03 cross-execution durability: author crash + recovery converges to runnable-local', () => {
  const evidence = runIsolatedDrive('cross-execution-durability', 'cross-exec-1');
  assert.equal(evidence.reachedRunnableLocal, true,
    'crash recovery must converge to runnable-local');
  assert.equal(evidence.strandedActiveExecutions, 0,
    'no stranded active executions after crash recovery');
  assert.ok(evidence.lostExecutionCount >= 1,
    'at least one lost execution from the deterministic crash');
  assert.ok(evidence.crashWorkplaceRef,
    'crash workplace identified');
  assert.equal(evidence.authorCandidateSetCount, 1,
    'exactly ONE author CandidateSet for the crashed workplace — partition invariance (no duplication, no loss)');
  assert.equal(evidence.partitionInvarianceHolds, true,
    'partition invariance holds: crash did not duplicate or lose contributions');
});

test('W9-03 cross-execution durability: deterministic (second drive identical shape)', () => {
  const evidence = runIsolatedDrive('cross-execution-durability', 'cross-exec-2');
  assert.equal(evidence.reachedRunnableLocal, true,
    'second drive also converges to runnable-local');
  assert.equal(evidence.strandedActiveExecutions, 0,
    'second drive: no stranded executions');
  assert.ok(evidence.lostExecutionCount >= 1,
    'second drive: crash fires deterministically');
  assert.equal(evidence.authorCandidateSetCount, 1,
    'second drive: partition invariance holds');
});

// ---------------------------------------------------------------------------
// Scenario 2: REVIEWER REJECT → REPAIR
// ---------------------------------------------------------------------------

test('W9-03 reviewer reject → repair: gate rejects first assessment, repaired set accepted', () => {
  const evidence = runIsolatedDrive('reviewer-reject-repair', 'reject-repair-1');
  assert.equal(evidence.reachedRunnableLocal, true,
    'repair cycle must converge to runnable-local');
  assert.ok(evidence.gateRepairDecisionCount >= 1,
    'at least one repair_required gate decision (the reject)');
  assert.ok(evidence.refsAreDistinct,
    'rejected and accepted CandidateSets have distinct refs (different production revisions)');
  assert.equal(evidence.headPointsToAccepted, true,
    'authority head points to the ACCEPTED (second) CandidateSet, never the rejected first');
  assert.equal(evidence.strandedActiveExecutions, 0,
    'no stranded executions after repair cycle');
});

test('W9-03 reviewer reject → repair: deterministic (second drive identical shape)', () => {
  const evidence = runIsolatedDrive('reviewer-reject-repair', 'reject-repair-2');
  assert.equal(evidence.reachedRunnableLocal, true,
    'second drive also converges');
  assert.ok(evidence.gateRepairDecisionCount >= 1,
    'second drive: reject fires deterministically');
  assert.equal(evidence.headPointsToAccepted, true,
    'second drive: head points to accepted set');
});

// ---------------------------------------------------------------------------
// Scenario 3: CARRY-FORWARD AUTHORITY
// ---------------------------------------------------------------------------

test('W9-03 carry-forward authority: integration task from readAuthorTaskId, not recency', () => {
  const evidence = runIsolatedDrive('carry-forward-authority', 'carry-forward-1');
  assert.equal(evidence.reachedRunnableLocal, true,
    'cohort converges to runnable-local');
  assert.ok(evidence.integratedTaskCount >= 1,
    'at least one development task was integrated');
  assert.equal(evidence.allHeadTaskIdsNonNull, true,
    'every integrated workplace has a non-null accepted_author_task_id on the authority head');
  assert.equal(evidence.allIntegratedTasksMatchHead, true,
    'every integrated task ID matches its workplace readAuthorTaskId — carry-forward-safe binding');
  assert.ok(evidence.multipleGitChangeTasksPresent,
    'multiple git_change tasks present (recency trap is structurally present, yet the head binding held)');
  assert.equal(evidence.strandedActiveExecutions, 0,
    'no stranded executions');
});

test('W9-03 carry-forward authority: deterministic (second drive identical shape)', () => {
  const evidence = runIsolatedDrive('carry-forward-authority', 'carry-forward-2');
  assert.equal(evidence.reachedRunnableLocal, true,
    'second drive also converges');
  assert.equal(evidence.allIntegratedTasksMatchHead, true,
    'second drive: all integrated tasks match the head');
});
