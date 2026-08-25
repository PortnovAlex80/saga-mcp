/**
 * workflow-kernel/testing/scenario-faults.ts - the EK-9 scenario fault
 * layer over the WP-07 16-point fault registry (WP-13B).
 *
 * A scenario's fault schedule is DATA: entries of (fault class, exact
 * anchor, boundary). This module turns that data into WP-07 registry
 * firings driven through PUBLIC COMMANDS ONLY:
 *
 *   - crash-before-commit / crash-after-event: the anchored command
 *     application dies at the mapped registry point (FaultCrashError - the
 *     simulated death of the driving process); restart reopens the SAME
 *     database file and re-derives every step from durable rows;
 *   - worker-loss: the scripted channel dies around the send; the attempt
 *     is classified (typed wait + retry obligation), never product-failed;
 *   - projection-wipe: every derived projection is dropped and rehydrated
 *     from the durable ledger rows (the projection is never authority);
 *   - projection-stale-write: a stale-revision write attempt against the
 *     ledger is answered by the CAS fence and changes nothing.
 *
 * Scenario boundaries map onto the closed WP-07 registry exactly:
 *   event/evidence/obligation/settlement-commit seams sit inside the one
 *   repository transaction (before/after-durable-write); worker seams are
 *   the spawn/return points; gate and effect seams are their named points.
 *
 * The scenario-level crash law (proven by the matrix): a fault scheduled at
 * EVERY named crash window settles, after restart, to the IDENTICAL
 * normalized world as the clean run (exactly-once logical outcome).
 *
 * PURITY of the driver logic: no clock, no timers, no board reads; state is
 * re-derived from durable rows only (the WP-07 stateless discipline).
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandInput, EvidenceFact, TypedRefusal } from '../domain/types.js';
import type { CommandName } from '../domain/universe.js';
import { COMMANDS } from '../domain/universe.js';
import { findInvariantViolations } from '../domain/explorer.js';
import {
  FAULT_POINTS,
  FaultCrashError,
  FaultScheduler,
  commandFaultPoints,
  type FaultPoint,
} from '../application/faults.js';
import {
  admitProviderRequest as applicationAdmitProviderRequest,
  type PromptBudgetLimits,
  type ProviderRequestEnvelope,
} from '../application/admission.js';
import { openKernelDatabase } from '../persistence/database.js';
import { KernelPersistenceSession } from '../persistence/session.js';

/* ------------------------------------------------------------------ */
/* Scenario fault vocabulary (mirror of the scenario contract)           */
/* ------------------------------------------------------------------ */

/** Scheduler-level fault classes the scenario contract may declare. */
export const SCENARIO_FAULT_CLASSES = [
  'crash-before-commit',
  'crash-after-event',
  'worker-loss',
  'projection-wipe',
  'projection-stale-write',
] as const;
export type ScenarioFaultClass = (typeof SCENARIO_FAULT_CLASSES)[number];

/** Restart-boundary dimension: every durable commit seam is addressable. */
export const SCENARIO_BOUNDARIES = [
  'before-event',
  'after-event',
  'before-evidence',
  'after-evidence',
  'before-obligation',
  'after-obligation',
  'before-worker',
  'after-worker',
  'before-gate',
  'after-gate',
  'before-effect',
  'after-effect',
  'before-settlement-commit',
  'after-settlement-commit',
] as const;
export type ScenarioBoundary = (typeof SCENARIO_BOUNDARIES)[number];

/** One scenario fault entry: (fault class, exact anchor, boundary). */
export interface ScenarioFaultEntry {
  readonly fault: ScenarioFaultClass;
  readonly anchor: {
    readonly command: CommandName;
    readonly instanceId: string;
    readonly occurrence?: number;
  };
  readonly boundary?: ScenarioBoundary;
}

/**
 * The EXACT map from scenario boundaries to WP-07 registry points. The
 * event/evidence/obligation/settlement-commit seams physically live inside
 * the sole-writer repository transaction, so they map to its durable-write
 * point pair; worker/gate/effect seams are their named registry points
 * (co-fired with the transaction pair by the repositories).
 */
export const SCENARIO_BOUNDARY_POINTS: Readonly<Record<ScenarioBoundary, readonly FaultPoint[]>> = {
  'before-event': ['before-durable-write'],
  'after-event': ['after-durable-write'],
  'before-evidence': ['before-durable-write'],
  'after-evidence': ['after-durable-write'],
  'before-obligation': ['before-durable-write'],
  'after-obligation': ['after-durable-write'],
  'before-worker': ['before-worker-spawn'],
  'after-worker': ['after-worker-spawn'],
  'before-gate': ['before-gate'],
  'after-gate': ['after-gate'],
  'before-effect': ['before-effect'],
  'after-effect': ['after-effect'],
  'before-settlement-commit': ['before-durable-write'],
  'after-settlement-commit': ['after-durable-write'],
};

