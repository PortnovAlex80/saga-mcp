/**
 * tools/frf-corpus/lib/execute.mjs - the FRF scenario execution core
 * (FRF-WP10): runs one validated scenario descriptor through the
 * dimension driver, compares the observed normalized world against the
 * descriptor's expected world (declared-subset semantics over the WP03
 * vocabulary), and evaluates the deterministic/capsule checks.
 *
 * A scenario is GREEN only when every check is green. Failures are
 * FINDINGS: printed honestly, never hidden. The mutation hooks exist so
 * the test suite can prove the comparisons detect tampering (RED/GREEN);
 * they are data transformations, never kernel code.
 */

import { driveDeskChain, greenChainInputs, normalizedWorldOf, capsuleReceiptOf } from './chain.mjs';
import { chainInputsFor, driftAcceptanceCriteria, eliteMissingCompositionDraft, eliteMissingEntrypointDraft, foreignScenarioBindingsCase, mutatedSurvivorInputs, scenarioIncompleteWorkItemInputs } from './mutations.mjs';
import { acceptedSurfacesOf, greenWorkItemInputs, repositoryPolicyRefsOf, srsAuthorityOf, wireCells } from './material.mjs';
import { FrfDurableSession, FrfFaultScheduler, FrfFaultCrashError, frfCrashWindows } from './faults.mjs';
import { FRF_DESK_CHAIN } from '../format.mjs';

/* ------------------------------------------------------------------ */
/* Deep equality over normalized JSON                                  */
/* ------------------------------------------------------------------ */

const stableString = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
export const sameWorld = (a, b) => stableString(a) === stableString(b);

/* ------------------------------------------------------------------ */
/* The expectation comparison (declared-subset, WP03 vocabulary)       */
/* ------------------------------------------------------------------ */

function verdictSlot(entry) {
  return entry.verdict ?? entry.outcome ?? null;
}

