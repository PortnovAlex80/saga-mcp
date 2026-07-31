/**
 * Ports and stable handler/adapter identifiers for Delivery/Release.
 *
 * No provider is selected here. Composition must inject every preflight,
 * human-approval, publication/deployment and observation implementation.
 */

import type {
  AuthorizedDeliveryReleaseCase,
  DeliveryApprovalDecision,
  DeliveryApprovalStatus,
  DeliveryObservationSnapshot,
  DeliveryPreflightSnapshot,
  DeliveryPublicationSnapshot,
  DeliveryProviderBinding,
  DeliveryReleaseCase,
  DeliverySettlementInput,
  DeliveryContentAddressedReference,
  ReleaseRecord,
} from './delivery-schemas.js';
import type {
  DeliveryPreflightPolicyPort,
  DeliverySettlementPolicyPort,
} from './delivery-settlement-policy.js';

export const DELIVERY_KERNEL_HANDLER_IDS = {
  preflight: 'delivery-preflight-policy',
  settle: 'delivery-settlement-policy',
} as const;

export const DELIVERY_HUMAN_ADAPTER_IDS = {
  approval: 'delivery-release-approval',
} as const;

export const DELIVERY_EXTERNAL_ADAPTER_IDS = {
  publishDeploy: 'delivery-publish-deploy',
  observeRelease: 'delivery-observe-release',
} as const;

export interface DeliveryPreflightStatePort {
  buildPreflightSnapshot(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    heartbeat: () => void;
  }): {
    preflight: DeliveryPreflightSnapshot;
    reference: DeliveryContentAddressedReference;
  };
}

export interface DeliveryApprovalPort {
  decide(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    preflightHash: string;
    heartbeat: () => void;
  }): Promise<{
    status: DeliveryApprovalStatus;
    decision: DeliveryContentAddressedReference | null;
    provider: DeliveryProviderBinding | null;
  }>;
}

export interface DeliveryPublicationPort {
  /**
   * Execute desired-state actions. Implementations must use each action's
   * deterministic actionKey, observe before acting, and persist uncertain
   * results for the observation adapter instead of blind retry.
   */
  publishAndDeploy(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    preflight: DeliveryPreflightSnapshot;
    approval: DeliveryApprovalDecision;
    heartbeat: () => void;
  }): Promise<{
    publication: DeliveryPublicationSnapshot;
    reference: DeliveryContentAddressedReference;
  }>;
}

export interface DeliveryObservationPort {
  observe(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    publication: DeliveryPublicationSnapshot;
    heartbeat: () => void;
  }): Promise<{
    observation: DeliveryObservationSnapshot;
    reference: DeliveryContentAddressedReference;
  }>;
}

export interface DeliverySettlementStatePort {
  buildSettlementInput(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
  }): DeliverySettlementInput;
}

export interface DeliveryOutputRecord {
  processRunId: number;
  projectId: number;
  epicId: number | null;
  artifactRef: string;
  contentHash: string;
  payload: ReleaseRecord;
}

/**
 * Durable canonical ReleaseRecord store. The exposed contentHash covers the
 * complete payload and is rechecked by the lifecycle payload registry.
 */
export interface DeliveryOutputRepository {
  persist(input: {
    processRunId: number;
    projectId: number;
    epicId: number | null;
    payload: ReleaseRecord;
  }): {
    record: DeliveryOutputRecord;
    replayed: boolean;
  };
  readByProcessRun(processRunId: number): DeliveryOutputRecord | null;
}

/**
 * Required installation dependencies. There are intentionally no optional
 * fallback providers or default external adapters.
 */
export interface DeliveryModuleInstallationDependencies {
  preflightState: DeliveryPreflightStatePort;
  approval: DeliveryApprovalPort;
  publication: DeliveryPublicationPort;
  observation: DeliveryObservationPort;
  settlementState: DeliverySettlementStatePort;
  outputRepository: DeliveryOutputRepository;
  preflightPolicy: DeliveryPreflightPolicyPort;
  settlementPolicy: DeliverySettlementPolicyPort;
}
