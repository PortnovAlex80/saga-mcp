/**
 * Domain contracts for Delivery/Release.
 *
 * External publication cannot be made transactionally atomic across Git,
 * registries and deployment systems. The module therefore models desired
 * actions and authoritative observations explicitly. Every action has a
 * deterministic key and every retry observes the target before acting.
 */

// CONVEYOR Wave 7: these two schema-id strings are lifecycle-referenced
// contracts whose canonical home is the lifecycle contracts module (Rule 3).
// Re-exported here so the module's own consumers keep a single import surface.
export {
  DELIVERY_RELEASE_CASE_SCHEMA,
  DELIVERY_DEFERRED_PROFILE_SCHEMA,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import {
  DELIVERY_RELEASE_CASE_SCHEMA,
  DELIVERY_DEFERRED_PROFILE_SCHEMA,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
export const DELIVERY_PREFLIGHT_SCHEMA = 'factory.delivery-preflight.v1';
export const DELIVERY_APPROVAL_SCHEMA = 'factory.delivery-approval-decision.v1';
export const DELIVERY_PUBLICATION_SCHEMA = 'factory.delivery-publication.v1';
export const DELIVERY_OBSERVATION_SCHEMA = 'factory.delivery-observation.v1';
export const RELEASE_RECORD_SCHEMA = 'factory.release-record.v1';
export const DELIVERY_SETTLEMENT_INPUT_SCHEMA =
  'factory.delivery-settlement-input.v1';
export const DELIVERY_CERTIFICATE_SCHEMA = 'factory.delivery-certificate.v2';

export interface DeliveryContentAddressedReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface DeliveryProviderBinding {
  providerId: number;
  name: string;
  version: string | null;
  category:
    | 'deterministic_evidence'
    | 'authoritative_state'
    | 'authorized_decision';
  trusted: boolean;
}

export type ReleaseActionKind =
  | 'source-tag'
  | 'source-release'
  | 'package-publish'
  | 'deployment';

export interface ReleaseActionDefinition {
  actionId: string;
  kind: ReleaseActionKind;
  target: string;
  desiredStateHash: string;
  payloadHash: string;
  required: boolean;
}

export interface DeliveryReleasePolicySnapshot {
  id: string;
  version: string;
  contentHash: string;
  channel: string;
  releaseVersion: string;
  releaseTag: string;
  humanApprovalRequired: boolean;
  requiredPreflightCheckIds: readonly string[];
  actions: readonly ReleaseActionDefinition[];
}

export interface DeliveryDeferredProfile {
  schemaVersion: typeof DELIVERY_DEFERRED_PROFILE_SCHEMA;
  reason: 'authorization-required';
  source: 'start-from-idea' | 'operator-deferred';
  profileHash: string;
}

interface DeliveryReleaseCaseBase {
  schemaVersion: typeof DELIVERY_RELEASE_CASE_SCHEMA;
  projectId: number;
  epicId: number | null;
  developmentCertificate: DeliveryContentAddressedReference & {
    decision: 'verified';
  };
  verifiedIntegrationBundle: DeliveryContentAddressedReference;
  integratedCandidate: DeliveryContentAddressedReference;
  initiatedBy: string;
}

export interface AuthorizedDeliveryReleaseCase extends DeliveryReleaseCaseBase {
  deliveryMode: 'authorized';
  policy: DeliveryReleasePolicySnapshot;
  /**
   * Explicit operator grant for externally-visible release effects.
   *
   * A complete Lifecycle cannot name the candidate hash before Development
   * produces it. `lifecycle-output` therefore authorizes the exact candidate
   * handed off by the preceding stage under this immutable release policy.
   * Standalone Delivery callers may instead bind one already-known hash.
   */
  operatorAuthorization: DeliveryContentAddressedReference & {
    requestedBy: string;
    releasePolicyHash: string;
    candidateScope:
      | {
          mode: 'exact';
          candidateHash: string;
        }
      | {
          mode: 'lifecycle-output';
        };
  };
  deferredProfile: null;
}

export interface DeferredDeliveryReleaseCase extends DeliveryReleaseCaseBase {
  deliveryMode: 'deferred';
  policy: null;
  operatorAuthorization: null;
  deferredProfile: DeliveryDeferredProfile;
}

export type DeliveryReleaseCase =
  | AuthorizedDeliveryReleaseCase
  | DeferredDeliveryReleaseCase;

export type GuardOutcome = 'passed' | 'failed' | 'unknown' | 'error';

export interface DeliveryPreflightCheck {
  checkId: string;
  subjectCandidateHash: string;
  outcome: GuardOutcome;
  evidence: DeliveryContentAddressedReference;
  provider: DeliveryProviderBinding;
}

export interface DeliveryPreflightSnapshot {
  schemaVersion: typeof DELIVERY_PREFLIGHT_SCHEMA;
  candidateHash: string;
  developmentCertificateHash: string;
  releasePolicyHash: string;
  checks: readonly DeliveryPreflightCheck[];
  complete: boolean;
  preflightHash: string;
}

export type DeliveryApprovalStatus =
  | 'not-required'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired';

export interface DeliveryApprovalDecision {
  schemaVersion: typeof DELIVERY_APPROVAL_SCHEMA;
  status: DeliveryApprovalStatus;
  candidateHash: string;
  preflightHash: string;
  releasePolicyHash: string;
  decision: DeliveryContentAddressedReference | null;
  provider: DeliveryProviderBinding | null;
  approvalHash: string;
}

export interface DeliveryActionReceipt {
  actionKey: string;
  actionId: string;
  kind: ReleaseActionKind;
  target: string;
  payloadHash: string;
  desiredStateHash: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'uncertain';
  externalRef: string | null;
  resultHash: string | null;
  provider: DeliveryProviderBinding;
  replayed: boolean;
}

export interface DeliveryPublicationSnapshot {
  schemaVersion: typeof DELIVERY_PUBLICATION_SCHEMA;
  candidateHash: string;
  preflightHash: string;
  approvalHash: string;
  plannedActions: readonly ReleaseActionDefinition[];
  receipts: readonly DeliveryActionReceipt[];
  publicationHash: string;
}

export interface DeliveryActionObservation {
  actionKey: string;
  target: string;
  desiredStateHash: string;
  observedStateHash: string | null;
  outcome: 'matched' | 'mismatched' | 'unknown' | 'error';
  observation: DeliveryContentAddressedReference;
  provider: DeliveryProviderBinding;
}

export interface DeliveryObservationSnapshot {
  schemaVersion: typeof DELIVERY_OBSERVATION_SCHEMA;
  candidateHash: string;
  publicationHash: string;
  currentCandidateHash: string;
  observations: readonly DeliveryActionObservation[];
  complete: boolean;
  observationHash: string;
}

export interface ReleasedDestination {
  actionKey: string;
  kind: ReleaseActionKind;
  target: string;
  externalRef: string;
  observedStateHash: string;
}

export interface ReleaseRecord {
  schemaVersion: typeof RELEASE_RECORD_SCHEMA;
  developmentCertificate: DeliveryContentAddressedReference;
  verifiedIntegrationBundle: DeliveryContentAddressedReference;
  integratedCandidate: DeliveryContentAddressedReference;
  policy: DeliveryReleasePolicySnapshot;
  preflight: DeliveryContentAddressedReference;
  approval: DeliveryContentAddressedReference;
  publication: DeliveryContentAddressedReference;
  observation: DeliveryContentAddressedReference;
  destinations: readonly ReleasedDestination[];
  recordHash: string;
}

export interface DeliverySettlementInput {
  schemaVersion: typeof DELIVERY_SETTLEMENT_INPUT_SCHEMA;
  deliveryCase: DeliveryReleaseCase;
  preflight: DeliveryPreflightSnapshot | null;
  approval: DeliveryApprovalDecision | null;
  publication: DeliveryPublicationSnapshot | null;
  observation: DeliveryObservationSnapshot | null;
  currentCandidateHash: string | null;
  productReferences: {
    preflight: DeliveryContentAddressedReference | null;
    approval: DeliveryContentAddressedReference | null;
    publication: DeliveryContentAddressedReference | null;
    observation: DeliveryContentAddressedReference | null;
  };
}

export type DeliveryDecision =
  | 'released'
  | 'approval-required'
  | 'blocked'
  | 'failed';

export type DeliveryReasonCode =
  | 'invalid-input-contract'
  | 'development-certificate-invalid'
  | 'operator-authorization-missing'
  | 'release-policy-invalid'
  | 'candidate-drifted'
  | 'preflight-missing'
  | 'preflight-hash-invalid'
  | 'preflight-lineage-mismatch'
  | 'preflight-check-missing'
  | 'preflight-check-failed'
  | 'preflight-check-inconclusive'
  | 'preflight-provider-untrusted'
  | 'approval-missing'
  | 'approval-hash-invalid'
  | 'approval-lineage-mismatch'
  | 'approval-provider-untrusted'
  | 'approval-denied'
  | 'approval-expired'
  | 'publication-missing'
  | 'publication-hash-invalid'
  | 'publication-lineage-mismatch'
  | 'action-plan-mismatch'
  | 'action-receipt-missing'
  | 'action-key-invalid'
  | 'action-failed'
  | 'action-uncertain'
  | 'observation-missing'
  | 'observation-hash-invalid'
  | 'observation-lineage-mismatch'
  | 'observation-mismatched'
  | 'observation-inconclusive'
  | 'observation-provider-untrusted'
  | 'infrastructure-error';

export interface DeliveryCertificatePayload {
  schemaVersion: typeof DELIVERY_CERTIFICATE_SCHEMA;
  decision: DeliveryDecision;
  reasonCodes: readonly DeliveryReasonCode[];
  rationale: string;
  inputHash: string;
  developmentCertificateHash: string;
  verifiedIntegrationBundleHash: string;
  candidateHash: string;
  releasePolicyHash: string | null;
  deferredProfileHash: string | null;
  preflightHash: string | null;
  approvalHash: string | null;
  publicationHash: string | null;
  observationHash: string | null;
  releaseRecordHash: string | null;
}
