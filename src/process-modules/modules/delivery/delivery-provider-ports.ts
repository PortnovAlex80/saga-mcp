import type {
  DeliveryApprovalStatus,
  DeliveryContentAddressedReference,
  DeliveryProviderBinding,
  DeliveryReleaseCase,
  GuardOutcome,
  ReleaseActionDefinition,
} from './delivery-schemas.js';

export type DeliveryProviderIdentity = Omit<
  DeliveryProviderBinding,
  'trusted'
>;

export interface DeliveryPreflightCheckResult {
  outcome: GuardOutcome;
  evidence: DeliveryContentAddressedReference;
  provider: DeliveryProviderIdentity;
}

/** Deterministic/read-only guard provider. */
export interface DeliveryPreflightCheckProvider {
  evaluate(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    checkId: string;
    heartbeat: () => void;
  }): DeliveryPreflightCheckResult;
}

export interface DeliveryApprovalSourceResult {
  status: Exclude<DeliveryApprovalStatus, 'not-required'>;
  decision: DeliveryContentAddressedReference | null;
  provider: DeliveryProviderIdentity | null;
}

/**
 * Human/policy authority. `pending` is a normal resumable result and must not
 * be converted into an approval by the adapter.
 */
export interface DeliveryApprovalSource {
  decide(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    preflightHash: string;
    heartbeat: () => void;
  }): Promise<DeliveryApprovalSourceResult> | DeliveryApprovalSourceResult;
}

export type DeliveryActionExecutionResult =
  | {
      outcome: 'succeeded';
      externalRef: string;
      resultHash: string;
    }
  | {
      outcome: 'failed' | 'blocked' | 'uncertain';
      externalRef?: string | null;
      resultHash?: string | null;
      error: string;
    };

export type DeliveryActionObservationResult =
  | {
      outcome: 'matched' | 'mismatched';
      observedStateHash: string;
      observation: DeliveryContentAddressedReference;
    }
  | {
      outcome: 'unknown' | 'error';
      observedStateHash?: string | null;
      observation: DeliveryContentAddressedReference;
      error: string;
    };

/**
 * One provider may support one or several action kinds. Namespace is persisted
 * in the external-effect ledger and therefore must be stable across versions
 * that share idempotency semantics.
 */
export interface DeliveryActionProvider {
  readonly namespace: string;
  readonly identity: DeliveryProviderIdentity;

  execute(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    action: ReleaseActionDefinition;
    actionKey: string;
    heartbeat: () => void;
  }): Promise<DeliveryActionExecutionResult>;

  observe(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    action: ReleaseActionDefinition;
    actionKey: string;
    externalRef: string | null;
    heartbeat: () => void;
  }): Promise<DeliveryActionObservationResult>;
}

export interface DeliveryRuntimeProviders {
  preflight: DeliveryPreflightCheckProvider;
  approval: DeliveryApprovalSource;
  actionProviders: Partial<
    Record<ReleaseActionDefinition['kind'], DeliveryActionProvider>
  >;
  /**
   * Synchronous authoritative observation used by settlement immediately
   * after the observation node. Null denies release.
   */
  observeCurrentCandidateHash(
    deliveryCase: DeliveryReleaseCase,
  ): string | null;
}
