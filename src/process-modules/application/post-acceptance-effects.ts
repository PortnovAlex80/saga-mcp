import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';
import type { ProductRef } from '../domain/spi/production-envelope.js';
import { sha256Hex } from '../../shared/canonical-json.js';

/**
 * ADR-053 Phase 6 — the exact accepted-candidate authority an effect consumes.
 *
 * This replaces the execution-scoped fields (producerExecutionRef, process/node/
 * task selectors, expected-schema rediscovery) in PostAcceptanceEffectInput.
 * Every material coordinate an effect needs is already resolved BEFORE the
 * Gate: the revision, the exact accepted ProductRefs, the GateDecision, and the
 * product contract. The effect must NOT re-derive any of these from execution
 * IDs, task IDs, or "latest" lookups.
 *
 * Phase 6 ADDS this to PostAcceptanceEffectInput alongside the legacy fields
 * (migration). Phase 7 REMOVES producerExecutionRef and the legacy fields,
 * leaving AcceptedCandidateAuthority as the sole input.
 */
export interface AcceptedCandidateAuthority {
  readonly workplaceRef: WorkplaceRef;
  readonly candidateSetRef: string;
  /** The immutable Workplace production revision the accepted material was sealed from. */
  readonly productionRevisionRef: string | null;
  /** The exact accepted ProductRefs from the accepted CandidateSet members. */
  readonly acceptedProductRefs: readonly ProductRef[];
  /** The GateDecision that accepted this CandidateSet. */
  readonly gateDecisionKey: string;
  /** The pinned product payload contract (provenance — which decoder validated the payload). */
  readonly productContractRef: {
    readonly contractId: string;
    readonly version: string;
    readonly contractDigest: string;
  } | null;
  /** Digest binding the acceptance (revision + productRefs + gateDecision). */
  readonly acceptanceDigest: string;
}

export interface PostAcceptanceEffectInput {
  readonly workplaceRef: WorkplaceRef;
  readonly processRunId: number;
  readonly moduleRef: { readonly name: string; readonly version: string };
  readonly nodeId: string;
  readonly candidateSetRef: string;
  /** @deprecated ADR-053 Phase 6 — use authority.productionRevisionRef instead. */
  readonly producerExecutionRef: string;
  readonly expectedProductSchema: string;
  /**
   * ADR-053 Phase 6 — the exact accepted-candidate authority. When present,
   * effects MUST consume this instead of producerExecutionRef. Phase 7 makes
   * this required and removes producerExecutionRef.
   */
  readonly authority?: AcceptedCandidateAuthority;
}

/**
 * ADR-053 Phase 6 — compute the acceptance digest binding the accepted
 * CandidateSet to its revision, productRefs and GateDecision. This digest is
 * shared by the effect receipt and CellFinalAcceptance, so they provably
 * consume the same exact acceptance (not a newer execution's re-derivation).
 */
export function computeAcceptanceDigest(input: {
  readonly candidateSetRef: string;
  readonly productionRevisionRef: string | null;
  readonly acceptedProductRefs: readonly ProductRef[];
  readonly gateDecisionKey: string;
}): string {
  // Lazy import to avoid a circular dependency at module load (sha256Hex is
  // in shared/canonical-json). Imported once, cached.
  return sha256Hex({
    candidateSetRef: input.candidateSetRef,
    productionRevisionRef: input.productionRevisionRef,
    productRefs: input.acceptedProductRefs
      .map(p => ({ schemaId: p.schemaId, ref: p.ref, digest: p.digest }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    gateDecisionKey: input.gateDecisionKey,
  });
}

export type PostAcceptanceEffectResult =
  | {
      readonly outcome: 'succeeded';
      readonly receiptRef: string;
      readonly receiptDigest: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: 'pending';
      readonly reason: string;
    }
  | {
      readonly outcome: 'repair_required';
      readonly reason: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome: 'human_required';
      readonly reason: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    };

export interface PostAcceptanceEffect {
  readonly effectId: string;
  run(input: PostAcceptanceEffectInput): void | PostAcceptanceEffectResult;
}

export class FactoryPostAcceptanceEffectRegistry {
  private readonly effects = new Map<string, PostAcceptanceEffect>();

  register(effect: PostAcceptanceEffect): void {
    if (!effect.effectId.trim()) throw new Error('POST_ACCEPTANCE_EFFECT_ID_REQUIRED');
    // Idempotent on effectId: a fresh instance of the same capability wired to
    // the same db may be re-registered (e.g. createProductLifecycleRuntime is
    // called once per process, but tests and the dispatch loop may rebuild the
    // runtime). Post-acceptance effects are stateless capabilities, so replacing
    // is safe and avoids a process-singleton accumulation bug. A genuinely
    // different effect would carry a different effectId by design.
    this.effects.set(effect.effectId, effect);
  }

  run(effectId: string, input: PostAcceptanceEffectInput): PostAcceptanceEffectResult {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error(`POST_ACCEPTANCE_EFFECT_NOT_REGISTERED: ${effectId}`);
    const result = effect.run(input);
    if (result) return result;
    // Legacy idempotent adapters are represented as a successful provider
    // receipt until migrated to the external-effect ledger. The receipt is
    // still bound to the exact candidate and effect identity.
    const receiptRef = `effect-receipt:${effectId}:${input.candidateSetRef}`;
    return {
      outcome: 'succeeded',
      receiptRef,
      receiptDigest: receiptRef,
    };
  }
}

const registry = new FactoryPostAcceptanceEffectRegistry();

export function createPostAcceptanceEffectRegistry(): FactoryPostAcceptanceEffectRegistry {
  return registry;
}

export function registerFactoryPostAcceptanceEffect(effect: PostAcceptanceEffect): void {
  registry.register(effect);
}
