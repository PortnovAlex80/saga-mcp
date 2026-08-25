/**
 * tools/project-corpus/lib/modes.mjs - the three public-command execution
 * engines of the project corpus (WP-13D). Every mode drives a FRESH
 * GREENFIELD database and never writes an authority table directly.
 *
 *   durable-session      - WP-13B actor programs compiled to kernel inputs,
 *                          driven over the sole-writer repositories with the
 *                          WP-13B fault scheduler (crash + stateless restart
 *                          settlement, projection wipe/stale write, worker
 *                          loss); the reference model (WP-13A) compares.
 *   planning-conveyor    - the WP-09 dependency conveyor over the declared
 *                          topologies (chain/diamond/fan-in/fan-out/
 *                          independent/failed-predecessor).
 *   development-vertical - the WP-08 capsule ingress -> material chain with
 *                          REAL product verification (build + loopback +
 *                          smoke on a temp copy of the fixture).
 */

import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join as joinPath, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { FaultScheduler, FaultCrashError, FAULT_POINTS } from '../../../dist/workflow-kernel/application/faults.js';
import {
  SCENARIO_BOUNDARY_POINTS,
  driveScenarioOnSession,
  openScenarioSession,
  scenarioAdmission,
  scenarioDatabasePath,
  scenarioExternalEvidence,
  scenarioNormalizedWorld,
} from '../../../dist/workflow-kernel/testing/scenario-faults.js';
import { actorPinSet, compileActorProgram } from '../../../dist/workflow-kernel/testing/actors.js';
import { SCENARIO_FORMAT_VERSION } from '../../../tests/workflow-kernel/engine/scenario.mjs';
import { UNIVERSE_SCHEMA_VERSION } from '../../../dist/workflow-kernel/domain/universe.js';
import { observedWorldView, projectIdentityDigests } from './world.mjs';
import { verifyProduct, stageFixtureWorkspace } from './products.mjs';
import { compareDeclaredHeads, compareDeclaredWithObserved, compareReferenceWithObserved } from './expectations.mjs';

const ok = (id, detail) => ({ id, status: 'green', detail });
const red = (id, detail) => ({ id, status: 'red', detail });

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** A fresh greenfield kernel database (Windows-safe unique temp dir). */
export function corpusDatabase(prefix = 'ek-corpus-') {
  const dir = mkdtempSync(joinPath(tmpdir(), prefix));
  const path = joinPath(dir, 'kernel.sqlite');
  return { path, dir, open: openAt(path) };
}
const openAt = (path) => async () => {
  const { openKernelDatabase } = await import('../../../dist/workflow-kernel/persistence/database.js');
  const { KernelPersistenceSession } = await import('../../../dist/workflow-kernel/persistence/session.js');
  return new KernelPersistenceSession(openKernelDatabase(path));
};

/** The registry point a crash entry arms (boundary map + anchor windows). */
export function crashPointOf(entry) {
  if (entry.boundary !== undefined) return SCENARIO_BOUNDARY_POINTS[entry.boundary][0];
  const before = entry.fault === 'crash-before-commit';
  switch (entry.anchor.command) {
    case 'activityAttempt.admitProviderRequest': return before ? 'before-admission' : 'after-admission';
    case 'cognition.sendProviderRequest': return before ? 'before-provider-send' : 'after-provider-send';
    case 'activityAttempt.recordOutcome': return before ? 'before-worker-return' : 'after-worker-return';
    case 'factoryRun.start': return before ? 'before-obligation-completion' : 'after-obligation-completion';
    default: return before ? 'before-durable-write' : 'after-durable-write';
  }
}

/** Build the full WP-13A scenario document of a durable-session project. */
export function buildScenarioDocument(descriptor, { pins } = {}) {
  const compiled = compileActorProgram(descriptor.scenario.program.steps, {
    seed: descriptor.scenario.seedInput.seed,
    pins: pins ?? actorPinSet(descriptor.scenario.seedInput.seed),
    allowedTools: descriptor.scenario.program.allowedTools,
  });
  const digests = projectIdentityDigests(descriptor.projectId);
  const doc = {
    formatVersion: SCENARIO_FORMAT_VERSION,
    identity: {
      protocolVersion: UNIVERSE_SCHEMA_VERSION,
      buildDigest: digests.buildDigest,
      packageDigest: digests.packageDigest,
      capsuleId: `capsule:${descriptor.projectId}`,
      capsuleDigest: digests.capsuleDigest,
    },
    seedInput: { fresh: true, seed: descriptor.scenario.seedInput.seed, ingress: descriptor.scenario.seedInput.ingress ?? [] },
    actorProgram: compiled.scenarioSteps,
    topology: descriptor.scenario.topology,
    faultSchedule: descriptor.scenario.faultSchedule,
    expectations: descriptor.scenario.expectations,
    verification: descriptor.scenario.verification,
    timeBudgets: descriptor.scenario.timeBudgets,
  };
  return { doc, compiled };
}

