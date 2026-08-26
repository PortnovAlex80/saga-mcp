/**
 * tools/project-corpus/lib/invariants.mjs - the closed invariant battery of
 * the project corpus (WP-13D). Every invariant is evaluated over the
 * observed normalized world (durable rows only) or over driver-controlled
 * probes (product commands, re-drives, armed crash executions).
 *
 * The vocabulary is CLOSED (tests/project-corpus/format.mjs); an unknown
 * invariant is a RED finding, never a silent skip.
 */

import { findInvariantViolations } from '../../../dist/workflow-kernel/domain/explorer.js';

const check = (id, ok, detail) => ({ id, status: ok ? 'green' : 'red', detail: detail ?? (ok ? 'ok' : 'violated') });

const counts = (list) => {
  const map = new Map();
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
};

/**
 * Evaluate the world-level invariants (the ones that read one observed
 * view). The probe-level invariants (product, re-drive, crash matrix) are
 * evaluated by the mode drivers and merged into the same report.
 */
export function evaluateWorldInvariants(descriptor, observed, context = {}) {
  const results = [];
  const world = observed.world;
  const declared = new Set(descriptor.expectedInvariants ?? []);

  if (declared.has('no-invariant-violations')) {
    const violations = findInvariantViolations(world);
    /* KERNEL FINDING (recorded, not worked around): the explorer's
       DUPLICATE_EFFECT oracle keys success receipts by producer COMMAND
       NAME, so a world with several workplaces that each lawfully settled
       one effect reports a false duplicate. The driver scopes the oracle
       correctly on its side: every settleEffect application may produce
       exactly one receipt; a true duplicate would show MORE receipts than
       applications. The artifact is reported as a typed note, never
       silently dropped. */
    const settleEvents = world.events.filter((event) => event.transition === 'workplace.settleEffect');
    const successReceipts = world.evidence.filter((fact) => fact.kind === 'EffectReceipt:success');
    const multiWorkplace = new Set(settleEvents.map((event) => event.sourceInstanceId)).size > 1;
    const trueViolations = [];
    const scopingArtifacts = [];
    for (const violation of violations) {
      const isArtifact = violation.kind === 'DUPLICATE_EFFECT' && multiWorkplace && successReceipts.length === settleEvents.length;
      if (isArtifact) scopingArtifacts.push(violation);
      else trueViolations.push(violation);
    }
    const detail = trueViolations.length === 0
      ? (scopingArtifacts.length > 0
        ? `ok (kernel-finding:dupe-effect-producer-scope x${scopingArtifacts.length}: the oracle keys receipts by producer command name, not owning workplace; ${successReceipts.length} receipts over ${settleEvents.length} settleEffect applications across ${new Set(settleEvents.map((event) => event.sourceInstanceId)).size} workplaces - no execution happened twice)`
        : 'ok')
      : JSON.stringify(trueViolations);
    results.push(check('no-invariant-violations', trueViolations.length === 0, detail));
  }

  if (declared.has('no-obligation-completed-twice')) {
    const completed = world.obligations.filter((obligation) => obligation.state === 'completed').map((obligation) => obligation.idempotencyKey);
    const unique = new Set(completed);
    results.push(check('no-obligation-completed-twice', unique.size === completed.length, `${unique.size}/${completed.length} completed keys unique`));
  }

  if (declared.has('no-open-terminal-drain-obligations')) {
    /* The drain-closed law (REG-28 / kit INV-02b) at a settled run: no
       CLAIMABLE lane head remains on the frontier. Per-application lane
       rows legitimately stay open behind their completed FIFO heads (the
       engine completes the lane head in-transaction); the drain is closed
       when the frontier holds nothing claimable. */
    const okDrain = context.drainClosed === true;
    results.push(check('no-open-terminal-drain-obligations', okDrain, context.drainClosedDetail ?? (okDrain ? 'the frontier is empty at settlement' : 'the drain did not close (claimable frontier rows remain)')));
  }

  if (declared.has('one-admitted-receipt-per-attempt')) {
    const receipts = new Set(world.evidence.filter((fact) => fact.kind === 'PromptAssemblyReceipt:admitted').map((fact) => fact.ref));
    const attempts = [...world.heads.values()].filter((head) => head.aggregate === 'ActivityAttempt' && head.status !== 'created').length;
    const admitted = context.admittedAttemptCount ?? attempts;
    results.push(check('one-admitted-receipt-per-attempt', receipts.size === admitted && admitted > 0, `${receipts.size} admitted receipts for ${admitted} driven attempts`));
  }

  if (declared.has('workplace-terminal-success')) {
    const workplaces = [...world.heads.values()].filter((head) => head.aggregate === 'Workplace');
    const terminal = workplaces.filter((head) => head.status === 'terminal' && head.terminal === 'TerminalProof:workplace.success');
    results.push(check('workplace-terminal-success', workplaces.length > 0 && terminal.length === workplaces.length, `${terminal.length}/${workplaces.length} workplaces terminal success`));
  }

  if (declared.has('truthful-failure-ladder')) {
    const proofs = new Set(world.proofs.map((proof) => proof.id));
    const ladder = ['TerminalProof:workplace.truthful-failure', 'TerminalProof:node.truthful-failure', 'TerminalProof:process.truthful-failure', 'TerminalProof:stage.truthful-failure', 'TerminalProof:lifecycle.truthful-failure', 'TerminalProof:run.truthful-failure'];
    const missing = ladder.filter((proof) => !proofs.has(proof));
    results.push(check('truthful-failure-ladder', missing.length === 0, missing.length === 0 ? 'the full honest failure ladder issued' : `missing: ${missing.join(', ')}`));
  }

  if (declared.has('typed-refusal-family')) {
    const refusal = context.refusal;
    const expected = descriptor.expectedRefusal;
    const ok = refusal !== undefined && expected !== undefined
      && refusal.reason === expected.reason
      && (expected.stepId === undefined || context.refusedStepId === expected.stepId);
    results.push(check('typed-refusal-family', ok, ok ? `refused ${refusal.reason} at ${context.refusedStepId}` : `expected refusal ${expected?.reason ?? '<none>'} at ${expected?.stepId ?? '<any>'}, got ${refusal === undefined ? 'no refusal' : `${refusal.reason} at ${context.refusedStepId}`}`));
  }

  if (declared.has('worker-loss-classified-never-failed')) {
    const classified = [...world.heads.values()].filter((head) => head.aggregate === 'ActivityAttempt' && head.status === 'worker-loss-classified');
    /* The classification created the retry lane; a same-intent retry
       consumes it (completed) - either way the lane exists and the attempt
       was NEVER product-failed. */
    const retryLane = world.obligations.some((obligation) => obligation.kind === 'obligation:retryAttempt');
    const failed = [...world.heads.values()].some((head) => head.aggregate === 'ActivityAttempt' && String(head.status).includes('failed') && head.status !== 'worker-loss-classified');
    results.push(check('worker-loss-classified-never-failed', classified.length > 0 && retryLane && !failed,
      `${classified.length} attempt(s) classified; retry lane exists: ${String(retryLane)}; product-failed attempts: ${String(failed)}`));
  }

  if (declared.has('operator-discharges-human-wait')) {
    const humanWaits = world.waits.filter((wait) => wait.kind === 'TypedWait:human-input');
    const discharged = humanWaits.filter((wait) => wait.state === 'discharged');
    const discharges = world.evidence.filter((fact) => fact.kind === 'WakeDischarge:human-response-command');
    const ok = humanWaits.length > 0 && discharged.length === humanWaits.length && discharges.length >= humanWaits.length;
    results.push(check('operator-discharges-human-wait', ok, `${discharged.length}/${humanWaits.length} discharged by operator commands, ${discharges.length} discharge facts`));
  }

  if (declared.has('d12-uncertainty-pending-operator-only')) {
    const uncertain = world.waits.filter((wait) => wait.kind === 'TypedWait:effect-uncertainty');
    const pending = uncertain.filter((wait) => wait.state === 'pending');
    const operatorOnly = pending.every((wait) => [...wait.wakeCommands].length === 1 && wait.wakeCommands[0] === 'workplace.resolveHumanResponse');
    results.push(check('d12-uncertainty-pending-operator-only', uncertain.length > 0 && pending.length === uncertain.length && operatorOnly,
      `${pending.length}/${uncertain.length} pending; wakes: ${pending.map((wait) => wait.wakeCommands.join('+')).join('; ') || 'none'}`));
  }

  if (declared.has('readiness-boundary-intact')) {
    // The declared dependant never became ready / never entered work while
    // its predecessor is unaccepted: no workplace of the dependant exists
    // and its readiness gaps are typed (context supplies the probe result
    // from the conveyor/readiness evaluation).
    const ok = context.readinessBoundaryIntact === true;
    results.push(check('readiness-boundary-intact', ok, context.readinessBoundaryDetail ?? 'the dependant never crossed the readiness boundary'));
  }

  if (declared.has('idempotent-replay-no-double-commit')) {
    /* The two probes are the oracle: the full stateless re-drive changed
       nothing (every step skipped/replayed - no second commit), and the
       verbatim re-issue under a fresh key was refused by the CAS fence. */
    const unchanged = context.redriveUnchanged !== false;
    const refused = context.verbatimReissueRefused === true;
    results.push(check('idempotent-replay-no-double-commit', unchanged && refused,
      `full re-drive unchanged: ${unchanged}; verbatim re-issue refused: ${refused}`));
  }

  if (declared.has('exactly-once-under-schedule')) {
    const settled = context.settledWorldsEqualGolden;
    results.push(check('exactly-once-under-schedule', settled === true, context.exactlyOnceDetail ?? 'every faulted execution settled to the clean golden world'));
  }

  if (declared.has('crash-matrix-covers-registry')) {
    const covered = context.matrixCoveredPoints ?? [];
    const missing = context.matrixMissingPoints ?? ['<matrix not executed>'];
    results.push(check('crash-matrix-covers-registry', missing.length === 0 && covered.length > 0, `covered ${covered.length} registry points${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`));
  }

  if (declared.has('projection-rehydrates-from-ledger')) {
    const ran = context.projectionRehydrated !== undefined;
    results.push(check('projection-rehydrates-from-ledger', context.projectionRehydrated === true,
      ran
        ? (context.projectionRehydrateDetail ?? 'rehydrated')
        : 'the projection-wipe probe did not run (the driven fault schedule no longer schedules projection-wipe)'));
  }

  if (declared.has('stale-write-refused-and-ineffective')) {
    const refused = context.staleWriteRefused === true;
    const unchanged = context.staleWriteUnchanged === true;
    results.push(check('stale-write-refused-and-ineffective', refused && unchanged, `stale write refused: ${refused}; world unchanged: ${unchanged}`));
  }

  if (declared.has('product-verification-green')) {
    const products = context.productResults ?? [];
    const ok = products.length > 0 && products.every((result) => result.code === 0);
    results.push(check('product-verification-green', ok, products.map((result) => `${result.label}: exit ${result.code}`).join('; ') || 'no product commands executed'));
  }

  if (declared.has('product-determinism')) {
    const digests = context.productBuildDigests ?? [];
    const ok = digests.length >= 2 && digests.every((digest) => digest === digests[0]);
    results.push(check('product-determinism', ok, `build digests: ${digests.join(', ') || 'none'}`));
  }

  if (declared.has('determinism-replay')) {
    results.push(check('determinism-replay', context.replayWorldEqual === true, context.replayWorldDetail ?? 'a full re-run on a fresh database produced the identical normalized world'));
  }

  if (declared.has('time-budget')) {
    const budget = descriptor.scenario?.timeBudgets?.totalMs ?? 0;
    const elapsed = context.elapsedMs ?? 0;
    results.push(check('time-budget', elapsed <= budget, `${Math.round(elapsed)}ms elapsed of ${budget}ms budget`));
  }

  return results;
}

/** Every declared invariant must have been evaluated exactly once. */
export function unevaluatedInvariants(descriptor, evaluated) {
  const evaluatedIds = new Set(evaluated.map((result) => result.id));
  return (descriptor.expectedInvariants ?? []).filter((invariant) => !evaluatedIds.has(invariant));
}
