/**
 * Deterministic policies for Delivery/Release.
 *
 * External adapters perform/observe side effects. These policies only validate
 * immutable, content-addressed snapshots and derive an outcome. In particular,
 * an uncertain publish response can still settle successfully when an
 * authoritative observation proves the desired state already exists.
 */

import { sha256Hex } from '../../shared/canonical-json.js';
import {
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} from '../development/development-schemas.js';
import {
  DELIVERY_APPROVAL_SCHEMA,
  DELIVERY_CERTIFICATE_SCHEMA,
  DELIVERY_OBSERVATION_SCHEMA,
  DELIVERY_PREFLIGHT_SCHEMA,
  DELIVERY_PUBLICATION_SCHEMA,
  DELIVERY_RELEASE_CASE_SCHEMA,
  DELIVERY_SETTLEMENT_INPUT_SCHEMA,
  RELEASE_RECORD_SCHEMA,
  type DeliveryApprovalDecision,
  type DeliveryCertificatePayload,
  type DeliveryContentAddressedReference,
  type DeliveryDecision,
  type DeliveryObservationSnapshot,
  type DeliveryPreflightSnapshot,
  type DeliveryPublicationSnapshot,
  type DeliveryReasonCode,
  type DeliveryReleaseCase,
  type DeliveryReleasePolicySnapshot,
  type DeliverySettlementInput,
  type ReleaseActionDefinition,
  type ReleaseRecord,
} from './delivery-schemas.js';

export interface DeliveryPreflightResult {
  event: 'ready' | 'blocked' | 'failed';
  reasonCodes: readonly DeliveryReasonCode[];
  rationale: string;
  inputHash: string;
}

export interface DeliveryPreflightPolicyPort {
  evaluate(
    deliveryCase: DeliveryReleaseCase,
    preflight: DeliveryPreflightSnapshot,
  ): DeliveryPreflightResult;
}

export interface DeliverySettlementResult {
  decision: DeliveryDecision;
  reasonCodes: readonly DeliveryReasonCode[];
  rationale: string;
  inputHash: string;
  releaseRecord: ReleaseRecord | null;
}

export interface DeliverySettlementPolicyPort {
  settle(input: DeliverySettlementInput): DeliverySettlementResult;
}

function hashWithoutField(value: object, field: string): string {
  const body: Record<string, unknown> = { ...value };
  delete body[field];
  return sha256Hex(body);
}

export function hashDeliveryPreflight(
  preflight: DeliveryPreflightSnapshot,
): string {
  return hashWithoutField(preflight, 'preflightHash');
}

export function hashDeliveryApproval(
  approval: DeliveryApprovalDecision,
): string {
  return hashWithoutField(approval, 'approvalHash');
}

export function hashDeliveryPublication(
  publication: DeliveryPublicationSnapshot,
): string {
  return hashWithoutField(publication, 'publicationHash');
}

export function hashDeliveryObservation(
  observation: DeliveryObservationSnapshot,
): string {
  return hashWithoutField(observation, 'observationHash');
}

export function hashReleaseRecord(record: ReleaseRecord): string {
  return hashWithoutField(record, 'recordHash');
}

export function hashDeliveryReleasePolicy(
  policy: DeliveryReleasePolicySnapshot,
): string {
  return hashWithoutField(policy, 'contentHash');
}

/**
 * Exact, cross-run idempotency key for an externally-visible desired state.
 * It deliberately excludes ProcessRun id: a second run for the same immutable
 * candidate/action must observe and reuse the first run's already-applied state.
 */