/* ------------------------------------------------------------------ */
/* Mode: durable-session                                               */
/* ------------------------------------------------------------------ */

/**
 * Run one durable-session project. Returns the check list, the invariant
 * probe context and the observed view of the golden (clean) run.
 */
export function runDurableSession(descriptor, mutations = {}) {
  const checks = [];
  const context = {};
  const seed = descriptor.scenario.seedInput.seed;
  const pins = actorPinSet(seed);
  const external = scenarioExternalEvidence();
  const admission = scenarioAdmission();

  let steps = descriptor.scenario.program.steps;
  if (mutations.tamperActorSteps) steps = mutations.tamperActorSteps(steps);
  const runDescriptor = { ...descriptor, scenario: { ...descriptor.scenario, program: { ...descriptor.scenario.program, steps } } };
  let expectations = descriptor.scenario.expectations;
  if (mutations.tamperExpectations) expectations = mutations.tamperExpectations(structuredClone(expectations));
  const scenarioDocDescriptor = { ...runDescriptor, scenario: { ...runDescriptor.scenario, expectations } };

  const { doc, compiled } = buildScenarioDocument(scenarioDocDescriptor, { pins });
  const inputs = mutations.tamperInputs ? mutations.tamperInputs(compiled.inputs) : compiled.inputs;
  const schedule = mutations.tamperFaultSchedule ? mutations.tamperFaultSchedule(structuredClone(descriptor.scenario.faultSchedule)) : descriptor.scenario.faultSchedule;
  const crashes = schedule.filter((entry) => entry.fault === 'crash-before-commit' || entry.fault === 'crash-after-event');

  checks.push(ok('program-compiles', `${inputs.length} kernel inputs compiled from ${steps.length} authored steps`));

  /* The clean golden run. */
  const goldenPath = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-golden`);
  const goldenSession = openScenarioSession(goldenPath);
  let golden;
  let drive;
  try {
    drive = driveScenarioOnSession(goldenSession, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
    golden = observedWorldView(goldenSession, inputs, external);
  } finally {
    goldenSession.close();
  }
  let goldenNormalized = null;
  const goldenWorld = () => {
    if (goldenNormalized !== null) return goldenNormalized;
    const session = openScenarioSession(goldenPath);
    try {
      goldenNormalized = scenarioNormalizedWorld(session, external);
      return goldenNormalized;
    } finally {
      session.close();
    }
  };

  if (drive.refusedAt !== null) {
    context.refusal = drive.outcomes[drive.refusedAt].refusal;
    context.refusedStepId = inputs[drive.refusedAt]?.idempotencyKey.replace(/^key:/, '');
  }

  /* Declared-vs-observed (the tamper-detecting layer). */
  const declared = compareDeclaredWithObserved(doc, golden, descriptor.drive.comparison?.expectationPolicies ?? {});
  checks.push(declared.equal
    ? ok('declared-expectations', 'every declared expectation section matches the observed world')
    : red('declared-expectations', declared.differences.map((difference) => difference.detail).join(' | ')));

  /* Reference-vs-observed (the WP-13A model comparison; a typed-refusal
     terminal has no clean reference comparison - the refusal IS the oracle,
     checked by the typed-refusal-family invariant). */
  if (drive.refusedAt === null) {
    const comparison = compareReferenceWithObserved(doc, golden, descriptor.drive.comparison?.referenceSections);
    checks.push(comparison.equal
      ? ok('reference-vs-observed', 'the pure reference model and the durable run agree on every declared section')
      : red('reference-vs-observed', comparison.differences.map((difference) => difference.detail).join(' | ')));
  } else {
    checks.push(ok('reference-vs-observed', `typed-refusal terminal (${String(context.refusal?.reason)}): the refusal is the oracle`));
  }

  /* Declared heads. */
  const heads = compareDeclaredHeads(descriptor.expectedWorld, golden);
  checks.push(heads.equal ? ok('declared-heads', `${descriptor.expectedWorld.heads.length} declared head(s) match`) : red('declared-heads', heads.problems.join(' | ')));

  /* Single armed crash: crash -> restart -> settle equal. */
  if (crashes.length === 1) {
    const entry = crashes[0];
    const point = crashPointOf(entry);
    const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-crash`);
    let crashed = null;
    const session = openScenarioSession(path);
    try {
      try {
        driveScenarioOnSession(session, inputs, {
          externalEvidence: external, admission,
          faults: new FaultScheduler(point, 1),
          scenarioFaults: [entry],
        });
      } catch (error) {
        crashed = error;
      }
    } finally {
      session.close();
    }
    const firedRight = crashed instanceof FaultCrashError && crashed.point === point;
    checks.push(firedRight
      ? ok('scheduled-crash-fired', `crashed exactly at the mapped registry point ${point}`)
      : red('scheduled-crash-fired', `expected FaultCrashError at ${point}, got ${crashed === null ? 'no crash' : String(crashed)}`));
    if (firedRight) {
      const restarted = openScenarioSession(path);
      try {
        const redrive = driveScenarioOnSession(restarted, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
        const settled = scenarioNormalizedWorld(restarted, external);
        context.settledWorldsEqualGolden = redrive.refusedAt === null && JSON.stringify(settled) === JSON.stringify(goldenWorld());
        context.exactlyOnceDetail = `crash at ${point}; the restart settled ${context.settledWorldsEqualGolden ? 'equal to' : 'DIVERGENT from'} the clean world`;
        checks.push(context.settledWorldsEqualGolden
          ? ok('crash-restart-settles-equal', `the ${point} crash settled to the clean-run world (exactly-once)`)
          : red('crash-restart-settles-equal', 'the restarted world diverges from the clean golden world'));
      } finally {
        restarted.close();
      }
    }
  }

  /* The crash matrix: one armed crash per entry (a schedule arming more
     than one crash is a matrix - one process dies once per execution). */
  if (crashes.length > 1) {
    const covered = [];
    const problems = [];
    for (const entry of crashes) {
      const point = crashPointOf(entry);
      const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-matrix-${point}`);
      let crashed = null;
      const session = openScenarioSession(path);
      try {
        try {
          driveScenarioOnSession(session, inputs, {
            externalEvidence: external, admission,
            faults: new FaultScheduler(point, 1),
            scenarioFaults: [entry],
          });
        } catch (error) {
          crashed = error;
        }
      } finally {
        session.close();
      }
      if (!(crashed instanceof FaultCrashError && crashed.point === point)) {
        problems.push(`${point}: expected FaultCrashError, got ${crashed === null ? 'no crash' : String(crashed)}`);
        continue;
      }
      const restarted = openScenarioSession(path);
      try {
        const redrive = driveScenarioOnSession(restarted, inputs, { externalEvidence: external, admission });
        const settled = scenarioNormalizedWorld(restarted, external);
        if (redrive.refusedAt === null && JSON.stringify(settled) === JSON.stringify(goldenWorld())) covered.push(point);
        else problems.push(`${point}: the restarted world diverges from the golden world`);
      } finally {
        restarted.close();
      }
    }
    context.matrixCoveredPoints = covered;
    context.matrixMissingPoints = FAULT_POINTS.filter((point) => !covered.includes(point));
    context.settledWorldsEqualGolden = problems.length === 0 && context.matrixMissingPoints.length === 0;
    checks.push(problems.length === 0
      ? ok('crash-matrix-settles-equal', `${covered.length}/${FAULT_POINTS.length} registry points crashed, restarted, settled equal`)
      : red('crash-matrix-settles-equal', problems.join(' | ')));
  }

  /* projection-wipe: a brand-new session must rehydrate the golden world. */
  if (schedule.some((entry) => entry.fault === 'projection-wipe')) {
    const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-wipe`);
    const first = openScenarioSession(path);
    try {
      driveScenarioOnSession(first, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
    } finally {
      first.close();
    }
    const second = openScenarioSession(path);
    try {
      const rehydrated = scenarioNormalizedWorld(second, external);
      context.projectionRehydrated = JSON.stringify(rehydrated) === JSON.stringify(goldenWorld());
      context.projectionRehydrateDetail = context.projectionRehydrated
        ? 'a brand-new session rehydrated the identical normalized world from ledger rows alone'
        : 'the rehydrated projection diverges from the clean-run world';
    } finally {
      second.close();
    }
    checks.push(context.projectionRehydrated ? ok('projection-wipe-rehydrates', context.projectionRehydrateDetail) : red('projection-wipe-rehydrates', context.projectionRehydrateDetail));
  }

  /* projection-stale-write: stage at the anchor, attempt a stale write. */
  const staleWrite = schedule.find((entry) => entry.fault === 'projection-stale-write');
  if (staleWrite !== undefined) {
    const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-stale`);
    const session = openScenarioSession(path);
    try {
      const staged = driveScenarioOnSession(session, inputs, {
        externalEvidence: external, admission,
        stopAfter: { command: staleWrite.anchor.command, instanceId: staleWrite.anchor.instanceId },
      });
      const before = scenarioNormalizedWorld(session, external);
      const anchorInput = inputs.find((input) => input.command === staleWrite.anchor.command && input.instanceId === staleWrite.anchor.instanceId);
      const stale = anchorInput === undefined ? null : { ...anchorInput, idempotencyKey: 'stale-projection-write', expectedRevision: (anchorInput.expectedRevision ?? 0) + 1 };
      let refusalOutcome = null;
      if (stale !== null) {
        const attempted = driveScenarioOnSession(session, [stale], { externalEvidence: external, admission });
        refusalOutcome = attempted.outcomes[0];
      }
      const after = scenarioNormalizedWorld(session, external);
      context.staleWriteRefused = refusalOutcome?.status === 'refused';
      context.staleWriteUnchanged = JSON.stringify(before) === JSON.stringify(after);
      checks.push(context.staleWriteRefused && context.staleWriteUnchanged && staged.refusedAt === null
        ? ok('stale-write-refused', 'the CAS fence refused the stale projection write and nothing changed')
        : red('stale-write-refused', `refused: ${String(context.staleWriteRefused)}; unchanged: ${String(context.staleWriteUnchanged)}`));
    } finally {
      session.close();
    }
  }

  /* The idempotency probes (the idempotency family). */
  if ((descriptor.expectedInvariants ?? []).includes('idempotent-replay-no-double-commit') && drive.refusedAt === null) {
    const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-redrive`);
    const session = openScenarioSession(path);
    try {
      driveScenarioOnSession(session, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
      const before = scenarioNormalizedWorld(session, external);
      const redrive = driveScenarioOnSession(session, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
      const after = scenarioNormalizedWorld(session, external);
      context.redriveUnchanged = redrive.refusedAt === null && JSON.stringify(before) === JSON.stringify(after);
      /* A verbatim re-issue under a fresh key at the pre-commit revision is
         refused by the CAS fence: a duplicate completion never double-commits. */
      const anchorInput = inputs.find((input) => input.command === 'workplace.recordContribution') ?? inputs[inputs.length - 1];
      const verbatim = { ...anchorInput, idempotencyKey: `${anchorInput.idempotencyKey}:verbatim-probe` };
      const attempted = driveScenarioOnSession(session, [verbatim], { externalEvidence: external, admission });
      context.verbatimReissueRefused = attempted.outcomes[0]?.status === 'refused';
      checks.push(context.redriveUnchanged ? ok('stateless-redrive-unchanged', 'a full re-drive changed nothing (every step skipped/replayed)') : red('stateless-redrive-unchanged', 'the re-drive diverged'));
      checks.push(context.verbatimReissueRefused ? ok('verbatim-reissue-refused', 'the verbatim re-issue under a fresh key was refused by the CAS fence') : red('verbatim-reissue-refused', 'the verbatim re-issue was not refused'));
    } finally {
      session.close();
    }
  }

  /* The determinism replay probe. */
  if ((descriptor.expectedInvariants ?? []).includes('determinism-replay') && drive.refusedAt === null) {
    const path = scenarioDatabasePath(`ek-corpus-${descriptor.projectId}-replay`);
    const session = openScenarioSession(path);
    try {
      driveScenarioOnSession(session, inputs, { externalEvidence: external, admission, scenarioFaults: schedule });
      const replay = scenarioNormalizedWorld(session, external);
      context.replayWorldEqual = JSON.stringify(replay) === JSON.stringify(goldenWorld());
      context.replayWorldDetail = context.replayWorldEqual
        ? 'a full re-run on a fresh database produced the identical normalized world'
        : 'the re-run diverged from the first run';
    } finally {
      session.close();
    }
    checks.push(context.replayWorldEqual ? ok('determinism-replay', context.replayWorldDetail) : red('determinism-replay', context.replayWorldDetail));
  }

  context.admittedAttemptCount = new Set(golden.world.evidence.filter((fact) => fact.kind === 'PromptAssemblyReceipt:admitted').map((fact) => fact.ref)).size;

  /* Product verification (the served-repair family delivers a real product
     even though its kernel drive is a durable-session program). */
  if (descriptor.product.verification !== 'none') {
    const productCheck = verifyProduct(descriptor.product);
    context.productResults = productCheck.results.map((result) => ({ label: result.label, code: result.code }));
    context.productBuildDigests = productCheck.buildDigests;
    checks.push(productCheck.ok
      ? ok('product-verified', `${productCheck.results.map((result) => result.label).join(' + ')} green (${productCheck.buildDigests[0] ?? 'no digest'})`)
      : red('product-verified', String(productCheck.failure)));
  }

  return { checks, context, observed: golden, scenarioDoc: doc };
}

/* ------------------------------------------------------------------ */
/* Mode: planning-conveyor                                             */
/* ------------------------------------------------------------------ */

const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const settlement = await import('../../../dist/workflow-kernel/planning/settlement.js');
const readiness = await import('../../../dist/workflow-kernel/planning/readiness.js');
const { topologyBindings } = await import('../../../dist/workflow-kernel/planning/bindings.js');

const conveyorWorldOf = (session) => session.hydrateWorld().world;

/** Run one planning-conveyor project over its declared topology. */
export async function runPlanningConveyor(descriptor) {
  const checks = [];
  const context = {};
  const topology = descriptor.drive.conveyorTopology;
  const facts = conveyor.factsForTopology(topology);
  const options = { ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() };
  const external = options.externalEvidence;

  const driveOnce = (session) => {
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology(topology, facts);
    const edges = conveyor.dependencyRowsOf(session);
    if (topology === 'failed-predecessor') {
      const a = conveyor.enterCell(session, cells[0], options);
      conveyor.admitCellIntent(session, a, edges, options);
      settlement.recordNodeTerminal(session, ids.process, [a.token], { externalEvidence: external, faults: options.faults });
      const b = conveyor.enterCell(session, cells[1], options);
      conveyor.admitCellIntent(session, b, edges, options, { waitForReadiness: true });
      /* The readiness boundary probe: while a is unaccepted, b is not ready
         and its gaps are typed (D7: never a silent block). */
      const bReadiness = readiness.evaluateReadiness(edges, topologyBindings(conveyorWorldOf(session)), b.itemInstanceId);
      context.readinessBoundaryIntact = bReadiness.state !== 'ready';
      context.readinessBoundaryDetail = `dependant readiness while the predecessor is unaccepted: ${bReadiness.state}${bReadiness.gaps ? ` (typed gaps: ${bReadiness.gaps.map((gap) => gap.reason).join(', ')})` : ''}`;
      conveyor.runDesk(session, a, 'truthful-failure', options);
      conveyor.settleDependantUnreachable(session, b, options);
      conveyor.settleFailureLadder(session, ids, a, options, false);
      return { ids, cells };
    }
    for (const cell of cells) {
      const entered = conveyor.enterCell(session, cell, options);
      conveyor.admitCellIntent(session, entered, edges, options);
      conveyor.runDesk(session, entered, 'success', options);
      conveyor.settleCellNode(session, ids, entered, options);
    }
    conveyor.settleSuccessLadder(session, ids, options);
    return { ids, cells };
  };

  const db = corpusDatabase(`ek-corpus-${descriptor.projectId}-`);
  const session = await db.open();
  let view;
  try {
    driveOnce(session);
    view = observedWorldView(session, [], undefined);

    /* The drain-closed probe: at a fully settled run the claimable frontier
       is empty (per-application lane rows may stay open behind their
       completed FIFO heads - that is the drain law, not a leak). */
    if ((descriptor.expectedInvariants ?? []).includes('no-open-terminal-drain-obligations')) {
      const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
      /* Only CLAIMABLE rows count (an unresolvable row carries its typed
         refusal and is a lane artifact, not an open drain). */
      const frontier = consumer.openFrontier(session).filter((entry) => entry.claim !== undefined);
      context.drainClosed = frontier.length === 0;
      context.drainClosedDetail = frontier.length === 0
        ? 'the claimable frontier is empty at settlement (drain closed)'
        : `claimable frontier rows remain: ${frontier.map((entry) => entry.kind).join(', ')}`;
    }

    const declared = compareDeclaredWithObserved({ expectations: descriptor.scenario.expectations }, view, descriptor.drive.comparison?.expectationPolicies ?? {});
    checks.push(declared.equal
      ? ok('declared-expectations', 'every declared expectation section matches the observed conveyor world')
      : red('declared-expectations', declared.differences.map((difference) => difference.detail).join(' | ')));
    const heads = compareDeclaredHeads(descriptor.expectedWorld, view);
    checks.push(heads.equal ? ok('declared-heads', `${descriptor.expectedWorld.heads.length} declared head(s) match`) : red('declared-heads', heads.problems.join(' | ')));

    if (descriptor.projectKind === 'cross-module') {
      const kinds = new Set(view.world.evidence.map((fact) => fact.kind));
      const seams = facts.integrationSeams.length;
      const evidenceOk = kinds.has('SeamOwnership') && kinds.has('ConstructionSurface') && seams > 0;
      /* Seam consumption: after full settlement the forward observed graph
         equals the declared planning graph (WP-09), i.e. every declared
         seam edge was consumed as predecessor acceptance evidence. */
      const observedGraphs = await import('../../../dist/workflow-kernel/planning/observed-graphs.js');
      const edges = conveyor.dependencyRowsOf(session);
      const graph = observedGraphs.compareGraphs(
        observedGraphs.forwardObservedGraph(view.world, edges),
        observedGraphs.declaredPlanningGraph(edges),
      );
      checks.push(evidenceOk && graph.equal
        ? ok('cross-module-seams', `${seams} declared integration seam(s); SeamOwnership + ConstructionSurface recorded; the observed consumption graph equals the declared graph (${graph.edgeCount} edges)`)
        : red('cross-module-seams', `evidence: SeamOwnership=${String(kinds.has('SeamOwnership'))} ConstructionSurface=${String(kinds.has('ConstructionSurface'))} seams=${seams}; graph equal=${String(graph.equal)} (${JSON.stringify(graph.divergences ?? [])})`));
    }
  } finally {
    session.close();
  }

  if ((descriptor.expectedInvariants ?? []).includes('determinism-replay')) {
    const second = corpusDatabase(`ek-corpus-${descriptor.projectId}-replay-`);
    const session2 = await second.open();
    try {
      driveOnce(session2);
      const secondView = observedWorldView(session2, [], undefined);
      context.replayWorldEqual = JSON.stringify(secondView.summary.proofs) === JSON.stringify(view.summary.proofs)
        && JSON.stringify(secondView.summary.heads) === JSON.stringify(view.summary.heads);
      context.replayWorldDetail = context.replayWorldEqual
        ? 'the replayed conveyor run produced the identical normalized proofs and heads'
        : 'the replayed conveyor run diverged';
    } finally {
      session2.close();
    }
    checks.push(context.replayWorldEqual ? ok('determinism-replay', context.replayWorldDetail) : red('determinism-replay', context.replayWorldDetail));
  }

  /* Product verification for the batch/static product families driven by
     conveyor projects (the products verify independently of the kernel). */
  if (descriptor.product.verification !== 'none') {
    const productCheck = verifyProduct(descriptor.product);
    context.productResults = productCheck.results.map((result) => ({ label: result.label, code: result.code }));
    context.productBuildDigests = productCheck.buildDigests;
    checks.push(productCheck.ok ? ok('product-verified', `${productCheck.results.map((result) => result.label).join(' + ')} green`) : red('product-verified', String(productCheck.failure)));
  }

  return { checks, context, observed: view };
}

/* ------------------------------------------------------------------ */
/* Mode: development-vertical                                          */
/* ------------------------------------------------------------------ */

/** The chain-gate verifier of one product family. */
async function chainGateVerifier(descriptor) {
  const support = await import('../../../tests/workflow-kernel/development/support.mjs');
  if (descriptor.product.fixture === 'simple-server') return support.productVerifier();
  /* The corpus static/batch fixtures: build + their own structure hook on
     a temp copy (no server - the static/batch families have no runtime). */
  return async () => {
    const staged = stageFixtureWorkspace(descriptor.product.fixture);
    try {
      const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: staged.workspace, encoding: 'utf8' });
      if ((build.status ?? -1) !== 0) return { ok: false, detail: `build failed: ${String(build.stderr)}`, digest: 'build' };
      const hook = descriptor.product.fixture === 'static-site'
        ? spawnSync(process.execPath, ['verify/structure.mjs'], { cwd: staged.workspace, encoding: 'utf8' })
        : { status: 0, stdout: 'batch product: determinism is the gate (checked by the driver)' };
      if ((hook.status ?? -1) === 0) return { ok: true, detail: `${descriptor.product.fixture} product gate green`, digest: 'gate' };
      return { ok: false, detail: String(hook.stderr ?? 'gate failed'), digest: 'gate' };
    } finally {
      staged.dispose();
    }
  };
}