export function compareExpectedWorld(world, expected) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, status: ok ? 'green' : 'red', detail });

  for (const expectedVerdict of expected.verdicts ?? []) {
    const matching = (world.desks ?? []).filter((entry) => entry.desk === expectedVerdict.desk);
    const ok = matching.some((entry) => verdictSlot(entry) === expectedVerdict.verdict);
    check(
      `verdict:${expectedVerdict.desk}`,
      ok,
      ok ? `desk ${expectedVerdict.desk} settled at verdict ${expectedVerdict.verdict}`
        : `expected desk ${expectedVerdict.desk} to settle at ${expectedVerdict.verdict}; observed [${matching.map((entry) => `${entry.status}/${String(verdictSlot(entry))}`).join(', ')}]`,
    );
  }

  for (const expectedRefusal of expected.refusals ?? []) {
    const ok = (world.refusals ?? []).some((refusal) => refusal.target === expectedRefusal.target && refusal.reason === expectedRefusal.reason);
    check(
      `refusal:${expectedRefusal.target}`,
      ok,
      ok ? `the typed refusal ${expectedRefusal.reason} surfaced at ${expectedRefusal.target}`
        : `expected the typed refusal ${expectedRefusal.reason} at ${expectedRefusal.target}; observed [${(world.refusals ?? []).map((r) => `${r.target}:${r.reason}`).join(', ')}]`,
    );
  }

  if (Array.isArray(expected.bindingDomains)) {
    const observedKinds = new Set((world.bindingDomains ?? []).map((domain) => domain.kind));
    for (const domain of expected.bindingDomains) {
      const observed = (world.bindingDomains ?? []).find((entry) => entry.kind === domain.kind);
      const same = observed !== undefined && stableString(observed.ids) === stableString([...domain.ids].sort());
      check(
        `binding-domain:${domain.kind}`,
        same,
        same ? `binding domain ${domain.kind} resolved to the exact frozen ids`
          : `expected binding domain ${domain.kind} = [${domain.ids.join(', ')}]; observed ${observed === undefined ? 'ABSENT' : `[${observed.ids.join(', ')}]`} (kinds present: ${[...observedKinds].join(', ') || 'none'})`,
      );
    }
  }

  if (expected.closure !== undefined) {
    const observed = world.closure ?? { gapReasons: [], verdict: 'not-reached' };
    const verdictOk = observed.verdict === expected.closure.verdict;
    check(
      'closure:verdict',
      verdictOk,
      verdictOk ? `the reconciliation verdict is ${expected.closure.verdict}`
        : `expected the computed closure verdict ${expected.closure.verdict}; observed ${String(observed.verdict)}`,
    );
    if (Array.isArray(expected.closure.gapReasons)) {
      const reasonsOk = stableString([...expected.closure.gapReasons].sort()) === stableString(observed.gapReasons ?? []);
      check(
        'closure:gapReasons',
        reasonsOk,
        reasonsOk ? `the computed gap reasons are [${expected.closure.gapReasons.join(', ')}]`
          : `expected gap reasons [${expected.closure.gapReasons.join(', ')}]; observed [${(observed.gapReasons ?? []).join(', ')}]`,
      );
    }
  }

  for (const expectedWait of expected.waits ?? []) {
    const observed = (world.waits ?? []).find((wait) => wait.kind === expectedWait.kind);
    const ok = observed !== undefined && observed.state === expectedWait.state;
    check(
      `wait:${expectedWait.kind}`,
      ok,
      ok ? `the ${expectedWait.kind} wait is ${expectedWait.state}`
        : `expected a ${expectedWait.state} ${expectedWait.kind} wait; observed ${JSON.stringify(world.waits ?? [])}`,
    );
  }

  if (expected.terminal !== undefined) {
    for (const key of ['developmentCase', 'plan', 'replan']) {
      if (expected.terminal[key] === undefined) continue;
      const observed = world.terminal?.[key];
      const ok = observed === expected.terminal[key];
      check(
        `terminal:${key}`,
        ok,
        ok ? `${key} reached "${expected.terminal[key]}"`
          : `expected terminal ${key} = ${expected.terminal[key]}; observed ${String(observed)}`,
      );
    }
  }

  if (Array.isArray(expected.capsuleKinds)) {
    const observedKinds = (world.capsule?.artifacts ?? []).map((artifact) => artifact.kind).sort();
    const wanted = [...expected.capsuleKinds].sort();
    const ok = stableString(observedKinds) === stableString(wanted);
    check(
      'capsule:kinds',
      ok,
      ok ? `the capsule sealed the expected artifact kinds`
        : `expected capsule kinds [${wanted.join(', ')}]; observed [${observedKinds.join(', ')}]`,
    );
  }

  if (expected.crashLaw !== undefined) {
    // The declared law value is compared too: a tampered expectation
    // ("not-a-law") must be detected even though the format validator
    // would refuse it at load time (the tamper path bypasses loading).
    const lawOk = expected.crashLaw === 'identical-normalized-world'
      && typeof world.crashLaw === 'object' && world.crashLaw !== null && world.crashLaw.identical === true;
    check('crashLaw', lawOk,
      lawOk ? `every crash window settled to the identical normalized world (${world.crashLaw.windows} windows)`
        : `the crash law FAILED (declared "${String(expected.crashLaw)}"): [${(world.crashLaw?.diverged ?? ['no-crash-law-observed']).join(', ')}]`);
  }

  return checks;
}

/* ------------------------------------------------------------------ */
/* The dimension drivers                                               */
/* ------------------------------------------------------------------ */

const sweepVerdictOf = (run, target) => {
  const deskName = target.split(':')[0];
  const entries = run.desks.filter((entry) => entry.desk === deskName);
  const last = entries[entries.length - 1];
  if (last === undefined) return { reason: 'NOT_REACHED', verdict: 'not-reached' };
  return { reason: last.reason ?? 'NONE', verdict: verdictSlot(last) ?? last.status };
};

