import { sha256Hex } from '../../shared/canonical-json.js';
import type { CandidateSetReaderPort } from '../../application/ports/candidate-set-reader.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import type { ContractRef, NodeSubmissionValidator } from './node-submission-policy.js';
import { encodeCheckDiagnostic } from '../domain/workplace/check-diagnostic.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
  type SubmissionValidationReceiptProjection,
} from './submission-validation-receipt-authority.js';

interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function submissionValidatorCheckProviderRef(input: {
  validatorId: string;
  validatorVersion: string;
  nodeId: string;
  contractRef?: ContractRef;
  requireManagedProduction?: boolean;
}) {
  const providerId = `factory.submission-validator.${input.validatorId}`;
  // v2 consumes the exact proof sealed into the production revision. v1
  // re-selected mutable execution ledgers through presenter_ref.
  const version = '2.0.0';
  const providerDigest = sha256Hex({
    providerId,
    version,
    validatorId: input.validatorId,
    validatorVersion: input.validatorVersion,
    nodeId: input.nodeId,
    contractRef: input.contractRef ?? null,
    requireManagedProduction: input.requireManagedProduction === true,
  });
  return { providerId, version, providerDigest } as const;
}

export function submissionValidatorCheckProvider(input: {
  db: DbHandle;
  candidateSets: CandidateSetReaderPort;
  validator: NodeSubmissionValidator;
  nodeId: string;
  contractRef?: ContractRef;
  requireManagedProduction?: boolean;
}): CheckProvider & { readonly providerDigest: string } {
  const ref = submissionValidatorCheckProviderRef({
    validatorId: input.validator.validatorId,
    validatorVersion: input.validator.validatorVersion,
    nodeId: input.nodeId,
    ...(input.contractRef ? { contractRef: input.contractRef } : {}),
    requireManagedProduction: input.requireManagedProduction,
  });
  return {
    ...ref,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author') return 'error';
        const processRunId = Number(parameters.processRunId);
        const moduleRef = String(parameters.moduleRef ?? '');
        if (
          !Number.isSafeInteger(processRunId)
          || processRunId < 1
          || candidate.workplaceRef.processRunId !== processRunId
          || candidate.workplaceRef.moduleRef !== moduleRef
        ) return 'error';

        const revision = input.db.prepare(
          'SELECT members FROM factory_workplace_production_revisions WHERE revision_ref=?',
        ).get(candidate.productionRevisionRef) as { members: string } | undefined;
        if (!revision) return 'error';
        const memberKey = submissionValidationMemberKey({
          validatorId: input.validator.validatorId,
          validatorVersion: input.validator.validatorVersion,
          nodeId: input.nodeId,
        });
        const members = JSON.parse(revision.members) as Array<{
          memberKey: string;
          productRef: string;
          contentDigest: string;
        }>;
        const proofMembers = members.filter(member => member.memberKey === memberKey);
        if (proofMembers.length !== 1) {
          return missingProof(subjectCandidateSetRef, input.validator.validatorId, input.validator.validatorVersion);
        }
        const proof = proofMembers[0];
        const match = /^submission-validation-receipt:(\d+)$/.exec(proof.productRef);
        if (!match) return 'error';
        const row = input.db.prepare(
          `SELECT id AS receiptId,validator_id AS validatorId,
                  validator_version AS validatorVersion,
                  process_run_id AS processRunId,module_ref AS moduleRef,
                  node_id AS nodeId,input_snapshot_hash AS inputSnapshotHash,
                  artifact_ids AS artifactIds,trace_ids AS traceIds,
                  artifact_hashes AS artifactHashes,trace_digest AS traceDigest,
                  contract_ref AS contractRef,validated_set_digest AS validatedSetDigest
             FROM factory_submission_validation_receipts
            WHERE id=?`,
        ).get(Number(match[1])) as Record<string, unknown> | undefined;
        if (!row) return 'error';
        const receipt = decodeReceipt(row);
        if (
          receipt.validatorId !== input.validator.validatorId
          || receipt.validatorVersion !== input.validator.validatorVersion
          || receipt.processRunId !== processRunId
          || receipt.moduleRef !== moduleRef
          || receipt.nodeId !== input.nodeId
          || !sameContract(receipt.contractRef, input.contractRef ?? null)
          || proof.contentDigest !== submissionValidationContentDigest(receipt)
        ) return 'error';
        if (input.requireManagedProduction
          && receipt.artifactIds.length === 0
          && receipt.traceIds.length === 0) {
          return missingProof(subjectCandidateSetRef, input.validator.validatorId, input.validator.validatorVersion);
        }
        return 'passed';
      } catch {
        return 'error';
      }
    },
  };
}

function sameContract(left: ContractRef | null, right: ContractRef | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.version === right.version && left.digest === right.digest;
}

function missingProof(subjectRef: string, validatorId: string, validatorVersion: string) {
  return {
    outcome: 'failed' as const,
    evidenceRefs: [encodeCheckDiagnostic({
      code: 'SUBMISSION_VALIDATION_RECEIPT_REQUIRED',
      message: `The sealed Workplace production revision has no exact ${validatorId}@${validatorVersion} validation proof. Publish the required managed delta and complete worker_done so the kernel can seal its accepted receipt with the material.`,
      subjectRef,
    })],
  };
}

function decodeReceipt(row: Record<string, unknown>): SubmissionValidationReceiptProjection {
  return {
    receiptId: Number(row.receiptId),
    validatorId: String(row.validatorId),
    validatorVersion: String(row.validatorVersion),
    processRunId: Number(row.processRunId),
    moduleRef: String(row.moduleRef),
    nodeId: String(row.nodeId),
    inputSnapshotHash: String(row.inputSnapshotHash),
    artifactIds: JSON.parse(String(row.artifactIds)) as number[],
    traceIds: JSON.parse(String(row.traceIds)) as number[],
    artifactHashes: JSON.parse(String(row.artifactHashes)) as Record<string, string>,
    traceDigest: String(row.traceDigest),
    contractRef: row.contractRef === null
      ? null
      : JSON.parse(String(row.contractRef)) as ContractRef,
    validatedSetDigest: String(row.validatedSetDigest),
  };
}
