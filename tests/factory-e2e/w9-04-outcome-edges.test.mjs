// tests/factory-e2e/w9-04-outcome-edges.test.mjs
//
// W9-04 — lifecycle outcome-edge runtime traces (CONVEYOR §23 L3/L4 item 7).
//
// Each test drives ONE outcome edge end to end through the fresh harness with
// a single targeted scripted-worker override (see w9-04-outcome-edge-handlers)
// and asserts the lifecycle actually traversed the declared route: the stage
// records the outcome, the lifecycle terminates on the route's terminal
// status, and settlement's certificate records the decision. The sibling
// registry (tests/architecture/lifecycle-outcome-edge-coverage.test.mjs)
// pins these scenarios as the named traces for each edge.
//
// Each drive runs in an ISOLATED child process (same isolation pattern as
// w9-02/w9-03) to avoid cross-drive module-level state contamination.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const DRIVE_SCRIPT = path.resolve(REPO_ROOT, 'tests/factory-e2e/w9-04-outcome-edge-drive.mjs');

const DRIVE_TIMEOUT_MS = 180_000;

function runEdgeDrive(scenario) {
  const result = spawnSync('node', [DRIVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, W9_SCENARIO: scenario, W9_DRIVE_LABEL: scenario },
    encoding: 'utf8',
    windowsHide: true,
    timeout: DRIVE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `${scenario}: isolated drive exited ${result.status}\n`
      + `stderr: ${stderr.slice(-2500)}`,
    );
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  assert.ok(jsonLine, `${scenario}: drive produced no evidence output`);
  return JSON.parse(jsonLine);
}

// The formalization terminals first: they are where settlement, certificates
// and order projection break the first time an untraversed edge fires.
test('outcome edge solution-formalization:inconsistent — architecture author adds an out-of-baseline AC', () => {
  const evidence = runEdgeDrive('frm-inconsistent');
  assert.equal(evidence.stageRunOutcome, 'inconsistent');
  assert.equal(evidence.lifecycleTerminalStatus, 'formalization-inconsistent');
  assert.equal(evidence.certificateDecision, 'inconsistent');
  assert.match(String(evidence.certificateReasonCodes), /baseline-missing/,
    'settlement must name the baseline hash mismatch, not a generic failure');
  assert.equal(evidence.strandedActiveExecutions, 0);
});

test('outcome edge solution-formalization:failed — AC document contradicts its artifact identity', () => {
  const evidence = runEdgeDrive('frm-failed');
  assert.equal(evidence.stageRunOutcome, 'failed');
  assert.equal(evidence.lifecycleTerminalStatus, 'failed');
  assert.equal(evidence.certificateDecision, null,
    'this edge detonates in the baseline-freeze kernel before settlement — no module certificate may exist');
  assert.equal(evidence.strandedActiveExecutions, 0);
});

test('outcome edge solution-development:blocked — repository drifts after candidate freeze', () => {
  const evidence = runEdgeDrive('dev-blocked');
  assert.equal(evidence.stageRunOutcome, 'blocked');
  assert.equal(evidence.lifecycleTerminalStatus, 'development-blocked');
  assert.equal(evidence.certificateDecision, 'blocked');
  assert.match(String(evidence.certificateReasonCodes), /candidate-drifted-after-freeze/,
    'settlement must name the drift, not a generic block');
  assert.equal(evidence.strandedActiveExecutions, 0);
});

test('deleted outcome word — a defer recommendation is rejected, never translated to clarify', () => {
  const evidence = runEdgeDrive('disc-deleted-word');
  assert.ok((evidence.deletedWordProposalGateRejections ?? 0) >= 1,
    'the proposal gate must reject the deleted word as invalid input (failed check receipts)');
  assert.equal(evidence.deletedWordDiscoveryCertificates, 0,
    'no discovery certificate may launder a deleted word into clarify');
  assert.notEqual(evidence.lifecycleTerminalStatus, 'runnable-local',
    'the lifecycle must not complete: a rejection is honest, a rewrite is not');
  assert.equal(evidence.strandedActiveExecutions, 0);
});

// Discovery strength codes: every code routes FORWARD to Formalization and is
// recorded in the discovery certificate — the trace asserts the CERTIFICATE
// code plus the forward routing, not a different terminal.
for (const code of ['clarify', 'reject']) {
  test(`outcome edge initial-discovery:${code} — settled code reaches the certificate and routing forwards`, () => {
    const evidence = runEdgeDrive(`disc-${code}`);
    assert.equal(evidence.stageRunOutcome, code);
    assert.equal(evidence.certificateDecision, code,
      `the discovery certificate must record the emitted strength code '${code}'`);
    assert.ok((evidence.formalizationStageRunsAfterDiscovery ?? 0) >= 1,
      'Discovery is a permissive strength gate: Formalization must still run');
    assert.equal(evidence.developmentOutcome, 'verified',
      'the forwarded run still completes the lifecycle on its own merits');
    assert.equal(evidence.strandedActiveExecutions, 0);
  });
}
