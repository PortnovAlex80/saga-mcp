/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/protocol.mjs -
 * the FRF-WP07 desk protocol of the WHAT-freeze kernel node and its
 * settlement successor (plan §"Desk contracts" / freeze-what-baseline and
 * settle-formalization; plan §"Target process graph").
 *
 * THE PROTOCOL (what the desk consumes and emits; deterministic):
 *
 *   freeze-what-baseline (kernel node, operator staffed)
 *     INPUT   = ALL upstream accepted surfaces, carried exactly:
 *               case identity pins; source claim/constraint/terminal-claim
 *               manifests; one CellFinalAcceptance + CandidateSet +
 *               WorkplaceProductionRevision ref per accepted pre-freeze
 *               desk; the six member containers with their accepted
 *               member/branch ids AND digests and their accepted revision
 *               pins; the accepted trace set; the five disposition
 *               sections; the evidence-method bindings; the Development
 *               handoff/obligation resolution surface.
 *     OUTPUT  = one sealed `frf-contracts.what-baseline.v1` payload - the
 *               whole-WHAT baseline - validating via the FRF-WP03 typed
 *               validator against the exact accepted universe derived
 *               from the SAME surfaces (fail-closed; never a scan, never
 *               a reselection, never a reparse of mutable documents).
 *
 *   settle-formalization (kernel node, operator staffed)
 *     INPUT   = the FROZEN baseline artifact (exact) + the accepted SRS
 *               revision + the typed Development handoff values.
 *     OUTPUT  = the settlement ladder products: authority pins, the
 *               binding-resolution record, and the sealed
 *               `frf-contracts.solution-contract.v1` whose handoff
 *               bindings resolve against the FROZEN baseline's exact id
 *               sets (cr-02: FOREIGN_LINEAGE refusal otherwise - the
 *               UC-FOREIGN kill at the contract level, ledger D-1).
 *
 * DESK OUTCOME ROUTING (deterministic, the CheckPlan's declared table):
 *   - validator/ingestion DRIFT_DETECTED => desk outcome `drift-detected`
 *     (the domain.drift-detected transition) BUT ONLY AFTER the freeze-
 *     drift human decision: a TypedWait:effect-uncertainty (D12 vocabulary
 *     only - operator disposition receipt, never an automatic redrive).
 *   - INDETERMINATE (the exact accepted id sets / pins were not carried
 *     by the transition; fail-closed MISSING_LINEAGE) => desk outcome
 *     `indeterminate`: a TypedWait:human-input (D5) discharged by the
 *     frozen wake commands only. The freezer never guesses the universe.
 *   - FOREIGN_LINEAGE => `upstream-repair` (the defect belongs to the
 *     owning upstream material; never a silent scope widen).
 *   - MALFORMED_PRODUCT / COVERAGE_GAP / SCOPE_VIOLATION / STALE_LINEAGE
 *     => `repair` (the desk re-runs on corrected surfaces).
 *   Settlement: FOREIGN_LINEAGE / STALE_LINEAGE / DRIFT_DETECTED =>
 *     `inconsistent` (domain.inconsistent); MALFORMED_PRODUCT /
 *     MISSING_LINEAGE => `failed` (domain.failed); success =>
 *     `formalized` (domain.formalized).
 *
 * PURITY: pure data + pure lookups. No I/O, no session, no clock.
 */

import { CONTRACT_KIND } from './shared.mjs';

/* ------------------------------------------------------------------ */
/* Node and product identities (data; cross-checked against the         */
/* installed manifest by the blocking cell-contracts test)              */
/* ------------------------------------------------------------------ */

export const FREEZE_NODE_ID = 'freeze-what-baseline';
export const SETTLE_NODE_ID = 'settle-formalization';

/** The replacement whole-WHAT baseline product kind (the WP03 contract identity). */
export const WHAT_BASELINE_PRODUCT_KIND = CONTRACT_KIND;

/** The WP07 settlement output contract identity. */
export const SOLUTION_CONTRACT_PRODUCT_KIND = 'frf-contracts.solution-contract.v1';

/** The post-acceptance effect ids the two kernel desks settle (manifest-declared). */
export const FREEZE_EFFECT_ID = 'formalization.freeze-what-baseline';
export const SETTLE_EFFECT_ID = 'formalization.settle-solution-contract';

/** The closed five-desk pre-freeze acceptance vocabulary (reverse edge/0073). */
export const PRE_FREEZE_DESKS = Object.freeze([
  'define-acceptance-contract',
  'define-product-intent',
  'derive-system-requirements',
  'model-use-cases',
  'reconcile-what',
]);

/** The freeze desk's output transitions (plan §"Expected transition universe"). */
export const FREEZE_TRANSITIONS = Object.freeze([
  { from: FREEZE_NODE_ID, on: 'domain.frozen', to: 'define-architecture-contract' },
  { from: FREEZE_NODE_ID, on: 'domain.drift-detected', to: 'complete-inconsistent' },
  { from: FREEZE_NODE_ID, on: 'domain.failed', to: 'complete-failed' },
]);

/** The settle desk's output transitions. */
export const SETTLE_TRANSITIONS = Object.freeze([
  { from: SETTLE_NODE_ID, on: 'domain.formalized', to: 'complete-formalized' },
  { from: SETTLE_NODE_ID, on: 'domain.inconsistent', to: 'complete-inconsistent' },
  { from: SETTLE_NODE_ID, on: 'domain.failed', to: 'complete-failed' },
]);

/* ------------------------------------------------------------------ */
/* Desk outcome kinds                                                  */
/* ------------------------------------------------------------------ */

export const FREEZE_OUTCOMES = Object.freeze([
  'frozen',
  'drift-detected',
  'indeterminate',
  'upstream-repair',
  'repair',
  'failed',
]);

export const SETTLE_OUTCOMES = Object.freeze([
  'formalized',
  'inconsistent',
  'failed',
]);

/** The typed wait descriptors the desks may open (D5/D12 vocabulary only). */
export const FREEZE_WAIT_KINDS = Object.freeze({
  driftDecision: 'TypedWait:effect-uncertainty',
  indeterminate: 'TypedWait:human-input',
});

/* ------------------------------------------------------------------ */
/* Deterministic refusal routing (the declared table, never a guess)    */
/* ------------------------------------------------------------------ */

/** The freeze desk's refusal-reason -> outcome routing (frozen table). */
export const FREEZE_OUTCOME_OF_REASON = Object.freeze({
  DRIFT_DETECTED: 'drift-detected',
  MISSING_LINEAGE: 'indeterminate',
  FOREIGN_LINEAGE: 'upstream-repair',
  MALFORMED_PRODUCT: 'repair',
  COVERAGE_GAP: 'repair',
  SCOPE_VIOLATION: 'repair',
  STALE_LINEAGE: 'repair',
});

/** The settle desk's refusal-reason -> outcome routing (frozen table). */
export const SETTLE_OUTCOME_OF_REASON = Object.freeze({
  FOREIGN_LINEAGE: 'inconsistent',
  STALE_LINEAGE: 'inconsistent',
  DRIFT_DETECTED: 'inconsistent',
  MALFORMED_PRODUCT: 'failed',
  MISSING_LINEAGE: 'failed',
  COVERAGE_GAP: 'inconsistent',
  SCOPE_VIOLATION: 'failed',
});

/** Route one typed refusal reason through a declared table (fail-closed on unknown). */
export function routeRefusal(table, reason) {
  const outcome = table[reason];
  if (outcome === undefined) {
    return { detail: `reason ${String(reason)} has no declared route in this desk's table`, ok: false, reason: 'SCOPE_VIOLATION', refused: true };
  }
  return { ok: true, outcome };
}

/** The freeze desk's domain transition of one outcome (fail-closed lookup). */
export function freezeTransitionOf(outcome) {
  switch (outcome) {
    case 'frozen': return { ok: true, on: 'domain.frozen' };
    case 'drift-detected': return { ok: true, on: 'domain.drift-detected' };
    case 'failed': return { ok: true, on: 'domain.failed' };
    // repair/upstream-repair/indeterminate stay INSIDE the desk: the desk
    // re-runs on corrected surfaces or waits (D5/D12); no domain edge fires.
    case 'upstream-repair':
    case 'repair':
    case 'indeterminate':
      return { ok: true, on: null };
    default:
      return { detail: `outcome ${String(outcome)} is not a freeze desk outcome`, ok: false, reason: 'SCOPE_VIOLATION', refused: true };
  }
}

/** The settle desk's domain transition of one outcome (fail-closed lookup). */
export function settleTransitionOf(outcome) {
  switch (outcome) {
    case 'formalized': return { ok: true, on: 'domain.formalized' };
    case 'inconsistent': return { ok: true, on: 'domain.inconsistent' };
    case 'failed': return { ok: true, on: 'domain.failed' };
    default:
      return { detail: `outcome ${String(outcome)} is not a settle desk outcome`, ok: false, reason: 'SCOPE_VIOLATION', refused: true };
  }
}
