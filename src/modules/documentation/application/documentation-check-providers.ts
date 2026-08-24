/**
 * Documentation workshop — check providers and payload contracts.
 *
 * The author gate is a REAL deterministic provider (not the placeholder
 * product-contract plan): it resolves the exact CandidateSet member
 * `managed-node-submission:<id>`, re-reads the submission payload by content
 * hash and validates document structure + per-kind section completeness.
 */

import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type { CheckProvider } from '../../../process-modules/domain/workplace/gate.js';
import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import {
  DOCUMENTATION_DOCUMENT_SCHEMA,
  DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
  missingRequiredSections,
  validateDocumentationDocument,
} from '../domain/documentation-schemas.js';
import {
  productPayloadContractDigest,
  type ProductPayloadContract,
} from '../../../process-modules/application/product-payload-contract.js';

// ---------------------------------------------------------------------------
// Documentation completeness check provider (author gate).
// ---------------------------------------------------------------------------

export const DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID =
  'factory.documentation-completeness.v1';
export const DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION = '1.0.0';
export const DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
  version: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
  invariant: 'document-structure-and-per-kind-sections-validated-against-exact-submission',
});

interface SubmissionRow {
  id: number;
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  process_run_id: number;
}

export function createDocumentationCompletenessCheckProvider(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): CheckProvider {
  return {
    providerId: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
    version: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
    providerDigest: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1) return 'error';
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author'
          || candidate.workplaceRef.processRunId !== processRunId
          || candidate.members.length !== 1) {
          return completenessFailure(
            subjectCandidateSetRef,
            'candidate-binding-invalid',
            'The documentation CandidateSet is not the exact single author product for this ProcessRun.',
          );
        }
        const member = candidate.members[0]!;
        if (member.productRef.schemaId !== DOCUMENTATION_DOCUMENT_SCHEMA
          || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return completenessFailure(
            subjectCandidateSetRef,
            'product-binding-invalid',
            'The CandidateSet member is not an exact managed documentation document submission.',
          );
        }
        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
          return completenessFailure(
            subjectCandidateSetRef,
            'submission-binding-invalid',
            'The documentation submission reference is malformed.',
          );
        }
        const row = input.db.prepare(
          `SELECT id,schema_version,payload_snapshot,content_hash
             FROM factory_managed_node_submissions
            WHERE id=? AND process_run_id=?`,
        ).get(submissionId, processRunId) as SubmissionRow | undefined;
        if (!row || row.schema_version !== DOCUMENTATION_DOCUMENT_SCHEMA
          || row.content_hash !== member.productRef.digest) {
          return completenessFailure(
            subjectCandidateSetRef,
            'submission-binding-invalid',
            'The document does not match the exact CandidateSet member submission and its desk receipt.',
          );
        }
        const decoded = validateDocumentationDocument(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.valid) {
          return {
            outcome: 'failed',
            evidenceRefs: decoded.errors.map(message => encodeDiagnostic(
              'document-structure-invalid',
              message,
            )),
          };
        }
        const missing = missingRequiredSections(decoded.document);
        if (missing.length > 0) {
          return {
            outcome: 'failed',
            evidenceRefs: [encodeDiagnostic(
              'document-sections-missing',
              `Document kind '${decoded.document.documentKind}' is missing required sections: ${missing.join(', ')}.`,
            )],
          };
        }
        return 'passed';
      } catch {
        // Unknown/error never authorizes acceptance (CONVEYOR §17).
        return 'error';
      }
    },
  };
}

function completenessFailure(
  subjectCandidateSetRef: string,
  code: string,
  message: string,
): { outcome: 'failed'; evidenceRefs: string[] } {
  void subjectCandidateSetRef;
  return { outcome: 'failed', evidenceRefs: [encodeDiagnostic(code, message)] };
}

function encodeDiagnostic(code: string, message: string): string {
  return `doc-check:${sha256Hex({ code, message }).slice(0, 16)}:${code}: ${message}`;
}

// ---------------------------------------------------------------------------
// Payload contracts (installed in EVERY process via the capability manifest).
// ---------------------------------------------------------------------------

export const DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_ID =
  'factory.documentation.document-payload';
export const DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_VERSION = '1.0.0';
const DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  required: [
    'schemaVersion', 'documentKind', 'title', 'locale', 'sections', 'generatedFor',
  ],
  schemaVersion: 'literal:factory.documentation-document.v1',
  documentKind: 'enum:user-manual|programmer-manual|operator-manual|acceptance-report',
  title: 'non-empty-string',
  locale: 'non-empty-string',
  sections: 'non-empty-array-of-{id,heading,blocks}',
  generatedFor: 'object-with-candidateHash-and-productSubject',
} as const;

export const DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DOCUMENTATION_DOCUMENT_SCHEMA,
    contractId: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_ID,
    version: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_VERSION,
    definition: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DEFINITION,
  });

export const documentationDocumentPayloadContract: ProductPayloadContract = {
  schemaId: DOCUMENTATION_DOCUMENT_SCHEMA,
  contractId: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_ID,
  version: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_VERSION,
  definition: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DIGEST,
  validate(payload) {
    const decoded = validateDocumentationDocument(payload);
    return decoded.valid ? [] : decoded.errors;
  },
};

export const DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID =
  'factory.documentation.review-verdict-payload';
export const DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION = '1.0.0';
const DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  required: ['subject_candidate_set_ref', 'verdict', 'findings'],
  subjectCandidateSetRef: 'candidate-set-ref',
  verdict: ['approved', 'changes_requested'],
  findings: 'non-empty-string-or-bounded-finding-object-array',
} as const;

export const DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
    contractId: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
    version: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
    definition: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  });

export const documentationReviewVerdictPayloadContract: ProductPayloadContract = {
  schemaId: DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
  contractId: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  version: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
  definition: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
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
      errors.push("verdict must be 'approved' or 'changes_requested'");
    }
    if (!Array.isArray(value.findings) || value.findings.length === 0) {
      errors.push('findings must be a non-empty array');
    } else if (value.findings.some(finding =>
      typeof finding !== 'string'
      && (!finding || typeof finding !== 'object'
        || typeof (finding as Record<string, unknown>).message !== 'string'))) {
      errors.push('each finding must be a string or an object with a message');
    }
    return errors;
  },
};
