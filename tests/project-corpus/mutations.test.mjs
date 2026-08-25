/**
 * mutations.test.mjs - the WP-13D RED/GREEN suite: one killed mutation per
 * family, each first proven GREEN (the honest run passes), then killed
 * (the tampered run is caught by the driver's comparisons).
 *
 *   family 1 - expected-world tampering: a phantom declared proof is
 *              detected by the declared-vs-observed comparison;
 *   family 2 - actor-program violation: a flipped gate verdict diverges
 *              the observed world from the authored expectations;
 *   family 3 - fault-schedule divergence: a crash entry whose boundary and
 *              anchor disagree never fires at the mapped registry point
 *              (and is caught), while the correctly paired entry fires
 *              and settles equal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { descriptorOf } from './registry.mjs';
import { runProject } from '../../tools/project-corpus/lib/execute.mjs';

const checkOf = (result, id) => result.checks.find((check) => check.id === id);

/* ------------------------------------------------------------------ */
/* Family 1: expected-world tampering                                  */
/* ------------------------------------------------------------------ */

test('GREEN: p06 passes with its authored expectations', async () => {
  const result = await runProject(await descriptorOf('p06-autonomous-ladder'));
  assert.equal(result.status, 'green');
  assert.equal(checkOf(result, 'declared-expectations').status, 'green');
});

test('RED kill (expected-world tampering): a phantom declared proof is detected', async () => {
  const descriptor = await descriptorOf('p06-autonomous-ladder');
  const result = await runProject(descriptor, {
    mutations: {
      /* The mutation declares a proof the program never issues - the
         declared-vs-observed comparison must name it missing. */
      tamperExpectations: (expectations) => {
        expectations.proofs.push('TerminalProof:run.cancellation');
        return expectations;
      },
    },
  });
  assert.equal(result.status, 'red');
  const declared = checkOf(result, 'declared-expectations');
  assert.equal(declared.status, 'red');
  assert.match(declared.detail, /TerminalProof:run\.cancellation.*declared but not demonstrated/);
});

/* ------------------------------------------------------------------ */
/* Family 2: actor-program violation                                   */
/* ------------------------------------------------------------------ */

test('RED kill (actor-program violation): a flipped gate verdict diverges the world', async () => {
  const descriptor = await descriptorOf('p06-autonomous-ladder');
  const result = await runProject(descriptor, {
    mutations: {
      /* The mutation flips the reviewer final gate verdict from accepted
         to terminal-reject: the authored expectations (accepted gates,
         workplace success terminal) no longer hold. */
      tamperActorSteps: (steps) => steps.map((step) => (
        step.stepId === 'desk-reviewer-1-gate' ? { ...step, gateVerdict: 'terminal-reject' } : step
      )),
    },
  });
  assert.equal(result.status, 'red');
  const offenders = result.checks.filter((check) => check.status === 'red').map((check) => check.id);
  assert.ok(
    offenders.includes('declared-expectations') || offenders.includes('declared-heads') || offenders.includes('reference-vs-observed'),
    `the violation is caught by the comparison layer (red checks: ${offenders.join(', ')})`,
  );
});

/* ------------------------------------------------------------------ */
/* Family 3: fault-schedule divergence                                 */
/* ------------------------------------------------------------------ */

const crashEntry = (boundary) => ({
  fault: 'crash-before-commit',
  boundary,
  anchor: { command: 'workplace.runAuthorGate', instanceId: 'workplace:1' },
});

test('GREEN: a correctly paired crash entry fires at the mapped registry point and settles equal', async () => {
  const descriptor = await descriptorOf('p06-autonomous-ladder');
  const result = await runProject(descriptor, {
    mutations: { tamperFaultSchedule: () => [crashEntry('before-gate')] },
  });
  assert.equal(checkOf(result, 'scheduled-crash-fired').status, 'green', checkOf(result, 'scheduled-crash-fired').detail);
  assert.equal(checkOf(result, 'crash-restart-settles-equal').status, 'green');
});

test('RED kill (fault-schedule divergence): a boundary/anchor disagreement never fires at the mapped point', async () => {
  const descriptor = await descriptorOf('p06-autonomous-ladder');
  const result = await runProject(descriptor, {
    mutations: {
      /* The mutated schedule declares the before-EFFECT boundary while
         anchoring the author GATE application: the before-effect point
         only fires on settleEffect, so the armed crash never happens at
         the mapped point - the divergence must be caught. */
      tamperFaultSchedule: () => [crashEntry('before-effect')],
    },
  });
  assert.equal(result.status, 'red');
  const fired = checkOf(result, 'scheduled-crash-fired');
  assert.equal(fired.status, 'red');
  assert.match(fired.detail, /expected FaultCrashError at before-effect.*no crash/);
});

test('RED kill (fault-schedule divergence): dropping a scheduled fault leaves its invariant unevaluated', async () => {
  const descriptor = await descriptorOf('p19-projection-faults');
  const result = await runProject(descriptor, {
    mutations: {
      tamperFaultSchedule: (schedule) => schedule.filter((entry) => entry.fault !== 'projection-wipe'),
    },
  });
  assert.equal(result.status, 'red');
  const invariant = checkOf(result, 'invariant:projection-rehydrates-from-ledger');
  assert.equal(invariant.status, 'red');
  assert.match(invariant.detail, /projection-wipe probe did not run/);
});
