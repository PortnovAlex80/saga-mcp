import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { DELIVERY_PROCESS_MODULE_REF } from '../modules/delivery/delivery-process-module.js';
import {
  DELIVERY_DEFERRED_PROFILE_SCHEMA,
  DELIVERY_RELEASE_CASE_SCHEMA,
  type AuthorizedDeliveryReleaseCase,
  type DeliveryDeferredProfile,
  type DeliveryReleasePolicySnapshot,
} from '../modules/delivery/delivery-schemas.js';
import {
  hashDeliveryDeferredProfile,
  hashDeliveryReleasePolicy,
} from '../modules/delivery/delivery-settlement-policy.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../modules/development/development-process-module.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  type DevelopmentPolicySnapshot,
} from '../modules/development/development-schemas.js';
import { hashDevelopmentPolicy } from '../modules/development/development-settlement-policy.js';
import { DISCOVERY_PROCESS_MODULE_REF } from '../modules/discovery/discovery-process-module.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../modules/formalization/formalization-process-module.js';
import { FORMALIZATION_CASE_SCHEMA } from '../modules/formalization/formalization-schemas.js';

export const PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA =
  'saga3.product-delivery-lifecycle-input.v2';

export interface ProductDeliveryLifecycleInput {
  initiative: {
    subject: string;
    context: unknown;
    evidence: unknown;
    constraints: unknown;
  };
  development: {
    repositories: readonly (
      ProductDeliveryRepositoryBinding | LegacyProductDeliveryRepositoryBinding
    )[];
    policy: DevelopmentPolicySnapshot;
  };
  delivery:
    | {
        mode: 'authorized';
        policy: DeliveryReleasePolicySnapshot;
        operatorAuthorization: Omit<
          AuthorizedDeliveryReleaseCase['operatorAuthorization'],
          'candidateScope'
        > & {
          candidateScope: {
            mode: 'lifecycle-output';
          };
        };
        deferredProfile: null;
      }
    | {
        mode: 'deferred';
        policy: null;
        operatorAuthorization: null;
        deferredProfile: DeliveryDeferredProfile;
      };
}

/**
 * Portable repository identity stored in the durable LifecycleRun input.
 * SQLite project_repositories.id is deliberately absent: it is a runtime
 * capability and may change after import, fixture restore, or reprovisioning.
 */
export interface ProductDeliveryRepositoryRef {
  repositoryName: string;
  role: string;
}

export interface ProductDeliveryRepositoryBinding {
  repositoryRef: ProductDeliveryRepositoryRef;
  integrationBranch: string;
  expectedBaseCommit: string;
}

/**
 * Input-only compatibility shape. The composition root converts it to a
 * ProductDeliveryRepositoryBinding before LifecycleRun persistence. A stale
 * or foreign id is rejected; it is never copied into a durable snapshot.
 */
export interface LegacyProductDeliveryRepositoryBinding {
  projectRepositoryId: number;
  integrationBranch: string;
  expectedBaseCommit: string;
}

