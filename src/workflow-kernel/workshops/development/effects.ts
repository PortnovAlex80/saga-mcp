/**
 * workflow-kernel/workshops/development/effects.ts - the IDEMPOTENT
 * EFFECT declaration of the converted workshop (WP-11V, plan EK-8).
 *
 * One effect is installed: the product freeze (build + start + smoke over
 * the accepted candidate), settled by the frozen single EffectReceipt
 * writer workplace.settleEffect (R13) with the full frozen seven-outcome
 * D2 vocabulary. Idempotence law: the deterministic key rule and the
 * truthful resume outcome already-applied - after an operator disposition
 * the effect condition already held, so a re-drive NEVER re-executes the
 * external send and never duplicates a receipt.
 *
 * PURITY: pure data + derivation from the frozen registry. No I/O.
 */

import type { EffectDeclaration } from './installation.js';
import { effectOutcomeVocabulary } from './installation.js';

/** The idempotent effect declaration of the product freeze. */
export function developmentEffectDeclaration(): EffectDeclaration {
  return {
    effectId: 'development.product-freeze',
    command: 'workplace.settleEffect',
    idempotencyKeyRule: 'workshop:development:effect:<capsuleRef> (deterministic per capsule; an identical re-settle replays)',
    outcomes: effectOutcomeVocabulary(),
    idempotentResumeOutcome: 'already-applied',
    verificationEvidenceKind: 'ProductVerificationEvidence',
  };
}
