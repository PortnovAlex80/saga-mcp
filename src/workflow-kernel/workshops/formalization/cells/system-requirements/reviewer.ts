/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * reviewer.ts - the REVIEWER ROUTE of the derive-system-requirements
 * Production Cell (FRF-WP05): accept / repair over the authored bundle.
 *
 * The reviewer is an independent cognition seat (the
 * formalization.implementation.reviewer launch kind, bound in ./roles.ts).
 * Its route is a PURE function over the same deterministic check surface
 * the gate consumes - the reviewer never invents findings and never
 * accepts what the checks did not pass:
 *
 *   - accept      : every declared check passed (including the WP03
 *                   validation through the seam);
 *   - repair      : a typed finding whose defect belongs to THIS desk
 *                   (malformed members, missing lineage, stale pins,
 *                   coverage gaps) - the author desk is re-staffed;
 *   - upstream-repair : a FOREIGN_LINEAGE finding - the defect belongs to
 *                   the owning upstream material, never a silent scope
 *                   widen (mirroring the workshop gate routing table);
 *   - human-wait  : the WP03 validation is INDETERMINATE (unbound seam);
 *                   a D5 typed wait (TypedWait:human-input) carries the
 *                   operator disposition. The reviewer NEVER accepts on an
 *                   indeterminate validation.
 *
 * PURITY: pure functions. No session, no SQL, no clock.
 */

import type { RequirementsBundle, RequirementsUniverse } from './contract.js';
import type { SeamBinding } from './seam.js';
import { runSystemRequirementsChecks } from './checkplan.js';
import type { CheckIssue } from './checkplan.js';
import { sealBundle } from './bundle.js';

/** The reviewer disposition surface (accept/repair routed by typed findings). */
export type ReviewerDisposition = 'accept' | 'repair' | 'upstream-repair' | 'human-wait';

export interface ReviewerRouteOutcome {
  readonly disposition: ReviewerDisposition;
  /** The sealed bundle reference (accept only). */
  readonly productRef?: string;
  /** The typed findings a repair requeue carries as feedback. */
  readonly issues: readonly CheckIssue[];
  /** The D5 wait descriptor (human-wait only). */
  readonly wait?: { readonly waitKind: 'TypedWait:human-input'; readonly wakeCommands: readonly string[] };
}

/** The typed finding -> route table (mirrors the workshop VERDICT_OF_REASON). */
const ROUTE_OF_REASON: Readonly<Record<CheckIssue['source'], Exclude<ReviewerDisposition, 'accept' | 'human-wait'>>> = {
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'repair',
  SCOPE_VIOLATION: 'upstream-repair',
};

/**
 * Review one authored bundle candidate: run the deterministic checks and
 * route the disposition by the FIRST typed finding (deterministic order:
 * the check order of the CheckPlan). An all-pass run accepts; an
 * indeterminate WP03 validation human-waits; the reviewer never accepts
 * material the checks did not pass.
 */
export function reviewRequirementsBundle(
  candidate: { readonly kind?: unknown; readonly product?: unknown },
  universe: RequirementsUniverse | undefined,
  seam: SeamBinding | undefined,
): ReviewerRouteOutcome {
  const run = runSystemRequirementsChecks(candidate, universe, seam);
  const indeterminate = run.results.find((result) => result.outcome === 'indeterminate');
  if (indeterminate !== undefined) {
    return {
      disposition: 'human-wait',
      issues: run.issues,
      wait: {
        waitKind: 'TypedWait:human-input',
        wakeCommands: ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision'],
      },
    };
  }
  const firstIssue = run.issues[0];
  if (firstIssue === undefined) {
    const sealed = sealBundle(candidate.product as RequirementsBundle);
    return { disposition: 'accept', productRef: sealed.ref, issues: [] };
  }
  return { disposition: ROUTE_OF_REASON[firstIssue.source], issues: run.issues };
}
