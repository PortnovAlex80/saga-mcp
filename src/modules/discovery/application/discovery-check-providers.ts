import type {
  CheckProvider,
  CheckProviderResult,
} from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import { encodeCheckDiagnostic } from '../../../process-modules/domain/workplace/check-diagnostic.js';
import {
  DISCOVERY_PROPOSAL_SCHEMA,
  validateDiscoveryProposal,
} from '../domain/discovery-proposal.js';
import {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  validateReadinessAssessment,
} from '../domain/discovery-readiness-assessment.js';

export const DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID =
  'discovery.proposal-contract.v1';
export const DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION = '1.0.0';
export const DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID,
  version: DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION,
  invariant: 'discovery-proposal-schema-and-required-fields',
});

export const DISCOVERY_READINESS_CHECK_PROVIDER_ID =
  'discovery.readiness-contract.v1';
export const DISCOVERY_READINESS_CHECK_PROVIDER_VERSION = '1.0.0';
export const DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DISCOVERY_READINESS_CHECK_PROVIDER_ID,
  version: DISCOVERY_READINESS_CHECK_PROVIDER_VERSION,
  invariant: 'readiness-binds-exact-accepted-proposal-and-cites-only-allowed-sources',
});

interface SubmissionRow {
  id: number;
  process_run_id: number;
  node_id: string;
  execution_id: string;
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
}

export function createDiscoveryProposalCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID,
    version: DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION,
    providerDigest: DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef }) {
      const row = producerSubmission(input.db, input.candidateSets, subjectCandidateSetRef);
      if (!row || row.schema_version !== DISCOVERY_PROPOSAL_SCHEMA) {
        return contractFailure('proposal-contract-invalid', subjectCandidateSetRef, [
          'the author submission is missing from the desk or its schema is not '
          + `${DISCOVERY_PROPOSAL_SCHEMA}`,
        ]);
      }
      try {
        const validation = validateDiscoveryProposal(JSON.parse(row.payload_snapshot));
        return validation.valid
          ? 'passed'
          : contractFailure(
            'proposal-contract-invalid',
            subjectCandidateSetRef,
            validation.errors,
          );
      } catch {
        return 'error';
      }
    },
  };
}

export function createDiscoveryReadinessCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DISCOVERY_READINESS_CHECK_PROVIDER_ID,
    version: DISCOVERY_READINESS_CHECK_PROVIDER_VERSION,
    providerDigest: DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const readiness = producerSubmission(
          input.db,
          input.candidateSets,
          subjectCandidateSetRef,
        );
        const processRunId = Number(parameters.processRunId);
        if (
          !readiness
          || readiness.schema_version !== DISCOVERY_READINESS_ASSESSMENT_SCHEMA
          || !Number.isSafeInteger(processRunId)
          || processRunId < 1
        ) {
          return contractFailure('readiness-contract-invalid', subjectCandidateSetRef, [
            !readiness
              ? 'the author submission is missing from the desk'
              : readiness.schema_version !== DISCOVERY_READINESS_ASSESSMENT_SCHEMA
                ? `the submission schema is ${readiness.schema_version}, not `
                  + DISCOVERY_READINESS_ASSESSMENT_SCHEMA
                : `check parameters must carry a positive integer processRunId, got `
                  + `${JSON.stringify(parameters.processRunId)}`,
          ]);
        }
        const assessment = JSON.parse(readiness.payload_snapshot) as Record<string, unknown>;
        const proposalId = assessment.proposal_id;
        const proposalHash = assessment.proposal_content_hash;
        if (
          !Number.isSafeInteger(proposalId)
          || Number(proposalId) < 1
          || typeof proposalHash !== 'string'
        ) {
          return contractFailure('readiness-contract-invalid', subjectCandidateSetRef, [
            'field \'proposal_id\' must be a positive integer and '
              + '\'proposal_content_hash\' must be a string binding the readiness '
              + 'assessment to the exact accepted proposal version',
          ]);
        }
        const proposal = input.db.prepare(
          `SELECT id,content_hash,payload_snapshot
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=? AND node_id='produce-proposal'
              AND schema_version=? AND content_hash=?`,
        ).get(proposalId, processRunId, DISCOVERY_PROPOSAL_SCHEMA, proposalHash) as {
          id: number;
          content_hash: string;
          payload_snapshot: string;
        } | undefined;
        if (!proposal) return 'error';
        const proposalPayload = JSON.parse(proposal.payload_snapshot) as Record<string, unknown>;
        const allowedRefs = allowedProposalSourceRefs(proposalPayload);
        const validation = validateReadinessAssessment(
          assessment,
          proposal.id,
          proposal.content_hash,
          allowedRefs,
        );
        return validation.valid
          ? 'passed'
          : contractFailure(
            'readiness-contract-invalid',
            subjectCandidateSetRef,
            validation.errors,
          );
      } catch {
        return 'error';
      }
    },
  };
}

export function allowedProposalSourceRefs(
  proposal: Readonly<Record<string, unknown>>,
): string[] {
  const refs = new Set<string>();
  for (const key of Object.keys(proposal)) refs.add(`$.${key}`);
  const evidence = proposal.evidence_refs;
  if (Array.isArray(evidence)) {
    for (const ref of evidence) if (typeof ref === 'string' && ref.trim()) refs.add(ref);
  }
  return [...refs].sort();
}

/**
 * WHY: a bare `'failed'` discards the validator's already-computed `errors[]`,
 * leaving the repair worker with only "Check X returned failed." Every failure
 * must carry one encoded diagnostic per validator error so the recovery
 * feedback loop can decode the exact reasons onto the worker's desk.
 */
function contractFailure(
  code: 'proposal-contract-invalid' | 'readiness-contract-invalid',
  subjectRef: string,
  messages: readonly string[],
): CheckProviderResult {
  const errors = messages.filter(message => typeof message === 'string' && message.trim());
  if (errors.length === 0) errors.push(`${code}: the submission is invalid`);
  return {
    outcome: 'failed',
    evidenceRefs: errors.map(message =>
      encodeCheckDiagnostic({ code, message, subjectRef })),
  };
}

function producerSubmission(
  db: SqlDatabasePort,
  candidateSets: CandidateSetReaderPort,
  candidateSetRef: string,
): SubmissionRow | null {  const candidate = candidateSets.read(candidateSetRef);
  if (!candidate || candidate.role !== 'author' || candidate.members.length === 0) return null;
  // ADR-053 cutover: resolve the submission by EXACT CandidateSet member
  // productRef digest, NOT by execution_id. The member's digest IS the sealed
  // content authority.
  const member = candidate.members[0]!;
  if (!member.productRef.ref.startsWith('managed-node-submission:')) return null;
  const submissionId = Number(member.productRef.ref.slice('managed-node-submission:'.length));
  if (!Number.isSafeInteger(submissionId) || submissionId < 1) return null;
  const row = db.prepare(
    `SELECT id,process_run_id,node_id,execution_id,schema_version,payload_snapshot,content_hash
       FROM factory_managed_node_submissions
      WHERE id=? AND process_run_id=? AND schema_version=? AND content_hash=?`,
  ).get(
    submissionId,
    candidate.workplaceRef.processRunId,
    member.productRef.schemaId,
    member.productRef.digest,
  ) as
    SubmissionRow | undefined;
  return row ?? null;
}
