export interface FactoryModelProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: 'zai';
  /** claude CLI --effort levels (verified against claude --help 2.1.215). */
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
    id: 'glm-4.5',
    label: 'GLM 4.5 — legacy budget',
    provider: 'zai',
    effort: 'high',
    limit: 2,
    tier: 'sonnet',
    note: 'Served by the coding-plan endpoint (verified 2026-08-18 via /models). '
      + 'Legacy tier for cheap experiments.',
  }),
  Object.freeze({
    id: 'glm-4.5-air',
    label: 'GLM 4.5 Air — lightest',
    provider: 'zai',
    effort: 'high',
    limit: 2,
    tier: 'sonnet',
    note: 'Air variant — fastest/cheapest endpoint model; drafts and routine nodes.',
  }),
  Object.freeze({
    id: 'glm-4.6',
    label: 'GLM 4.6 — legacy budget',
    provider: 'zai',
    effort: 'high',
    limit: 8,
    tier: 'sonnet',
    note: 'Served by the coding-plan endpoint (verified 2026-08-18 via /models). '
      + 'Sonnet-level fallback for cheap dev loops. Operator-requested ceiling 8 '
      + '(2026-08-24, DEVTEST stage-23: factory worker rate limit 6 -> 8).',
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
    id: 'glm-5',
    label: 'GLM 5',
    provider: 'zai',
    effort: 'high',
    limit: 3,
    tier: 'flagship',
    note: 'Previous flagship generation, x1 rate.',
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
    id: 'glm-5.1',
    label: 'GLM 5.1',
    provider: 'zai',
    effort: 'high',
    limit: 3,
    tier: 'flagship',
    note: 'Mid-generation flagship, x1 rate.',
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
  Object.freeze({
    id: 'glm-5.3',
    label: 'GLM 5.3',
    provider: 'zai',
    effort: 'max',
    limit: 6,
    tier: 'flagship',
    note: 'Operator-requested 2026-08-16 for the TrackPlan run (plan concurrency ceiling 6; '
      + 'effort=max per operator decision — maximum reasoning, accepts the token cost)',
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

/**
 * Bucket key for an active execution that carries no frozen model (pre-D1.1
 * rows with empty metadata). Such executions never consume a catalog slot —
 * they are still counted by the epic-wide live ceiling.
 */
export const UNFROZEN_MODEL_BUCKET = '(unfrozen)';

export interface ModelAdmissionDecision {
  /** FROZEN model id → active in-flight count (epic-scoped). */
  activeByModel: Record<string, number>;
  /**
   * Catalog limit of the model the NEXT claim would freeze; null when the
   * model is unknown to the catalog (fail-open, capped by the controls
   * ceiling instead).
   */
  requestedModelLimit: number | null;
  /**
   * Would ONE more claim of `requestedModel` stay within the per-model
   * aggregation? True when activeByModel[requestedModel] < catalog limit;
   * for an unknown model, when it is below the epic's effective controls
   * ceiling (fail-open on the catalog lookup but never above controls).
   */
  modelSlotsAvailable: boolean;
}

/**
 * C-4 (stage-11 PREVENTIVE-HUNT Layer 6): enforce the FROZEN route limits of
 * in-flight executions during admission.
 *
 * The live controls row is rewritten by /api/model/set mid-run; counting all
 * actives against the LIVE ceiling alone lets a model switch stack spawns
 * past a frozen model's own catalog limit (glm-5.2(10, 8 active) → glm-4.7(2)
 * → back). This pure aggregation groups actives by their FROZEN model and
 * decides whether ONE more claim of `requestedModel` fits BOTH the catalog
 * limit of that model AND (for unknown models) the epic's effective controls
 * ceiling. The epic-wide live ceiling is enforced separately by the caller
 * (activeExecutions >= effectiveConcurrency).
 */
export function computeModelAdmission(input: {
  /** The model the NEXT claim would freeze (live controls model_name). */
  requestedModel: string | null;
  /** FROZEN model of each active in-flight execution (null → unfrozen bucket). */
  activeFrozenModels: ReadonlyArray<string | null>;
  /** Effective live ceiling: min(operator concurrency, controls model limit). */
  effectiveControlsCeiling: number;
  /** Catalog limit lookup — overridable for tests. */
  catalog?: (model: string) => number | null;
}): ModelAdmissionDecision {
  const catalog = input.catalog
    ?? ((model: string) => factoryModelProfile(model)?.limit ?? null);
  const activeByModel: Record<string, number> = {};
  for (const frozen of input.activeFrozenModels) {
    const key = frozen ?? UNFROZEN_MODEL_BUCKET;
    activeByModel[key] = (activeByModel[key] ?? 0) + 1;
  }
  const requestedModelLimit = input.requestedModel !== null
    ? catalog(input.requestedModel)
    : null;
  if (input.requestedModel === null) {
    return { activeByModel, requestedModelLimit: null, modelSlotsAvailable: true };
  }
  const active = activeByModel[input.requestedModel] ?? 0;
  if (requestedModelLimit !== null) {
    return {
      activeByModel,
      requestedModelLimit,
      modelSlotsAvailable: active < requestedModelLimit,
    };
  }
  // Unknown model: fail-open on the catalog lookup, but never above the
  // controls ceiling.
  return {
    activeByModel,
    requestedModelLimit: null,
    modelSlotsAvailable: active < input.effectiveControlsCeiling,
  };
}
