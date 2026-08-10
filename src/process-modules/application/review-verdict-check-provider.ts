import type Database from 'better-sqlite3';
import type { SqliteCandidateSetRepository } from '../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import { sha256Hex } from '../../shared/canonical-json.js';

export const REVIEW_VERDICT_CHECK_PROVIDER_ID = 'factory.review-verdict.v1';
export const REVIEW_VERDICT_CHECK_PROVIDER_VERSION = '1.0.0';
export const REVIEW_VERDICT_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
  version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
  invariant: 'review-product-binds-exact-author-candidate-and-approves-it',
});

export const FACTORY_REVIEW_VERDICT_SCHEMA = 'factory.review-verdict.v1';

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
        return payload.verdict === 'approved' ? 'passed' : 'failed';
      } catch {
        return 'error';
      }

    },
  };
}
