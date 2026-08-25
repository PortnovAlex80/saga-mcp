/**
 * workflow-kernel/projection/context.ts - the tool/hook context builder
 * (WP-10, plan phase EK-7).
 *
 * THE LAW (plan EK-7): "tools and hooks receive exact context from
 * authoritative commands, never by reverse-reading the board."
 *
 * This module builds the context a tool invocation or a hook
 * (additionalContext) receives FROM THE COMMAND SIDE: the exact obligation
 * being consumed, its evidence references, the aggregate head it targets,
 * the pinned role contract of the attempt bound to the lane, and the
 * prompt-receipt references committed so far. Every field is read from the
 * authoritative ledger through the repositories' public readers - this
 * module contains NO SQL, imports NO store, and cannot see a card row.
 *
 * The output is a plain, bounded, JSON-serializable object: hooks inject it
 * verbatim as additionalContext, tools receive it as their invocation
 * context. Nothing here is ever written back into the kernel.
 */

import type { CanonicalRoleContractReference, EvidenceRef, InstanceId, ObligationRecord } from '../domain/types.js';
import type { CommandName } from '../domain/universe.js';
import type { KernelPersistenceSession } from '../persistence/session.js';
import { openFrontier } from '../application/obligation-consumer.js';

/* ------------------------------------------------------------------ */
/* The context shapes (exact, closed, command-derived)                  */
/* ------------------------------------------------------------------ */

/** The context one TOOL invocation receives (derived from its command). */
export interface ToolInvocationContext {
  /** The authoritative command the tool serves (a frozen-universe name). */
  readonly command: CommandName;
  readonly targetAggregate: string;
  readonly targetInstanceId: InstanceId;
  readonly expectedRevision: number;
  /** The exact evidence references the command consumes. */
  readonly evidenceRefs: readonly EvidenceRef[];
  /** The obligation the command completes (its kind + key when resolvable). */
  readonly obligation: { readonly kind: string; readonly idempotencyKey: string | null } | null;
  /** The pinned role contract of the attempt bound to this lane (display). */
  readonly pinnedRoleContract: CanonicalRoleContractReference | null;
  /**
   * Prompt-receipt REFERENCES committed for the bound attempt (display for
   * diagnosis - the receipts themselves are immutable evidence at these
   * refs; nothing here re-derives their payloads).
   */
  readonly promptReceiptRefs: readonly string[];
}

/** The context one HOOK receives as additionalContext (command-derived). */
export interface HookAdditionalContext {
  readonly kind: 'ek-hook-context';
  readonly command: CommandName;
  readonly targetInstanceId: InstanceId;
  readonly obligationKind: string | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly pinnedRoleContractRef: string | null;
}

/* ------------------------------------------------------------------ */
/* Builders (authoritative reads only)                                  */
/* ------------------------------------------------------------------ */

/**
 * The exact context of one command application: either a frontier claim
 * (the obligation-consumer lane head for the target command) or a direct
 * command against a named instance. NEVER reads a card, a lane or a task
 * status - the board simply does not exist on this path.
 */
export function toolContextForCommand(
  session: KernelPersistenceSession,
  target: CommandName,
  options?: { readonly instanceId?: InstanceId },
): ToolInvocationContext {
  const world = session.hydrateWorld().world;
  const entry = openFrontier(session).find((candidate) => candidate.target === target);

  // The lane's obligation KIND is exact on the frontier row; its consume key
  // exists only when the claim resolved durably (cross-aggregate lanes are
  // pinned by the caller - the key is honestly null then, never invented).
  let instanceId = options?.instanceId;
  let expectedRevision = 0;
  let evidenceRefs: readonly EvidenceRef[] = [];
  let obligation: { kind: string; idempotencyKey: string | null } | null = null;

  if (entry !== undefined) {
    obligation = { kind: entry.kind, idempotencyKey: entry.claim === undefined ? null : entry.claim.idempotencyKey };
    if (entry.claim !== undefined && (instanceId === undefined || instanceId === entry.claim.targetInstanceId)) {
      instanceId = entry.claim.targetInstanceId;
      expectedRevision = entry.claim.expectedRevision;
      evidenceRefs = [...entry.claim.evidenceRefs];
    }
  }
  if (instanceId === undefined) {
    // No open lane and no named instance: an empty-but-honest context.
    return {
      command: target,
      targetAggregate: '',
      targetInstanceId: '',
      expectedRevision: 0,
      evidenceRefs: [],
      obligation: null,
      pinnedRoleContract: null,
      promptReceiptRefs: [],
    };
  }

  const head = world.heads.get(instanceId);
  if (head !== undefined) {
    expectedRevision = head.revision;
  }

  // The pinned contract + receipt references of the attempt bound to this
  // instance (authoritative owning-repository readers; null/empty when none).
  const pin = session.activityAttempt.loadRoleContractPin(instanceId);
  const counters = session.activityAttempt.loadContextCounters(instanceId);
  const receiptRefs: string[] = [];
  if (pin !== undefined && counters !== undefined) {
    for (let ordinal = 1; ordinal <= counters.nextRequestOrdinal; ordinal += 1) {
      receiptRefs.push(`prompt-receipt:${instanceId}:${ordinal}`);
    }
  }

  return {
    command: target,
    targetAggregate: head?.aggregate ?? '',
    targetInstanceId: instanceId,
    expectedRevision,
    evidenceRefs,
    obligation,
    pinnedRoleContract: pin === undefined ? null : { roleContractRef: pin.roleContractRef, roleContractDigest: pin.roleContractDigest },
    promptReceiptRefs: receiptRefs,
  };
}

/** The bounded additionalContext object a hook injects for one command. */
export function hookAdditionalContextForCommand(
  session: KernelPersistenceSession,
  target: CommandName,
  options?: { readonly instanceId?: InstanceId },
): HookAdditionalContext {
  const context = toolContextForCommand(session, target, options);
  return {
    kind: 'ek-hook-context',
    command: context.command,
    targetInstanceId: context.targetInstanceId,
    obligationKind: context.obligation === null ? null : context.obligation.kind,
    evidenceRefs: [...context.evidenceRefs],
    pinnedRoleContractRef: context.pinnedRoleContract === null ? null : context.pinnedRoleContract.roleContractRef,
  };
}

/**
 * The context of the obligation a worker is about to consume (the claim
 * lane): used by runner-side tools that serve the exact claimed obligation.
 */
export function toolContextForObligation(session: KernelPersistenceSession, obligation: Pick<ObligationRecord, 'target' | 'targetInstanceId' | 'evidenceRefs' | 'kind' | 'idempotencyKey'>): ToolInvocationContext {
  return toolContextForCommand(session, obligation.target, { instanceId: obligation.targetInstanceId ?? undefined });
}
