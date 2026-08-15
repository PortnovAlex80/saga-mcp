export interface FactoryModelProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: 'zai';
  readonly effort: 'high';
  readonly limit: number;
  readonly tier: 'flagship' | 'sonnet';
  readonly note: string;
}

/**
 * The single checked-in catalog for cloud Factory routes.
 *
 * `limit` is Saga's safe concurrent-worker ceiling for the configured provider
 * account, not a token multiplier or prompt quota. Dynamic local models are
 * discovered separately and must carry an explicit runtime limit.
 */
export const FACTORY_CLOUD_MODELS: readonly FactoryModelProfile[] = Object.freeze([
  Object.freeze({
    id: 'glm-4.6',
    label: 'GLM 4.6',
    provider: 'zai',
    effort: 'high',
    limit: 3,
    tier: 'sonnet',
    note: 'Served by the z.ai Coding Plan endpoint (operator-verified 2026-08-15); plan concurrency ceiling 3',
  }),
  Object.freeze({
    id: 'glm-4.7',
    label: 'GLM 4.7 — recommended default',
    provider: 'zai',
    effort: 'high',
    limit: 2,
    tier: 'sonnet',
    note: 'Sonnet-level, x1 rate — recommended default',
  }),
  Object.freeze({
    id: 'glm-5-turbo',
    label: 'GLM 5 Turbo',
    provider: 'zai',
    effort: 'high',
    limit: 5,
    tier: 'flagship',
    note: 'Opus-level, x1 rate',
  }),
  Object.freeze({
    id: 'glm-5.2',
    label: 'GLM 5.2',
    provider: 'zai',
    effort: 'high',
    limit: 10,
    tier: 'flagship',
    note: 'Opus-level, x3 peak rate — operator-approved ceiling 10 (A/B vs turbo on RTK-Dual)',
  }),
]);

export const DEFAULT_FACTORY_MODEL = 'glm-4.7';
export const DEFAULT_FACTORY_CONCURRENCY = 2;

export function factoryModelProfile(modelId: string): FactoryModelProfile | null {
  return FACTORY_CLOUD_MODELS.find(model => model.id === modelId) ?? null;
}

export function effectiveFactoryConcurrency(
  requested: number,
  modelLimit: number,
): number {
  if (!Number.isInteger(requested) || requested < 1 || requested > 10) {
    throw new Error(`requested concurrency must be an integer 1..10, got '${requested}'`);
  }
  if (!Number.isInteger(modelLimit) || modelLimit < 1 || modelLimit > 10) {
    throw new Error(`model concurrency limit must be an integer 1..10, got '${modelLimit}'`);
  }
  return Math.min(requested, modelLimit);
}