/** The binding-mutation sweep: one chain run per declared mutation target. */
async function driveBindingMutationSweep(descriptor) {
  const cells = await wireCells();
  const sweep = [];
  for (const mutation of descriptor.frf.mutations) {
    if (mutation.target === 'admit-development-case:scenario-bindings') {
      // The consumer kill: a green case is admitted, then a substituted-
      // bindings candidate is refused by the case validator (never planned).
      const run = await driveDeskChain(chainInputsFor(null));
      if (run.state.developmentCase === undefined) {
        sweep.push({ reason: `green-chain-did-not-reach-the-case:${String(run.refusedAt)}`, target: mutation.target, verdict: 'not-reached' });
        continue;
      }
      const authorities = {
        frozenBaseline: run.state.frozen.baseline,
        baselineArtifact: run.state.frozen.artifact,
        srs: srsAuthorityOf(),
        repositoryPolicyRefs: repositoryPolicyRefsOf(),
        solutionContract: run.state.settled.contract,
        architectureContract: run.state.architectureContract,
      };
      const validation = cells.caseDesk.validateDevelopmentCase(foreignScenarioBindingsCase(run.state.developmentCase), authorities);
      sweep.push({
        reason: validation.ok === false ? validation.reason : 'ACCEPTED (KILL FAILED)',
        target: mutation.target,
        verdict: validation.ok === false ? 'refused' : 'admitted',
      });
      continue;
    }
    const run = await driveDeskChain(chainInputsFor(mutation), { actorDisposition: false });
    sweep.push({ ...sweepVerdictOf(run, mutation.target), target: mutation.target });
  }
  return { sweep };
}

/** The reconciliation drift: the F-2 gaps verdict is COMPUTED over drifted material. */
async function driveReconciliationDrift() {
  const cells = await wireCells();
  const run = await driveDeskChain(chainInputsFor(null));
  if (run.state.reconciliationSnapshot === undefined) {
    throw new Error(`the green chain did not reach the reconciler (refused at ${String(run.refusedAt)})`);
  }
  const driftedReport = cells.acceptance.reconcileWhat(driftAcceptanceCriteria(run.state.reconciliationSnapshot));
  const world = normalizedWorldOf(run);
  world.closure = {
    gapReasons: [...new Set(driftedReport.gaps.map((gap) => gap.reason))].sort(),
    verdict: driftedReport.verdict,
  };
  return { world };
}

/** The WHAT-freeze authority mutations (substituted member / folded section). */
async function driveFreezeAuthorityMutations(descriptor) {
  const cells = await wireCells();
  const sweep = [];
  const extraChecks = [];
  for (const mutation of descriptor.frf.mutations) {
    const run = await driveDeskChain(chainInputsFor(mutation), { actorDisposition: false });
    sweep.push({ ...sweepVerdictOf(run, mutation.target), target: mutation.target });
    // The D12 resume point: a drift-detected freeze opens the freeze-drift
    // wait; the operator disposition receipt (the public command path)
    // resolves it, an automatic redrive is refused.
    if (run.waitOpened !== null && run.waitOpened.kind === 'TypedWait:effect-uncertainty') {
      const wait = run.waitOpened;
      const auto = cells.persistence.resolveFreezeDriftDecision(wait, undefined);
      extraChecks.push({
        detail: auto.ok === false ? `the automatic redrive of the D12 wait is refused typed (${auto.reason})` : `FAIL: an automatic redrive resolved`,
        id: `d12:auto-redrive-refused:${mutation.target}`,
        status: auto.ok === false ? 'green' : 'red',
      });
      const lawful = cells.persistence.resolveFreezeDriftDecision(wait, {
        command: 'workplace.resolveHumanResponse',
        decision: 'resume-upstream-repair',
        driftEvidenceDigest: wait.driftEvidenceDigest,
      });
      extraChecks.push({
        detail: lawful.ok === true ? 'the operator disposition receipt resolves the D12 wait (resume-upstream-repair)' : `FAIL: the lawful disposition was refused (${String(lawful.reason)})`,
        id: `d12:operator-disposition:${mutation.target}`,
        status: lawful.ok === true ? 'green' : 'red',
      });
      const recycled = cells.persistence.resolveFreezeDriftDecision(wait, {
        command: 'workplace.resolveHumanResponse',
        decision: 'resume-upstream-repair',
        driftEvidenceDigest: 'f'.repeat(64),
      });
      extraChecks.push({
        detail: recycled.ok === false ? `a receipt naming a different drift is refused (${recycled.reason})` : 'FAIL: a recycled receipt resolved',
        id: `d12:recycled-receipt-refused:${mutation.target}`,
        status: recycled.ok === false ? 'green' : 'red',
      });
    }
  }
  return { extraChecks, sweep };
}

