// tests/factory-contract/test-verification-check-provider.mjs
//
// Test-only verification check provider for scripted factory-contract tests.
//
// The production provider (createDevelopmentVerificationCheckProvider) always
// returns 'unknown' for LM-authored assessments — by design, an LM "passed"
// cannot become Factory acceptance without an independent candidate-check
// receipt (CGAD principle: verifier must be independent from builder).
//
// In scripted tests, the "LM" is a deterministic script. There is no
// independence requirement because there is no LLM bias to guard against.
// This provider runs the SAME contract + lineage validation as the real
// provider, then trusts the assessment outcome when the product is well-formed.
//
// This lets E2E golden-path tests reach 'released' without weakening any
// other factory infrastructure (gates, CandidateSets, lifecycle routing).

import {
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
} from '../../dist/modules/development/application/development-check-providers.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';
import { decodeDevelopmentVerificationProduct } from '../../dist/modules/development/domain/development-verification-product.js';

/**
 * Factory that creates a test verification check provider trusting well-formed
 * LM-authored assessments. Validates the same contract + lineage as the
 * production provider, but returns 'passed' instead of 'unknown'.
 *
 * This factory is passed as `development.verificationCheckProviderFactory`
 * in the scenario composition, so it receives `db` and `candidateSets` from
 * the registration site (which has access to shared deps).
 *
 * @returns {(deps: { db: any, candidateSets: any }) => object} provider factory
 */
export function createTestVerificationCheckProviderFactory() {
  return ({ db, candidateSets }) => ({
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isSafeInteger(processRunId) || processRunId < 1)
          return 'error';

        const candidate = candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author'
            || candidate.workplaceRef.processRunId !== processRunId
            || candidate.members.length !== 1)
          return 'failed';

        const member = candidate.members[0];
        if (member.productRef.schemaId
            !== DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA
            || !member.productRef.ref.startsWith('managed-node-submission:')) {
          return 'failed';
        }

        const submissionId = Number(
          member.productRef.ref.slice('managed-node-submission:'.length),
        );
        if (!Number.isSafeInteger(submissionId) || submissionId < 1)
          return 'failed';

        const row = db.prepare(
          `SELECT s.payload_snapshot,s.content_hash,t.verification_target_artifact_id,
                  t.metadata,a.accepted_hash
             FROM factory_managed_node_submissions s
             JOIN tasks t ON t.id=s.task_id
             LEFT JOIN artifacts a ON a.id=t.verification_target_artifact_id
            WHERE s.id=? AND s.process_run_id=? AND s.execution_id=?`,
        ).get(submissionId, processRunId, candidate.producerExecutionRef);

        if (!row || row.content_hash !== member.productRef.digest)
          return 'failed';

        const decoded = decodeDevelopmentVerificationProduct(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) return 'failed';

        // Same lineage validation as the production provider:
        const metadata = JSON.parse(row.metadata);
        const item = metadata.cell_input_item;
        const criterionIds = item?.acceptanceCriterionIds;
        const frozenHash = metadata.process_node_input?.upstream?.bindings
          ?.candidate?.candidateHash;

        if (decoded.value.verificationItemKey !== item?.key
            || !Array.isArray(criterionIds)
            || criterionIds.length !== 1
            || decoded.value.acceptanceCriterionId !== criterionIds[0]
            || decoded.value.acceptanceCriterionId
               !== row.verification_target_artifact_id
            || decoded.value.acceptedCriterionHash !== row.accepted_hash
            || decoded.value.candidateHash !== frozenHash)
          return 'failed';

        // KEY DIFFERENCE from production: trust the assessment outcome.
        // Production always returns 'unknown' here. We return the actual
        // outcome because in scripted tests the "LM" is deterministic.
        // IMPORTANT: return evidenceRefs so the settlement's
        // readTrustedVerificationReceipt admits the receipt (it requires
        // refs.length > 0).
        const evidenceDigest = sha256Hex({
          provider: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
          submissionId,
          outcome: decoded.value.outcome,
        });
        if (decoded.value.outcome === 'passed') return {
          outcome: 'passed',
          evidenceRefs: [`test-verification:${evidenceDigest}`],
        };
        if (decoded.value.outcome === 'failed') return {
          outcome: 'failed',
          evidenceRefs: [`test-verification:${evidenceDigest}`],
        };
        return 'unknown';
      } catch {
        return 'error';
      }
    },
  });
}