export function assertProductDeliveryLifecycleInput(
  value: unknown,
): asserts value is ProductDeliveryLifecycleInput {
  if (!isRecord(value)) throw new Error('PRODUCT_LIFECYCLE_INPUT_OBJECT_REQUIRED');
  if (
    !isRecord(value.initiative)
    || typeof value.initiative.subject !== 'string'
    || value.initiative.subject.trim().length === 0
  ) {
    throw new Error('PRODUCT_LIFECYCLE_INITIATIVE_SUBJECT_REQUIRED');
  }
  if (
    !Object.hasOwn(value.initiative, 'context')
    || !Object.hasOwn(value.initiative, 'evidence')
    || !Object.hasOwn(value.initiative, 'constraints')
  ) {
    throw new Error('PRODUCT_LIFECYCLE_INITIATIVE_CONTEXT_INCOMPLETE');
  }
  if (
    !isRecord(value.development)
    || !Array.isArray(value.development.repositories)
    || !isRecord(value.development.policy)
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DEVELOPMENT_CONFIGURATION_REQUIRED');
  }
  const repositories = value.development.repositories;
  const developmentPolicy = value.development.policy;
  if (
    repositories.length === 0
    || repositories.some(repository =>
      !isRecord(repository)
      || !(
        (
          isRecord(repository.repositoryRef)
          && nonEmptyString(repository.repositoryRef.repositoryName)
          && nonEmptyString(repository.repositoryRef.role)
        )
        || positiveInteger(repository.projectRepositoryId)
      )
      || !nonEmptyString(repository.integrationBranch)
      || !nonEmptyString(repository.expectedBaseCommit))
    || !nonEmptyString(developmentPolicy.id)
    || !nonEmptyString(developmentPolicy.version)
    || !nonEmptyString(developmentPolicy.contentHash)
    || hashDevelopmentPolicy(
      developmentPolicy as unknown as DevelopmentPolicySnapshot,
    ) !== developmentPolicy.contentHash
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DEVELOPMENT_CONFIGURATION_INVALID');
  }
  if (
    !isRecord(value.delivery)
    || !nonEmptyString(value.delivery.mode)
    || !Object.hasOwn(value.delivery, 'policy')
    || !Object.hasOwn(value.delivery, 'operatorAuthorization')
    || !Object.hasOwn(value.delivery, 'deferredProfile')
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_REQUIRED');
  }
  if (value.delivery.mode === 'deferred') {
    const profile = value.delivery.deferredProfile;
    if (
      value.delivery.policy !== null
      || value.delivery.operatorAuthorization !== null
      || !isRecord(profile)
      || profile.schemaVersion !== DELIVERY_DEFERRED_PROFILE_SCHEMA
      || profile.reason !== 'authorization-required'
      || !['start-from-idea', 'operator-deferred'].includes(String(profile.source))
      || !nonEmptyString(profile.profileHash)
      || hashDeliveryDeferredProfile(
        profile as unknown as DeliveryDeferredProfile,
      ) !== profile.profileHash
    ) {
      throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID');
    }
    return;
  }
  if (value.delivery.mode !== 'authorized') {
    throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID');
  }
  const deliveryPolicy = value.delivery.policy;
  const authorization = value.delivery.operatorAuthorization;
  if (!isRecord(deliveryPolicy) || !isRecord(authorization)) {
    throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID');
  }
  const actions = deliveryPolicy.actions;
  const checkIds = deliveryPolicy.requiredPreflightCheckIds;
  if (
    value.delivery.deferredProfile !== null
    || !nonEmptyString(deliveryPolicy.id)
    || !nonEmptyString(deliveryPolicy.version)
    || !nonEmptyString(deliveryPolicy.contentHash)
    || !nonEmptyString(deliveryPolicy.channel)
    || !nonEmptyString(deliveryPolicy.releaseVersion)
    || !nonEmptyString(deliveryPolicy.releaseTag)
    || typeof deliveryPolicy.humanApprovalRequired !== 'boolean'
    || !Array.isArray(checkIds)
    || checkIds.some(checkId => !nonEmptyString(checkId))
    || new Set(checkIds).size !== checkIds.length
    || !Array.isArray(actions)
    || actions.length === 0
    || !actions.some(action => isRecord(action) && action.required === true)
    || actions.some(action =>
      !isRecord(action)
      || !nonEmptyString(action.actionId)
      || ![
        'source-tag',
        'source-release',
        'package-publish',
        'deployment',
      ].includes(String(action.kind))
      || !nonEmptyString(action.target)
      || !nonEmptyString(action.desiredStateHash)
      || !nonEmptyString(action.payloadHash)
      || typeof action.required !== 'boolean')
    || new Set(
      actions
        .filter(isRecord)
        .map(action => String(action.actionId)),
    ).size !== actions.length
    || hashDeliveryReleasePolicy(
      deliveryPolicy as unknown as DeliveryReleasePolicySnapshot,
    ) !== deliveryPolicy.contentHash
    || !validReference(authorization)
    || !nonEmptyString(authorization.requestedBy)
    || authorization.releasePolicyHash !== deliveryPolicy.contentHash
    || !isRecord(authorization.candidateScope)
    || authorization.candidateScope.mode !== 'lifecycle-output'
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID');
  }
}

/**
 * Standard product lifecycle. Every stage emits only a local outcome; this
 * definition alone owns cross-module routing and exact handoff construction.
 * Routing is purely declarative: the static `outcomeRoutes` table is the
 * single source of truth (plan §13.8). The former per-run `discoveryGate`
 * override (a product-specific route resolver attached via
 * `Object.defineProperty`) was removed in Wave 13; the strict-gate variant is
 * now a separate declarative Lifecycle Scenario Package
 * (`LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT`).
 *
 * Root input contract (documented structurally by the mappings):
 *   initiative.{subject,context,evidence,constraints}
 *   development.{repositories,policy}
 *   delivery.{mode,policy,operatorAuthorization,deferredProfile}
 *
 * Missing deployment/provider configuration fails at its first required
 * mapping. The lifecycle never invents repositories, policies or authority.
 */
