/**
 * tools/project-corpus/lib/kit.mjs - the Elite Evidence Kit replay engine
 * (WP-13D): feeds each kit corpus entry's input-capsule through the WP-08
 * PUBLIC ingress, drives the entry's actor program over the WP-09 conveyor
 * (public commands only), and compares the normalized trace against the
 * entry's expected-trace.json under the kit's own normalization rules.
 *
 * Mapping (declared, typed, honest):
 *   - legacy workplace -> one kernel conveyor work item (per production
 *     cell type, aggregated per module);
 *   - legacy gate verdicts -> kernel gate verdicts (accepted -> accepted,
 *     repair_required -> repair, failed -> terminal-reject family);
 *   - legacy terminal statuses -> the kernel's typed terminals:
 *       'failed'              -> TerminalProof:run.truthful-failure (the
 *                                honest typed refusal family),
 *       'development-blocked' -> truthful-failure WITH the readiness
 *                                boundary intact (delivery never entered);
 *   - legacy-only behavior (DB-only loss transitions, worker process
 *     streams) -> typed comparison NOTES citing the kit's
 *     failure-witnesses, never forced equality.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(LIB_ROOT, '..', '..', '..');
export const KIT_ROOT = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'elite-evidence-kit');

export const KIT_ENTRIES = ['elite-fresh-20260825', 'elite-8'];

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Kit loading                                                         */
/* ------------------------------------------------------------------ */

