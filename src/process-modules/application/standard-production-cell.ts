import type { CheckPlan, ProductionCellDefinition } from '../domain/workplace/index.js';
import { buildProductContractCheckPlan } from './standard-check-providers.js';

export interface SingletonProductionCellOptions {
  readonly id: string;
  readonly executionProfileId: string;
  readonly outputSchemaRef: string;
  readonly acceptedTransition: string;
  readonly failedTransition: string;
  readonly humanRequiredTransition?: string;
  readonly capabilityPreset?: string;
  readonly mediaType?: string;
  readonly cardinality?: '1' | '0..1' | '1..n';
  readonly payloadContract?: {
    readonly contractId: string;
    readonly version: string;
    readonly contractDigest: string;
  };
  readonly maxAttempts: number;
  readonly onExhausted: 'fail' | 'pause';
  readonly checkPlan?: CheckPlan;
  readonly postAcceptanceEffect?: string;
  readonly review?: {
    readonly executionProfileId: string;
    readonly verdictSchemaRef: string;
    readonly payloadContract?: {
      readonly contractId: string;
      readonly version: string;
      readonly contractDigest: string;
    };
    readonly finalCheckPlan: CheckPlan;
    readonly capabilityPreset?: string;
  };
}

/** Canonical declaration for a singleton Production Cell. */
export function singletonProductionCell(
  options: SingletonProductionCellOptions,
): ProductionCellDefinition {
  const authorGatePhase = options.review ? 'author' : 'final';
  return {
    id: options.id,
    inputSelectors: ['input'],
    materialization: { completionPolicy: 'all' },
    author: {
      skillRef: options.executionProfileId,
      capabilityPreset: options.capabilityPreset ?? 'module-author',
    },
    productContracts: [{
      binding: 'product',
      schemaRef: options.outputSchemaRef,
      mediaType: options.mediaType ?? 'application/json',
      cardinality: options.cardinality ?? '1..n',
      ...(options.payloadContract ? { payloadContract: options.payloadContract } : {}),
    }],
    authorGate: {
      gateId: `${options.id}.${authorGatePhase}`,
      gatePhase: authorGatePhase,
      checkPlan:
        options.checkPlan
        ?? buildProductContractCheckPlan(`${options.id}.${authorGatePhase}`),
    },
    ...(options.review ? {
      review: {
        reviewer: {
          skillRef: options.review.executionProfileId,
          capabilityPreset:
            options.review.capabilityPreset ?? 'module-reviewer',
        },
        verdictSchemaRef: options.review.verdictSchemaRef,
        ...(options.review.payloadContract
          ? { payloadContract: options.review.payloadContract }
          : {}),
        finalGate: {
          gateId: `${options.id}.final`,
          gatePhase: 'final' as const,
          checkPlan: options.review.finalCheckPlan,
        },
      },
    } : {}),
    recovery: {
      maxAttempts: options.maxAttempts,
      onExhausted: options.onExhausted,
    },
    ...(options.postAcceptanceEffect
      ? { postAcceptanceEffect: options.postAcceptanceEffect }
      : {}),
    transitions: {
      accepted: options.acceptedTransition,
      humanRequired: options.humanRequiredTransition ?? options.failedTransition,
      failed: options.failedTransition,
    },
  };
}
