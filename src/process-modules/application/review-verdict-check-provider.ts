import type Database from 'better-sqlite3';
import type { SqliteCandidateSetRepository } from '../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import { encodeCheckDiagnostic } from '../domain/workplace/check-diagnostic.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  productPayloadContractDigest,
  type ProductPayloadContract,
} from './product-payload-contract.js';

export const REVIEW_VERDICT_CHECK_PROVIDER_ID = 'factory.review-verdict.v1';
export const REVIEW_VERDICT_CHECK_PROVIDER_VERSION = '1.1.0';
export const REVIEW_VERDICT_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
  version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
  invariant: 'review-product-binds-exact-author-candidate-and-approves-it',
});

export const FACTORY_REVIEW_VERDICT_SCHEMA = 'factory.review-verdict.v1';
export const FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID =
  'factory.review-verdict-payload.v1';
export const FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION = '1.1.0';
export const FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  required: ['subject_candidate_set_ref', 'verdict', 'findings'],
  subjectCandidateSetRef: 'candidate-set-ref',
  verdict: ['approved', 'changes_requested'],
  findings: 'non-empty-string-or-bounded-finding-object-array',
} as const;
export const FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: FACTORY_REVIEW_VERDICT_SCHEMA,
    contractId: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
    version: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
    definition: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  });

export interface FactoryReviewVerdictProduct {
  readonly subject_candidate_set_ref: string;
  readonly verdict: 'approved' | 'changes_requested';
  readonly findings: readonly (string | {
    readonly message: string;
    readonly severity?: string;
    readonly subjectRef?: string;
  })[];
}

function isReviewFinding(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  return typeof finding.message === 'string' && finding.message.trim().length > 0
    && (finding.severity === undefined || typeof finding.severity === 'string')
    && (finding.subjectRef === undefined || typeof finding.subjectRef === 'string');
}

export const factoryReviewVerdictPayloadContract: ProductPayloadContract = {
  schemaId: FACTORY_REVIEW_VERDICT_SCHEMA,
  contractId: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  version: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
  definition: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: FACTORY_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
  validate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return ['payload must be an object'];
    }
    const value = payload as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof value.subject_candidate_set_ref !== 'string'
        || !value.subject_candidate_set_ref.startsWith('candidate-set/')) {
      errors.push('subject_candidate_set_ref must be an exact candidate-set/ reference');
    }
    if (value.verdict !== 'approved' && value.verdict !== 'changes_requested') {
      errors.push('verdict must be approved or changes_requested');
    }
    if (!Array.isArray(value.findings) || !value.findings.every(isReviewFinding)) {
      errors.push('findings must be strings or structured finding objects');
    }
    return errors;
  },
};

export function createReviewVerdictCheckProvider(input: {
  db: Database.Database;
  candidateSets: SqliteCandidateSetRepository;
}): CheckProvider {
  return {
    providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
    version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const refs = parameters.assessmentCandidateSetRefs;
        if (!Array.isArray(refs) || refs.length !== 1 || typeof refs[0] !== 'string') {
          return 'unknown';
        }
        const reviewSet = input.candidateSets.read(refs[0]);
        if (
          !reviewSet
          || reviewSet.role !== 'reviewer'
          || reviewSet.subjectCandidateSetRef !== subjectCandidateSetRef
        ) return 'unknown';
        const verdictSchemaRef = typeof parameters.verdictSchemaRef === 'string'
          ? parameters.verdictSchemaRef
          : FACTORY_REVIEW_VERDICT_SCHEMA;
        const verdictRefs = reviewSet.members
          .map(member => member.productRef)
          .filter(ref => ref.schemaId === verdictSchemaRef);
        if (verdictRefs.length !== 1) return 'unknown';
        const ref = verdictRefs[0]!;
        if (!ref.ref.startsWith('managed-node-submission:')) return 'unknown';
        const id = Number(ref.ref.slice('managed-node-submission:'.length));
        if (!Number.isSafeInteger(id) || id < 1) return 'unknown';
        const row = input.db.prepare(
          `SELECT schema_version,payload_snapshot,content_hash
             FROM factory_managed_node_submissions WHERE id=?`,
        ).get(id) as {
          schema_version: string;
          payload_snapshot: string;
          content_hash: string;
        } | undefined;
        if (
          !row
          || row.schema_version !== verdictSchemaRef
          || row.content_hash !== ref.digest
        ) return 'unknown';
        const payload = JSON.parse(row.payload_snapshot) as Partial<FactoryReviewVerdictProduct>;
        if (
          payload.subject_candidate_set_ref !== subjectCandidateSetRef
          || !Array.isArray(payload.findings)
          || !payload.findings.every(isReviewFinding)
          || (payload.verdict !== 'approved' && payload.verdict !== 'changes_requested')
        ) return 'unknown';
        if (payload.verdict === 'approved') return 'passed';
        return {
          outcome: 'failed',
          evidenceRefs: payload.findings.map((finding, index) => {
            const structured = typeof finding === 'string'
              ? { message: finding }
              : finding;
            return encodeCheckDiagnostic({
              code: `review-finding-${index + 1}`,
              message: structured.message,
              ...(structured.subjectRef ? { subjectRef: structured.subjectRef } : {}),
            });
          }),
        };
      } catch {
        return 'error';
      }

    },
  };
}
