import type { LifecycleDefinition, RouteResolver, TransitionTarget } from '../domain/lifecycle.js';
import { DELIVERY_PROCESS_MODULE_REF } from '../modules/delivery/delivery-process-module.js';
import {
  DELIVERY_RELEASE_CASE_SCHEMA,
  type DeliveryReleaseCase,
  type DeliveryReleasePolicySnapshot,
} from '../modules/delivery/delivery-schemas.js';
import { hashDeliveryReleasePolicy } from '../modules/delivery/delivery-settlement-policy.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../modules/development/development-process-module.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  type DevelopmentPolicySnapshot,
  type DevelopmentRepositoryBinding,
} from '../modules/development/development-schemas.js';
import { hashDevelopmentPolicy } from '../modules/development/development-settlement-policy.js';
import { DISCOVERY_PROCESS_MODULE_REF } from '../modules/discovery/discovery-process-module.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../modules/formalization/formalization-process-module.js';
import { FORMALIZATION_CASE_SCHEMA } from '../modules/formalization/formalization-schemas.js';

export const PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA =
  'saga3.product-delivery-lifecycle-input.v1';

export interface ProductDeliveryLifecycleInput {
  initiative: {
    subject: string;
    context: unknown;
    evidence: unknown;
    constraints: unknown;
  };
  development: {
    repositories: readonly DevelopmentRepositoryBinding[];
    policy: DevelopmentPolicySnapshot;
  };
  delivery: {
    policy: DeliveryReleasePolicySnapshot;
    operatorAuthorization: Omit<
      DeliveryReleaseCase['operatorAuthorization'],
      'candidateScope'
    > & {
      candidateScope: {
        mode: 'lifecycle-output';
      };
    };
  };
  /**
   * Per-run Discovery gate. The operator who starts the lifecycle has ALREADY
   * decided they want to see the product built; Discovery is therefore an
   * idea-strength gate (the decision + readiness confidence are recorded in the
   * certificate), not a build gate.
   *
   * - `'permissive'` (default): every Discovery outcome (including weak
   *   `clarify` / `reject` / `defer` / `inconclusive` / `failed`) is forwarded
   *   to Formalization. The strength is carried by the certificate.
   * - `'strict'`: non-`go` Discovery outcomes terminate the lifecycle (legacy
   *   behavior). Use this for regulated / contractual environments where
   *   Discovery is a real go/no-go gate.
   *
   * The flag lives in input, so it never changes the lifecycle definition hash;
   * the same definition serves both modes and the operator picks per run.
   */
  discoveryGate?: 'permissive' | 'strict';
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
      || !positiveInteger(repository.projectRepositoryId)
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
    || !isRecord(value.delivery.policy)
    || !isRecord(value.delivery.operatorAuthorization)
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_REQUIRED');
  }
  const deliveryPolicy = value.delivery.policy;
  const authorization = value.delivery.operatorAuthorization;
  const actions = deliveryPolicy.actions;
  const checkIds = deliveryPolicy.requiredPreflightCheckIds;
  if (
    !nonEmptyString(deliveryPolicy.id)
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
  // discoveryGate is optional; when present it must be a recognized mode.
  // Default is 'permissive', validated downstream by the route resolver.
  if (
    value.discoveryGate !== undefined
    && value.discoveryGate !== 'permissive'
    && value.discoveryGate !== 'strict'
  ) {
    throw new Error('PRODUCT_LIFECYCLE_DISCOVERY_GATE_INVALID');
  }
}

/**
 * Per-run Discovery gate resolver. The static `outcomeRoutes` table is the
 * permissive default (every outcome forwards to Formalization); this resolver
 * only overrides non-`go` Discovery outcomes when the operator set
 * `discoveryGate: 'strict'` in the lifecycle input. All other stages and
 * outcomes defer to the static table.
 *
 * Returning `undefined` falls through to the static lookup, so this resolver
 * augments rather than replaces the table.
 */
const DISCOVERY_GATE_TERMINAL_STATUSES: Readonly<Record<string, string>> = {
  clarify: 'clarification-required',
  reject: 'rejected',
  defer: 'deferred',
  inconclusive: 'inconclusive',
  failed: 'failed',
};

const resolveProductDeliveryRoute: RouteResolver = ({ stage, outcome, rootInput }) => {
  // Only the Discovery stage is gated, and only non-go outcomes.
  if (stage.id !== 'initial-discovery' || outcome === 'go') return undefined;
  const gate = isRecord(rootInput) && typeof rootInput.discoveryGate === 'string'
    ? rootInput.discoveryGate
    : 'permissive';
  if (gate !== 'strict') return undefined; // permissive: use static routes
  const terminalStatus = DISCOVERY_GATE_TERMINAL_STATUSES[outcome];
  if (!terminalStatus) return undefined; // unknown outcome: defer to static table
  const target: TransitionTarget = { type: 'terminal', status: terminalStatus };
  return target;
};

/**
 * Standard product lifecycle. Every stage emits only a local outcome; this
 * definition alone owns cross-module routing and exact handoff construction.
 *
 * Root input contract (documented structurally by the mappings):
 *   initiative.{subject,context,evidence,constraints}
 *   development.{repositories,policy}
 *   delivery.{policy,operatorAuthorization}
 *   discoveryGate? ('permissive' default | 'strict')
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
        // Every Discovery outcome is forwarded to Formalization. The strength
        // of the idea is carried by the discovery certificate (decision +
        // readiness confidence); it does not gate the lifecycle. Formalization
        // reads the certificate ref/hash and reasons about the contract.
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
        policy: '$.delivery.policy',
        operatorAuthorization: '$.delivery.operatorAuthorization',
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
        'Operator authorization binds the exact candidate and release policy',
      ],
      exitConditions: ['Every required external action has authoritative observed state'],
    },
  ],
};
// Attach the route resolver as a NON-enumerable property so it is invisible to
// canonicalJson/JSON serialization (functions are not valid JSON values and
// would break the persisted definitionSnapshot + its hash). The resolver is
// still reachable at runtime via `productDeliveryLifecycle.routeResolver` and
// is covered by the lifecycle identity (name@version), not by the snapshot.
Object.defineProperty(
  productDeliveryLifecycle,
  'routeResolver',
  { value: resolveProductDeliveryRoute, enumerable: false, writable: false, configurable: false },
);

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
