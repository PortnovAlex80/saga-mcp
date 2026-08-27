/**
 * workflow-kernel/workshops/formalization/cells/use-cases/reviewer.ts -
 * the independent reviewer of the model-use-cases Cell (FRF-WP04).
 *
 * Closed accept/repair verdicts over the GATE OUTCOME (never the raw
 * product): a non-accepted gate can never be reviewed into acceptance;
 * a refused gate has nothing to review (typed refusal). Mirrors
 * ../product-intent/reviewer.ts.
 */

import type { CellGateOutcome, CellGateRefusal, CellGateIssue } from './gate.js';
import { obligationRoutingOf } from './gate.js';

export const UC_REVIEWER_SKILL_ID = 'frf-cell-use-cases-reviewer';

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
export function reviewUcGate(outcome: CellGateOutcome | CellGateRefusal): ReviewerDecision | ReviewerRefusal {
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
