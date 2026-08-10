import type { CheckProvider } from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
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
    run({ subjectCandidateSetRef }) {
      const row = producerSubmission(input.db, input.candidateSets, subjectCandidateSetRef);
      if (!row || row.schema_version !== DISCOVERY_PROPOSAL_SCHEMA) return 'failed';
      try {
        return validateDiscoveryProposal(JSON.parse(row.payload_snapshot)).valid
          ? 'passed'
          : 'failed';
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
        ) return 'failed';
        const proposal = input.db.prepare(
          `SELECT id,content_hash,payload_snapshot
             FROM factory_managed_node_submissions
            WHERE process_run_id=? AND node_id='produce-proposal'
              AND schema_version=?
            ORDER BY id DESC LIMIT 1`,
        ).get(processRunId, DISCOVERY_PROPOSAL_SCHEMA) as {
          id: number;
          content_hash: string;
          payload_snapshot: string;
        } | undefined;
        if (!proposal) return 'error';
        const proposalPayload = JSON.parse(proposal.payload_snapshot) as Record<string, unknown>;
        const allowedRefs = allowedProposalSourceRefs(proposalPayload);
        const assessment = JSON.parse(readiness.payload_snapshot);
        return validateReadinessAssessment(
          assessment,
          proposal.id,
          proposal.content_hash,
          allowedRefs,
        ).valid ? 'passed' : 'failed';
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

function producerSubmission(
  db: SqlDatabasePort,
  candidateSets: CandidateSetReaderPort,
  candidateSetRef: string,
): SubmissionRow | null {
  const candidate = candidateSets.read(candidateSetRef);
  if (!candidate || candidate.role !== 'author') return null;
  const row = db.prepare(
    `SELECT id,process_run_id,node_id,execution_id,schema_version,payload_snapshot,content_hash
       FROM factory_managed_node_submissions
      WHERE process_run_id=? AND execution_id=?
      ORDER BY id DESC LIMIT 1`,
  ).get(candidate.workplaceRef.processRunId, candidate.producerExecutionRef) as
    SubmissionRow | undefined;
  return row ?? null;
}
