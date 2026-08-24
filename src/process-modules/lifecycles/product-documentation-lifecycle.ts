import type { LifecycleDefinition } from '../domain/lifecycle.js';
// Rule 3 (CONVEYOR Wave 7): the lifecycle references module contracts only —
// the module identity ref + schema-id string from the canonical contracts
// module, never module implementation files.
import {
  DOCUMENTATION_PROCESS_MODULE_REF,
  DOCUMENTATION_RELEASE_CASE_SCHEMA,
} from './product-delivery-module-contracts.js';
import { productDeliveryLifecycle } from './product-delivery-lifecycle.js';

/**
 * Documentation profile — the operator's documentation request carried in the
 * lifecycle root input. Validated here so both the start path and the
 * continuation additive mapping share one structural contract.
 */
export interface ProductDocumentationProfile {
  kinds: readonly string[];
  outputRoot: string;
}

export function assertProductDocumentationProfile(
  value: unknown,
): asserts value is ProductDocumentationProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PRODUCT_DOCUMENTATION_PROFILE_OBJECT_REQUIRED');
  }
  const profile = value as Record<string, unknown>;
  if (!Array.isArray(profile.kinds) || profile.kinds.length === 0
    || profile.kinds.some(kind => typeof kind !== 'string' || kind.trim().length === 0)) {
    throw new Error('PRODUCT_DOCUMENTATION_PROFILE_KINDS_INVALID');
  }
  if (typeof profile.outputRoot !== 'string' || profile.outputRoot.trim().length === 0) {
    throw new Error('PRODUCT_DOCUMENTATION_PROFILE_OUTPUT_ROOT_REQUIRED');
  }
}

export const PRODUCT_DOCUMENTATION_LIFECYCLE_NAME = 'product-documentation';

/**
 * Product-construction lifecycle WITH the documentation workshop.
 *
 * Mirrors `product-delivery-lifecycle` with the `delivery-release` stage
 * REPLACED by `documentation-release`: after a verified Development candidate
 * the conveyor proceeds to authoring/rendering the PDF documentation set.
 * The terminal for a documented build stays `runnable-local` (law 12:
 * documentation does not release anything); a typed-blocked render engine
 * terminates `documentation-blocked` and is continuable (see
 * `factory-documentation-continuation.ts`).
 *
 * Selected at factory start via `SAGA_FACTORY_LIFECYCLE=product-documentation`
 * (default remains `product-build`). Runs already started keep their pinned
 * definition snapshot; the selector never rewrites a live run's topology.
 */
export const productDocumentationLifecycle: LifecycleDefinition = {
  ...productDeliveryLifecycle,
  identity: {
    name: PRODUCT_DOCUMENTATION_LIFECYCLE_NAME,
    version: '1.0.0',
    displayName: 'Product Documentation',
    description:
      'Builds one locally runnable product revision and renders its PDF documentation set; deployment stays a separate request.',
  },
  stages: productDeliveryLifecycle.stages.map(stage =>
    stage.id === 'delivery-release'
      ? documentationReleaseStage()
      : stage.id === 'solution-development'
        ? {
          ...stage,
          outcomeRoutes: {
            ...stage.outcomeRoutes,
            verified: { type: 'stage' as const, stageId: 'documentation-release' },
          },
        }
        : stage),
};

function documentationReleaseStage(): LifecycleDefinition['stages'][number] {
  return {
    id: 'documentation-release',
    displayName: 'Documentation Release',
    moduleRef: DOCUMENTATION_PROCESS_MODULE_REF,
    inputMapping: {
      schemaVersion: { literal: DOCUMENTATION_RELEASE_CASE_SCHEMA },
      projectId: { runtime: 'projectId' },
      epicId: { runtime: 'epicId' },
      'developmentCertificate.schema':
        '$.stages.solution-development.certificate.schema',
      'developmentCertificate.ref':
        '$.stages.solution-development.certificate.ref',
      'developmentCertificate.hash':
        '$.stages.solution-development.certificate.hash',
      'developmentCertificate.decision': { literal: 'verified' },
      'verifiedIntegrationBundle.schema':
        '$.stages.solution-development.verifiedBundle.schema',
      'verifiedIntegrationBundle.ref':
        '$.stages.solution-development.verifiedBundle.ref',
      'verifiedIntegrationBundle.hash':
        '$.stages.solution-development.verifiedBundle.hash',
      // Canonical VerifiedIntegrationBundle shape (2026-08-24 port): the
      // candidate rides as a ContentAddressedReference (`integratedCandidate.hash`
      // IS the frozen candidate hash) and the repository snapshots are a
      // top-level bundle member. The archived WIP mapped
      // `integratedCandidate.candidateHash`/`.repositories` — members that do
      // not exist on the ref triple and would fail the first handoff with
      // LIFECYCLE_MAPPING_SOURCE_MISSING.
      integratedCandidateHash:
        '$.stages.solution-development.verifiedBundlePayload.integratedCandidate.hash',
      candidateRepositories:
        '$.stages.solution-development.verifiedBundlePayload.repositories',
      srs: '$.stages.solution-formalization.solutionContractPayload.srs',
      acceptanceCriteria:
        '$.stages.solution-formalization.solutionContractPayload.acceptanceCriteria',
      documentKinds: '$.documentation.kinds',
      outputRoot: '$.documentation.outputRoot',
      initiatedBy: { runtime: 'initiatedBy' },
    },
    outputMapping: {
      decision: '$.processOutcome.code',
      authority: '$.processOutcome.authority',
      'certificate.schema': '$.processOutcome.certificateSchema',
      'certificate.ref': '$.processOutcome.certificateRef',
      'certificate.hash': '$.processOutcome.certificateHash',
      'documentationBundle.schema': '$.processOutcome.outputSchema',
      'documentationBundle.ref': '$.processOutcome.outputRef',
      'documentationBundle.hash': '$.processOutcome.outputHash',
      documentationBundlePayload: '$.processOutcome.outputPayload',
    },
    outcomeRoutes: {
      documented: { type: 'terminal', status: 'runnable-local' },
      blocked: { type: 'terminal', status: 'documentation-blocked' },
      failed: { type: 'terminal', status: 'failed' },
    },
    entryConditions: [
      'Development outcome is verified',
      'A documentation profile (kinds + output root) is present in the lifecycle input',
    ],
    exitConditions: [
      'Every planned document kind has an accepted product and a deterministic PDF render receipt',
    ],
  };
}
