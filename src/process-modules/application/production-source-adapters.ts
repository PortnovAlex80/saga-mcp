// ADR-067 / ADR-053 B-7 — the sole runtime material adapter.
//
// Physical ingress is resolved and validated before this boundary. Revision
// assembly receives only exact ProductRefs and therefore cannot branch on
// worker tool, storage table, Git, evidence, or carry-forward provenance.

import {
  buildContribution,
  productRevisionMemberKey,
  type MemberOperation,
  type WorkplaceContribution,
} from '../domain/workplace/workplace-production-revision.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
  type SubmissionValidationReceiptProjection,
} from './submission-validation-receipt-authority.js';

export interface CanonicalProductRef {
  readonly schemaId: string;
  readonly ref: string;
  readonly digest: string;
}

/**
 * Normalize exact ProductRefs to a partition-invariant Workplace contribution.
 * Row aliases stay as audit provenance; schema+ordinal and content digest are
 * the accepted material coordinates.
 */
export function canonicalProductsToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  products: readonly CanonicalProductRef[];
  validationReceipts?: readonly SubmissionValidationReceiptProjection[];
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const schemaOrdinals = new Map<string, number>();
  const operations: MemberOperation[] = [...input.products]
    .sort((a, b) => a.schemaId.localeCompare(b.schemaId)
      || a.digest.localeCompare(b.digest))
    .map(product => {
      const ordinal = schemaOrdinals.get(product.schemaId) ?? 0;
      schemaOrdinals.set(product.schemaId, ordinal + 1);
      return {
        op: 'put' as const,
        memberKey: productRevisionMemberKey(product.schemaId, ordinal),
        productRef: product.ref,
        contentDigest: product.digest,
        sourceAdapter: 'product-ref' as const,
      };
    });
  for (const receipt of input.validationReceipts ?? []) {
    operations.push({
      op: 'put',
      memberKey: submissionValidationMemberKey(receipt),
      productRef: `submission-validation-receipt:${receipt.receiptId}`,
      contentDigest: submissionValidationContentDigest(receipt),
      sourceAdapter: 'evidence',
    });
  }
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'product-ref',
    operations,
    parentContributionRef: input.parentContributionRef ?? null,
  });
}