/** The three NAMED crash windows of the EK-4 law, at scenario granularity. */
export const NAMED_CRASH_WINDOWS: readonly { readonly window: string; readonly point: FaultPoint }[] = [
  { window: 'after-admission/before-send', point: 'after-admission' },
  { window: 'after-send/before-outcome', point: 'after-provider-send' },
  { window: 'after-outcome/before-completion', point: 'after-worker-return' },
];

/* ------------------------------------------------------------------ */
/* The scenario fault arming                                           */
/* ------------------------------------------------------------------ */

export class ScenarioFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioFaultError';
  }
}

/** Validate a scenario fault schedule against the closed vocabulary. */
export function validateScenarioFaults(entries: readonly ScenarioFaultEntry[]): void {
  for (const entry of entries) {
    if (!SCENARIO_FAULT_CLASSES.includes(entry.fault)) {
      throw new ScenarioFaultError(`unknown scenario fault class "${String(entry.fault)}"`);
    }
    if (entry.boundary !== undefined && !SCENARIO_BOUNDARIES.includes(entry.boundary)) {
      throw new ScenarioFaultError(`unknown scenario boundary "${String(entry.boundary)}"`);
    }
    if (!COMMANDS.some((descriptor) => descriptor.name === entry.anchor.command)) {
      throw new ScenarioFaultError(`fault anchor command "${String(entry.anchor.command)}" is not in the frozen universe`);
    }
  }
}

/**
 * Arm the WP-07 registry from a scenario fault schedule. Exactly one
 * registry point may carry a crash (a schedule arming two crashes is a
 * harness defect: one process dies once). The armed point is the FIRST
 * registry point of the mapped boundary; the anchor gates WHICH command
 * application fires it (applyScenarioStep honors the anchor).
 */
export function armRegistryFromScenario(entries: readonly ScenarioFaultEntry[]): FaultScheduler {
  validateScenarioFaults(entries);
  const crashEntries = entries.filter((entry) => entry.fault === 'crash-before-commit' || entry.fault === 'crash-after-event');
  if (crashEntries.length > 1) {
    throw new ScenarioFaultError(`the scenario schedules ${crashEntries.length} crashes; one process dies once`);
  }
  if (crashEntries.length === 0) return FaultScheduler.observing();
  const entry = crashEntries[0];
  const points: readonly FaultPoint[] = entry.boundary === undefined ? ['before-durable-write'] : SCENARIO_BOUNDARY_POINTS[entry.boundary];
  return new FaultScheduler(points[0], 1);
}

/** The crash anchor of a schedule (the application whose boundary fires). */
export function crashAnchorOf(entries: readonly ScenarioFaultEntry[]): ScenarioFaultEntry['anchor'] | undefined {
  const crashEntries = entries.filter((entry) => entry.fault === 'crash-before-commit' || entry.fault === 'crash-after-event');
  return crashEntries.length === 1 ? crashEntries[0].anchor : undefined;
}

/** True when the anchored command occurrence matches this application. */
export function anchorMatches(anchor: ScenarioFaultEntry['anchor'], command: string, instanceId: string, occurrence: number): boolean {
  return anchor.command === command && anchor.instanceId === instanceId && (anchor.occurrence ?? 1) === occurrence;
}

/* ------------------------------------------------------------------ */
/* The external Input evidence (CheckPlan + verifier actor, R15/R5)     */
/* ------------------------------------------------------------------ */

const sha256Of = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** External Input-authority evidence admitted through public ingress. */
export function scenarioExternalEvidence(): EvidenceFact[] {
  return [
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: sha256Of('checkplan:ek-wp13b') },
    { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: sha256Of('pve:ek-wp13b') },
    { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: sha256Of('pvf:ek-wp13b') },
  ];
}

/** The deterministic admission envelope + limits of the scenario verticals. */
export function scenarioAdmission(requestInputTokens = 5000): {
  readonly envelope: ProviderRequestEnvelope;
  readonly limits: PromptBudgetLimits;
} {
  return {
    envelope: {
      providerModel: 'zai/opencode-pin',
      requestInputTokens,
      envelopeDigest: `sha256:${sha256Of(`envelope:ek-wp13b:${requestInputTokens}`)}`,
    },
    limits: {
      providerContextLimitTokens: 200000,
      reservedOutputTokens: 16000,
      providerOverheadReserveTokens: 2000,
      safetyMarginTokens: 2000,
      maxTotalInputTokens: 120000,
      maxCumulativeSessionInputTokens: 400000,
      maxProviderRequests: 20,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The stateless durable scenario driver                               */
/* ------------------------------------------------------------------ */

const COMMAND_AGGREGATE = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor.aggregate]));

