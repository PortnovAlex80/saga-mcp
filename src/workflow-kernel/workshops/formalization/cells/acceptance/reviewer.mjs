/**
 * FRF-WP06 define-acceptance-contract cell - THE REVIEWER CONTRACT.
 *
 * The reviewer of this desk re-runs the SAME declared deterministic
 * provider as the author gate (gates.ts law: one declared provider per
 * desk; a reviewer can never soften a check). The reviewer's own duties
 * are the adversarial re-derivations the pure validator cannot do for
 * the author: re-derive each criterion's citation pair from the bound
 * requirement's derivation, re-check the deferral reasons, and escalate
 * FOREIGN_LINEAGE upstream (never widen scope).
 *
 * PURITY: pure data + pure functions. No I/O.
 */

import { ACCEPTANCE_CELL_NODE_ID } from './protocol.mjs';
import { ACCEPTANCE_CHECK_PROVIDER } from './check-plan.mjs';

/** The reviewer route of this desk (one declared provider, re-run). */
export const ACCEPTANCE_REVIEWER_ROUTE = Object.freeze({
  desk: ACCEPTANCE_CELL_NODE_ID,
  providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
  policy: 'same-provider-recheck',
  softening: 'none - the reviewer gate runs the identical declared provider; verdicts are a pure function of (provider, candidate, accepted chain)',
});

/** The reviewer checklist (adversarial re-derivations). */
export const ACCEPTANCE_REVIEWER_CHECKLIST = Object.freeze([
  Object.freeze({
    dutyId: 'rev-1',
    duty: 'Re-derive every scenario-facing criterion citation pair from the bound requirement derivation: the cited scenario and branch must be the material the requirement derives from.',
  }),
  Object.freeze({
    dutyId: 'rev-2',
    duty: 'Re-read every deferral reason: a deferral without a substantive owner and reason is refused, not negotiated.',
  }),
  Object.freeze({
    dutyId: 'rev-3',
    duty: 'FOREIGN_LINEAGE findings route upstream-repair to the owning cell (requirements or UC); the reviewer never widens a scope or patches accepted material.',
  }),
  Object.freeze({
    dutyId: 'rev-4',
    duty: 'AC-complete but scenario-stripped candidates are the primary adversarial probe: keep AC coverage, remove the terminal scenario binding - it must be refused.',
  }),
]);

/**
 * Resolve the reviewer route for a launch kind (fail-closed: an unknown
 * launch kind never reviews this desk).
 */
export function reviewerRouteOf(launchKind) {
  if (launchKind === 'formalization.implementation.reviewer') {
    return { ok: true, route: ACCEPTANCE_REVIEWER_ROUTE };
  }
  return {
    ok: false,
    reason: 'ROLE_NOT_BOUND',
    detail: `launch kind ${String(launchKind)} is not the reviewer binding of desk ${ACCEPTANCE_CELL_NODE_ID} (fail-closed)`,
  };
}