export const productDeliveryLifecycle: LifecycleDefinition = {
  identity: {
    name: 'product-delivery',
    version: '1.0.0',
    displayName: 'Product Delivery',
    description:
      'Moves one product initiative through Discovery, Formalization, Development and Delivery/Release.',
  },
  entryStageId: 'initial-discovery',
  stages: [
    {
      id: 'initial-discovery',
      displayName: 'Initial Discovery',
      moduleRef: DISCOVERY_PROCESS_MODULE_REF,
      inputMapping: {
        projectId: { runtime: 'projectId' },
        epicId: { runtime: 'epicId' },
        objective: '$.initiative.subject',
        subject: '$.initiative.subject',
        context: '$.initiative.context',
        evidence: '$.initiative.evidence',
        constraints: '$.initiative.constraints',
        initiatedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: {
        decision: '$.processOutcome.code',
        authority: '$.processOutcome.authority',
        'certificate.schema': '$.processOutcome.certificateSchema',
        'certificate.ref': '$.processOutcome.certificateRef',
        'certificate.hash': '$.processOutcome.certificateHash',
      },
      outcomeRoutes: {
        // Discovery is an idea-STRENGTH gate, not a build gate: an operator who
        // starts the lifecycle has already decided to see the product built
        // (commit 2af9709). The strength of the idea (go / clarify / reject /
        // defer / inconclusive / failed) is recorded in the discovery
        // certificate and carried forward, NOT used to block the conveyor.
        // Every Discovery outcome therefore forwards to Formalization, which
        // then reasons about the contract on its own merits and is itself the
        // real go/no-go gate (its non-formalized outcomes terminate). The
        // strict-gate variant lives in the separate declarative
        // LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT scenario package for
        // regulated/contractual environments; the production lifecycle is
        // permissive by default.
        go: { type: 'stage', stageId: 'solution-formalization' },
        clarify: { type: 'stage', stageId: 'solution-formalization' },
        reject: { type: 'stage', stageId: 'solution-formalization' },
        defer: { type: 'stage', stageId: 'solution-formalization' },
        inconclusive: { type: 'stage', stageId: 'solution-formalization' },
        failed: { type: 'stage', stageId: 'solution-formalization' },
      },
      entryConditions: ['initiative.subject exists'],
      exitConditions: ['Discovery has an immutable local outcome and certificate lineage'],
    },
    {
      id: 'solution-formalization',
      displayName: 'Solution Formalization',
      moduleRef: FORMALIZATION_PROCESS_MODULE_REF,
      inputMapping: {
        schemaVersion: { literal: FORMALIZATION_CASE_SCHEMA },
        discoveryEpicId: { runtime: 'epicId' },
        formalizationEpicId: { runtime: 'epicId' },
        discoveryCertificateRef: '$.stages.initial-discovery.certificate.ref',
        discoveryCertificateHash: '$.stages.initial-discovery.certificate.hash',
        discoveryOutcome: '$.stages.initial-discovery.decision',
        initiatedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: {
        decision: '$.processOutcome.code',
        authority: '$.processOutcome.authority',
        'certificate.schema': '$.processOutcome.certificateSchema',
        'certificate.ref': '$.processOutcome.certificateRef',
        'certificate.hash': '$.processOutcome.certificateHash',
        'solutionContract.schema': '$.processOutcome.outputSchema',
        'solutionContract.ref': '$.processOutcome.outputRef',
        'solutionContract.hash': '$.processOutcome.outputHash',
        solutionContractPayload: '$.processOutcome.outputPayload',
      },
      outcomeRoutes: {
        formalized: { type: 'stage', stageId: 'solution-development' },
        'clarification-required': { type: 'terminal', status: 'clarification-required' },
        inconsistent: { type: 'terminal', status: 'formalization-inconsistent' },
        infeasible: { type: 'terminal', status: 'infeasible' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['Discovery certificate ref and hash exist'],
      exitConditions: ['Formalization has a frozen content-addressed Solution Contract'],
    },
    {
      id: 'solution-development',
      displayName: 'Solution Development',
      moduleRef: DEVELOPMENT_PROCESS_MODULE_REF,
      inputMapping: {
        schemaVersion: { literal: DEVELOPMENT_CASE_SCHEMA },
        projectId: { runtime: 'projectId' },
        epicId: { runtime: 'epicId' },
        'formalizationCertificate.schema':
          '$.stages.solution-formalization.certificate.schema',
        'formalizationCertificate.ref':
          '$.stages.solution-formalization.certificate.ref',
        'formalizationCertificate.hash':
          '$.stages.solution-formalization.certificate.hash',
        'formalizationCertificate.decision': { literal: 'formalized' },
        'solutionContract.schema':
          '$.stages.solution-formalization.solutionContract.schema',
        'solutionContract.ref':
          '$.stages.solution-formalization.solutionContract.ref',
        'solutionContract.hash':
          '$.stages.solution-formalization.solutionContract.hash',
        acceptanceBaselineHash:
          '$.stages.solution-formalization.solutionContractPayload.bundle.acceptanceBaselineHash',
        srs: '$.stages.solution-formalization.solutionContractPayload.srs',
        acceptanceCriteria:
          '$.stages.solution-formalization.solutionContractPayload.acceptanceCriteria',
        repositories: '$.development.repositories',
        policy: '$.development.policy',
        initiatedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: {
        decision: '$.processOutcome.code',
        authority: '$.processOutcome.authority',
        'certificate.schema': '$.processOutcome.certificateSchema',
        'certificate.ref': '$.processOutcome.certificateRef',
        'certificate.hash': '$.processOutcome.certificateHash',
        'verifiedBundle.schema': '$.processOutcome.outputSchema',
        'verifiedBundle.ref': '$.processOutcome.outputRef',
        'verifiedBundle.hash': '$.processOutcome.outputHash',
        verifiedBundlePayload: '$.processOutcome.outputPayload',
      },
      outcomeRoutes: {
        verified: { type: 'stage', stageId: 'delivery-release' },
        'rework-required': { type: 'terminal', status: 'development-rework-required' },
        'clarification-required': { type: 'terminal', status: 'clarification-required' },
        blocked: { type: 'terminal', status: 'development-blocked' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: [
        'Formalization outcome is formalized',
        'Solution Contract and accepted baseline are content-addressed',
      ],
      exitConditions: ['Development has verified an immutable integrated candidate'],
    },
    {
      id: 'delivery-release',
      displayName: 'Delivery and Release',
      moduleRef: DELIVERY_PROCESS_MODULE_REF,
      inputMapping: {
        schemaVersion: { literal: DELIVERY_RELEASE_CASE_SCHEMA },
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
        integratedCandidate:
          '$.stages.solution-development.verifiedBundlePayload.integratedCandidate',
        deliveryMode: '$.delivery.mode',
        policy: '$.delivery.policy',
        operatorAuthorization: '$.delivery.operatorAuthorization',
        deferredProfile: '$.delivery.deferredProfile',
        initiatedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: {
        decision: '$.processOutcome.code',
        authority: '$.processOutcome.authority',
        'certificate.schema': '$.processOutcome.certificateSchema',
        'certificate.ref': '$.processOutcome.certificateRef',
        'certificate.hash': '$.processOutcome.certificateHash',
        'releaseRecord.schema': '$.processOutcome.outputSchema',
        'releaseRecord.ref': '$.processOutcome.outputRef',
        'releaseRecord.hash': '$.processOutcome.outputHash',
        releaseRecordPayload: '$.processOutcome.outputPayload',
      },
      outcomeRoutes: {
        released: { type: 'terminal', status: 'released' },
        'approval-required': { type: 'terminal', status: 'approval-required' },
        blocked: { type: 'terminal', status: 'delivery-blocked' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: [
        'Development outcome is verified',
        'Release authorization is explicit, or Delivery terminates as approval-required',
      ],
      exitConditions: ['Every required external action has authoritative observed state'],
    },
  ],
};

/**
 * Backward-compatible export name. It now refers to the complete lifecycle;
 * callers that previously stopped after Formalization receive the new routing.
 */
export const discoveryToFormalizationLifecycle = productDeliveryLifecycle;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validReference(value: Record<string, unknown>): boolean {
  return nonEmptyString(value.schema)
    && nonEmptyString(value.ref)
    && nonEmptyString(value.hash);
}