/** The SRS Elite kills over the WP08 elite fixture universe. */
async function driveSrsEliteKills(descriptor) {
  const cells = await wireCells();
  const universe = cells.srsRealization.eliteUniverse();
  const draft = cells.srsRealization.eliteRealizationDraft();
  const sweep = [];
  for (const mutation of descriptor.frf.mutations) {
    const killed = mutation.target === 'define-architecture-contract:entrypoint'
      ? eliteMissingEntrypointDraft(draft)
      : eliteMissingCompositionDraft(draft);
    const assembly = cells.srsRealization.authorArchitectureContract(killed, universe);
    sweep.push({
      reason: assembly.ok === false ? assembly.reason : 'ACCEPTED (KILL FAILED)',
      target: mutation.target,
      verdict: assembly.ok === false ? cells.srsRealization.deskVerdictOf(assembly) : 'accepted',
    });
  }
  return { sweep };
}

/** The planning gate: an AC-complete but scenario-incomplete plan is refused. */
async function drivePlanningGateKill(descriptor) {
  const run = await driveDeskChain(chainInputsFor(null), {
    workItemInputs: scenarioIncompleteWorkItemInputs(greenWorkItemInputs()),
  });
  return { run };
}

/** The replan identity-preservation cycle. */
async function driveReplanCycle(descriptor) {
  const cells = await wireCells();
  const run = await driveDeskChain(chainInputsFor(null));
  if (run.state.plan === undefined) return { run };
  const devCase = run.state.developmentCase;
  const nextItems = [...greenWorkItemInputs().filter((item) => item.workItemId !== 'wi:verify'), {
    ...greenWorkItemInputs().find((item) => item.workItemId === 'wi:verify'),
    workItemId: 'wi:verify-2',
  }];
  const built = [];
  for (const item of nextItems) {
    const outcome = cells.workitemDesk.buildWorkItem(item);
    if (outcome.ok !== true) throw new Error(`replan work item build refused: ${JSON.stringify(outcome)}`);
    built.push(outcome.workItem);
  }
  const lawful = cells.preservationDesk.replanDevelopmentPlan(devCase, run.state.plan.plan, built, { planId: 'plan:development-2' });
  if (lawful.ok !== true) {
    run.state.replanOutcome = `refused:${String(lawful.reason)}`;
    return { run };
  }
  const adoption = cells.preservationDesk.adoptDevelopmentPlan(devCase, lawful.plan);
  if (adoption.ok !== true) {
    run.state.replanOutcome = `adoption-refused:${String(adoption.reason)}`;
    return { run };
  }
  const preserved = cells.preservationDesk.identitiesPreserved(adoption.record, devCase);
  const mutatedBuilt = [];
  for (const item of mutatedSurvivorInputs(greenWorkItemInputs())) {
    const outcome = cells.workitemDesk.buildWorkItem(item);
    if (outcome.ok !== true) throw new Error(`mutated survivor build refused: ${JSON.stringify(outcome)}`);
    mutatedBuilt.push(outcome.workItem);
  }
  const drifted = cells.preservationDesk.replanDevelopmentPlan(devCase, run.state.plan.plan, mutatedBuilt);
  run.state.replanOutcome = lawful.ok === true && preserved === true && drifted.ok === false && drifted.reason === 'DRIFT_DETECTED'
    ? 'identity-preserved'
    : `unexpected (${preserved === true ? 'preserved' : 'NOT preserved'}; drifted replan ${drifted.ok === false ? String(drifted.reason) : 'ACCEPTED (KILL FAILED)'})`;
  run.state.replanChange = lawful.change;
  return { run };
}