function repositoryFor(session: KernelPersistenceSession, command: CommandName) {
  const aggregate = COMMAND_AGGREGATE.get(command);
  if (aggregate === undefined) throw new ScenarioFaultError(`command ${command} is not in the frozen universe`);
  switch (aggregate) {
    case 'FactoryRun':
      return session.factoryRun;
    case 'LifecycleRun':
      return session.lifecycleRun;
    case 'StageRun':
      return session.stageRun;
    case 'ProcessRun':
      return session.processRun;
    case 'NodeRun':
      return session.nodeRun;
    case 'Workplace':
      return session.workplace;
    case 'ActivityAttempt':
      return session.activityAttempt;
    case 'WorkItem':
      return session.workItem;
    case 'CognitionTransport':
      return session.cognitionTransport;
    default:
      throw new ScenarioFaultError(`unknown owning aggregate ${String(aggregate)}`);
  }
}

export interface ScenarioDriveOptions {
  /** The armed WP-07 registry (observing mode by default). */
  readonly faults?: FaultScheduler;
  /** The scenario fault schedule (crash anchor + projection classes). */
  readonly scenarioFaults?: readonly ScenarioFaultEntry[];
  readonly externalEvidence?: readonly EvidenceFact[];
  /** Stop the run once the anchored application committed (staging). */
  readonly stopAfter?: { readonly command: string; readonly instanceId: string };
  /** The admission envelope + limits of every admitProviderRequest step. */
  readonly admission?: {
    readonly envelope: ProviderRequestEnvelope;
    readonly limits: PromptBudgetLimits;
  };
}

export type ScenarioStepOutcome =
  | { readonly status: 'committed' }
  | { readonly status: 'replayed' }
  | { readonly status: 'skipped' }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal };

/**
 * Apply one scenario step idempotently through the owning repository
 * (public commands only). Stateless: the step is skipped when its durable
 * postcondition - the recorded idempotency key - already holds; fault
 * points fire exactly at the registry seams around the transaction.
 */
export function applyScenarioStep(
  session: KernelPersistenceSession,
  input: CommandInput,
  occurrences: Map<string, number>,
  options: ScenarioDriveOptions = {},
): ScenarioStepOutcome {
  const world = session.hydrateWorld(options.externalEvidence ? { externalEvidence: options.externalEvidence } : undefined).world;
  const occurrenceKey = `${input.command}@${input.instanceId}`;
  const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
  occurrences.set(occurrenceKey, occurrence);

  if (world.idempotency.has(input.idempotencyKey)) return { status: 'skipped' };

  const faults = options.faults;
  const crashAnchor = options.scenarioFaults !== undefined ? crashAnchorOf(options.scenarioFaults) : undefined;
  // A crash-anchored registry fires ONLY at the anchored application; an
  // observing registry fires everywhere (coverage evidence).
  const anchorOk = crashAnchor === undefined || anchorMatches(crashAnchor, input.command, input.instanceId, occurrence);

  // The admission command runs through the one application admission path
  // (receipt + provider-send obligation + counters in ONE transaction); it
  // fires the before/after-admission registry points itself.
  if (input.command === 'activityAttempt.admitProviderRequest') {
    const attemptHead = world.heads.get(input.instanceId);
    if (attemptHead !== undefined && attemptHead.status !== 'created') return { status: 'skipped' };
    if (options.admission === undefined) {
      throw new ScenarioFaultError('the scenario drives activityAttempt.admitProviderRequest but no admission envelope/limits were supplied');
    }
    const result = applicationAdmitProviderRequest(session, {
      attemptInstanceId: input.instanceId,
      envelope: options.admission.envelope,
      limits: options.admission.limits,
      idempotencyKey: input.idempotencyKey,
      faults: anchorOk ? faults : undefined,
    });
    if (result.status === 'redrive') return { status: 'skipped' };
    if (result.status === 'refused' || result.status === 'stale') {
      return { status: 'refused', refusal: { refused: true, reason: 'ILLEGAL_TRANSITION', detail: `${result.status}: ${result.detail}` } as TypedRefusal };
    }
    return { status: 'committed' };
  }

  const fire = (point: FaultPoint): void => {
    if (anchorOk) faults?.fire(point);
  };
  for (const point of commandFaultPoints(input.command)) {
    if (point.startsWith('before-')) fire(point);
  }
  fire('before-durable-write');
  fire('before-obligation-completion');
  const outcome = repositoryFor(session, input.command).applyCommand(
    input,
    options.externalEvidence === undefined ? undefined : { externalEvidence: options.externalEvidence },
  );
  if ((outcome as TypedRefusal).refused === true) {
    return { status: 'refused', refusal: outcome as TypedRefusal };
  }
  if ((outcome as { replayed?: boolean }).replayed === true) {
    return { status: 'replayed' };
  }
  fire('after-durable-write');
  fire('after-obligation-completion');
  for (const point of commandFaultPoints(input.command)) {
    if (point.startsWith('after-')) fire(point);
  }
  return { status: 'committed' };
}

