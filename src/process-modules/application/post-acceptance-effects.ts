import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';
import type { ProductRef } from '../domain/spi/production-envelope.js';
import {
  RECOVERY_ISSUE_SCHEMA,
  assertRecoveryIssue,
  type RecoveryIssue,
} from '../domain/recovery.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

/**
 * ADR-053 Phase 6 — the exact accepted-candidate authority an effect consumes.
 *
 * This replaces the execution-scoped fields (presenter identity, process/node/
 * task selectors, expected-schema rediscovery) in PostAcceptanceEffectInput.
 * Every material coordinate an effect needs is already resolved BEFORE the
 * Gate: the revision, the exact accepted ProductRefs, the GateDecision, and the
 * product contract. The effect must NOT re-derive any of these from execution
 * IDs, task IDs, or "latest" lookups.
 *
 * Clean-break contract: AcceptedCandidateAuthority is the sole post-seal
 * material input. Presenter/execution/task coordinates are provenance only
 * and cannot be used to rediscover accepted material.
 */
export interface AcceptedCandidateAuthority {
  readonly workplaceRef: WorkplaceRef;
  readonly candidateSetRef: string;
  /** The immutable Workplace production revision the accepted material was sealed from. */
  readonly productionRevisionRef: string;
  /**
   * Exact locators for the products presented by the revision. `ref` is
   * provenance/lookup only; accepted material identity binds schema+digest.
   */
  readonly acceptedProductRefs: readonly ProductRef[];
  /** The accepted product's output schema (material coordinate). */
  readonly productSchema: string;
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
  /** ADR-053 B-4 — the SOLE material authority for effects. */
  readonly authority: AcceptedCandidateAuthority;
  /** Operational-only (observability/ownership). NON-material — MUST NOT select material. */
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
  readonly productSchema: string;
  readonly productContractRef: AcceptedCandidateAuthority['productContractRef'];
}): string {
  // Lazy import to avoid a circular dependency at module load (sha256Hex is
  // in shared/canonical-json). Imported once, cached.
  return sha256Hex({
    candidateSetRef: input.candidateSetRef,
    productionRevisionRef: input.productionRevisionRef,
    // ProductRef.ref is a presentation locator and may contain a submission
    // row id.  The accepted material identity is the schema/content multiset;
    // equivalent presentations must therefore produce the same digest.
    products: input.acceptedProductRefs
      .map(p => ({ schemaId: p.schemaId, digest: p.digest }))
      .sort((a, b) => a.schemaId.localeCompare(b.schemaId)
        || a.digest.localeCompare(b.digest)),
    gateDecisionKey: input.gateDecisionKey,
    productSchema: input.productSchema,
    productContractRef: input.productContractRef,
  });
}

/**
 * ADR-053 C17 — fail-closed authority validation. Every post-acceptance effect
 * MUST run against a fully-bound, internally-consistent AcceptedCandidateAuthority.
 * This rejects:
 *   - empty productionRevisionRef / candidateSetRef / gateDecisionKey (a consumer
 *     would have to re-derive material from execution/task/latest — the exact
 *     legacy path ADR-053 removes);
 *   - an empty acceptedProductRefs list (nothing was accepted);
 *   - a stale/forged acceptanceDigest (the authority drifted from the sealed
 *     material). The digest is recomputed from the other authority fields and
 *     required to match exactly, so a hand-edited or stale authority cannot
 *     drive an external effect.
 */