/** The D5 human-wait scenario: the wait opens, the actor discharges through the public command, the flow completes. */
async function driveHumanWait(descriptor, options = {}) {
  const mutation = descriptor.frf.mutations.find((entry) => entry.target === 'freeze-what-baseline:surfaces.dispositions');
  if (mutation === undefined) throw new Error('the human-wait scenario requires the surfaces.dispositions omission mutation');
  const run = await driveDeskChain(chainInputsFor(mutation), {
    refreezeSurfaces: acceptedSurfacesOf(),
    scheduler: options.scheduler,
    session: options.session,
  });
  return { run };
}

/** The crash-restart matrix: every named window, restart, identical world. */
async function driveCrashMatrix(descriptor) {
  const cleanRun = await driveHumanWait(descriptor);
  const cleanWorld = normalizedWorldOf(cleanRun.run);
  const cells = await wireCells();
  const windows = frfCrashWindows([...FRF_DESK_CHAIN]);
  const diverged = [];
  for (const window of windows) {
    const scheduler = new FrfFaultScheduler({ anchor: window.anchor, fault: window.fault });
    let session = new FrfDurableSession(cells.persistence);
    let faultedRun = null;
    for (let attempt = 0; attempt < 5 && faultedRun === null; attempt += 1) {
      try {
        faultedRun = await driveHumanWait(descriptor, { scheduler, session });
      } catch (error) {
        if (!(error instanceof FrfFaultCrashError)) throw error;
        session = new FrfDurableSession(cells.persistence, session.snapshotRows()); // restart from durable rows
      }
    }
    if (faultedRun === null) {
      diverged.push(`${window.fault}@${window.anchor}:restart-did-not-converge`);
      continue;
    }
    const faultedWorld = normalizedWorldOf(faultedRun.run);
    if (!sameWorld(cleanWorld, faultedWorld)) diverged.push(`${window.fault}@${window.anchor}`);
  }
  return {
    world: { ...cleanWorld, crashLaw: { diverged, identical: diverged.length === 0, windows: windows.length } },
  };
}

/* ------------------------------------------------------------------ */
/* The scenario runner                                                 */
/* ------------------------------------------------------------------ */

/**
 * Run one FRF scenario descriptor.
 *
 * options.mutations (test-only, data transformations):
 *   - tamperExpectations(world) -> world   (expected-world tampering)
 *   - tamperInputs(inputs) -> inputs       (input-stream tampering)
 */
