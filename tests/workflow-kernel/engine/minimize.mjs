/**
 * tests/workflow-kernel/engine/minimize.mjs - the EK-9 delta-debugging
 * minimizer (WP-13A, plan phase EK-9 "Engine requirements": "Minimize
 * failures while preserving the random seed and fault schedule").
 *
 * The minimizer reduces a FAILING command stream (or the command steps of a
 * whole scenario) to a 1-minimal core that still reproduces the failure,
 * under two hard preservation laws:
 *
 *   1. the RANDOM SEED is retained verbatim in every intermediate run
 *      (the failure must stay reproducible, never re-randomized);
 *   2. the FAULT SCHEDULE is preserved: fault-anchored command applications
 *      are PROTECTED and can never be deleted (protection is unconditional,
 *      not predicate-driven), and the schedule itself is carried through
 *      byte-identically; the result reports schedulePreserved so a caller
 *      can assert the contract instead of trusting it.
 *
 * Algorithm: Zeller-style ddmin over the deletable steps - try removing the
 * complement of each chunk at growing granularity; keep a removal iff the
 * predicate still holds on the re-run (with the same seed and the same
 * schedule); on success reduce granularity, otherwise grow it until no
 * chunk removal at size n=len succeeds. This generalizes the kernel's own
 * minimizeTrace (single-step deletion) with chunked removal and the fault
 * anchor protection the scenario engine requires.
 */

import { driveCommandSteps, scenarioSteps } from './compare.mjs';

/* ------------------------------------------------------------------ */
/* Fault anchors                                                       */
/* ------------------------------------------------------------------ */

const anchorKey = (anchor) => `${anchor.command}@${anchor.instanceId}#${anchor.occurrence ?? 1}`;

const stepAnchorKey = (command, instanceId, occurrence) => `${command}@${instanceId}#${occurrence}`;

/**
 * Indexes of steps a fault anchors to: the nth application of
 * (command, instanceId) named by each anchor. Anchored steps are protected
 * from deletion for the whole run.
 */
export function protectedStepIndexes(steps, faultSchedule) {
  const anchors = new Set(faultSchedule.map((fault) => anchorKey(fault.anchor)));
  const protectedIndexes = new Set();
  const counters = new Map();
  steps.forEach((step, index) => {
    const key = `${step.command}@${step.instanceId}`;
    const occurrence = (counters.get(key) ?? 0) + 1;
    counters.set(key, occurrence);
    if (anchors.has(stepAnchorKey(step.command, step.instanceId, occurrence))) {
      protectedIndexes.add(index);
    }
  });
  return protectedIndexes;
}

/** True iff every scheduled fault still has its anchored application. */
export function faultSchedulePreserved(steps, faultSchedule) {
  const present = new Set();
  const counters = new Map();
  for (const step of steps) {
    const key = `${step.command}@${step.instanceId}`;
    const occurrence = (counters.get(key) ?? 0) + 1;
    counters.set(key, occurrence);
    present.add(stepAnchorKey(step.command, step.instanceId, occurrence));
  }
  return faultSchedule.every((fault) => present.has(anchorKey(fault.anchor)));
}

/* ------------------------------------------------------------------ */
/* ddmin over a command stream                                         */
/* ------------------------------------------------------------------ */

/**
 * Minimize a failing command stream.
 *
 *   steps         the failing command-step list (objects with at least
 *                 command + instanceId; scenario command-step shape);
 *   seed          the retained random seed (passed to every run);
 *   faultSchedule the preserved fault schedule (anchors protect steps);
 *   run           (steps, seed, faultSchedule) => run result;
 *   predicate     (runResult) => true iff the failure is still reproduced.
 *
 * Returns { steps, minimized, iterations, predicateHolds, schedulePreserved,
 * seedPreserved }.
 */