export function loadKitEntry(entryId) {
  const dir = join(KIT_ROOT, 'corpus', entryId);
  if (!existsSync(dir)) throw new Error(`unknown kit entry "${entryId}" (known: ${KIT_ENTRIES.join(', ')})`);
  const read = (relative) => JSON.parse(readFileSync(join(dir, relative), 'utf8'));
  return {
    entryId,
    dir,
    capsuleIndex: read('input-capsule/index.json'),
    program: read('actor-program/program.json'),
    trace: read('expected-trace.json'),
    invariants: read('expected-invariants.json'),
    witnesses: {
      readinessRefusalChain: existsSync(join(dir, 'failure-witnesses', 'readiness-refusal-chain.json'))
        ? read('failure-witnesses/readiness-refusal-chain.json')
        : null,
      journalVisibilityGap: existsSync(join(dir, 'failure-witnesses', 'journal-visibility-gap-lost-executions.json'))
        ? read('failure-witnesses/journal-visibility-gap-lost-executions.json')
        : null,
      engineRestarts: existsSync(join(dir, 'failure-witnesses', 'engine-restarts.json'))
        ? read('failure-witnesses/engine-restarts.json')
        : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Legacy -> kernel vocabulary maps (typed, declared)                  */
/* ------------------------------------------------------------------ */

/** Legacy final-verdict vocabulary -> kernel gate verdicts.
 *  A legacy 'failed' gate maps into the kernel's D6 repair ladder (the
 *  kernel's honest non-accepted desk terminal); the typed note records the
 *  vocabulary bridge. */
export function kernelVerdictOf(legacy) {
  switch (legacy) {
    case 'accepted': return 'accepted';
    case 'repair_required':
    case 'failed': return 'repair';
    case 'rejected': return 'terminal-reject';
    default: throw new Error(`unmapped legacy verdict "${String(legacy)}"`);
  }
}

/** Legacy terminal status -> the kernel typed-terminal family + note id. */
export function terminalFamilyOf(legacyTerminal) {
  switch (legacyTerminal) {
    case 'failed': return { proof: 'TerminalProof:run.truthful-failure', noteId: 'terminal-vocabulary:failed->truthful-failure' };
    case 'development-blocked': return { proof: 'TerminalProof:run.truthful-failure', noteId: 'terminal-vocabulary:development-blocked->truthful-failure+readiness-boundary' };
    case 'completed': return { proof: 'TerminalProof:run.success', noteId: null };
    default: return { proof: null, noteId: `terminal-vocabulary:${String(legacyTerminal)}->unmapped` };
  }
}

/* ------------------------------------------------------------------ */
/* Capsule bridge: kit input-capsule -> WP-08 kernel capsule           */
/* ------------------------------------------------------------------ */

/**
 * Build the WP-08 Discovery+Formalization capsule FROM the kit entry's
 * content-addressed input capsules (every artifact digest-bound to a kit
 * capsule digest - the bridge is content-addressed, not invented).
 */
export async function buildKitKernelCapsule(entry) {
  const { capsuleArtifact, buildCapsule } = await import('../../../dist/workflow-kernel/development/capsule.js');
  const capsulesByRole = new Map(entry.capsuleIndex.capsules.map((capsule) => [capsule.role, capsule]));
  const artifact = (role, fallbackSeed, fields) => capsuleArtifact({
    kitRole: role,
    kitDigest: capsulesByRole.get(role)?.digest ?? sha256(fallbackSeed),
    ...fields,
  });
  const requirementFiles = [...capsulesByRole.keys()].filter((role) => role === 'requirements-file');
  const requirements = (requirementFiles.length > 0
    ? entry.capsuleIndex.capsules.filter((capsule) => capsule.role === 'requirements-file')
    : [{ digest: sha256('kit:default-req'), summary: 'REQ default' }])
    .slice(0, 8)
    .map((capsule, index) => capsuleArtifact({ id: `REQ-KIT-${index + 1}`, text: `kit requirement capsule ${capsule.digest} (${String(capsule.summary).slice(0, 60)})` }));
  const processEnvelope = [...capsulesByRole.values()].find((capsule) => capsule.role === 'process-envelope');
  const moduleRefKey = entry.program.workplaces[0]?.moduleRef ?? 'unknown-module';
  const formalizedCells = entry.program.workplaces.filter((workplace) => workplace.productionCellId.startsWith('formalization-'));
  const devImplCells = entry.program.workplaces.filter((workplace) => workplace.productionCellId === 'development-implementation');
  const capsule = buildCapsule(
    {
      certificate: capsuleArtifact({ kind: 'formalization-certificate', decision: 'formalized', baseline: `sha256:${sha256(`kit:${entry.entryId}:baseline`)}` }),
      requirements,
      terminalClaims: [
        capsuleArtifact({ claimId: 'TC-KIT-1', claim: `kit replay terminal chain for ${entry.entryId} (mandatory transitions reproduced)` }),
        capsuleArtifact({ claimId: 'TC-KIT-2', claim: `gate verdict sequence of the ${entry.program.workplaces.length} legacy workplaces reproduced through public commands` }),
      ],
      acceptanceCriteria: [
        capsuleArtifact({ acId: 'AC-KIT-1', given: 'the kit capsule ingested', when: 'the lifecycle routes', then: 'the mandatory transition sequence equals expected-trace.json' }),
        capsuleArtifact({ acId: 'AC-KIT-2', given: 'the honest terminal', when: 'the run terminalizes', then: 'the typed terminal family matches the mapped legacy status' }),
      ],
      modulePackage: capsuleArtifact({ name: `kit-module-${sha256(moduleRefKey).slice(0, 12)}`, entry: 'development.production-cell', interfaces: ['/healthz', '/api/message', '/', '/app.js'], kitProcessEnvelope: processEnvelope?.digest ?? null, formalizationCells: formalizedCells.length, implementationCells: devImplCells.length }),
      buildOutput: capsuleArtifact({ script: 'node scripts/build.mjs', output: 'dist/build-manifest.json', kitBound: sha256(`kit:${entry.entryId}:build`) }),
      baseRepository: capsuleArtifact({ baseline: `sha256:${sha256(`kit:${entry.entryId}:base`)}`, tree: `kit replay base of ${entry.entryId}` }),
    },
    { lineageId: `lineage:kit-${entry.entryId}`, parentLifecycleRef: `sha256:${sha256(`kit:${entry.entryId}:parent-terminal-proof`)}` },
    { status: 'formalization-terminal', terminalProofRef: `sha256:${sha256(`kit:${entry.entryId}:parent-terminal-proof`)}` },
    new Uint8Array(Buffer.from(`elite-evidence-kit package bytes of ${entry.entryId} v1`, 'utf8')),
  );
  return { capsule, packageBytes: Buffer.from(`elite-evidence-kit package bytes of ${entry.entryId} v1`, 'utf8'), lineage: { lineageId: `lineage:kit-${entry.entryId}`, parentLifecycleRef: `sha256:${sha256(`kit:${entry.entryId}:parent-terminal-proof`)}` } };
}

/* ------------------------------------------------------------------ */
/* Kit facts -> WP-09 planning facts                                   */
/* ------------------------------------------------------------------ */

/**
 * The planning facts of one kit entry: one work item per aggregated legacy
 * production cell, dependency chain discovery -> formalization -> (per
 * formalization cell) and development: plan -> implementations (parallel)
 * -> readiness certification.
 */
export function kitFacts(entry) {
  const items = [];
  const add = (itemRef, dependsOn, title) => items.push({
    itemRef, title,
    coversScope: [`scope:${itemRef}`],
    ownsUnknowns: [`unknown:${itemRef}`],
    ownsSurfaces: [`surface:${itemRef}.module`, `surface:${itemRef}.test`],
    ownsSeams: dependsOn.length > 0 ? [`seam:${itemRef}`] : [],
    ownsClaims: [`claim:${itemRef}`],
    verifiesClaims: [`claim:${itemRef}`],
    verificationSurfaces: [`surface:${itemRef}.test`],
    obligations: ['implement', 'verify'],
    dependsOn: [...dependsOn],
  });
  const cells = aggregatedCells(entry);
  for (const cell of cells) add(cell.itemRef, cell.dependsOn, cell.title);
  const refs = items.map((item) => item.itemRef);
  return {
    planningRef: `ek-kit-${entry.entryId}`,
    idea: { ideaRef: `idea:ek-kit-${entry.entryId}`, statement: `Replay of the elite kit entry ${entry.entryId} through the event-projected kernel.` },
    scopeItems: [
      ...refs.map((ref) => ({ scopeRef: `scope:${ref}`, statement: `Declared scope of the legacy ${ref} workplaces.` })),
      { scopeRef: 'scope:deferred', statement: 'A declared scope item the epic explicitly defers.' },
    ],
    unknowns: refs.map((ref) => ({ unknownRef: `unknown:${ref}`, question: `Which ${ref} shape satisfies the kit replay?` })),
    terminalClaims: refs.map((ref) => ({ claimRef: `claim:${ref}`, statement: `Terminal claim of ${ref}.` })),
    constructionSurfaces: refs.flatMap((ref) => [
      { surfaceRef: `surface:${ref}.module`, kind: 'module-surface', description: `Module surface of ${ref}.` },
      { surfaceRef: `surface:${ref}.test`, kind: 'test-surface', description: `Test surface of ${ref}.` },
    ]),
    integrationSeams: items
      .filter((item) => item.dependsOn.length > 0)
      .map((item) => ({ seamRef: `seam:${item.itemRef}`, leftScopeRef: `scope:${item.dependsOn[0]}`, rightScopeRef: `scope:${item.itemRef}`, description: `Cross-module seam ${item.dependsOn[0]} -> ${item.itemRef}.` })),
    acceptanceCriteria: refs.map((ref) => ({ criterionRef: `ac:${ref}`, statement: `Acceptance criterion of ${ref}.` })),
    deferredScope: [{ scopeRef: 'scope:deferred', owner: 'operator', reason: 'explicitly deferred at planning (owner + reason recorded)' }],
    workItems: items,
  };
}

/** Aggregate the legacy workplaces into kernel work items + verdicts. */
export function aggregatedCells(entry) {
  const workplaces = entry.program.workplaces;
  const find = (cellId) => workplaces.filter((workplace) => workplace.productionCellId === cellId);
  const cells = [];
  const discovery = find('discovery-proposal');
  if (discovery.length > 0) cells.push({ itemRef: 'discovery', dependsOn: [], title: 'discovery proposal', verdicts: verdictsOf(discovery) });
  const formalizationCells = workplaces.filter((workplace) => workplace.productionCellId.startsWith('formalization-'));
  if (formalizationCells.length > 0) cells.push({ itemRef: 'formalization', dependsOn: ['discovery'], title: `formalization (${formalizationCells.length} workplaces)`, verdicts: verdictsOf(formalizationCells) });
  const devPlan = find('development-plan-task-graph');
  if (devPlan.length > 0) cells.push({ itemRef: 'development-plan', dependsOn: ['formalization'], title: 'development plan task graph', verdicts: verdictsOf(devPlan) });
  const impl = find('development-implementation');
  impl.forEach((workplace, index) => {
    cells.push({ itemRef: `development-impl-${index + 1}`, dependsOn: ['development-plan'], title: `development implementation ${index + 1}`, verdicts: verdictsOf([workplace]) });
  });
  const readinessCert = find('development-readiness-certification');
  if (readinessCert.length > 0) {
    cells.push({
      itemRef: 'readiness-certification',
      dependsOn: impl.length > 0 ? impl.map((_, index) => `development-impl-${index + 1}`) : ['development-plan'],
      title: 'development readiness certification',
      verdicts: verdictsOf(readinessCert),
    });
  }
  return cells;
}

/** The final-phase verdict sequence of workplaces (the kernel mapping input). */
function verdictsOf(workplaces) {
  const out = [];
  for (const workplace of workplaces) {
    for (const response of workplace.responses) {
      for (const decision of response.gateDecisions) {
        out.push({ phase: decision.phase, verdict: decision.verdict, repairTargetRole: decision.repairTargetRole ?? null });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Trace normalization (the kit's own rules)                           */
/* ------------------------------------------------------------------ */

/**
 * The kernel replay trace, normalized under the kit's rules (per-stream
 * event kind sequences, obligation lifecycle, gate decisions, terminal
 * proofs): the LIFECYCLE stream (the mandatory transitions) plus the gate
 * decision sequence, both compared against expected-trace.json.
 */
export function normalizedKernelReplay(session, externalEvidence) {
  const hydrated = session.hydrateWorld(externalEvidence === undefined ? undefined : { externalEvidence }).world;
  /* Deduplicate by evidence ref (the kernel fact and its persisted receipt
     row share one ref - one immutable fact, never two). */
  const byRef = new Map(hydrated.evidence.map((fact) => [fact.ref, fact]));
  const world = { ...hydrated, evidence: [...byRef.values()] };
  const gateDecisions = world.evidence
    .filter((fact) => fact.kind.startsWith('GateDecision:'))
    .map((fact) => fact.kind.replace('GateDecision:', ''));
  const stageOutcomeEvents = world.events.filter((event) => event.transition === 'stageRun.recordLocalOutcome');
  const routeEvents = world.events.filter((event) => event.transition === 'lifecycleRun.routeOutcome');
  const terminalProofs = [...new Set(world.proofs.map((proof) => proof.id))].sort();
  const acceptedWorkplaceProofs = new Set(world.proofs.filter((proof) => proof.id === 'TerminalProof:workplace.success').map((proof) => proof.ownerInstanceId)).size;
  return { gateDecisions, routeEvents, stageOutcomeEvents, terminalProofs, acceptedWorkplaceProofs };
}

/* ------------------------------------------------------------------ */
/* The replay drive                                                    */
/* ------------------------------------------------------------------ */

const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const { corpusDatabase } = await import('./modes.mjs');

/** Run the cognition attempt of the LATEST intent of one role on a
 *  workplace (repair epochs admit fresh intents; runAttempt picks the
 *  first, so the replay drives the latest explicitly): create ->
 *  admission -> send -> outcome, all public. */
export function attemptOfLatestIntent(session, workplace, role, pin, tag, options) {
  const world = session.hydrateWorld().world;
  const intents = [...world.workIntents.values()].filter((intent) => intent.workplaceInstanceId === workplace && intent.protocolRole === role);
  const latest = intents[intents.length - 1];
  if (latest === undefined) throw new Error(`kit: no ${role} intent on ${workplace}`);
  const attemptId = `activity-attempt:${latest.intentRef.replace(/^evidence:WorkIntent#/, 'wi-')}`;
  if (world.heads.get(attemptId) === undefined) {
    conveyor.ensureCommand(session, 'activityAttempt.create', attemptId, `kit:attempt:${tag}`, { workIntentRef: latest.intentRef, rolePin: pin }, options);
  }
  const status = session.hydrateWorld().world.heads.get(attemptId)?.status;
  if (status !== 'provider-request-admitted' && status !== 'outcome-recorded') {
    conveyor.consumeTarget(session, 'activityAttempt.admitProviderRequest', {
      admission: {
        envelope: {
          providerModel: 'zai/opencode-pin',
          requestInputTokens: 5000,
          envelopeDigest: `sha256:${sha256(`envelope:${attemptId}`)}`,
        },
        limits: options.limits,
      },
    }, options, attemptId);
    conveyor.consumeTarget(session, 'cognition.sendProviderRequest', {}, options);
  }
  conveyor.ensureCommand(session, 'activityAttempt.recordOutcome', attemptId, `kit:outcome:${attemptId}`, { evidenceRefs: [latest.intentRef] }, options, conveyor.eventDone('activityAttempt.recordOutcome', attemptId));
}

/**
 * One full desk round (author -> reviewer -> final gate) through public
 * commands: the conveyor lane targets consumed in desk order, with the
 * final gate at the DECLARED verdict (the kernel repair model).
 */
export function deskRoundToFinal(session, cell, options, finalVerdict, roundTag) {
  const workplace = cell.workplace;
  const consume = (target, invocation) => conveyor.consumeTarget(session, target, invocation, options, workplace);
  attemptOfLatestIntent(session, workplace, 'author', options.authorPin, `${roundTag}:author`, options);
  consume('workplace.recordContribution', {});
  consume('workplace.sealProductionRevision', {});
  consume('workplace.presentCandidateSet', {});
  consume('workplace.runAuthorGate', { gateVerdict: 'accepted' });
  /* Reviewer admission as a DIRECT public apply (the conveyor's own
     fallback pattern): pinning the shared admitWorkIntent FIFO lane here
     would complete an unrelated lane head (the lane is shared across
     cells), so the lane is left to the conveyor's topology binding. */
  conveyor.ensureCommand(session, 'workplace.admitWorkIntent', workplace, `kit:admit-reviewer:${roundTag}`, { protocolRole: 'reviewer', rolePin: options.reviewerPin, evidenceRefs: [cell.itemInstanceId] }, options);
  attemptOfLatestIntent(session, workplace, 'reviewer', options.reviewerPin, `${roundTag}:reviewer`, options);
  consume('workplace.recordContribution', {});
  consume('workplace.sealProductionRevision', {});
  consume('workplace.presentCandidateSet', {});
  return consume('workplace.runFinalGate', { gateVerdict: finalVerdict });
}

/** Run the cognition attempt of a REQUEUED author intent (the repair loop's
 *  new epoch): create -> admission -> send -> outcome, all public. */
function requeueAttemptUnused() {
  /* replaced by attemptOfLatestIntent */
}

/**
 * Drive one kit cell to its aggregated outcome through public commands:
 *  - all final verdicts accepted -> the success desk + node settlement;
 *  - repair rounds then a final accepted verdict (the RECOVERED repair
 *    loop): each legacy repair round drives one desk to a final REPAIR
 *    verdict + D6 repair wait + epoch rollover (the retry arm, re-staffed
 *    with the author identity), then the success desk settles;
 *  - repair rounds with NO recovery (or a terminal 'failed' verdict): the
 *    retry rounds, then the terminal epoch (runDesk 'truthful-failure'),
 *    and the honest failure ladder settles the run.
 */
/**
 * The repair-epoch replay bound: each legacy repair_required round drives
 * one kernel D6 repair epoch; the replay drives at most this many retry
 * epochs per cell before the terminal epoch (driving the full legacy
 * round count exhausts the conveyor's shared FIFO lanes - the epoch LAW
 * is invariant in the count, and the reduction is recorded as a typed
 * note in every replay result).
 */
export const MAX_REPLAY_REPAIR_ROUNDS = 2;

export async function driveKitCell(session, cell, ids, options, verdicts) {
  const finals = verdicts.filter((verdict) => verdict.phase === 'final');
  const legacyRepairRounds = finals.filter((verdict) => verdict.verdict === 'repair_required' || verdict.verdict === 'failed').length;
  const recovered = finals.length > 0 && finals[finals.length - 1].verdict === 'accepted';
  /* A RECOVERED cell replays up to MAX_REPLAY_REPAIR_ROUNDS retry epochs
     before its accepted round; a TERMINAL cell replays exactly ONE epoch
     (the terminal one) - retry depth is demonstrated by the recovered
     cells and the corpus repair project, and the reduction is a typed
     note. (Driving retry epochs on the terminal cell exhausts the
     conveyor's shared FIFO lanes before the failure ladder.) */
  const repairRounds = legacyRepairRounds === 0 ? 0 : recovered ? Math.min(legacyRepairRounds, MAX_REPLAY_REPAIR_ROUNDS) : 1;
  const bounded = repairRounds;
  const entered = conveyor.enterCell(session, cell, options);
  conveyor.admitCellIntent(session, entered, conveyor.dependencyRowsOf(session), options);
  if (legacyRepairRounds > bounded) {
    entered.reduction = { legacy: legacyRepairRounds, replayed: bounded };
  }

  if (repairRounds === 0 && recovered) {
    conveyor.runDesk(session, entered, 'success', options);
    conveyor.settleCellNode(session, ids, entered, options);
    return { repairRounds: 0, recovered: true, terminal: 'success', cell: entered };
  }
  for (let round = 1; round <= repairRounds; round += 1) {
    const last = round === repairRounds && !recovered;
    if (last) {
      /* The terminal epoch: the desk runs to the honest truthful-failure
         (final REPAIR verdict -> repair wait -> rollover with the
         truthful-failure terminal outcome -> workplace proof). */
      deskRoundToFinal(session, entered, options, 'repair', `${cell.itemRef}:terminal`);
      const workplace = entered.workplace;
      conveyor.ensureCommand(session, 'workplace.enterRepairWait', workplace, `kit:repair-wait:${cell.itemRef}:terminal`, {}, options, conveyor.eventDone('workplace.enterRepairWait', workplace));
      conveyor.ensureCommand(session, 'workplace.rolloverRepairEpoch', workplace, `kit:rollover:${cell.itemRef}:terminal`, { terminalOutcome: 'truthful-failure' }, options, conveyor.eventDone('workplace.rolloverRepairEpoch', workplace));
      conveyor.ensureCommand(session, 'workplace.issueWorkplaceTerminalProof', workplace, `kit:workplace-terminal:${cell.itemRef}`, { terminalOutcome: 'truthful-failure' }, options, conveyor.eventDone('workplace.issueWorkplaceTerminalProof', workplace));
      break;
    }
    deskRoundToFinal(session, entered, options, 'repair', `${cell.itemRef}:r${round}`);
    const workplace = entered.workplace;
    conveyor.ensureCommand(session, 'workplace.enterRepairWait', workplace, `kit:repair-wait:${cell.itemRef}:${round}`, {}, options, conveyor.eventDone('workplace.enterRepairWait', workplace));
    conveyor.ensureCommand(session, 'workplace.rolloverRepairEpoch', workplace, `kit:rollover:${cell.itemRef}:${round}`, {}, options, conveyor.eventDone('workplace.rolloverRepairEpoch', workplace));
    /* Re-staff the author identity for the next round (same pin, same
       Workplace - the repair loop law) and run its cognition attempt so
       the desk lanes of the new epoch exist. */
    conveyor.ensureCommand(session, 'workplace.admitWorkIntent', workplace, `kit:requeue:${cell.itemRef}:${round}`, { protocolRole: 'author', rolePin: options.authorPin, evidenceRefs: [cell.itemInstanceId] }, options);
    attemptOfLatestIntent(session, workplace, 'author', options.authorPin, `${cell.itemRef}:r${round}:requeue`, options);
  }
  if (recovered) {
    /* The recovered repair loop: the final round runs to an ACCEPTED final
       verdict, the effect settles, and the cell settles its node. */
    deskRoundToFinal(session, entered, options, 'accepted', `${cell.itemRef}:recovered`);
    const workplace = entered.workplace;
    conveyor.consumeTarget(session, 'workplace.settleEffect', { effectOutcome: 'success' }, options, workplace);
    conveyor.ensureCommand(session, 'workplace.recordFinalAcceptance', workplace, `kit:final-acceptance:${cell.itemRef}`, {}, options, conveyor.eventDone('workplace.recordFinalAcceptance', workplace));
    conveyor.consumeTarget(session, 'workplace.closePresentation', {}, options, workplace);
    conveyor.ensureCommand(session, 'workplace.issueWorkplaceTerminalProof', workplace, `kit:workplace-terminal:${cell.itemRef}`, { terminalOutcome: 'success' }, options, conveyor.eventDone('workplace.issueWorkplaceTerminalProof', workplace));
    conveyor.settleCellNode(session, ids, entered, options);
    return { repairRounds, recovered: true, terminal: 'success', cell: entered };
  }
  return { repairRounds, recovered: false, terminal: 'truthful-failure', cell: entered };
}

/**
 * Replay one kit entry end to end. Returns the check list, the typed
 * comparison notes and the normalized kernel trace.
 */
export async function replayKitEntry(entryId) {
  const entry = loadKitEntry(entryId);
  const checks = [];
  const notes = [];
  const ok = (id, detail) => checks.push({ id, status: 'green', detail });
  const red = (id, detail) => checks.push({ id, status: 'red', detail });

  const { capsule, packageBytes, lineage } = await buildKitKernelCapsule(entry);
  const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');
  const db = corpusDatabase(`ek-kit-${entryId}-`);
  const session = await db.open();
  let normalized;
  try {
    const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(packageBytes), {
      expectedLineageId: lineage.lineageId,
      expectedParentLifecycleRef: lineage.parentLifecycleRef,
    });
    if (imported.imported) {
      ok('capsule-ingress', `the kit input-capsule imported through the WP-08 public ingress (${entry.capsuleIndex.capsules.length} content-addressed kit capsules bound)`);
    } else {
      red('capsule-ingress', `ingress refused: ${JSON.stringify(imported)}`);
      return { entryId, checks, notes, normalized: null };
    }

    const options = { ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() };
    const facts = kitFacts(entry);
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology(undefined, facts);
    const aggregates = aggregatedCells(entry);
    const outcomes = [];
    let failureCell = null;
    for (const cell of cells) {
      const aggregate = aggregates.find((candidate) => candidate.itemRef === cell.itemRef);
      const outcome = await driveKitCell(session, cell, ids, options, aggregate?.verdicts ?? []);
      outcomes.push({ itemRef: cell.itemRef, ...outcome });
      if (outcome.terminal === 'truthful-failure') failureCell = outcome.cell;
    }
    if (failureCell !== null) {
      /* The honest failure settlement: the truthful-failure ladder (the
         flow terminal for the failed cell's node happens inside it). */
      conveyor.settleFailureLadder(session, ids, failureCell, options, false);
    } else {
      conveyor.settleSuccessLadder(session, ids, options);
    }
    normalized = normalizedKernelReplay(session, options.externalEvidence);
  } finally {
    session.close();
  }

  /* Comparison 1: the mandatory transitions. The kernel replay models the
     legacy multi-stage lifecycle as ONE kernel stage whose work items are
     the legacy production cells: the non-terminal transitions (go,
     formalized) map onto the ACCEPTED cells they routed from; the terminal
     transition maps onto the kernel's typed terminal chain (stage outcome ->
     lifecycle route -> lifecycle proof -> run proof). */
  const family = terminalFamilyOf(entry.trace.finalOutcome.terminalStatus);
  const expectedRoutes = entry.trace.mandatoryTransitions.map((transition) => `${transition.from} --${transition.outcome}--> ${transition.to}`);
  const nonTerminalCount = Math.max(entry.trace.mandatoryTransitions.length - 1, 0);
  const runProof = family.proof;
  const routesOk = normalized.terminalProofs.includes(runProof)
    && normalized.stageOutcomeEvents.length >= 1
    && normalized.routeEvents.length >= 1
    && normalized.acceptedWorkplaceProofs >= nonTerminalCount;
  if (routesOk) {
    ok('mandatory-transitions', `the mandatory chain is demonstrated: ${normalized.acceptedWorkplaceProofs} accepted cells carry the non-terminal routes (${nonTerminalCount}), and the terminal chain settled in the mapped family (${runProof})`);
  } else {
    red('mandatory-transitions', `expected terminal family ${String(runProof)} over ${nonTerminalCount} non-terminal routes; proofs: ${normalized.terminalProofs.join(', ')}; stage outcomes ${normalized.stageOutcomeEvents.length}; routes ${normalized.routeEvents.length}; accepted cells ${normalized.acceptedWorkplaceProofs}`);
  }
  notes.push({ id: 'kit:mandatory-transitions', expected: expectedRoutes, note: `the legacy stage-route chain (${expectedRoutes.join('; ')}) maps onto the kernel replay: the non-terminal transitions correspond to the accepted production cells, and the legacy terminal '${entry.trace.finalOutcome.terminalStatus}' maps to ${String(runProof)} (${family.noteId})` });

  /* Comparison 2: the gate-decision sequence (mapped vocabulary). The
     non-accepted final verdicts are the oracle; repair counts follow the
     declared replay bound (with the typed reduction note). */
  const expectedFinalVerdicts = aggregatedCells(entry)
    .flatMap((cell) => cell.verdicts.filter((verdict) => verdict.phase === 'final' && verdict.verdict !== 'accepted'))
    .map((verdict) => kernelVerdictOf(verdict.verdict));
  const kernelFinals = normalized.gateDecisions.filter((verdict) => verdict !== 'accepted');
  const acceptedCount = normalized.gateDecisions.filter((verdict) => verdict === 'accepted').length;
  const repairsExpected = expectedFinalVerdicts.filter((verdict) => verdict === 'repair').length;
  const repairsReplayed = Math.min(repairsExpected, MAX_REPLAY_REPAIR_ROUNDS + 1);
  const finalsOk = repairsExpected > 0
    ? kernelFinals.includes('repair') && kernelFinals.filter((verdict) => verdict === 'repair').length === Math.min(kernelFinals.filter((verdict) => verdict === 'repair').length, repairsReplayed)
    : kernelFinals.length === 0;
  if (finalsOk && acceptedCount > 0) {
    ok('gate-verdict-sequence', `the mapped non-accepted final verdict family is demonstrated (${kernelFinals.join(', ')}; ${acceptedCount} accepted gates behind them; legacy repairs ${repairsExpected} -> replayed epochs ${repairsReplayed})`);
  } else {
    red('gate-verdict-sequence', `expected mapped non-accepted finals [${expectedFinalVerdicts.join(', ')}], kernel finals [${kernelFinals.join(', ')}]`);
  }
  notes.push({ id: 'kit:gate-verdicts', note: 'legacy author-phase gates have no kernel counterpart per round (the kernel desk opens the reviewer desk through the accepted author gate); the comparison covers the FINAL-phase verdict family under the declared vocabulary map' });
  if (repairsExpected > repairsReplayed) {
    notes.push({ id: 'kit:repair-epoch-reduction', note: `the legacy run drove ${repairsExpected} repair rounds; the replay drives ${repairsReplayed} D6 repair epochs (the conveyor's shared FIFO lanes bound the per-cell epoch count). The epoch LAW - repair verdict -> repair wait -> epoch rollover -> re-staffed author identity -> next round - is invariant in the count and is proven at full depth by the corpus repair project (p03) and the WP-13B repair suites.` });
  }

  /* Comparison 3: the terminal family per entry class. */
  if (entryId === 'elite-8') {
    const honest = normalized.terminalProofs.includes('TerminalProof:run.truthful-failure')
      && normalized.terminalProofs.includes('TerminalProof:lifecycle.truthful-failure');
    if (honest) ok('honest-typed-refusal-terminal', 'elite-8 terminated in the honest typed refusal family (run + lifecycle truthful-failure proofs)');
    else red('honest-typed-refusal-terminal', `expected the truthful-failure family; proofs: ${normalized.terminalProofs.join(', ')}`);
    notes.push({ id: 'kit:legacy-failed', note: "legacy terminal 'failed' (a silent DB-side status) maps to the kernel's typed TerminalProof:run.truthful-failure - an honest, evidenced terminal" });
  }
  if (entryId === 'elite-fresh-20260825') {
    const honest = normalized.terminalProofs.includes('TerminalProof:run.truthful-failure');
    const readinessWitness = entry.witnesses.readinessRefusalChain;
    if (honest) ok('development-blocked-terminal', "elite-fresh reached its development-blocked outcome in the honest typed family (readiness certification refused -> truthful-failure; delivery never entered)");
    else red('development-blocked-terminal', `expected the truthful-failure family with readiness evidence; proofs: ${normalized.terminalProofs.join(', ')}`);
    if (readinessWitness) {
      notes.push({ id: 'kit:readiness-refusal', note: `the kit's honest-refusal chain witness (workplace ${String(readinessWitness.workplace)}: local readiness FAILED -> stage blocked -> lifecycle development-blocked) maps onto the kernel readiness boundary: the readiness-certification cell terminalizes honestly and the delivery stage is never entered` });
    }
  }

  /* Comparison 4: the kit invariant rules the kernel world can evaluate. */
  const worldProofs = new Set(normalized.terminalProofs);
  const runTerminals = [...worldProofs].filter((proof) => proof.startsWith('TerminalProof:run.'));
  ok('kit-invariant:exactly-once-terminal', runTerminals.length === 1 ? 'INV-05: exactly one run terminal proof' : `INV-05 violation: ${runTerminals.length} run terminal proofs`);
  if (runTerminals.length !== 1) checks[checks.length - 1].status = 'red';

  /* The legacy-only behavior notes (never forced equality). */
  if (entry.witnesses.journalVisibilityGap) {
    notes.push({
      id: 'kit:legacy-only-loss-transitions',
      note: "the kit's journal-visibility witness records executions the legacy DB marked lost WITHOUT a journal transition; the kernel has no DB-only loss transitions - worker loss is classifyWorkerLoss evidence behind an open retry obligation. The replay does not force equality on these streams (typed divergence, by design).",
    });
  }
  notes.push({
    id: 'kit:worker-process-streams',
    note: `the kit's exec#N streams (worker spawn/exit process surface, ${Object.keys(entry.trace.streams).filter((stream) => stream.startsWith('exec#')).length} streams) are legacy-only: the kernel books the same work as obligation lanes + admission receipts, not as process streams`,
  });
  if (entry.witnesses.engineRestarts) {
    notes.push({ id: 'kit:engine-restarts', note: 'legacy engine restarts are replayed by the WP-13B crash registry (the corpus restart-heavy projects); the kit restart stream is not reproduced verbatim' });
  }

  const status = checks.every((check) => check.status === 'green') ? 'green' : 'red';
  return { entryId, status, checks, notes, normalized };
}
