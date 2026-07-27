import type Database from 'better-sqlite3';
import { getDb } from '../../../db.js';
import type {
  ExternalEffectActionRecord,
  ExternalEffectLedger,
} from '../../persistence/external-effect-ledger.js';
import { SqliteExternalEffectLedger } from '../../persistence/sqlite-external-effect-ledger.js';
import {
  SqliteProcessProductRepository,
} from '../../persistence/sqlite-process-product-repository.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  DeliveryApprovalPort,
  DeliveryObservationPort,
  DeliveryPreflightStatePort,
  DeliveryPublicationPort,
  DeliverySettlementStatePort,
} from './delivery-kernel-ports.js';
import {
  DELIVERY_PROCESS_MODULE_REF,
} from './delivery-process-module.js';
import type {
  DeliveryActionExecutionResult,
  DeliveryActionObservationResult,
  DeliveryProviderIdentity,
  DeliveryRuntimeProviders,
} from './delivery-provider-ports.js';
import {
  DELIVERY_APPROVAL_SCHEMA,
  DELIVERY_OBSERVATION_SCHEMA,
  DELIVERY_PREFLIGHT_SCHEMA,
  DELIVERY_PUBLICATION_SCHEMA,
  DELIVERY_SETTLEMENT_INPUT_SCHEMA,
  type DeliveryActionObservation,
  type DeliveryActionReceipt,
  type DeliveryApprovalDecision,
  type DeliveryContentAddressedReference,
  type DeliveryObservationSnapshot,
  type DeliveryPreflightCheck,
  type DeliveryPreflightSnapshot,
  type DeliveryProviderBinding,
  type DeliveryPublicationSnapshot,
  type DeliveryReleaseCase,
  type DeliverySettlementInput,
  type ReleaseActionDefinition,
} from './delivery-schemas.js';
import {
  deliveryActionKey,
  hashDeliveryApproval,
  hashDeliveryObservation,
  hashDeliveryPreflight,
  hashDeliveryPublication,
} from './delivery-settlement-policy.js';

const PRODUCT_KINDS = {
  preflight: 'delivery.preflight',
  approval: 'delivery.approval',
  approvalPending: 'delivery.approval.pending',
  publication: 'delivery.publication',
  observation: 'delivery.observation',
} as const;

const DELIVERY_PUBLICATION_NODE_ID = 'publish-deploy';
const EFFECT_LEASE_SECONDS = 300;

export interface SqliteDeliveryRuntimeOptions {
  providers: DeliveryRuntimeProviders;
  db?: Database.Database;
  effectLedger?: ExternalEffectLedger;
  effectOwner?: string;
}

/**
 * Provider-neutral Delivery implementation.
 *
 * The adapter owns hashes, durable products, provider trust resolution and the
 * external-effect protocol. Providers only implement their actual guard,
 * human authority, publish/deploy and observation operations.
 */
