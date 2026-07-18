/**
 * Composite invariants — predicates that hold after every allowed transition.
 *
 * Source: blueprint §18 Pure domain (docs/architecture/passive-worker-kernel-blueprint.md:1071-1078).
 *
 * Property-test (blueprint §18:1078): for every accepted decision,
 *   decision.events.reduce(evolve, state) MUST satisfy `compositeInvariants`.
 * If it does not, the reducer has a bug — the transition table is inconsistent
 * with the typestate union.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type { ManagedTaskState } from './state.js';

export interface InvariantViolationReport {
  readonly ok: false;
  readonly rule: string;
  readonly detail: string;
}

export interface InvariantOk {
  readonly ok: true;
}

export type InvariantCheck = InvariantOk | InvariantViolationReport;

/**
 * Check all composite invariants. Returns the first violation or ok.
 * Tests should call this after folding decision events.
 */
export function compositeInvariants(state: ManagedTaskState): InvariantCheck {
  // INV-1: an active state always carries both workerId and executionId.
  if (state.kind === 'active') {
    if (!state.workerId) {
      return { ok: false, rule: 'ACTIVE_HAS_WORKER', detail: 'active state has empty workerId' };
    }
    if (!state.executionId) {
      return { ok: false, rule: 'ACTIVE_HAS_EXECUTION', detail: 'active state has empty executionId' };
    }
  }

  // INV-2: a finishing state always carries an executionId.
  if (state.kind === 'finishing') {
    if (!state.executionId) {
      return { ok: false, rule: 'FINISHING_HAS_EXECUTION', detail: 'finishing state has empty executionId' };
    }
  }

  // INV-3: a waiting_human state always carries a requestId.
  if (state.kind === 'waiting_human') {
    if (!state.requestId) {
      return { ok: false, rule: 'WAITING_HAS_REQUEST', detail: 'waiting_human has empty requestId' };
    }
    // resumePhase must be a known phase.
    if (!['implementation', 'review', 'integration'].includes(state.resumePhase)) {
      return { ok: false, rule: 'WAITING_VALID_PHASE', detail: `invalid resumePhase ${state.resumePhase}` };
    }
  }

  // INV-4: an integrating state carries both ids.
  if (state.kind === 'integrating') {
    if (!state.integrationId) {
      return { ok: false, rule: 'INTEGRATING_HAS_INTENT', detail: 'integrating state has empty integrationId' };
    }
    if (!state.executorExecutionId) {
      return { ok: false, rule: 'INTEGRATING_HAS_EXECUTOR', detail: 'integrating state has empty executorExecutionId' };
    }
  }

  // INV-5: an integration_conflict state carries an integrationId.
  if (state.kind === 'integration_conflict') {
    if (!state.integrationId) {
      return { ok: false, rule: 'CONFLICT_HAS_INTENT', detail: 'integration_conflict has empty integrationId' };
    }
  }

  // INV-6: an awaiting_integration state carries an integrationId.
  if (state.kind === 'awaiting_integration') {
    if (!state.integrationId) {
      return { ok: false, rule: 'AWAITING_HAS_INTENT', detail: 'awaiting_integration has empty integrationId' };
    }
  }

  return { ok: true };
}