/** Run one development-vertical project (capsule ingress + material chain). */
export async function runDevelopmentVertical(descriptor) {
  const checks = [];
  const context = {};
  const support = await import('../../../tests/workflow-kernel/development/support.mjs');
  const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');
  const chain = await import('../../../dist/workflow-kernel/development/material-chain.js');

  const db = corpusDatabase(`ek-corpus-${descriptor.projectId}-`);
  const session = await db.open();
  let view;
  try {
    const capsule = await support.buildCapsuleFixture();
    const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(support.CAPSULE_BYTES), {
      expectedLineageId: support.LINEAGE.lineageId,
      expectedParentLifecycleRef: support.LINEAGE.parentLifecycleRef,
    });
    checks.push(imported.imported
      ? ok('capsule-ingress', `imported through the WP-08 public ingress (${imported.ingressReceiptRef})`)
      : red('capsule-ingress', `ingress refused: ${JSON.stringify(imported)}`));
    if (!imported.imported) return { checks, context, observed: null };

    const { runtime, authorLaunchKind, reviewerLaunchKind } = await support.roleRuntime();
    runtime.resolveOnce(authorLaunchKind);
    runtime.resolveOnce(reviewerLaunchKind);
    const task = await support.taskManifest();
    const { transport } = await support.sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2', 'activity-attempt:3'] });
    const config = {
      session,
      roles: runtime,
      authorLaunchKind,
      reviewerLaunchKind,
      transport,
      taskSummary: descriptor.description,
      requiredInfo: task,
      verifyProduct: await chainGateVerifier(descriptor),
      externalEvidence: chain.externalInputEvidence(`sha256:${support.sha256(descriptor.projectId)}`, true),
    };
    const run = await chain.driveDevelopmentVertical(config, {
      authorScript: await support.authorScript(),
      reviewerScript: await support.reviewerScript('accepted'),
    });
    const refusedSteps = run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused');
    checks.push(run.blockedAt === undefined && refusedSteps.length === 0
      ? ok('material-chain', `the vertical settled (${run.steps.length} steps, no refusal)`)
      : red('material-chain', `blocked at ${String(run.blockedAt)}: ${JSON.stringify(refusedSteps.map((step) => ({ step: step.step, result: step.result })))}`));

    view = observedWorldView(session, [], undefined);
    const declared = compareDeclaredWithObserved({ expectations: descriptor.scenario.expectations }, view, descriptor.drive.comparison?.expectationPolicies ?? {});
    checks.push(declared.equal
      ? ok('declared-expectations', 'every declared expectation section matches the observed material-chain world')
      : red('declared-expectations', declared.differences.map((difference) => difference.detail).join(' | ')));
    const heads = compareDeclaredHeads(descriptor.expectedWorld, view);
    checks.push(heads.equal ? ok('declared-heads', `${descriptor.expectedWorld.heads.length} declared head(s) match`) : red('declared-heads', heads.problems.join(' | ')));
  } finally {
    session.close();
  }

  /* The corpus product check (the simple-server pattern on a temp copy). */
  if (descriptor.product.verification !== 'none') {
    const productCheck = verifyProduct(descriptor.product);
    context.productResults = productCheck.results.map((result) => ({ label: result.label, code: result.code }));
    context.productBuildDigests = productCheck.buildDigests;
    checks.push(productCheck.ok ? ok('product-verified', `${productCheck.results.map((result) => result.label).join(' + ')} green (${productCheck.buildDigests[0] ?? 'no digest'})`) : red('product-verified', String(productCheck.failure)));
  }

  return { checks, context, observed: view };
}

export { FAULT_POINTS };
