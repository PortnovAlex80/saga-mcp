/**
 * workflow-kernel/application/waits.ts - typed waits with exact durable wake
 * sources and idempotent wake/redrive (WP-07, plan phase EK-4).
 *
 * Frozen protocol decisions exercised (PROTOCOL-DECISIONS-FROZEN.md):
 *   - D5 wake discharge: a wait is discharged by the OBLIGATION-COMPLETION
 *     RECEIPT of its named wake-source obligation kinds, or by its named
 *     wake COMMAND - the owning aggregate's transaction performs the
 *     discharge atomically (the pure engine already does); this module never
 *     invents a second discharge path;
 *   - D7 dead wake: a terminally failed predecessor converts dependant
 *     readiness waits into settlement work; nothing waits on a dead wake
 *     source, and the liveness report names any survivor;
 *   - D12 effect/send uncertainty: the wake is an OPERATOR disposition
 *     command receipt - an automatic redrive of a non-idempotent external
 *     send is refused (it would duplicate an uncertain send);
 *   - D9 watchdog adjacency: the liveness report is observe-only evidence
 *     for the watchdog command (factoryRun.observeWatchdog); it repairs
 *     nothing and writes no SQL.
 *
 * Idempotent wake/redrive WITHOUT reading Kanban or any inferred task
 * status: every decision here is a function of the durable shared-ledger
 * rows (typed_wait, transition_obligation, terminal_proof, workflow_event
 * hydration) and the owning repository's public head reader - nothing else.
 */

import type {
  CanonicalRoleContractReference,
  CommandOutcome,
  EffectOutcome,
  GateVerdict,
  ProtocolRole,
  TerminalOutcome,
  TypedRefusal,
} from '../domain/types.js';
import type { CommandName, ObligationKind, WaitKind } from '../domain/universe.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import type { FaultScheduler } from './faults.js';
import { repositoryOf } from './obligation-consumer.js';

/* ------------------------------------------------------------------ */
/* Durable wait views (shared-ledger reads only)                        */
/* ------------------------------------------------------------------ */

export interface DurableWaitView {
  readonly rowId: number;
  readonly kind: WaitKind;
  readonly ownerAggregate: string;
  readonly ownerInstanceId: string;
  readonly wakeCommands: readonly CommandName[];
  readonly wakeObligationKinds: readonly ObligationKind[];
  readonly deadWakeConversion: ObligationKind | undefined;
  readonly state: 'pending' | 'discharged' | 'converted';
  /** The wait row's discharge evidence ref once discharged/converted (durable D5 receipt). */
  readonly dischargeEvidenceRef: string | undefined;
  /** Wake-source obligation kinds that still have an OPEN obligation (D5 live sources). */
  readonly liveWakeObligationKinds: readonly ObligationKind[];
}

/** Every durable wait row with its exact wake sources (never a board/task status read). */
export function durableWaits(session: KernelPersistenceSession): readonly DurableWaitView[] {
  const ledger = session.hydrateWorld();
  return ledger.world.waits.map((wait, index) => ({
    rowId: ledger.waitRowIds[index],
    kind: wait.kind,
    ownerAggregate: wait.ownerAggregate,
    ownerInstanceId: wait.ownerInstanceId,
    wakeCommands: [...wait.wakeCommands],
    wakeObligationKinds: [...wait.wakeObligationKinds],
    deadWakeConversion: wait.deadWakeConversion,
    state: wait.state,
    dischargeEvidenceRef: wait.dischargeEvidenceRef,
    liveWakeObligationKinds: wait.wakeObligationKinds.filter((kind) =>
      ledger.world.obligations.some((obligation) => obligation.kind === kind && obligation.state === 'open'),
    ),
  }));
}

/** Only the pending waits (the ones a wake can still discharge). */
export function pendingWaits(session: KernelPersistenceSession): readonly DurableWaitView[] {
  return durableWaits(session).filter((wait) => wait.state === 'pending');
}

/* ------------------------------------------------------------------ */
/* Wake liveness report (D7/D9 evidence; observe-only, no repair)        */
/* ------------------------------------------------------------------ */

export type WakeLivenessIssue =
  | { readonly kind: 'NO_LIVE_WAKE_SOURCE'; readonly waitKind: WaitKind; readonly ownerInstanceId: string; readonly detail: string }
  | { readonly kind: 'DEAD_WAKE_SOURCE_UNCONVERTED'; readonly waitKind: WaitKind; readonly ownerInstanceId: string; readonly detail: string };

/**
 * Observe-only liveness evidence over the durable rows: a pending wait must
 * keep a live wake source (an open wake obligation of a declared kind, or a
 * declared wake command), and a pending wait with a dead-wake conversion
 * must not survive a committed terminal failure. The result feeds the
 * watchdog command (D9); it NEVER writes or repairs anything.
 */
