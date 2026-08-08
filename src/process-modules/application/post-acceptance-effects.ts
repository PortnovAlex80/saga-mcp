import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';

export interface PostAcceptanceEffectInput {
  readonly workplaceRef: WorkplaceRef;
  readonly processRunId: number;
  readonly candidateSetRef: string;
  readonly producerExecutionRef: string;
  readonly expectedProductSchema: string;
}

export interface PostAcceptanceEffect {
  readonly effectId: string;
  run(input: PostAcceptanceEffectInput): void;
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

  run(effectId: string, input: PostAcceptanceEffectInput): void {
    const effect = this.effects.get(effectId);
    if (!effect) throw new Error(`POST_ACCEPTANCE_EFFECT_NOT_REGISTERED: ${effectId}`);
    effect.run(input);
  }
}

const registry = new FactoryPostAcceptanceEffectRegistry();

export function createPostAcceptanceEffectRegistry(): FactoryPostAcceptanceEffectRegistry {
  return registry;
}

export function registerFactoryPostAcceptanceEffect(effect: PostAcceptanceEffect): void {
  registry.register(effect);
}
