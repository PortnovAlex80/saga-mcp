import type { ProductionCellDefinition } from '../domain/workplace/index.js';
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
  readonly productSource?: 'typed-submission' | 'managed-production';
  readonly maxAttempts: number;
  readonly onExhausted: 'fail' | 'pause';
}

/**
 * Canonical declaration for a singleton authoring Production Cell.
 *
 * This replaces the deleted implicit `kind: lm` compatibility path. A workshop
 * still chooses its profile, schema and recovery budget, but worker lifecycle,
 * CandidateSet sealing and GateDecision semantics are always supplied by the
 * same Production Cell runtime.
 */
export function singletonProductionCell(
  options: SingletonProductionCellOptions,
): ProductionCellDefinition {
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
      ...(options.productSource ? { productSource: options.productSource } : {}),
    }],
    authorGate: {
      gateId: `${options.id}.final`,
      gatePhase: 'final',
      checkPlan: buildProductContractCheckPlan(`${options.id}.final`),
    },
    recovery: {
      maxAttempts: options.maxAttempts,
      onExhausted: options.onExhausted,
    },
    transitions: {
      accepted: options.acceptedTransition,
      humanRequired: options.humanRequiredTransition ?? options.failedTransition,
      failed: options.failedTransition,
    },
  };
}
