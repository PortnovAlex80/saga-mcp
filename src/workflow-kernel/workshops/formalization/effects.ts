/**
 * workflow-kernel/workshops/formalization/effects.ts - the IDEMPOTENT
 * effects and typed waits of the Formalization workshop (WP-11F, plan phase
 * EK-8 workshop conversion; D2/D5/D12 vocabulary only).
 *
 * Laws implemented here:
 *   - settleEffect (the kernel's SOLE EffectReceipt writer, R13) settles
 *     every workshop effect. The effects themselves are idempotent by an
 *     exact action key (effect id + content digest): a re-drive of the same
 *     key yields 'already-applied', never a second mutation (D2 outcome
 *     vocabulary; the freeze/settlement content digests make the keys
 *     content-addressed).
 *   - Typed human/external waits use ONLY the frozen D5/D12 vocabulary:
 *     TypedWait:human-input discharges via workplace.resolveHumanResponse
 *     (WakeDischarge:human-response-command); TypedWait:effect-uncertainty
 *     requires an OPERATOR disposition command - never an automatic
 *     duplicate of a non-idempotent external send.
 *
 * PURITY: pure bookkeeping (a deterministic in-process applied-key ledger).
 * No SQL, no clock, no network: the real external mutations are injected by
 * the caller through the executor's payload; this module only decides the
 * outcome kind idempotently.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import { WAITS } from '../../domain/universe.js';
import type { WaitKind } from '../../domain/universe.js';

/** The declared effect ids of the workshop (manifest-declared). */
export const FORMALIZATION_EFFECT_IDS = [
  'formalization.accept-products',
  'formalization.freeze-what-baseline',
  'formalization.settle-solution-contract',
] as const;
export type FormalizationEffectId = (typeof FORMALIZATION_EFFECT_IDS)[number];

/** The D2 effect outcome kinds this workshop can settle. */
export type FormalizationEffectOutcome = 'success' | 'already-applied';

/** The receipt of one settled effect. */
export interface EffectSettlement {
  readonly effectId: FormalizationEffectId;
  readonly actionKey: string;
  readonly outcome: FormalizationEffectOutcome;
  readonly receiptDigest: string;
}

/** Typed wait descriptor (D5/D12 vocabulary only). */
export interface TypedWaitDescriptor {
  readonly kind: WaitKind;
  /** The exact wake commands that discharge the wait (from the frozen WAITS registry). */
  readonly wakeCommands: readonly string[];
  readonly disposition: 'operator-disposition-command-required' | 'wake-source-completion';
}

/** The D5/D12 wait descriptors of the workshop (derived from the frozen registry, never invented). */
export function typedWaitOf(kind: 'TypedWait:human-input' | 'TypedWait:effect-uncertainty'): TypedWaitDescriptor {
  const spec = WAITS.find((entry) => entry.kind === kind);
  if (spec === undefined) {
    throw new Error(`FORMALIZATION_WAIT_UNKNOWN: wait kind ${kind} is not in the frozen registry`);
  }
  return {
    kind,
    wakeCommands: [...spec.wakeCommands],
    disposition: kind === 'TypedWait:effect-uncertainty' ? 'operator-disposition-command-required' : 'wake-source-completion',
  };
}

/* ------------------------------------------------------------------ */
/* The idempotent effect executor                                     */
/* ------------------------------------------------------------------ */

/**
 * The deterministic effect executor. The applied-key ledger is pure
 * bookkeeping: same action key -> 'already-applied'; first application
 * invokes the injected external mutation and settles 'success'. No clock,
 * no randomness - the action key is derived from content digests.
 */
export class FormalizationEffectExecutor {
  private readonly applied = new Map<string, string>();

  /** The exact idempotency action key of one effect application (content-addressed). */
  static actionKeyOf(effectId: FormalizationEffectId, contentDigest: string): string {
    return `${effectId}#${sha256OfCanonical({ effectId, contentDigest })}`;
  }

  /**
   * Execute (or replay) one effect. `mutate` is the injected external
   * mutation; it runs at most once per action key.
   */
  execute(
    effectId: FormalizationEffectId,
    contentDigest: string,
    mutate: () => string,
  ): EffectSettlement {
    const actionKey = FormalizationEffectExecutor.actionKeyOf(effectId, contentDigest);
    const already = this.applied.get(actionKey);
    if (already !== undefined) {
      return { effectId, actionKey, outcome: 'already-applied', receiptDigest: already };
    }
    const receiptDigest = mutate();
    this.applied.set(actionKey, receiptDigest);
    return { effectId, actionKey, outcome: 'success', receiptDigest };
  }

  /** True when the exact action key already settled (idempotency oracle). */
  hasApplied(effectId: FormalizationEffectId, contentDigest: string): boolean {
    return this.applied.has(FormalizationEffectExecutor.actionKeyOf(effectId, contentDigest));
  }

  /** The number of settled effects (test oracle). */
  get settledCount(): number {
    return this.applied.size;
  }
}