export function assertAuthorityBound(input: PostAcceptanceEffectInput): void {
  const a = input.authority;
  if (!a.productionRevisionRef) {
    throw new Error('AUTHORITY_PRODUCTION_REVISION_REQUIRED');
  }
  if (!a.candidateSetRef) {
    throw new Error('AUTHORITY_CANDIDATE_SET_REQUIRED');
  }
  if (!a.gateDecisionKey) {
    throw new Error('AUTHORITY_GATE_DECISION_KEY_REQUIRED');
  }
  if (a.acceptedProductRefs.length === 0) {
    throw new Error('AUTHORITY_ACCEPTED_PRODUCTS_REQUIRED');
  }
  const recomputed = computeAcceptanceDigest({
    candidateSetRef: a.candidateSetRef,
    productionRevisionRef: a.productionRevisionRef,
    acceptedProductRefs: a.acceptedProductRefs,
    gateDecisionKey: a.gateDecisionKey,
    productSchema: a.productSchema,
    productContractRef: a.productContractRef,
  });
  if (recomputed !== a.acceptanceDigest) {
    throw new Error(
      `AUTHORITY_ACCEPTANCE_DIGEST_MISMATCH: expected '${recomputed}' got '${a.acceptanceDigest}'`,
    );
  }
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

export function buildAcceptanceEffectRepairIssue(input: {
  readonly effect: PostAcceptanceEffectIdentity;
  readonly authority: AcceptedCandidateAuthority;
  readonly result: Extract<PostAcceptanceEffectResult, { outcome: 'repair_required' }>;
}): RecoveryIssue {
  const reason = input.result.reason.trim();
  if (!reason) throw new Error('ACCEPTANCE_EFFECT_REPAIR_REASON_REQUIRED');
  // Canonicalization is both validation and the durable JSON boundary: effect
  // evidence must be a serializable immutable snapshot, never a live object.
  canonicalJson(input.result.evidence ?? {});
  const productSubjects = input.authority.acceptedProductRefs.map(product => ({
    kind: 'product',
    ref: product.ref,
    schema: product.schemaId,
    contentHash: product.digest,
  }));
  const issue: RecoveryIssue = {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId: `acceptance-effect:${input.effect.effectId}`,
    disposition: 'repair',
    reasonCode: 'ACCEPTANCE_EFFECT_REPAIR_REQUIRED',
    summary: reason,
    findings: [{
      code: `${input.effect.effectId}:repair-required`,
      severity: 'error',
      message: reason,
      subjectRef: input.authority.candidateSetRef,
      actual: input.result.evidence ?? {},
      evidenceRefs: [
        input.authority.gateDecisionKey,
        input.authority.candidateSetRef,
        input.authority.productionRevisionRef,
      ],
    }],
    subjectRefs: [
      { kind: 'candidate-set', ref: input.authority.candidateSetRef },
      { kind: 'production-revision', ref: input.authority.productionRevisionRef },
      ...productSubjects,
    ],
    acceptanceCriteria: [
      `Post-acceptance effect '${input.effect.effectId}' must return succeeded for the repaired candidate.`,
    ],
    allowedChanges: input.authority.acceptedProductRefs.map(product =>
      `${product.schemaId}:${product.ref}@${product.digest}`),
    context: {
      source: 'acceptance-effect',
      effectId: input.effect.effectId,
      effectVersion: input.effect.version,
      effectDigest: input.effect.effectDigest,
      workplaceRef: input.authority.workplaceRef,
      candidateSetRef: input.authority.candidateSetRef,
      productionRevisionRef: input.authority.productionRevisionRef,
      gateDecisionKey: input.authority.gateDecisionKey,
      acceptanceDigest: input.authority.acceptanceDigest,
      evidence: input.result.evidence ?? {},
    },
  };
  assertRecoveryIssue(issue);
  return issue;
}

export interface PostAcceptanceEffect {
  readonly effectId: string;
  readonly version: string;
  readonly effectDigest: string;
  run(input: PostAcceptanceEffectInput): void | PostAcceptanceEffectResult;
}

export type PostAcceptanceEffectIdentity = Readonly<
  Pick<PostAcceptanceEffect, 'effectId' | 'version' | 'effectDigest'>
>;

export class FactoryPostAcceptanceEffectRegistry {
  private readonly effects = new Map<string, PostAcceptanceEffect>();

  register(effect: PostAcceptanceEffect): void {
    if (!effect.effectId.trim() || !effect.version.trim() || !effect.effectDigest.trim()) {
      throw new Error('POST_ACCEPTANCE_EFFECT_IDENTITY_REQUIRED');
    }
    // Idempotent on effectId: a fresh instance of the same capability wired to
    // the same db may be re-registered (e.g. createProductLifecycleRuntime is
    // called once per process, but tests and the dispatch loop may rebuild the
    // runtime). Post-acceptance effects are stateless capabilities, so replacing
    // is safe and avoids a process-singleton accumulation bug. A genuinely
    // different effect would carry a different digest and must fail closed.
    const existing = this.effects.get(effect.effectId);
    if (existing) {
      if (
        existing.version !== effect.version
        || existing.effectDigest !== effect.effectDigest
      ) {
        throw new Error(`POST_ACCEPTANCE_EFFECT_BINDING_MISMATCH: ${effect.effectId}`);
      }
      return;
    }
    this.effects.set(effect.effectId, effect);
  }

  run(effectId: string, input: PostAcceptanceEffectInput): PostAcceptanceEffectResult {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error(`POST_ACCEPTANCE_EFFECT_NOT_REGISTERED: ${effectId}`);
    // ADR-053 C17 — fail closed on incomplete / inconsistent accepted authority
    // BEFORE any external action. See assertAuthorityBound.
    assertAuthorityBound(input);
    const result = effect.run(input);
    if (result) return result;
    // Legacy idempotent adapters are represented as a successful provider
    // receipt until migrated to the external-effect ledger. The receipt is
    // still bound to the exact candidate and effect identity.
    const receiptRef = `effect-receipt:${effectId}:${input.authority.candidateSetRef}`;
    return {
      outcome: 'succeeded',
      receiptRef,
      receiptDigest: receiptRef,
    };
  }

  identity(effectId: string): PostAcceptanceEffectIdentity {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error(`POST_ACCEPTANCE_EFFECT_NOT_REGISTERED: ${effectId}`);
    return {
      effectId: effect.effectId,
      version: effect.version,
      effectDigest: effect.effectDigest,
    };
  }

  snapshot(): readonly Pick<PostAcceptanceEffect, 'effectId' | 'version' | 'effectDigest'>[] {
    return [...this.effects.values()]
      .map(effect => ({
        effectId: effect.effectId,
        version: effect.version,
        effectDigest: effect.effectDigest,
      }))
      .sort((a, b) => a.effectId.localeCompare(b.effectId));
  }
}

const registry = new FactoryPostAcceptanceEffectRegistry();

export function createPostAcceptanceEffectRegistry(): FactoryPostAcceptanceEffectRegistry {
  return registry;
}

export function registerFactoryPostAcceptanceEffect(effect: PostAcceptanceEffect): void {
  registry.register(effect);
}