export function deliveryActionKey(
  deliveryCase: DeliveryReleaseCase,
  action: ReleaseActionDefinition,
): string {
  const identityHash = sha256Hex({
    developmentCertificateHash: deliveryCase.developmentCertificate.hash,
    candidateHash: deliveryCase.integratedCandidate.hash,
    releasePolicyHash: deliveryCase.policy.contentHash,
    actionId: action.actionId,
    kind: action.kind,
    target: action.target,
    desiredStateHash: action.desiredStateHash,
    payloadHash: action.payloadHash,
  });
  return `delivery:${action.kind}:${identityHash}`;
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function validRef(reference: DeliveryContentAddressedReference): boolean {
  return reference.schema.trim().length > 0
    && reference.ref.trim().length > 0
    && reference.hash.trim().length > 0;
}

function invalidPolicy(deliveryCase: DeliveryReleaseCase): boolean {
  const policy = deliveryCase.policy;
  return !policy.id.trim()
    || !policy.version.trim()
    || !policy.contentHash.trim()
    || hashDeliveryReleasePolicy(policy) !== policy.contentHash
    || !policy.channel.trim()
    || !policy.releaseVersion.trim()
    || !policy.releaseTag.trim()
    || !unique(policy.requiredPreflightCheckIds)
    || policy.requiredPreflightCheckIds.some(id => !id.trim())
    || policy.actions.length === 0
    || !policy.actions.some(action => action.required)
    || !unique(policy.actions.map(action => action.actionId))
    || policy.actions.some(action =>
      !action.actionId.trim()
      || ![
        'source-tag',
        'source-release',
        'package-publish',
        'deployment',
      ].includes(action.kind)
      || !action.target.trim()
      || !action.desiredStateHash.trim()
      || !action.payloadHash.trim()
      || typeof action.required !== 'boolean');
}

function invalidCase(deliveryCase: DeliveryReleaseCase): DeliveryReasonCode | null {
  if (
    deliveryCase.schemaVersion !== DELIVERY_RELEASE_CASE_SCHEMA
    || deliveryCase.projectId <= 0
    || !deliveryCase.initiatedBy.trim()
  ) {
    return 'invalid-input-contract';
  }
  if (
    deliveryCase.developmentCertificate.decision !== 'verified'
    || !validRef(deliveryCase.developmentCertificate)
    || deliveryCase.developmentCertificate.schema
      !== DEVELOPMENT_CERTIFICATE_SCHEMA
    || !validRef(deliveryCase.verifiedIntegrationBundle)
    || deliveryCase.verifiedIntegrationBundle.schema
      !== VERIFIED_INTEGRATION_BUNDLE_SCHEMA
    || !validRef(deliveryCase.integratedCandidate)
    || deliveryCase.integratedCandidate.schema !== INTEGRATED_CANDIDATE_SCHEMA
  ) {
    return 'development-certificate-invalid';
  }
  if (
    !validRef(deliveryCase.operatorAuthorization)
    || !deliveryCase.operatorAuthorization.requestedBy.trim()
    || deliveryCase.operatorAuthorization.candidateHash
      !== deliveryCase.integratedCandidate.hash
    || deliveryCase.operatorAuthorization.releasePolicyHash
      !== deliveryCase.policy.contentHash
  ) {
    return 'operator-authorization-missing';
  }
  if (invalidPolicy(deliveryCase)) return 'release-policy-invalid';
  return null;
}

function referenceMatches(
  reference: DeliveryContentAddressedReference | null,
  schema: string,
  hash: string,
): boolean {
  return reference !== null
    && reference.schema === schema
    && reference.hash === hash
    && reference.ref.trim().length > 0;
}

export class ReferenceDeliveryPreflightPolicy
implements DeliveryPreflightPolicyPort {
  evaluate(
    deliveryCase: DeliveryReleaseCase,
    preflight: DeliveryPreflightSnapshot,
  ): DeliveryPreflightResult {
    const inputHash = sha256Hex(deliveryCase);
    const invalid = invalidCase(deliveryCase);
    if (invalid) {
      return {
        event: 'failed',
        reasonCodes: [invalid],
        rationale: 'DeliveryReleaseCase failed contract validation.',
        inputHash,
      };
    }
    if (
      preflight.schemaVersion !== DELIVERY_PREFLIGHT_SCHEMA
      || hashDeliveryPreflight(preflight) !== preflight.preflightHash
    ) {
      return {
        event: 'failed',
        reasonCodes: ['preflight-hash-invalid'],
        rationale: 'Preflight snapshot failed integrity validation.',
        inputHash,
      };
    }
    if (
      preflight.candidateHash !== deliveryCase.integratedCandidate.hash
      || preflight.developmentCertificateHash
        !== deliveryCase.developmentCertificate.hash
      || preflight.releasePolicyHash !== deliveryCase.policy.contentHash
    ) {
      return {
        event: 'failed',
        reasonCodes: ['preflight-lineage-mismatch'],
        rationale: 'Preflight does not target the exact certified candidate and release policy.',
        inputHash,
      };
    }

    const checkIds = preflight.checks.map(check => check.checkId);
    const checkById = new Map(preflight.checks.map(check => [
      check.checkId,
      check,
    ]));
    if (
      !unique(checkIds)
      || preflight.checks.some(check =>
        !check.checkId.trim()
        || !validRef(check.evidence)
        || check.subjectCandidateHash
          !== deliveryCase.integratedCandidate.hash)
    ) {
      return {
        event: 'failed',
        reasonCodes: ['preflight-lineage-mismatch'],
        rationale: 'Preflight checks are duplicate, malformed, missing or target another candidate.',
        inputHash,
      };
    }
    if (
      deliveryCase.policy.requiredPreflightCheckIds.some(id =>
        !checkById.has(id))
    ) {
      return {
        event: 'blocked',
        reasonCodes: ['preflight-check-missing'],
        rationale: 'One or more required preflight checks are missing.',
        inputHash,
      };
    }

    for (const check of preflight.checks) {
      if (
        !check.provider.trusted
        || (
          check.provider.category !== 'deterministic_evidence'
          && check.provider.category !== 'authoritative_state'
        )
        || check.provider.providerId <= 0
        || !check.provider.name.trim()
      ) {
        return {
          event: 'blocked',
          reasonCodes: ['preflight-provider-untrusted'],
          rationale: `Preflight check '${check.checkId}' has no trusted evidence provider.`,
          inputHash,
        };
      }
    }

    for (const checkId of deliveryCase.policy.requiredPreflightCheckIds) {
      const check = checkById.get(checkId);
      if (!check) continue;
      if (check.outcome === 'failed') {
        return {
          event: 'blocked',
          reasonCodes: ['preflight-check-failed'],
          rationale: `Required preflight check '${checkId}' failed.`,
          inputHash,
        };
      }
      if (check.outcome === 'unknown') {
        return {
          event: 'blocked',
          reasonCodes: ['preflight-check-inconclusive'],
          rationale: `Required preflight check '${checkId}' is unknown.`,
          inputHash,
        };
      }
      if (check.outcome === 'error') {
        return {
          event: 'failed',
          reasonCodes: ['infrastructure-error'],
          rationale: `Required preflight check '${checkId}' errored.`,
          inputHash,
        };
      }
    }

    if (!preflight.complete) {
      return {
        event: 'blocked',
        reasonCodes: ['preflight-check-missing'],
        rationale: 'Preflight snapshot is incomplete.',
        inputHash,
      };
    }
    return {
      event: 'ready',
      reasonCodes: [],
      rationale: 'All required checks passed for the exact certified candidate.',
      inputHash,
    };
  }
}

function settlementResult(
  decision: DeliveryDecision,
  reasonCodes: readonly DeliveryReasonCode[],
  rationale: string,
  inputHash: string,
  releaseRecord: ReleaseRecord | null = null,
): DeliverySettlementResult {
  return { decision, reasonCodes, rationale, inputHash, releaseRecord };
}

function actionPlansMatch(
  left: readonly ReleaseActionDefinition[],
  right: readonly ReleaseActionDefinition[],
): boolean {
  return sha256Hex(left) === sha256Hex(right);
}

export class ReferenceDeliverySettlementPolicy
implements DeliverySettlementPolicyPort {
  constructor(
    private readonly preflightPolicy: DeliveryPreflightPolicyPort =
      new ReferenceDeliveryPreflightPolicy(),
  ) {}

  settle(input: DeliverySettlementInput): DeliverySettlementResult {
    const inputHash = sha256Hex(input.deliveryCase);
    if (input.schemaVersion !== DELIVERY_SETTLEMENT_INPUT_SCHEMA) {
      return settlementResult(
        'failed',
        ['invalid-input-contract'],
        'Delivery settlement input schema is invalid.',
        inputHash,
      );
    }
    const invalid = invalidCase(input.deliveryCase);
    if (invalid) {
      return settlementResult(
        invalid === 'operator-authorization-missing' ? 'blocked' : 'failed',
        [invalid],
        'DeliveryReleaseCase failed contract validation.',
        inputHash,
      );
    }
    if (
      input.currentCandidateHash !== input.deliveryCase.integratedCandidate.hash
    ) {
      return settlementResult(
        'blocked',
        ['candidate-drifted'],
        'The candidate changed after Development certification.',
        inputHash,
      );
    }

    const preflight = input.preflight;
    if (preflight === null) {
      return settlementResult(
        'blocked',
        ['preflight-missing'],
        'No preflight snapshot exists.',
        inputHash,
      );
    }
    if (
      !referenceMatches(
        input.productReferences.preflight,
        DELIVERY_PREFLIGHT_SCHEMA,
        preflight.preflightHash,
      )
    ) {
      return settlementResult(
        'failed',
        ['preflight-lineage-mismatch'],
        'Preflight durable reference does not match the snapshot.',
        inputHash,
      );
    }
    const preflightResult = this.preflightPolicy.evaluate(
      input.deliveryCase,
      preflight,
    );
    if (preflightResult.event !== 'ready') {
      return settlementResult(
        preflightResult.event === 'failed' ? 'failed' : 'blocked',
        preflightResult.reasonCodes,
        preflightResult.rationale,
        inputHash,
      );
    }

    const approval = input.approval;
    if (approval === null) {
      return settlementResult(
        'approval-required',
        ['approval-missing'],
        'Release approval has not been materialized.',
        inputHash,
      );
    }
    if (
      approval.schemaVersion !== DELIVERY_APPROVAL_SCHEMA
      || hashDeliveryApproval(approval) !== approval.approvalHash
      || !referenceMatches(
        input.productReferences.approval,
        DELIVERY_APPROVAL_SCHEMA,
        approval.approvalHash,
      )
    ) {
      return settlementResult(
        'failed',
        ['approval-hash-invalid'],
        'Approval decision failed integrity validation.',
        inputHash,
      );
    }
    if (
      approval.candidateHash !== input.deliveryCase.integratedCandidate.hash
      || approval.preflightHash !== preflight.preflightHash
      || approval.releasePolicyHash !== input.deliveryCase.policy.contentHash
    ) {
      return settlementResult(
        'failed',
        ['approval-lineage-mismatch'],
        'Approval does not target the exact candidate, preflight and policy.',
        inputHash,
      );
    }

    if (input.deliveryCase.policy.humanApprovalRequired) {
      if (approval.status === 'pending' || approval.status === 'not-required') {
        return settlementResult(
          'approval-required',
          ['approval-missing'],
          'The release policy requires an explicit human decision.',
          inputHash,
        );
      }
      if (approval.status === 'denied') {
        return settlementResult(
          'blocked',
          ['approval-denied'],
          'Authorized release approval was denied.',
          inputHash,
        );
      }
      if (approval.status === 'expired') {
        return settlementResult(
          'approval-required',
          ['approval-expired'],
          'The prior approval expired for this candidate/preflight.',
          inputHash,
        );
      }
    }
    if (approval.status === 'approved') {
      if (
        approval.decision === null
        || !validRef(approval.decision)
        || approval.provider === null
        || !approval.provider.trusted
        || approval.provider.category !== 'authorized_decision'
        || approval.provider.providerId <= 0
        || !approval.provider.name.trim()
      ) {
        return settlementResult(
          'blocked',
          ['approval-provider-untrusted'],
          'Approved status lacks a trusted authorized-decision provider.',
          inputHash,
        );
      }
    } else if (
      !input.deliveryCase.policy.humanApprovalRequired
      && approval.status !== 'not-required'
    ) {
      if (approval.status === 'denied') {
        return settlementResult(
          'blocked',
          ['approval-denied'],
          'An explicit human decision denied release.',
          inputHash,
        );
      }
      if (approval.status === 'pending' || approval.status === 'expired') {
        return settlementResult(
          'approval-required',
          [approval.status === 'expired' ? 'approval-expired' : 'approval-missing'],
          'A recorded human approval has not reached an admissible terminal state.',
          inputHash,
        );
      }
    }

    const publication = input.publication;
    if (publication === null) {
      return settlementResult(
        'blocked',
        ['publication-missing'],
        'Publication/deployment actions have not been materialized.',
        inputHash,
      );
    }
    if (
      publication.schemaVersion !== DELIVERY_PUBLICATION_SCHEMA
      || hashDeliveryPublication(publication) !== publication.publicationHash
      || !referenceMatches(
        input.productReferences.publication,
        DELIVERY_PUBLICATION_SCHEMA,
        publication.publicationHash,
      )
    ) {
      return settlementResult(
        'failed',
        ['publication-hash-invalid'],
        'Publication snapshot failed integrity validation.',
        inputHash,
      );
    }
    if (
      publication.candidateHash !== input.deliveryCase.integratedCandidate.hash
      || publication.preflightHash !== preflight.preflightHash
      || publication.approvalHash !== approval.approvalHash
    ) {
      return settlementResult(
        'failed',
        ['publication-lineage-mismatch'],
        'Publication does not target the approved candidate/preflight.',
        inputHash,
      );
    }
    if (
      !actionPlansMatch(
        publication.plannedActions,
        input.deliveryCase.policy.actions,
      )
    ) {
      return settlementResult(
        'failed',
        ['action-plan-mismatch'],
        'Publication action plan differs from the immutable release policy.',
        inputHash,
      );
    }

    const actionById = new Map(
      input.deliveryCase.policy.actions.map(action => [action.actionId, action]),
    );
    const receiptByActionId = new Map(
      publication.receipts.map(receipt => [receipt.actionId, receipt]),
    );
    if (!unique(publication.receipts.map(receipt => receipt.actionId))) {
      return settlementResult(
        'failed',
        ['action-plan-mismatch'],
        'Publication contains duplicate action receipts.',
        inputHash,
      );
    }
    for (const action of input.deliveryCase.policy.actions) {
      const receipt = receiptByActionId.get(action.actionId);
      if (!receipt) {
        if (!action.required) continue;
        return settlementResult(
          'blocked',
          ['action-receipt-missing'],
          `Required action '${action.actionId}' has no durable receipt.`,
          inputHash,
        );
      }
      if (
        receipt.actionKey !== deliveryActionKey(input.deliveryCase, action)
        || receipt.kind !== action.kind
        || receipt.target !== action.target
        || receipt.payloadHash !== action.payloadHash
        || receipt.desiredStateHash !== action.desiredStateHash
        || !receipt.provider.trusted
        || receipt.provider.category !== 'authoritative_state'
        || receipt.provider.providerId <= 0
        || !receipt.provider.name.trim()
        || !['succeeded', 'failed', 'blocked', 'uncertain'].includes(
          receipt.status,
        )
        || typeof receipt.replayed !== 'boolean'
      ) {
        return settlementResult(
          'failed',
          ['action-key-invalid'],
          `Action receipt '${action.actionId}' does not match the desired-state command.`,
          inputHash,
        );
      }
    }
    if (
      publication.receipts.some(receipt => !actionById.has(receipt.actionId))
    ) {
      return settlementResult(
        'failed',
        ['action-plan-mismatch'],
        'Publication contains a receipt for an undeclared action.',
        inputHash,
      );
    }

    const observation = input.observation;
    if (observation === null) {
      return settlementResult(
        'blocked',
        ['observation-missing'],
        'Authoritative post-publication observation is missing.',
        inputHash,
      );
    }
    if (
      observation.schemaVersion !== DELIVERY_OBSERVATION_SCHEMA
      || hashDeliveryObservation(observation) !== observation.observationHash
      || !referenceMatches(
        input.productReferences.observation,
        DELIVERY_OBSERVATION_SCHEMA,
        observation.observationHash,
      )
    ) {
      return settlementResult(
        'failed',
        ['observation-hash-invalid'],
        'Observation snapshot failed integrity validation.',
        inputHash,
      );
    }
    if (
      observation.candidateHash
        !== input.deliveryCase.integratedCandidate.hash
      || observation.currentCandidateHash
        !== input.deliveryCase.integratedCandidate.hash
      || observation.publicationHash !== publication.publicationHash
    ) {
      return settlementResult(
        'failed',
        ['observation-lineage-mismatch'],
        'Observation does not target the exact publication and candidate.',
        inputHash,
      );
    }

    const observationByKey = new Map(
      observation.observations.map(item => [item.actionKey, item]),
    );
    if (!unique(observation.observations.map(item => item.actionKey))) {
      return settlementResult(
        'failed',
        ['observation-lineage-mismatch'],
        'Observation snapshot contains duplicate action keys.',
        inputHash,
      );
    }
    const actionByKey = new Map(
      input.deliveryCase.policy.actions.map(action => [
        deliveryActionKey(input.deliveryCase, action),
        action,
      ]),
    );
    for (const item of observation.observations) {
      const action = actionByKey.get(item.actionKey);
      if (
        !action
        || !receiptByActionId.has(action.actionId)
        || item.target !== action.target
        || item.desiredStateHash !== action.desiredStateHash
        || !validRef(item.observation)
        || !['matched', 'mismatched', 'unknown', 'error'].includes(
          item.outcome,
        )
      ) {
        return settlementResult(
          'failed',
          ['observation-lineage-mismatch'],
          `Observation '${item.actionKey}' is undeclared or has invalid desired-state lineage.`,
          inputHash,
        );
      }
      if (
        !item.provider.trusted
        || item.provider.category !== 'authoritative_state'
        || item.provider.providerId <= 0
        || !item.provider.name.trim()
      ) {
        return settlementResult(
          'blocked',
          ['observation-provider-untrusted'],
          `Observation provider for '${action.actionId}' is not trusted authoritative state.`,
          inputHash,
        );
      }
      if (
        item.outcome === 'matched'
        && item.observedStateHash !== action.desiredStateHash
      ) {
        return settlementResult(
          'failed',
          ['observation-lineage-mismatch'],
          `Matched observation for '${action.actionId}' carries the wrong state hash.`,
          inputHash,
        );
      }
    }

    for (const action of input.deliveryCase.policy.actions) {
      if (!action.required) continue;
      const key = deliveryActionKey(input.deliveryCase, action);
      const item = observationByKey.get(key);
      const receipt = receiptByActionId.get(action.actionId);
      if (!item || !receipt) {
        return settlementResult(
          'blocked',
          ['observation-missing'],
          `Required action '${action.actionId}' lacks an authoritative observation.`,
          inputHash,
        );
      }
      if (
        item.target !== action.target
        || item.desiredStateHash !== action.desiredStateHash
      ) {
        return settlementResult(
          'failed',
          ['observation-lineage-mismatch'],
          `Observation for '${action.actionId}' has invalid desired-state lineage.`,
          inputHash,
        );
      }
      if (
        !item.provider.trusted
        || item.provider.category !== 'authoritative_state'
      ) {
        return settlementResult(
          'blocked',
          ['observation-provider-untrusted'],
          `Observation provider for '${action.actionId}' is not trusted authoritative state.`,
          inputHash,
        );
      }
      if (
        item.outcome === 'matched'
        && item.observedStateHash !== action.desiredStateHash
      ) {
        return settlementResult(
          'failed',
          ['observation-lineage-mismatch'],
          `Matched observation for '${action.actionId}' carries the wrong state hash.`,
          inputHash,
        );
      }
      if (item.outcome === 'mismatched') {
        return settlementResult(
          receipt.status === 'failed' ? 'failed' : 'blocked',
          [receipt.status === 'failed' ? 'action-failed' : 'observation-mismatched'],
          `Observed state for '${action.actionId}' does not match the desired state.`,
          inputHash,
        );
      }
      if (item.outcome === 'unknown') {
        return settlementResult(
          'blocked',
          [receipt.status === 'uncertain' ? 'action-uncertain' : 'observation-inconclusive'],
          `Observed state for '${action.actionId}' is unknown.`,
          inputHash,
        );
      }
      if (item.outcome === 'error') {
        return settlementResult(
          'failed',
          ['infrastructure-error'],
          `Observation for '${action.actionId}' failed.`,
          inputHash,
        );
      }
      if (!receipt.externalRef) {
        return settlementResult(
          'blocked',
          ['action-receipt-missing'],
          `Matched action '${action.actionId}' has no canonical external reference.`,
          inputHash,
        );
      }
    }
    if (!observation.complete) {
      return settlementResult(
        'blocked',
        ['observation-inconclusive'],
        'Post-publication observation is incomplete.',
        inputHash,
      );
    }

    const preflightRef = input.productReferences.preflight;
    const approvalRef = input.productReferences.approval;
    const publicationRef = input.productReferences.publication;
    const observationRef = input.productReferences.observation;
    if (
      preflightRef === null
      || approvalRef === null
      || publicationRef === null
      || observationRef === null
    ) {
      return settlementResult(
        'failed',
        ['infrastructure-error'],
        'A validated Delivery product is missing its durable reference.',
        inputHash,
      );
    }

    const destinations = input.deliveryCase.policy.actions.flatMap(action => {
      const receipt = receiptByActionId.get(action.actionId);
      const observed = observationByKey.get(
        deliveryActionKey(input.deliveryCase, action),
      );
      if (
        !receipt?.externalRef
        || observed?.outcome !== 'matched'
        || observed.observedStateHash === null
      ) {
        return [];
      }
      return [{
        actionKey: receipt.actionKey,
        kind: action.kind,
        target: action.target,
        externalRef: receipt.externalRef,
        observedStateHash: observed.observedStateHash,
      }];
    });
    const recordBody: Omit<ReleaseRecord, 'recordHash'> = {
      schemaVersion: RELEASE_RECORD_SCHEMA,
      developmentCertificate: input.deliveryCase.developmentCertificate,
      verifiedIntegrationBundle: input.deliveryCase.verifiedIntegrationBundle,
      integratedCandidate: input.deliveryCase.integratedCandidate,
      policy: input.deliveryCase.policy,
      preflight: preflightRef,
      approval: approvalRef,
      publication: publicationRef,
      observation: observationRef,
      destinations,
    };
    const releaseRecord: ReleaseRecord = {
      ...recordBody,
      recordHash: sha256Hex(recordBody),
    };

    return settlementResult(
      'released',
      [],
      'Every required desired-state action is authoritatively observed for the approved certified candidate.',
      inputHash,
      releaseRecord,
    );
  }
}

export function buildDeliveryCertificatePayload(
  settlement: DeliverySettlementResult,
  input: DeliverySettlementInput,
): DeliveryCertificatePayload {
  return {
    schemaVersion: DELIVERY_CERTIFICATE_SCHEMA,
    decision: settlement.decision,
    reasonCodes: settlement.reasonCodes,
    rationale: settlement.rationale,
    inputHash: settlement.inputHash,
    developmentCertificateHash:
      input.deliveryCase.developmentCertificate.hash,
    verifiedIntegrationBundleHash:
      input.deliveryCase.verifiedIntegrationBundle.hash,
    candidateHash: input.deliveryCase.integratedCandidate.hash,
    releasePolicyHash: input.deliveryCase.policy.contentHash,
    preflightHash: input.preflight?.preflightHash ?? null,
    approvalHash: input.approval?.approvalHash ?? null,
    publicationHash: input.publication?.publicationHash ?? null,
    observationHash: input.observation?.observationHash ?? null,
    releaseRecordHash: settlement.releaseRecord?.recordHash ?? null,
  };
}
