import type Database from 'better-sqlite3';
import type { SqliteCandidateSetRepository } from '../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import { encodeCheckDiagnostic } from '../domain/workplace/check-diagnostic.js';
import { serializeWorkplaceRef } from '../domain/workplace/workplace-ref.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  parseRepositoryFilePath,
  parseRepositoryScope,
  repositoryScopeContainsPath,
} from '../../shared/repository-scope.js';
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
    /**
     * ADR-062 — repository paths this finding is about. When present, the
     * provider can machine-check the ADR-062 rule: a BLOCKING finding must be
     * repairable within the subject item's frozen changeScopes. A blocker whose
     * every declared path lies OUTSIDE the scopes is an observation about files
     * owned by another work item — it is DEFERRED, not blocking.
     */
    readonly paths?: readonly string[];
  })[];
}

function isReviewFinding(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  return typeof finding.message === 'string' && finding.message.trim().length > 0
    && (finding.severity === undefined || typeof finding.severity === 'string')
    && (finding.subjectRef === undefined || typeof finding.subjectRef === 'string')
    && (finding.paths === undefined
        || (Array.isArray(finding.paths)
            && finding.paths.every(p => typeof p === 'string' && p.trim().length > 0)));
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
    providerDigest: REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
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
        // ADR-062 (executable): a blocking finding must be repairable within the
        // subject item's frozen changeScopes. A blocker whose every declared path
        // lies outside the scopes is an observation about files owned by another
        // graph item — it is DEFERRED and cannot, alone, produce
        // changes_requested. Universal: when no scopes are declared for the
        // subject (non-repository cells), the filter is a no-op.
        const scopes = readSubjectChangeScopes(
          input.db,
          reviewSet.workplaceRef,
          subjectCandidateSetRef,
        );
        const actionable: Array<{ finding: typeof payload.findings[number]; index: number }> = [];
        const deferred: Array<{ finding: typeof payload.findings[number]; index: number }> = [];
        payload.findings.forEach((finding, index) => {
          const structured = typeof finding === 'string'
            ? { message: finding }
            : finding;
          if (scopes !== null && isBlockingSeverity(structured.severity)) {
            const paths = structured.paths;
            if (Array.isArray(paths)
                && paths.length > 0
                && paths.every(path => !pathWithinScopes(path, scopes))) {
              deferred.push({ finding, index });
              return;
            }
          }
          actionable.push({ finding, index });
        });
        const encode = (
          entry: { finding: typeof payload.findings[number]; index: number },
          deferredOut: boolean,
        ): string => {
          const structured = typeof entry.finding === 'string'
            ? { message: entry.finding }
            : entry.finding;
          return encodeCheckDiagnostic({
            // BLINDSIGHT (f) — the code is STRUCTURAL (file scope; the nature
            // rides in the message and therefore in the finding key), never
            // ordinal: `review-finding-N` renumbered on every round, so the
            // same defect got a different key each attempt and trajectory
            // comparison had to exclude review findings entirely. Legacy
            // ordinal codes already written in chains stay excluded by
            // isOrdinalReviewCode; new codes carry the finding's declared
            // paths (sorted, deduped — 'unscoped' for pathless prose) and
            // remain byte-stable across index shifts.
            code: deferredOut
              ? `deferred-out-of-scope:${findingScopeKey(structured.paths)}`
              : `review-finding:${findingScopeKey(structured.paths)}`,
            message: deferredOut
              ? `[DEFERRED — outside this item's frozen changeScopes; owned by another work item] ${structured.message}`
              : structured.message,
            ...(structured.subjectRef ? { subjectRef: structured.subjectRef } : {}),
          });
        };
        if (actionable.length > 0) {
          return {
            outcome: 'failed',
            evidenceRefs: [
              ...actionable.map(entry => encode(entry, false)),
              ...deferred.map(entry => encode(entry, true)),
            ],
          };
        }
        // Every blocking finding was out-of-scope: per ADR-062 they cannot
        // produce changes_requested. The verdict passes and the deferred
        // observations still ride along as decodable diagnostics so the
        // desk keeps the information for the owning item / final assembly.
        return {
          outcome: 'passed',
          evidenceRefs: deferred.map(entry => encode(entry, true)),
        };
      } catch (error) {
        // Surface a decodable diagnostic with the actual parse/contract error so
        // a reviewer facing an indeterminate result is told WHAT was malformed
        // (which field/value), not just that the verdict was unreadable.
        const reason = error instanceof Error ? error.message : String(error);
        return {
          outcome: 'error',
          evidenceRefs: [encodeCheckDiagnostic({
            code: 'review-verdict-contract',
            message: `review-verdict check threw: ${reason.slice(0, 1000)}`,
          })],
        };
      }

    },
  };
}

