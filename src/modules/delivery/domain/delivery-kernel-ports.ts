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
import type {
  ProcessOutcomeCertificateRepository,
} from '../../../process-modules/persistence/process-outcome-certificate-repository.js';

export const DELIVERY_KERNEL_HANDLER_IDS = {
  preflight: 'delivery-preflight-policy',
  publishDeploy: 'delivery-publish-deploy',
  observeRelease: 'delivery-observe-release',
  settle: 'delivery-settlement-policy',
} as const;

export const DELIVERY_HUMAN_ADAPTER_IDS = {
  approval: 'delivery-release-approval',
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
  /**
   * Wave 4 (Uncle Bob) — the settlement kernel now issues the
   * ProcessOutcomeCertificate ITSELF and emits an explicit ModuleCompletion
   * whose outputEnvelope.certificateRef points at the issued row. This replaces
   * the legacy reliance on the generic-flow-executor's magic-bindings
   * certificateRepo.issue (generic-flow-executor.ts:377). The magic bindings
   * are KEPT alongside (additive) until Wave 5 deletes that branch.
   */
  certificateRepo: ProcessOutcomeCertificateRepository;
}

// ---------------------------------------------------------------------------
// Wave 7 hex-extraction ports (driver-neutral, inline). Mirror the Development
// module: these ports let the Delivery module's SQLite adapters accept their
// concrete dependencies as injected ports instead of constructing them with
// getDb()/Sqlite* internally. Defined inline (record types only) so the module
// imports neither the concrete adapters nor db.ts. The concrete implementations
// live in infrastructure (src/infrastructure/process-modules/delivery-ports.ts)
// and are injected by the composition root.
// ---------------------------------------------------------------------------

/**
 * ProcessRun schema-ensure port. Replaces the direct
 * `ensureSaga3ProcessRunSchema` import from the shared SQLite process-run
 * repository. Delivery's own tables reference saga3_process_runs; this port
 * guarantees that parent table exists before delivery's tables are created,
 * without the module importing the concrete SQLite repository.
 */
export interface ProcessRunSchemaEnsurePort {
  ensure(db: unknown): void;
}

/**
 * Driver-neutral port for the v1 process-product repository (keyed by
 * processRunId + productKind). Delivery's runtime reads/writes its durable
 * preflight/approval/publication/observation products through this surface;
 * the concrete SQLite implementation is supplied by the composition root.
 * Identical shape to Development's ProcessProductRepositoryPort.
 */
export interface DeliveryProcessProductReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface DeliveryProcessProductRecord<T = unknown> {
  processRunId: number;
  productKind: string;
  reference: DeliveryProcessProductReference;
  payload: T;
  payloadHash: string;
  createdAt: string;
}

export interface DeliveryProcessProductRepositoryPort {
  persist<T>(input: {
    processRunId: number;
    productKind: string;
    schema: string;
    productHash: string;
    payload: T;
    artifactRefPrefix: string;
  }): {
    record: DeliveryProcessProductRecord<T>;
    replayed: boolean;
  };
  read<T>(
    processRunId: number,
    productKind: string,
  ): DeliveryProcessProductRecord<T> | null;
}

/**
 * Driver-neutral external-effect ledger port. Delivery's runtime records
 * publish/deploy action execution results through this surface; the concrete
 * SQLite implementation is supplied by the composition root. Mirrors the
 * ExternalEffectLedger interface from persistence/external-effect-ledger.ts
 * but defined here in module-local terms so the module imports no concrete
 * adapter.
 */
export interface DeliveryExternalEffectActionRecord {
  id: number;
  providerNamespace: string;
  actionKey: string;
  processRunId: number;
  moduleRef: { name: string; version: string };
  moduleRefKey: string;
  nodeId: string;
  requestSnapshot: string;
  requestHash: string;
  state:
    | 'new'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'unknown'
    | 'retry-authorized'
    | 'blocked';
  claimFence: number;
  activeClaimKind: 'execution' | 'observation' | null;
  activeClaimOwner: string | null;
  activeClaimExpiresAt: string | null;
  executionAttempts: number;
  providerEffectId: string | null;
  lastError: string | null;
  lastExecutionFence: number | null;
  lastExecutionOwner: string | null;
  executionResultSnapshot: string | null;
  executionResultHash: string | null;
  lastObservationFence: number | null;
  lastObservationOwner: string | null;
  observationSnapshot: string | null;
  observationHash: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DeliveryExternalEffectClaim {
  actionId: number;
  kind: 'execution' | 'observation';
  owner: string;
  fence: number;
  expiresAt: string;
}

export type DeliveryExternalEffectExecutionResult =
  | {
      outcome: 'succeeded';
      receipt: Record<string, unknown>;
      providerEffectId?: string | null;
    }
  | {
      outcome: 'failed' | 'unknown';
      error: string;
      details?: Record<string, unknown>;
      providerEffectId?: string | null;
    };

export interface DeliveryExternalEffectLedgerPort {
  start(command: {
    providerNamespace: string;
    actionKey: string;
    processRunId: number;
    moduleRef: { name: string; version: string };
    nodeId: string;
    request: Record<string, unknown>;
    requestHash: string;
  }): {
    record: DeliveryExternalEffectActionRecord;
    replayed: boolean;
  };

  claim(command: {
    actionId: number;
    owner: string;
    leaseSeconds: number;
  }): {
    record: DeliveryExternalEffectActionRecord;
    claim: DeliveryExternalEffectClaim;
  } | null;

  recordExecutionResult(command: {
    claim: DeliveryExternalEffectClaim;
    result: DeliveryExternalEffectExecutionResult;
  }): DeliveryExternalEffectActionRecord;
}