export function wakeLivenessReport(session: KernelPersistenceSession): readonly WakeLivenessIssue[] {
  const ledger = session.hydrateWorld();
  const failureCommitted = ledger.world.proofs.some((proof) => proof.id.endsWith('.truthful-failure') || proof.id.endsWith('.unreachable'));
  const issues: WakeLivenessIssue[] = [];
  for (const wait of pendingWaits(session)) {
    if (wait.liveWakeObligationKinds.length === 0 && wait.wakeCommands.length === 0) {
      issues.push({
        kind: 'NO_LIVE_WAKE_SOURCE',
        waitKind: wait.kind,
        ownerInstanceId: wait.ownerInstanceId,
        detail: `${wait.kind} on ${wait.ownerInstanceId} has no open wake obligation and no declared wake command`,
      });
    }
    if (failureCommitted && wait.deadWakeConversion !== undefined) {
      issues.push({
        kind: 'DEAD_WAKE_SOURCE_UNCONVERTED',
        waitKind: wait.kind,
        ownerInstanceId: wait.ownerInstanceId,
        detail: `a terminal failure is committed but ${wait.kind} on ${wait.ownerInstanceId} is still pending instead of converted to ${wait.deadWakeConversion}`,
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Idempotent wake by command                                          */
/* ------------------------------------------------------------------ */

/** The typed fields one wake command may need (closed shape; no metadata bag). */
export interface WakePayload {
  /** Must be one of THIS wait's declared wake commands (durable vocabulary check). */
  readonly command: CommandName;
  /** Deterministic key: an identical re-wake replays instead of committing twice. */
  readonly idempotencyKey: string;
  readonly evidenceRefs?: readonly string[];
  readonly gateVerdict?: GateVerdict;
  readonly effectOutcome?: EffectOutcome;
  readonly terminalOutcome?: TerminalOutcome;
  readonly protocolRole?: ProtocolRole;
  readonly rolePin?: CanonicalRoleContractReference;
  readonly workIntentRef?: string;
  /**
   * D12: the operator disposition receipt reference. REQUIRED for
   * TypedWait:effect-uncertainty - an automatic wake of an uncertain
   * non-idempotent external send/effect is refused.
   */
  readonly operatorDispositionRef?: string;
}

export type WakeResult =
  | { readonly status: 'discharged'; readonly waitKind: WaitKind; readonly dischargeEvidenceRef: string; readonly command: CommandName }
  | { readonly status: 'replayed'; readonly waitKind: WaitKind; readonly command: CommandName; readonly idempotencyKey: string }
  | { readonly status: 'refused'; readonly refusal: TypedRefusal };

/**
 * Execute one declared wake command of one pending wait through the OWNING
 * repository. The engine discharges the wait inside the same transaction as
 * the wake command's fact (D5); this function verifies that and reports a
 * typed DEAD_WAKE_SOURCE refusal if a committed wake failed to discharge
 * the wait (never a silent success).
 */
export function wakeByCommand(session: KernelPersistenceSession, rowId: number, payload: WakePayload, faults?: FaultScheduler): WakeResult {
  const wait = durableWaits(session).find((entry) => entry.rowId === rowId);
  if (wait === undefined) {
    return {
      status: 'refused',
      refusal: { refused: true, reason: 'ILLEGAL_TRANSITION', detail: `typed wait row ${rowId} does not exist` },
    };
  }
  if (wait.state !== 'pending') {
    return {
      status: 'refused',
      refusal: { refused: true, reason: 'ILLEGAL_TRANSITION', detail: `typed wait ${wait.kind} on ${wait.ownerInstanceId} is ${wait.state}, not pending` },
    };
  }
  if (!(wait.wakeCommands as readonly string[]).includes(payload.command)) {
    return {
      status: 'refused',
      refusal: {
        refused: true,
        reason: 'WAIT_WITHOUT_WAKE_SOURCE',
        detail: `${payload.command} is not a declared wake command of ${wait.kind} (declared: ${wait.wakeCommands.join(', ') || '<none>'})`,
      },
    };
  }
  if (wait.kind === 'TypedWait:effect-uncertainty' && payload.operatorDispositionRef === undefined) {
    return {
      status: 'refused',
      refusal: {
        refused: true,
        reason: 'WAIT_WITHOUT_WAKE_SOURCE',
        detail: 'D12: an effect-uncertainty wait wakes only on an operator disposition receipt; an automatic redrive would duplicate an uncertain non-idempotent external send',
      },
    };
  }

  const ledger = session.hydrateWorld();
  const head = ledger.world.heads.get(wait.ownerInstanceId);
  const input = {
    command: payload.command,
    instanceId: wait.ownerInstanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: payload.idempotencyKey,
    ...(payload.evidenceRefs !== undefined ? { evidenceRefs: payload.evidenceRefs } : {}),
    ...(payload.gateVerdict !== undefined ? { gateVerdict: payload.gateVerdict } : {}),
    ...(payload.effectOutcome !== undefined ? { effectOutcome: payload.effectOutcome } : {}),
    ...(payload.terminalOutcome !== undefined ? { terminalOutcome: payload.terminalOutcome } : {}),
    ...(payload.protocolRole !== undefined ? { protocolRole: payload.protocolRole } : {}),
    ...(payload.rolePin !== undefined ? { rolePin: payload.rolePin } : {}),
    ...(payload.workIntentRef !== undefined ? { workIntentRef: payload.workIntentRef } : {}),
  };
  faults?.fire('before-durable-write');
  const outcome: CommandOutcome = repositoryOf(session, wait.ownerAggregate).applyCommand(input);
  if ('refused' in outcome) {
    return { status: 'refused', refusal: outcome };
  }
  if ('replayed' in outcome) {
    return { status: 'replayed', waitKind: wait.kind, command: payload.command, idempotencyKey: payload.idempotencyKey };
  }
  const discharged = durableWaits(session).find((entry) => entry.rowId === rowId);
  if (discharged === undefined || discharged.state !== 'discharged') {
    return {
      status: 'refused',
      refusal: {
        refused: true,
        reason: 'DEAD_WAKE_SOURCE',
        detail: `${payload.command} committed but did not discharge ${wait.kind} on ${wait.ownerInstanceId} (the wake source is not durable for this wait)`,
      },
    };
  }
  faults?.fire('after-durable-write');
  return { status: 'discharged', waitKind: wait.kind, dischargeEvidenceRef: discharged.dischargeEvidenceRef ?? '', command: payload.command };
}