export class SqliteDeliveryRuntime implements
  DeliveryPreflightStatePort,
  DeliveryApprovalPort,
  DeliveryPublicationPort,
  DeliveryObservationPort,
  DeliverySettlementStatePort {
  private readonly db: Database.Database;
  private readonly products: SqliteProcessProductRepository;
  private readonly ledger: ExternalEffectLedger;
  private readonly providers: DeliveryRuntimeProviders;
  private readonly effectOwner: string;

  constructor(options: SqliteDeliveryRuntimeOptions) {
    this.db = options.db ?? getDb();
    this.products = new SqliteProcessProductRepository(this.db);
    this.ledger = options.effectLedger
      ?? new SqliteExternalEffectLedger(this.db);
    this.providers = options.providers;
    this.effectOwner = options.effectOwner?.trim()
      || `delivery-runtime:${process.pid}`;
  }

  buildPreflightSnapshot(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    heartbeat: () => void;
  }): {
    preflight: DeliveryPreflightSnapshot;
    reference: DeliveryContentAddressedReference;
  } {
    const replay = this.products.read<DeliveryPreflightSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.preflight,
    );
    if (replay) {
      return {
        preflight: replay.payload,
        reference: replay.reference,
      };
    }

    const checks: DeliveryPreflightCheck[] = [];
    for (const checkId of input.deliveryCase.policy.requiredPreflightCheckIds) {
      input.heartbeat();
      const evaluated = this.providers.preflight.evaluate({
        processRunId: input.processRunId,
        deliveryCase: input.deliveryCase,
        checkId,
        heartbeat: input.heartbeat,
      });
      checks.push({
        checkId,
        subjectCandidateHash: input.deliveryCase.integratedCandidate.hash,
        outcome: evaluated.outcome,
        evidence: evaluated.evidence,
        provider: this.resolveTrustedProvider(
          input.deliveryCase.projectId,
          evaluated.provider,
          ['deterministic_evidence', 'authoritative_state'],
        ),
      });
    }
    const body: Omit<DeliveryPreflightSnapshot, 'preflightHash'> = {
      schemaVersion: DELIVERY_PREFLIGHT_SCHEMA,
      candidateHash: input.deliveryCase.integratedCandidate.hash,
      developmentCertificateHash:
        input.deliveryCase.developmentCertificate.hash,
      releasePolicyHash: input.deliveryCase.policy.contentHash,
      checks,
      complete:
        checks.length
          === input.deliveryCase.policy.requiredPreflightCheckIds.length,
    };
    const preflight: DeliveryPreflightSnapshot = {
      ...body,
      preflightHash: hashDeliveryPreflight({
        ...body,
        preflightHash: '',
      }),
    };
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind: PRODUCT_KINDS.preflight,
      schema: DELIVERY_PREFLIGHT_SCHEMA,
      productHash: preflight.preflightHash,
      payload: preflight,
      artifactRefPrefix: 'delivery-preflight',
    });
    return {
      preflight,
      reference: stored.record.reference,
    };
  }

  async decide(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    preflight: DeliveryPreflightSnapshot;
    heartbeat: () => void;
  }): Promise<{
    approval: DeliveryApprovalDecision;
    reference: DeliveryContentAddressedReference;
  }> {
    const finalReplay = this.products.read<DeliveryApprovalDecision>(
      input.processRunId,
      PRODUCT_KINDS.approval,
    );
    if (finalReplay) {
      return {
        approval: finalReplay.payload,
        reference: finalReplay.reference,
      };
    }

    input.heartbeat();
    const sourced = input.deliveryCase.policy.humanApprovalRequired
      ? await this.providers.approval.decide({
          processRunId: input.processRunId,
          deliveryCase: input.deliveryCase,
          preflightHash: input.preflight.preflightHash,
          heartbeat: input.heartbeat,
        })
      : {
          status: 'not-required' as const,
          decision: null,
          provider: null,
        };
    const provider = sourced.provider === null
      ? null
      : this.resolveTrustedProvider(
          input.deliveryCase.projectId,
          sourced.provider,
          ['authorized_decision'],
        );
    const body: Omit<DeliveryApprovalDecision, 'approvalHash'> = {
      schemaVersion: DELIVERY_APPROVAL_SCHEMA,
      status: sourced.status,
      candidateHash: input.deliveryCase.integratedCandidate.hash,
      preflightHash: input.preflight.preflightHash,
      releasePolicyHash: input.deliveryCase.policy.contentHash,
      decision: sourced.decision,
      provider,
    };
    const approval: DeliveryApprovalDecision = {
      ...body,
      approvalHash: hashDeliveryApproval({
        ...body,
        approvalHash: '',
      }),
    };
    const productKind = approval.status === 'pending'
      ? PRODUCT_KINDS.approvalPending
      : PRODUCT_KINDS.approval;
    const pending = approval.status === 'pending'
      ? this.products.read<DeliveryApprovalDecision>(
          input.processRunId,
          PRODUCT_KINDS.approvalPending,
        )
      : null;
    if (pending) {
      if (pending.reference.hash !== approval.approvalHash) {
        throw new Error(
          'DELIVERY_PENDING_APPROVAL_CHANGED_WITHOUT_A_DECISION',
        );
      }
      return {
        approval: pending.payload,
        reference: pending.reference,
      };
    }
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind,
      schema: DELIVERY_APPROVAL_SCHEMA,
      productHash: approval.approvalHash,
      payload: approval,
      artifactRefPrefix: 'delivery-approval',
    });
    return {
      approval,
      reference: stored.record.reference,
    };
  }

  async publishAndDeploy(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    preflight: DeliveryPreflightSnapshot;
    approval: DeliveryApprovalDecision;
    heartbeat: () => void;
  }): Promise<{
    publication: DeliveryPublicationSnapshot;
    reference: DeliveryContentAddressedReference;
  }> {
    const replay = this.products.read<DeliveryPublicationSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.publication,
    );
    if (replay) {
      return {
        publication: replay.payload,
        reference: replay.reference,
      };
    }

    const receipts: DeliveryActionReceipt[] = [];
    for (const action of input.deliveryCase.policy.actions) {
      input.heartbeat();
      receipts.push(await this.executeAction({
        processRunId: input.processRunId,
        deliveryCase: input.deliveryCase,
        action,
        heartbeat: input.heartbeat,
      }));
    }
    const body: Omit<DeliveryPublicationSnapshot, 'publicationHash'> = {
      schemaVersion: DELIVERY_PUBLICATION_SCHEMA,
      candidateHash: input.deliveryCase.integratedCandidate.hash,
      preflightHash: input.preflight.preflightHash,
      approvalHash: input.approval.approvalHash,
      plannedActions: [...input.deliveryCase.policy.actions],
      receipts,
    };
    const publication: DeliveryPublicationSnapshot = {
      ...body,
      publicationHash: hashDeliveryPublication({
        ...body,
        publicationHash: '',
      }),
    };
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind: PRODUCT_KINDS.publication,
      schema: DELIVERY_PUBLICATION_SCHEMA,
      productHash: publication.publicationHash,
      payload: publication,
      artifactRefPrefix: 'delivery-publication',
    });
    return {
      publication,
      reference: stored.record.reference,
    };
  }

  async observe(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    publication: DeliveryPublicationSnapshot;
    heartbeat: () => void;
  }): Promise<{
    observation: DeliveryObservationSnapshot;
    reference: DeliveryContentAddressedReference;
  }> {
    const replay = this.products.read<DeliveryObservationSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.observation,
    );
    if (replay) {
      return {
        observation: replay.payload,
        reference: replay.reference,
      };
    }

    const receiptByAction = new Map(
      input.publication.receipts.map(receipt => [
        receipt.actionId,
        receipt,
      ]),
    );
    const observations: DeliveryActionObservation[] = [];
    for (const action of input.deliveryCase.policy.actions) {
      input.heartbeat();
      const receipt = receiptByAction.get(action.actionId);
      observations.push(await this.observeAction({
        processRunId: input.processRunId,
        deliveryCase: input.deliveryCase,
        action,
        externalRef: receipt?.externalRef ?? null,
        heartbeat: input.heartbeat,
      }));
    }
    const currentCandidateHash =
      this.providers.observeCurrentCandidateHash(input.deliveryCase)
      ?? '';
    const complete = currentCandidateHash.length > 0
      && observations.length === input.deliveryCase.policy.actions.length
      && observations.every(observation =>
        observation.outcome !== 'unknown'
        && observation.outcome !== 'error');
    const body: Omit<DeliveryObservationSnapshot, 'observationHash'> = {
      schemaVersion: DELIVERY_OBSERVATION_SCHEMA,
      candidateHash: input.deliveryCase.integratedCandidate.hash,
      publicationHash: input.publication.publicationHash,
      currentCandidateHash,
      observations,
      complete,
    };
    const observation: DeliveryObservationSnapshot = {
      ...body,
      observationHash: hashDeliveryObservation({
        ...body,
        observationHash: '',
      }),
    };
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind: PRODUCT_KINDS.observation,
      schema: DELIVERY_OBSERVATION_SCHEMA,
      productHash: observation.observationHash,
      payload: observation,
      artifactRefPrefix: 'delivery-observation',
    });
    return {
      observation,
      reference: stored.record.reference,
    };
  }

  buildSettlementInput(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
  }): DeliverySettlementInput {
    const preflight = this.products.read<DeliveryPreflightSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.preflight,
    );
    const approval = this.products.read<DeliveryApprovalDecision>(
      input.processRunId,
      PRODUCT_KINDS.approval,
    ) ?? this.products.read<DeliveryApprovalDecision>(
      input.processRunId,
      PRODUCT_KINDS.approvalPending,
    );
    const publication = this.products.read<DeliveryPublicationSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.publication,
    );
    const observation = this.products.read<DeliveryObservationSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.observation,
    );
    return {
      schemaVersion: DELIVERY_SETTLEMENT_INPUT_SCHEMA,
      deliveryCase: input.deliveryCase,
      preflight: preflight?.payload ?? null,
      approval: approval?.payload ?? null,
      publication: publication?.payload ?? null,
      observation: observation?.payload ?? null,
      currentCandidateHash:
        this.providers.observeCurrentCandidateHash(input.deliveryCase),
      productReferences: {
        preflight: preflight?.reference ?? null,
        approval: approval?.reference ?? null,
        publication: publication?.reference ?? null,
        observation: observation?.reference ?? null,
      },
    };
  }

  private async executeAction(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    action: ReleaseActionDefinition;
    heartbeat: () => void;
  }): Promise<DeliveryActionReceipt> {
    const actionKey = deliveryActionKey(input.deliveryCase, input.action);
    const provider = this.providers.actionProviders[input.action.kind];
    if (!provider) {
      return missingProviderReceipt(input.action, actionKey);
    }
    const providerBinding = this.resolveTrustedProvider(
      input.deliveryCase.projectId,
      provider.identity,
      ['authoritative_state'],
    );
    const request = {
      actionKey,
      action: input.action,
      candidateHash: input.deliveryCase.integratedCandidate.hash,
      releasePolicyHash: input.deliveryCase.policy.contentHash,
      operatorAuthorizationHash:
        input.deliveryCase.operatorAuthorization.hash,
    };
    const ledgerActionKey =
      `${actionKey}:process-run:${input.processRunId}`;
    const started = this.ledger.start({
      providerNamespace: provider.namespace,
      actionKey: ledgerActionKey,
      processRunId: input.processRunId,
      moduleRef: DELIVERY_PROCESS_MODULE_REF,
      nodeId: DELIVERY_PUBLICATION_NODE_ID,
      request,
      requestHash: sha256Hex(request),
    });
    if (started.record.state === 'succeeded') {
      return replaySucceededReceipt(
        started.record,
        input.action,
        actionKey,
        providerBinding,
      );
    }
    if (
      started.record.state === 'failed'
      || started.record.state === 'unknown'
      || started.record.state === 'blocked'
    ) {
      return receiptFromLedgerTerminal(
        started.record,
        input.action,
        actionKey,
        providerBinding,
      );
    }

    const claimed = this.ledger.claim({
      actionId: started.record.id,
      owner: this.effectOwner,
      leaseSeconds: EFFECT_LEASE_SECONDS,
    });
    if (!claimed) {
      return baseActionReceipt(
        input.action,
        actionKey,
        providerBinding,
        {
          status: 'uncertain',
          externalRef: started.record.providerEffectId,
          resultHash: started.record.executionResultHash,
          replayed: true,
        },
      );
    }

    input.heartbeat();
    let result: DeliveryActionExecutionResult;
    try {
      // Cross-run idempotency boundary: observe the provider before every
      // mutation. A prior run may already have reached the desired state even
      // though this ProcessRun has a fresh ledger claim.
      const before = await provider.observe({
        processRunId: input.processRunId,
        deliveryCase: input.deliveryCase,
        action: input.action,
        actionKey,
        externalRef: null,
        heartbeat: input.heartbeat,
      });
      if (
        before.outcome === 'matched'
        && before.observedStateHash === input.action.desiredStateHash
      ) {
        result = {
          outcome: 'succeeded',
          externalRef: before.observation.ref,
          resultHash: before.observedStateHash,
        };
      } else {
        result = await provider.execute({
          processRunId: input.processRunId,
          deliveryCase: input.deliveryCase,
          action: input.action,
          actionKey,
          heartbeat: input.heartbeat,
        });
      }
    } catch (error) {
      result = {
        outcome: 'uncertain',
        error: errorMessage(error),
      };
    }
    const receipt = baseActionReceipt(
      input.action,
      actionKey,
      providerBinding,
      {
        status: executionStatus(result),
        externalRef: result.externalRef ?? null,
        resultHash: result.resultHash ?? null,
        replayed: started.replayed,
      },
    );
    this.ledger.recordExecutionResult({
      claim: claimed.claim,
      result: result.outcome === 'succeeded'
        ? {
            outcome: 'succeeded',
            receipt: receipt as unknown as Record<string, unknown>,
            providerEffectId: result.externalRef,
          }
        : result.outcome === 'uncertain'
          ? {
              outcome: 'unknown',
              error: result.error,
              details: {
                receipt: receipt as unknown as Record<string, unknown>,
              },
              providerEffectId: result.externalRef ?? null,
            }
          : {
              outcome: 'failed',
              error: result.error,
              details: {
                receipt: receipt as unknown as Record<string, unknown>,
              },
              providerEffectId: result.externalRef ?? null,
            },
    });
    return receipt;
  }

  private async observeAction(input: {
    processRunId: number;
    deliveryCase: DeliveryReleaseCase;
    action: ReleaseActionDefinition;
    externalRef: string | null;
    heartbeat: () => void;
  }): Promise<DeliveryActionObservation> {
    const actionKey = deliveryActionKey(input.deliveryCase, input.action);
    const provider = this.providers.actionProviders[input.action.kind];
    if (!provider) {
      const body = {
        actionKey,
        target: input.action.target,
        reason: `No provider configured for ${input.action.kind}`,
      };
      return {
        actionKey,
        target: input.action.target,
        desiredStateHash: input.action.desiredStateHash,
        observedStateHash: null,
        outcome: 'error',
        observation: {
          schema: 'saga3.delivery-provider-error.v1',
          ref: `delivery-provider-error:${sha256Hex(body)}`,
          hash: sha256Hex(body),
        },
        provider: unconfiguredProvider(input.action.kind),
      };
    }
    const providerBinding = this.resolveTrustedProvider(
      input.deliveryCase.projectId,
      provider.identity,
      ['authoritative_state'],
    );
    let result: DeliveryActionObservationResult;
    try {
      result = await provider.observe({
        processRunId: input.processRunId,
        deliveryCase: input.deliveryCase,
        action: input.action,
        actionKey,
        externalRef: input.externalRef,
        heartbeat: input.heartbeat,
      });
    } catch (error) {
      const body = {
        actionKey,
        target: input.action.target,
        error: errorMessage(error),
      };
      result = {
        outcome: 'error',
        observedStateHash: null,
        observation: {
          schema: 'saga3.delivery-observation-error.v1',
          ref: `delivery-observation-error:${sha256Hex(body)}`,
          hash: sha256Hex(body),
        },
        error: errorMessage(error),
      };
    }
    return {
      actionKey,
      target: input.action.target,
      desiredStateHash: input.action.desiredStateHash,
      observedStateHash: result.observedStateHash ?? null,
      outcome: result.outcome,
      observation: result.observation,
      provider: providerBinding,
    };
  }

  private resolveTrustedProvider(
    projectId: number,
    identity: DeliveryProviderIdentity,
    allowedCategories: readonly DeliveryProviderIdentity['category'][],
  ): DeliveryProviderBinding {
    const row = this.db.prepare(
      `SELECT id,name,version,category
         FROM trusted_providers
        WHERE id=? AND name=? AND category=? AND status='active'
          AND (project_id=? OR project_id IS NULL)`,
    ).get(
      identity.providerId,
      identity.name,
      identity.category,
      projectId,
    ) as {
      id: number;
      name: string;
      version: string | null;
      category: DeliveryProviderIdentity['category'];
    } | undefined;
    const trusted = row !== undefined
      && allowedCategories.includes(row.category)
      && row.version === identity.version;
    return {
      providerId: identity.providerId,
      name: identity.name,
      version: identity.version,
      category: identity.category,
      trusted,
    };
  }
}

