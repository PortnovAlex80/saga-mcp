/**
 * Saga 3 — Scheduler admission.
 *
 * The controller decides what is admissible. The scheduler decides
 * what to launch NOW, within capacity and WIP limits.
 *
 * Admission check: capacity available, no conflict, budget reserved,
 * prerequisites met. If admitted → atomically reserve budget + claim
 * resources + issue lease.
 */

import type { WorkIntent } from '../domain/types.js';
import type { BudgetLedger } from '../budgets/budget-ledger.js';
import {
  type ResourceScope,
  type HeldClaim,
  type AdmissionDecision,
  checkScopeConflict,
} from '../resources/resource-claim.js';

export interface AdmitRequest {
  readonly intent: WorkIntent;
  readonly writeScopes: readonly ResourceScope[];
  readonly writeScopesKnown: boolean;
  readonly repositories: readonly string[];
  readonly heldClaims: readonly HeldClaim[];
  readonly capacityUsed: number;
  readonly capacityMax: number;
  readonly budget: BudgetLedger;
  readonly budgetReservationRef: string;
}

/**
 * Admit a WorkIntent: check capacity, scope conflict, budget.
 * Returns admitted:true with canonical repo order, or admitted:false with reason.
 */
export function admitWorkIntent(req: AdmitRequest): AdmissionDecision {
  // 1. Unknown/incomplete write scopes serialize by default.
  if (!req.writeScopesKnown || req.writeScopes.length === 0) {
    if (req.capacityUsed > 0) {
      return {
        admitted: false,
        reason: 'unknown_scope_serialized',
        detail: 'write scopes unknown/incomplete — serialize',
      };
    }
  }

  // 2. Write-scope conflict check.
  const conflict = checkScopeConflict(req.writeScopes, req.heldClaims);
  if (conflict) {
    return {
      admitted: false,
      reason: 'write_scope_conflict',
      detail: `conflict with ${conflict.workIntentId} on ${conflict.scope.scopeType}:${conflict.scope.scopeValue}`,
    };
  }

  // 3. Budget check.
  if (req.intent.budgetReservation && req.intent.budgetReservation > 0) {
    const reserved = req.budget.reserve(
      req.intent.budgetReservation,
      req.budgetReservationRef,
    );
    if (!reserved) {
      return {
        admitted: false,
        reason: 'budget_exhausted',
        detail: `cannot reserve ${req.intent.budgetReservation} (remaining: ${req.budget.getRemaining()})`,
      };
    }
  }

  // 4. Capacity.
  if (req.capacityUsed >= req.capacityMax) {
    return {
      admitted: false,
      reason: 'capacity_full',
      detail: `${req.capacityUsed}/${req.capacityMax}`,
    };
  }

  // 5. Multi-repo canonical order.
  const canonicalRepoOrder = req.repositories.length > 1
    ? [...req.repositories].sort()
    : undefined;

  return { admitted: true, canonicalRepoOrder };
}

// ---------------------------------------------------------------------------
// Backpressure (plan §9.5)
// ---------------------------------------------------------------------------

export function integrationBacklogThrottle(input: {
  readonly backlogSize: number;
  readonly threshold: number;
}): { readonly admitWriters: boolean } {
  return { admitWriters: input.backlogSize <= input.threshold };
}

export function reserveCapacity(input: {
  readonly capacityMax: number;
  readonly reservedForVerification: number;
  readonly reservedForRecovery: number;
  readonly currentDevUse: number;
}): { readonly devAdmissible: boolean } {
  const available = Math.max(
    0,
    input.capacityMax - input.reservedForVerification - input.reservedForRecovery,
  );
  return { devAdmissible: input.currentDevUse < available };
}

export function antiStarvation(input: {
  readonly pendingMandatory: ReadonlyArray<{ readonly id: string; readonly waitCycles: number }>;
  readonly pendingOptional: readonly string[];
  readonly agingThreshold?: number;
}): { readonly admitId: string | null } {
  const threshold = input.agingThreshold ?? 8;
  const aged = input.pendingMandatory
    .filter((t) => t.waitCycles > threshold)
    .sort((a, b) => b.waitCycles - a.waitCycles);
  if (aged.length > 0) return { admitId: aged[0].id };
  if (input.pendingOptional.length > 0) return { admitId: input.pendingOptional[0] };
  if (input.pendingMandatory.length > 0) return { admitId: input.pendingMandatory[0].id };
  return { admitId: null };
}

export function adaptiveConcurrency(input: {
  readonly current: number;
  readonly min: number;
  readonly max: number;
  readonly incidentRate: number;
  readonly highThreshold?: number;
  readonly lowThreshold?: number;
}): { readonly next: number } {
  const high = input.highThreshold ?? 0.10;
  const low = input.lowThreshold ?? 0.01;
  let next = input.current;
  if (input.incidentRate >= high) next = Math.max(input.min, input.current - 1);
  else if (input.incidentRate <= low) next = Math.min(input.max, input.current + 1);
  return { next: Math.max(input.min, Math.min(input.max, next)) };
}
