/**
 * workflow-kernel/workshops/formalization/cells/product-intent/reviewer.ts -
 * the independent reviewer of the define-product-intent Cell (FRF-WP04).
 *
 * The reviewer consumes the GATE OUTCOME, never the raw product: its two
 * lawful verdicts are the closed accept/repair pair. A non-accepted gate
 * can never be reviewed into acceptance (the reviewer adds judgment
 * about routing and feedback, not a second validity oracle); a refused
 * gate (infrastructure miss) has nothing to review - a typed refusal.
 */

import type { CellGateOutcome, CellGateRefusal, CellGateIssue } from './gate.js';
import { obligationRoutingOf } from './gate.js';

export const PRODUCT_INTENT_REVIEWER_SKILL_ID = 'frf-cell-product-intent-reviewer';

/** The reviewer's closed verdict vocabulary. */
export type ReviewerVerdict = 'accept' | 'repair';

export interface ReviewerDecision {
  readonly verdict: ReviewerVerdict;
  readonly reviewedProviderId: string;
  readonly productRef?: string;
  /** The typed repair feedback a requeue carries (gate issues, verbatim). */
  readonly feedback: readonly CellGateIssue[];
  /** The obligation routing the desk driver follows for this verdict. */
  readonly obligationRouting: ReturnType<typeof obligationRoutingOf>;
}

export interface ReviewerRefusal {
  readonly refused: true;
  readonly reason: 'GATE_REFUSED_NOTHING_TO_REVIEW';
  readonly detail: string;
}

/** Review one gate outcome (accept, or repair with typed feedback). */
export function reviewProductIntentGate(outcome: CellGateOutcome | CellGateRefusal): ReviewerDecision | ReviewerRefusal {
  if ('refused' in outcome) {
    return {
      refused: true,
      reason: 'GATE_REFUSED_NOTHING_TO_REVIEW',
      detail: `the gate refused (${outcome.reason}): there is no evaluated product to review; repair the gate input first - ${outcome.detail}`,
    };
  }
  if (outcome.verdict === 'accepted') {
    return {
      verdict: 'accept',
      reviewedProviderId: outcome.providerId,
      productRef: outcome.productRef,
      feedback: [],
      obligationRouting: obligationRoutingOf('accepted'),
    };
  }
  return {
    verdict: 'repair',
    reviewedProviderId: outcome.providerId,
    feedback: outcome.issues,
    obligationRouting: obligationRoutingOf(outcome.verdict),
  };
}