function baseActionReceipt(
  action: ReleaseActionDefinition,
  actionKey: string,
  provider: DeliveryProviderBinding,
  result: {
    status: DeliveryActionReceipt['status'];
    externalRef: string | null;
    resultHash: string | null;
    replayed: boolean;
  },
): DeliveryActionReceipt {
  return {
    actionKey,
    actionId: action.actionId,
    kind: action.kind,
    target: action.target,
    payloadHash: action.payloadHash,
    desiredStateHash: action.desiredStateHash,
    status: result.status,
    externalRef: result.externalRef,
    resultHash: result.resultHash,
    provider,
    replayed: result.replayed,
  };
}

function missingProviderReceipt(
  action: ReleaseActionDefinition,
  actionKey: string,
): DeliveryActionReceipt {
  return baseActionReceipt(
    action,
    actionKey,
    unconfiguredProvider(action.kind),
    {
      status: 'blocked',
      externalRef: null,
      resultHash: null,
      replayed: false,
    },
  );
}

function unconfiguredProvider(kind: string): DeliveryProviderBinding {
  return {
    providerId: 0,
    name: `unconfigured:${kind}`,
    version: null,
    category: 'authoritative_state',
    trusted: false,
  };
}

function executionStatus(
  result: DeliveryActionExecutionResult,
): DeliveryActionReceipt['status'] {
  return result.outcome;
}

