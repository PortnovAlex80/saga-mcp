/**
 * workflow-kernel/workshops/discovery/contributions.ts - the PURE
 * contribution mappings of the Discovery workshop (WP-11D): input products
 * -> contributions -> production revisions through the kernel's material
 * chain.
 *
 * Chain law (ADR-053, decision 053): the Workplace production revision is
 * the accepted-material authority; the ActivityAttempt is provenance. The
 * mappings below are pure functions of product VALUES - the driver applies
 * their outputs through workplace.recordContribution ->
 * workplace.sealProductionRevision; the sealed revision (never the attempt)
 * is what gates, effects and acceptance bind.
 *
 *   idea (input product)
 *     -> draftBriefFromIdea (pure derivation)
 *     -> mapAuthorContribution (brief product: shape + lineage to the idea)
 *     -> mapReviewerContribution (intent product: lineage to the SEALED brief)
 *
 * Every mapping failure is typed (closed set) and names the exact break:
 *   MALFORMED_PRODUCT  a product fails its installed contract;
 *   LINEAGE_BREAK      a lineage ref does not bind its upstream product;
 *   CONTRACT_MISMATCH  a product claims a contract it does not satisfy.
 *
 * PURITY: sibling pure modules only. No I/O, no clock, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import {
  BRIEF_CONTRACT,
  INTENT_CONTRACT,
  productContractOf,
  sealProduct,
  validateProduct,
  type SealedProduct,
} from './products.js';

/* ------------------------------------------------------------------ */
/* The pure idea -> brief derivation                                   */
/* ------------------------------------------------------------------ */

/** Derive the brief DRAFT from the admitted idea (pure; the actor authors from it). */
export function draftBriefFromIdea(idea: SealedProduct): Record<string, unknown> {
  return {
    schemaVersion: BRIEF_CONTRACT.schemaVersion,
    briefId: `brief-of-${String(idea.value.ideaId)}`,
    problem: String(idea.value.statement),
    outcome: String(idea.value.outcomeWish),
    constraints: [...(Array.isArray(idea.value.constraints) ? idea.value.constraints.map(String) : [])],
    openQuestions: [...(Array.isArray(idea.value.unknowns) ? idea.value.unknowns.map(String) : [])],
    ideaRef: idea.ref,
  };
}

/** Derive the intent DRAFT from the sealed brief + the decision (pure). */
export function draftIntentFromBrief(brief: SealedProduct, decision: 'go' | 'no-go' | 'needs-human', rationale: string): Record<string, unknown> {
  return {
    schemaVersion: INTENT_CONTRACT.schemaVersion,
    intentId: `intent-for-${String(brief.value.briefId)}`,
    decision,
    rationale,
    briefRef: brief.ref,
    targetStageRoute: 'solution-formalization',
  };
}

/* ------------------------------------------------------------------ */
/* Typed mapping refusals (closed set)                                 */
/* ------------------------------------------------------------------ */

export type ContributionRefusalReason =
  | 'MALFORMED_PRODUCT'
  | 'LINEAGE_BREAK'
  | 'CONTRACT_MISMATCH';

export interface ContributionRefusal {
  readonly refused: true;
  readonly reason: ContributionRefusalReason;
  readonly detail: string;
}

/** The mapped contribution the driver records (recordContribution payload). */
export interface MappedContribution {
  readonly contributionRef: string;
  readonly productRefs: readonly string[];
  readonly payloadDigest: string;
  readonly description: string;
}

export type ContributionMapping =
  | { readonly mapped: true; readonly contribution: MappedContribution }
  | ContributionRefusal;

const refusal = (reason: ContributionRefusalReason, detail: string): ContributionRefusal => ({ refused: true, reason, detail });

/** Deterministic contribution ref over the mapped products (the ONE kernel digest rule). */
function contributionRefOf(parts: readonly unknown[]): string {
  return `sha256:${sha256OfCanonical(parts)}`;
}