export function minimizeFailureRun({ steps, seed, faultSchedule = [], run, predicate }) {
  if (typeof run !== 'function') throw new TypeError('minimizeFailureRun: run(steps, seed, faultSchedule) is required');
  if (typeof predicate !== 'function') throw new TypeError('minimizeFailureRun: predicate(runResult) is required');

  let current = [...steps];
  let iterations = 0;
  let minimized = false;
  let granularity = 2;

  for (;;) {
    const protectedIndexes = protectedStepIndexes(current, faultSchedule);
    const deletable = current.length - protectedIndexes.size;
    if (deletable === 0) break;

    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && !reduced; start += chunkSize) {
      const end = Math.min(start + chunkSize, current.length);
      let touchesProtected = false;
      for (let index = start; index < end; index += 1) {
        if (protectedIndexes.has(index)) {
          touchesProtected = true;
          break;
        }
      }
      if (touchesProtected) continue;
      const candidate = current.slice(0, start).concat(current.slice(end));
      iterations += 1;
      if (predicate(run(candidate, seed, faultSchedule))) {
        current = candidate;
        minimized = true;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
      }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }

  const finalRun = run(current, seed, faultSchedule);
  return {
    steps: current,
    seed,
    faultSchedule,
    minimized,
    iterations,
    predicateHolds: predicate(finalRun),
    schedulePreserved: faultSchedulePreserved(current, faultSchedule),
    seedPreserved: true,
  };
}

/* ------------------------------------------------------------------ */
/* Scenario-level minimization                                         */
/* ------------------------------------------------------------------ */
/**
 * Minimize the command steps of a SCENARIO while preserving the random seed
 * and the fault schedule verbatim. Ingress steps and actor steps are
 * minimized as one concatenated stream (a failure may not need its ingress
 * either); the write-back keeps every surviving step in its original
 * ingress/actor slot. Everything else in the scenario (identities,
 * topology, fault schedule, time budgets) is carried through unchanged.
 *
 * Note the expectations are NOT rewritten: the minimized scenario is a
 * failure reproducer, not a passing scenario.
 *
 * Options: runScenario (steps, seed, faultSchedule) => run result
 * (defaults to the reference-model driver) and predicate(runResult).
 */
export function minimizeScenario(scenario, { runScenario, predicate }) {
  if (typeof predicate !== 'function') throw new TypeError('minimizeScenario: predicate(runResult) is required');
  const run = runScenario ?? ((steps, seed, faultSchedule) => driveCommandSteps(steps, faultSchedule, seed));

  const ingress = scenario.seedInput.ingress;
  const actors = scenario.actorProgram;
  const ingressIdentity = new Set(ingress);

  const result = minimizeFailureRun({
    steps: scenarioSteps(scenario),
    seed: scenario.seedInput.seed,
    faultSchedule: scenario.faultSchedule,
    run,
    predicate,
  });

  const minimizedIngress = result.steps.filter((step) => ingressIdentity.has(step));
  const minimizedActors = result.steps.filter((step) => !ingressIdentity.has(step));
  const minimizedScenario = {
    ...scenario,
    seedInput: { ...scenario.seedInput, ingress: minimizedIngress },
    actorProgram: minimizedActors,
  };

  return {
    scenario: minimizedScenario,
    originalScenario: scenario,
    minimized: result.minimized,
    iterations: result.iterations,
    predicateHolds: result.predicateHolds,
    schedulePreserved: result.schedulePreserved,
    seedPreserved: minimizedScenario.seedInput.seed === scenario.seedInput.seed,
    faultSchedulePreservedVerbatim: canonicalJsonShallow(minimizedScenario.faultSchedule) === canonicalJsonShallow(scenario.faultSchedule),
  };
}

function canonicalJsonShallow(value) {
  return JSON.stringify(sortKeysShallow(value));
}

function sortKeysShallow(value) {
  if (Array.isArray(value)) return value.map(sortKeysShallow);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysShallow(value[key]);
    return out;
  }
  return value;
}
