import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';

export interface PostAcceptanceEffectInput {
  readonly workplaceRef: WorkplaceRef;
  readonly processRunId: number;
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
    const existing = this.effects.get(effect.effectId);
    if (existing) {
      if (existing === effect) return;
      throw new Error(`POST_ACCEPTANCE_EFFECT_DUPLICATE: ${effect.effectId}`);
    }
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
