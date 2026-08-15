/**
 * W1-A4 — ExecutionContextEnvelope (plan §7.7, spec §1 row 8).
 *
 * The ExecutionContextEnvelope is the immutable, driver-neutral payload the
 * Runtime assembles from durable state and hands to the next node's executor
 * (plan §7.7). It is explicitly NOT a mutable in-memory frame.
 *
 * Driver-neutrality (plan §7.7.1-7.7.6, §13.16, C061): board/task/epic/
 * WorkIntent IDs are NOT base fields of this envelope. They live in
 * adapter-specific data on the receipt / projection, never on the contract
 * the executor switches on. A test that tries to add `taskId` to a base
 * envelope must fail canonical serialization (the TypeScript type does not
 * declare it; canonicalJson drops unknown own-properties silently, but the
 * validator below explicitly checks for forbidden base keys).
 *
 * This file re-exports `ProductRef` from W1-A6 (it does NOT redefine it —
 * the production envelope is the canonical owner). The import is a value
 * re-export; it resolves at Wave 1 integration when A6 lands. The
 * `RecoveryFeedback` import is from the existing `../recovery.ts` (already
 * present in the worktree).
 */

import type { RecoveryFeedback } from '../recovery.js';
export type { ProductRef } from './production-envelope.js';
import type { ProductRef } from './production-envelope.js';

// ---------------------------------------------------------------------------
// Package + Node references (plan §7.7.1).
// ---------------------------------------------------------------------------

/**
 * Identity of the installed package snapshot the envelope was assembled
 * against. `digest` pins the exact immutable content the Runtime loaded.
 */
export interface PackageRef {
  name: string;
  version: string;
  digest: string;
}

/**
 * Identity of the Flow node this envelope targets, including its owning
 * Flow's id+version so a node id is never ambiguous across module versions.
 */
export interface NodeRef {
  nodeId: string;
  flowId: string;
  flowVersion: string;
}

// ---------------------------------------------------------------------------
// ExecutionContextEnvelope (plan §7.7).
// ---------------------------------------------------------------------------

/**
 * Immutable execution envelope assembled from durable state.
 *
 * Fields mirror plan §7.7.1-7.7.6 verbatim:
 *   - processRunId / nodeRunId / attempt / executionId — identities.
 *   - packageRef / nodeRef — pinned package + owning Flow node.
 *   - frozenAuthority — durable authority snapshot, never mutated mid-run.
 *   - immutableRunInput — the original ProcessRun input (plan §7.7.3).
 *   - upstreamProducts — exact declared predecessor products (plan §7.7.4);
 *     never reconstructed by the executor.
 *   - recoveryFeedback — present only when this attempt is a repair (§7.7.5).
 *   - scenarioId / stageId — present when the run is scoped to a Lifecycle
 *     Scenario (§7.7.6).
 *
 * NOTE: board / task / epic / WorkIntent IDs are intentionally absent
 * (plan §13.16, C061). Adding them here is a contract violation.
 */
export interface ExecutionContextEnvelope {
  processRunId: number;
  nodeRunId: number;
  attempt: number;
  executionId: string;
  packageRef: PackageRef;
  nodeRef: NodeRef;
  frozenAuthority: Readonly<Record<string, unknown>>;
  immutableRunInput: unknown;
  upstreamProducts: readonly ProductRef[];
  recoveryFeedback?: RecoveryFeedback;
  scenarioId?: string;
  stageId?: string;
}

/**
 * Base-key guard. The TypeScript type does not declare board/task/epic
 * fields, but canonical JSON would silently drop them rather than reject.
 * This helper exists so a future test (or downstream invariant) can fail a
 * payload that carries one of the forbidden driver-specific keys on the
 * envelope itself.
 */
export const FORBIDDEN_DRIVER_NEUTRAL_KEYS: readonly string[] = [
  'taskId',
  'epicId',
  'projectId',
  'workIntentId',
  'boardId',
] as const;

/**
 * Returns the list of forbidden driver-neutral keys actually present on the
 * candidate envelope (or its `frozenAuthority`). Empty array means clean.
 *
 * Pure utility — does not throw. Used by adapters + tests; the Runtime
 * guards itself with `assertCanonicalSerializable` at the persistence
 * boundary.
 */
export function findForbiddenDriverNeutralKeys(
  candidate: unknown,
): readonly string[] {
  if (candidate === null || typeof candidate !== 'object') return [];
  const obj = candidate as Record<string, unknown>;
  const found: string[] = [];
  for (const k of FORBIDDEN_DRIVER_NEUTRAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) found.push(k);
  }
  // Also scan frozenAuthority (the only nested Record<string, unknown> on
  // the envelope) — board/task ids have historically leaked in there.
  const fa = obj['frozenAuthority'];
  if (fa !== null && typeof fa === 'object') {
    const faObj = fa as Record<string, unknown>;
    for (const k of FORBIDDEN_DRIVER_NEUTRAL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(faObj, k)) {
        found.push(`frozenAuthority.${k}`);
      }
    }
  }
  return found;
}