/**
 * ADR-062 — resolve the frozen changeScopes of the subject work item (the
 * author task's cell_input_item on the reviewed workplace). Returns null when
 * the cell declares no repository scopes (non-repository work): the scope
 * filter is then a no-op, keeping this check universal across workshops.
 */
function readSubjectChangeScopes(
  db: Database.Database,
  workplaceRef: Parameters<typeof serializeWorkplaceRef>[0],
  subjectCandidateSetRef: string,
): string[] | null {
  // ADR-053 B-6: the accepted-author head binds the exact author task whose
  // immutable CandidateSet is under review. A later repair task on the same
  // Workplace must never change the jurisdiction of an already-sealed review.
  const row = db.prepare(
    `SELECT t.metadata
       FROM factory_accepted_authority_head h
       JOIN tasks t ON CAST(t.id AS TEXT)=h.accepted_author_task_id
      WHERE h.workplace_ref=?
        AND h.accepted_author_candidate_set_ref=?
        AND t.workplace_ref=h.workplace_ref
        AND json_extract(t.metadata,'$.role')='author'`,
  ).get(
    serializeWorkplaceRef(workplaceRef),
    subjectCandidateSetRef,
  ) as { metadata: string } | undefined;
  if (!row) return null;
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  const item = metadata.cell_input_item as { changeScopes?: unknown } | undefined;
  const scopes = item?.changeScopes;
  if (!Array.isArray(scopes) || scopes.length === 0
      || !scopes.every(value => typeof value === 'string' && value.trim().length > 0)) {
    return null;
  }
  return scopes as string[];
}

/** Blocking severities per the reviewer finding contract; absent severity on a
 * structured finding (and bare prose strings) default to blocking — the
 * conservative pre-ADR-062 behaviour. */
function isBlockingSeverity(severity: string | undefined): boolean {
  return severity === undefined || severity === 'error' || severity === 'blocker';
}

/**
 * BLINDSIGHT (f) — the STRUCTURAL scope key of a reviewer finding: its
 * declared repository paths, trimmed, deduplicated, sorted (order of
 * declaration is not identity); 'unscoped' when the finding names no files.
 * Combined with the message (which enters the finding key verbatim after
 * normalization), this gives the finding a file+nature identity that is
 * byte-stable across rounds regardless of list position.
 */
function findingScopeKey(paths: readonly string[] | undefined): string {
  if (!paths || paths.length === 0) return 'unscoped';
  const normalized = [...new Set(paths.map(path => path.trim()).filter(path => path !== ''))]
    .sort();
  return normalized.length === 0 ? 'unscoped' : normalized.join('|');
}

/** Path-containment identical to the deterministic scope gate: a scope is an
 * exact file or a directory prefix (trailing slash insignificant). */
function pathWithinScopes(path: string, scopes: readonly string[]): boolean {
  try {
    const candidate = parseRepositoryFilePath(path);
    return scopes
      .map(parseRepositoryScope)
      .some(scope => repositoryScopeContainsPath(scope, candidate));
  } catch {
    return false;
  }
}
