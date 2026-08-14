import { sha256Hex } from '../../shared/canonical-json.js';
import type { ContractRef } from './node-submission-policy.js';

/**
 * Exact durable validator proof that is presented as part of a sealed
 * WorkplaceProductionRevision. Execution/task coordinates remain on the
 * receipt row for audit, but are deliberately excluded from material identity.
 */
export interface SubmissionValidationReceiptProjection {
  readonly receiptId: number;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly inputSnapshotHash: string;
  readonly artifactIds: readonly number[];
  readonly traceIds: readonly number[];
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly traceDigest: string;
  readonly contractRef: ContractRef | null;
  readonly validatedSetDigest: string;
}

export function submissionValidationMemberKey(input: {
  validatorId: string;
  validatorVersion: string;
  nodeId: string;
}): string {
  return `validation/${input.validatorId}/${input.validatorVersion}/${input.nodeId}`;
}

/**
 * Material identity for a successful validation. Row ids, execution ids,
 * task ids and timestamps are audit provenance and cannot affect acceptance.
 */
export function submissionValidationContentDigest(
  receipt: Omit<SubmissionValidationReceiptProjection, 'receiptId'>,
): string {
  return sha256Hex({
    validatorId: receipt.validatorId,
    validatorVersion: receipt.validatorVersion,
    processRunId: receipt.processRunId,
    moduleRef: receipt.moduleRef,
    nodeId: receipt.nodeId,
    inputSnapshotHash: receipt.inputSnapshotHash,
    artifactIds: [...receipt.artifactIds].sort((a, b) => a - b),
    traceIds: [...receipt.traceIds].sort((a, b) => a - b),
    artifactHashes: receipt.artifactHashes,
    traceDigest: receipt.traceDigest,
    contractRef: receipt.contractRef,
    validatedSetDigest: receipt.validatedSetDigest,
  });
}
