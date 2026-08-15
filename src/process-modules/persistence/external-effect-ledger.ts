import type { ProcessModuleReference } from '../domain/process-module.js';

/**
 * Durable state of one externally visible side effect.
 *
 * `failed` and `unknown` are deliberately not retryable states. A provider
 * reconciliation must first prove either that the requested effect exists
 * (`succeeded`), that it is absent and safe to retry (`retry-authorized`), or
 * that further execution must stop (`blocked`).
 */
export type ExternalEffectActionState =
  | 'new'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'retry-authorized'
  | 'blocked';

export type ExternalEffectClaimKind = 'execution' | 'observation';

export interface ExternalEffectActionRecord {
  id: number;
  providerNamespace: string;
  actionKey: string;
  processRunId: number;
  moduleRef: ProcessModuleReference;
  moduleRefKey: string;
  nodeId: string;
  requestSnapshot: string;
  requestHash: string;
  state: ExternalEffectActionState;
  claimFence: number;
  activeClaimKind: ExternalEffectClaimKind | null;
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

export interface StartExternalEffectActionCommand {
  /** Stable provider/adapter namespace, for example `github.release.v1`. */
  providerNamespace: string;
  /**
   * Deterministic key chosen by the caller for this logical effect. It must not
   * be a random execution-attempt id.
   */
  actionKey: string;
  processRunId: number;
  moduleRef: ProcessModuleReference;
  nodeId: string;
  request: Record<string, unknown>;
  /** SHA-256 of the canonical request JSON. Verified by the repository. */
  requestHash: string;
}

export interface ExternalEffectClaim {
  actionId: number;
  kind: ExternalEffectClaimKind;
  owner: string;
  fence: number;
  expiresAt: string;
}

export interface ClaimExternalEffectCommand {
  actionId: number;
  owner: string;
  leaseSeconds: number;
}

export type ExternalEffectExecutionResult =
  | {
      outcome: 'succeeded';
      receipt: Record<string, unknown>;
      providerEffectId?: string | null;
    }
  | {
      outcome: 'failed';
      error: string;
      details?: Record<string, unknown>;
      providerEffectId?: string | null;
    }
  | {
      outcome: 'unknown';
      error: string;
      details?: Record<string, unknown>;
      providerEffectId?: string | null;
    };

export interface RecordExternalEffectExecutionResultCommand {
  claim: ExternalEffectClaim;
  result: ExternalEffectExecutionResult;
}

export type ExternalEffectObservation =
  | {
      outcome: 'matched';
      evidence: Record<string, unknown>;
      providerEffectId?: string | null;
    }
  | {
      outcome: 'absent-retry-safe';
      evidence: Record<string, unknown>;
    }
  | {
      outcome: 'blocked';
      evidence: Record<string, unknown>;
      reason: string;
    };

export interface RecordExternalEffectObservationCommand {
  claim: ExternalEffectClaim;
  observation: ExternalEffectObservation;
}

/**
 * Persistence port only. Provider calls and provider-specific interpretation
 * stay in external adapters; this port records authority, fencing and history.
 */
export interface ExternalEffectLedger {
  start(command: StartExternalEffectActionCommand): {
    record: ExternalEffectActionRecord;
    replayed: boolean;
  };

  read(actionId: number): ExternalEffectActionRecord | null;

  readByKey(
    providerNamespace: string,
    actionKey: string,
  ): ExternalEffectActionRecord | null;

  /**
   * Claim permission to perform the provider mutation. Returns null while
   * another execution is in-flight or after a terminal outcome.
   */
  claim(command: ClaimExternalEffectCommand): {
    record: ExternalEffectActionRecord;
    claim: ExternalEffectClaim;
  } | null;

  recordExecutionResult(
    command: RecordExternalEffectExecutionResultCommand,
  ): ExternalEffectActionRecord;

  /**
   * Claim permission to reconcile provider state. An expired `executing`
   * action is atomically converted to `unknown` before this claim is issued.
   */
  claimObservation(command: ClaimExternalEffectCommand): {
    record: ExternalEffectActionRecord;
    claim: ExternalEffectClaim;
  } | null;

  recordObservation(
    command: RecordExternalEffectObservationCommand,
  ): ExternalEffectActionRecord;
}