/* ------------------------------------------------------------------ */
/* The mappings                                                        */
/* ------------------------------------------------------------------ */

/**
 * Map the AUTHOR contribution: the brief product over the admitted idea.
 * Fences: the brief satisfies its contract, and its ideaRef binds the
 * EXACT admitted idea product (lineage is content-addressed, never named).
 */
export function mapAuthorContribution(idea: SealedProduct, brief: SealedProduct): ContributionMapping {
  const ideaShape = validateProduct(idea.value);
  if ('refused' in ideaShape) {
    return refusal('MALFORMED_PRODUCT', `idea product ${ideaShape.reason}(${ideaShape.field}): ${ideaShape.detail}`);
  }
  if (ideaShape.contract.contractId !== 'idea-intake') {
    return refusal('CONTRACT_MISMATCH', `the input product claims contract ${ideaShape.contract.contractId}, expected idea-intake`);
  }
  const briefShape = validateProduct(brief.value);
  if ('refused' in briefShape) {
    return refusal('MALFORMED_PRODUCT', `brief product ${briefShape.reason}(${briefShape.field}): ${briefShape.detail}`);
  }
  if (briefShape.contract.contractId !== 'brief') {
    return refusal('CONTRACT_MISMATCH', `the author product claims contract ${briefShape.contract.contractId}, expected brief`);
  }
  if (brief.value.ideaRef !== idea.ref) {
    return refusal('LINEAGE_BREAK', `the brief pins idea ${String(brief.value.ideaRef)} but the admitted idea is ${idea.ref}`);
  }
  return {
    mapped: true,
    contribution: {
      contributionRef: contributionRefOf(['author', idea.ref, brief.ref]),
      productRefs: [idea.ref, brief.ref],
      payloadDigest: brief.digest,
      description: `brief ${String(brief.value.briefId)} authored from idea ${String(idea.value.ideaId)}`,
    },
  };
}

/**
 * Map the REVIEWER contribution: the intent product over the SEALED brief
 * revision. Fences: contract shape, decision legality and the
 * briefRef -> sealed-brief content address lineage.
 */
export function mapReviewerContribution(brief: SealedProduct, intent: SealedProduct): ContributionMapping {
  const briefShape = validateProduct(brief.value);
  if ('refused' in briefShape) {
    return refusal('MALFORMED_PRODUCT', `brief product ${briefShape.reason}(${briefShape.field}): ${briefShape.detail}`);
  }
  const intentShape = validateProduct(intent.value);
  if ('refused' in intentShape) {
    return refusal('MALFORMED_PRODUCT', `intent product ${intentShape.reason}(${intentShape.field}): ${intentShape.detail}`);
  }
  if (intentShape.contract.contractId !== 'intent') {
    return refusal('CONTRACT_MISMATCH', `the reviewer product claims contract ${intentShape.contract.contractId}, expected intent`);
  }
  if (intent.value.briefRef !== brief.ref) {
    return refusal('LINEAGE_BREAK', `the intent pins brief ${String(intent.value.briefRef)} but the sealed brief revision is ${brief.ref}`);
  }
  return {
    mapped: true,
    contribution: {
      contributionRef: contributionRefOf(['reviewer', brief.ref, intent.ref]),
      productRefs: [brief.ref, intent.ref],
      payloadDigest: intent.digest,
      description: `intent ${String(intent.value.intentId)} decided ${String(intent.value.decision)} over brief ${String(brief.value.briefId)}`,
    },
  };
}

/** Seal a drafted product value (the actors/products test oracle). */
export function sealDraftedProduct(draft: Record<string, unknown>): SealedProduct {
  const shape = validateProduct(draft);
  if ('refused' in shape) {
    throw new TypeError(`drafted product does not satisfy its contract: ${shape.reason}(${shape.field}): ${shape.detail}`);
  }
  void productContractOf(shape.contract.schemaVersion);
  return sealProduct(draft);
}