/** A unique Windows-safe database path (no cleanup reliance). */
let tempCounter = 0;
export function scenarioDatabasePath(label = 'ek-wp13b'): string {
  tempCounter += 1;
  return join(tmpdir(), `${label}-${process.pid}-${tempCounter}`, 'kernel.sqlite');
}

/**
 * Drive the scenario command list over a durable session. Stateless over
 * durable facts: re-driving after any crash converges (every step checks
 * its own durable postcondition first). Throws FaultCrashError through.
 */
export function driveScenarioOnSession(
  session: KernelPersistenceSession,
  inputs: readonly CommandInput[],
  options: ScenarioDriveOptions = {},
): { outcomes: readonly ScenarioStepOutcome[]; refusedAt: number | null } {
  const occurrences = new Map<string, number>();
  const outcomes: ScenarioStepOutcome[] = [];
  let refusedAt: number | null = null;
  let stopped = false;
  inputs.forEach((input, index) => {
    if (refusedAt !== null || stopped) {
      outcomes.push({ status: 'skipped' });
      return;
    }
    const outcome = applyScenarioStep(session, input, occurrences, options);
    outcomes.push(outcome);
    if (outcome.status === 'refused') refusedAt = index;
    if (
      outcome.status === 'committed' &&
      options.stopAfter !== undefined &&
      options.stopAfter.command === input.command &&
      options.stopAfter.instanceId === input.instanceId
    ) {
      stopped = true; // stage: end the run silently after this step
    }
  });
  return { outcomes, refusedAt };
}

/** Open a fresh durable session at `path` (the restart entry point). */
export function openScenarioSession(path: string): KernelPersistenceSession {
  mkdirSync(dirname(path), { recursive: true });
  return new KernelPersistenceSession(openKernelDatabase(path));
}

/* ------------------------------------------------------------------ */
/* The normalized-world oracle (scenario-level exactly-once proof)      */
/* ------------------------------------------------------------------ */

/**
 * The normalized durable world: everything semantic, nothing volatile.
 * Two runs (faulted + restarted vs clean) settling to identical logical
 * outcomes produce identical snapshots - the scenario-level exactly-once
 * proof over the WP-13A comparison semantics.
 */
export function scenarioNormalizedWorld(session: KernelPersistenceSession, externalEvidence?: readonly EvidenceFact[]) {
  const hydrated = session.hydrateWorld(externalEvidence ? { externalEvidence } : undefined).world;
  // Deduplicate by evidence ref before the invariant oracle: the kernel fact
  // and its persisted receipt row share one ref (one immutable fact listed
  // twice by hydration, never two facts; a genuine duplicate carries a new
  // sequence ref and survives the dedupe).
  const byRef = new Map(hydrated.evidence.map((fact) => [fact.ref, fact] as const));
  const world = { ...hydrated, evidence: [...byRef.values()] };
  return {
    sequence: world.sequence,
    heads: [...world.heads.values()]
      .map((head) => ({ instanceId: head.instanceId, status: head.status, revision: head.revision, ...(head.terminal !== undefined ? { terminal: head.terminal } : {}) }))
      .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1)),
    events: world.events
      .map((event) => ({ transition: event.transition, source: event.sourceInstanceId, revision: event.sourceRevision, kind: event.kind }))
      .sort((a, b) => a.revision - b.revision || (a.transition < b.transition ? -1 : 1)),
    obligations: world.obligations
      .map((obligation) => ({
        kind: obligation.kind,
        key: obligation.idempotencyKey,
        state: obligation.state,
        ...(obligation.completionEvidenceRef !== undefined ? { completion: obligation.completionEvidenceRef } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    waits: world.waits
      .map((wait) => ({ kind: wait.kind, owner: wait.ownerInstanceId, state: wait.state, ...(wait.dischargeEvidenceRef !== undefined ? { discharge: wait.dischargeEvidenceRef } : {}) }))
      .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.kind < b.kind ? -1 : 1)),
    proofs: world.proofs
      .map((proof) => ({ id: proof.id, owner: proof.ownerInstanceId, closure: [...proof.evidenceClosure].sort() }))
      .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.id < b.id ? -1 : 1)),
    evidence: world.evidence.map((fact) => fact.ref).sort(),
    invariantViolations: findInvariantViolations(world).map((violation) => `${violation.kind}: ${violation.detail}`),
  };
}

export { FAULT_POINTS, FaultCrashError, FaultScheduler, commandFaultPoints };
export type { FaultPoint };