export async function runFrfScenario(descriptor, options = {}) {
  const startedAt = Date.now();
  const { mutations = {} } = options;
  const checks = [];
  const check = (id, ok, detail) => checks.push({ detail, id, status: ok ? 'green' : 'red' });
  let world = null;
  let sweep = null;
  let extraChecks = null;

  try {
    switch (descriptor.frf.dimension) {
      case 'desk-chain-happy': {
        const { run } = { run: await driveDeskChain(greenChainInputs()) };
        world = normalizedWorldOf(run);
        break;
      }
      case 'binding-mutation-sweep': {
        const result = await driveBindingMutationSweep(descriptor);
        sweep = result.sweep;
        break;
      }
      case 'reconciliation-drift': {
        const result = await driveReconciliationDrift();
        world = result.world;
        break;
      }
      case 'what-freeze-authority-mutation': {
        const result = await driveFreezeAuthorityMutations(descriptor);
        sweep = result.sweep;
        extraChecks = result.extraChecks;
        break;
      }
      case 'srs-elite-kill': {
        const result = await driveSrsEliteKills(descriptor);
        sweep = result.sweep;
        break;
      }
      case 'planning-gate-kill': {
        const { run } = await drivePlanningGateKill(descriptor);
        world = normalizedWorldOf(run);
        break;
      }
      case 'replan-identity-cycle': {
        const { run } = await driveReplanCycle(descriptor);
        world = normalizedWorldOf(run);
        break;
      }
      case 'human-wait-disposition': {
        const { run } = await driveHumanWait(descriptor);
        world = normalizedWorldOf(run);
        break;
      }
      case 'crash-restart-matrix': {
        const result = await driveCrashMatrix(descriptor);
        world = result.world;
        break;
      }
      default:
        throw new Error(`unknown dimension "${String(descriptor.frf.dimension)}"`);
    }
  } catch (error) {
    return {
      checks: [{ detail: `${error?.stack ?? String(error)}`, id: 'drive', status: 'red' }],
      dimension: descriptor.frf.dimension,
      elapsedMs: Date.now() - startedAt,
      observed: null,
      scenarioId: descriptor.frf.scenarioId,
      status: 'red',
    };
  }

  const expected = typeof mutations.tamperExpectations === 'function'
    ? mutations.tamperExpectations(structuredClone(descriptor.frf.expectedWorld))
    : descriptor.frf.expectedWorld;

  if (extraChecks !== null) checks.push(...extraChecks);

  if (sweep !== null) {
    const wanted = expected.sweep ?? [];
    const targetsOk = stableString(sweep.map((entry) => entry.target).sort()) === stableString(wanted.map((entry) => entry.target).sort());
    check('sweep:targets', targetsOk, targetsOk
      ? `the sweep exercised exactly the declared targets (${sweep.length})`
      : `sweep targets diverged; declared [${wanted.map((w) => w.target).join(', ')}]; observed [${sweep.map((s) => s.target).join(', ')}]`);
    for (const wantedEntry of wanted) {
      const observed = sweep.find((entry) => entry.target === wantedEntry.target);
      const ok = observed !== undefined && observed.reason === wantedEntry.reason && observed.verdict === wantedEntry.verdict;
      check(
        `sweep:${wantedEntry.target}`,
        ok,
        ok ? `${wantedEntry.target}: typed refusal ${wantedEntry.reason} routed ${wantedEntry.verdict}`
          : `expected ${wantedEntry.target} -> ${wantedEntry.reason}/${wantedEntry.verdict}; observed ${observed === undefined ? 'ABSENT' : `${observed.reason}/${observed.verdict}`}`,
      );
    }
  }

  if (world !== null) {
    checks.push(...compareExpectedWorld(world, expected));
    if (descriptor.frf.dimension === 'desk-chain-happy' || descriptor.frf.dimension === 'human-wait-disposition') {
      // Determinism: a second clean drive must produce the identical
      // normalized world AND the identical capsule digests (seeded).
      const second = descriptor.frf.dimension === 'desk-chain-happy'
        ? normalizedWorldOf(await driveDeskChain(greenChainInputs()))
        : normalizedWorldOf((await driveHumanWait(descriptor)).run);
      const deterministic = sameWorld(world, second);
      check('determinism:identical-world', deterministic, deterministic
        ? 'two independent drives settled to the identical normalized world'
        : `two drives diverged:\n  first  ${stableString(world)}\n  second ${stableString(second)}`);
    }
  }

  const status = checks.every((entry) => entry.status === 'green') ? 'green' : 'red';
  return {
    checks,
    dimension: descriptor.frf.dimension,
    elapsedMs: Date.now() - startedAt,
    observed: world === null ? { sweep } : { summary: worldSummary(world), world },
    scenarioId: descriptor.frf.scenarioId,
    status,
  };
}

function worldSummary(world) {
  return {
    bindingDomains: world.bindingDomains.length,
    capsuleArtifacts: world.capsule.artifacts.length,
    closure: world.closure ?? null,
    desks: world.desks.map((entry) => `${entry.desk}:${verdictSlot(entry) ?? entry.status}`),
    evidenceRows: world.evidence.length,
    refusals: world.refusals,
    terminal: world.terminal,
    waits: world.waits,
  };
}

export { capsuleReceiptOf };