function replaySucceededReceipt(
  record: ExternalEffectActionRecord,
  action: ReleaseActionDefinition,
  actionKey: string,
  provider: DeliveryProviderBinding,
): DeliveryActionReceipt {
  const parsed = parseExecutionResult(record);
  const receipt = parsed?.receipt;
  if (
    receipt
    && typeof receipt === 'object'
    && !Array.isArray(receipt)
    && (receipt as { actionKey?: unknown }).actionKey === actionKey
  ) {
    return {
      ...(receipt as unknown as DeliveryActionReceipt),
      replayed: true,
      provider,
    };
  }
  return baseActionReceipt(action, actionKey, provider, {
    status: 'succeeded',
    externalRef: record.providerEffectId,
    resultHash: record.executionResultHash,
    replayed: true,
  });
}

function receiptFromLedgerTerminal(
  record: ExternalEffectActionRecord,
  action: ReleaseActionDefinition,
  actionKey: string,
  provider: DeliveryProviderBinding,
): DeliveryActionReceipt {
  const details = parseExecutionResult(record)?.details;
  const stored = details
    && typeof details === 'object'
    && !Array.isArray(details)
    ? (details as { receipt?: unknown }).receipt
    : null;
  if (
    stored
    && typeof stored === 'object'
    && !Array.isArray(stored)
    && (stored as { actionKey?: unknown }).actionKey === actionKey
  ) {
    return {
      ...(stored as unknown as DeliveryActionReceipt),
      replayed: true,
      provider,
    };
  }
  const status = record.state === 'unknown'
    ? 'uncertain'
    : record.state === 'blocked'
      ? 'blocked'
      : 'failed';
  return baseActionReceipt(action, actionKey, provider, {
    status,
    externalRef: record.providerEffectId,
    resultHash: record.executionResultHash,
    replayed: true,
  });
}

function parseExecutionResult(
  record: ExternalEffectActionRecord,
): Record<string, unknown> | null {
  if (!record.executionResultSnapshot) return null;
  try {
    const value = JSON.parse(record.executionResultSnapshot);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
