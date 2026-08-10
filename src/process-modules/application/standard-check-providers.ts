import { sha256Hex } from '../../shared/canonical-json.js';
import type { CheckPlan, CheckProvider } from '../domain/workplace/gate.js';
import type { CheckProviderRegistry } from './gate-run-driver.js';

export const PRODUCT_CONTRACT_CHECK_PROVIDER_ID = 'factory.product-contract.v1';
export const PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION = '1.0.0';
export const PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
  version: PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
  invariant: 'candidate-members-validated-by-production-cell-reconciler',
});

const productContractProvider: CheckProvider = {
  providerId: PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
  version: PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
  run() {
    return 'passed';
  },
};

export class FactoryCheckProviderRegistry implements CheckProviderRegistry {
  private readonly providers = new Map<string, CheckProvider>();

  constructor() {
    this.register(productContractProvider);
  }

  register(provider: CheckProvider): void {
    if (!provider.providerId.trim() || !provider.version.trim()) {
      throw new Error('CHECK_PROVIDER_IDENTITY_REQUIRED');
    }
    const existing = this.providers.get(provider.providerId);
    if (existing) {
      if (existing === provider || existing.version === provider.version) return;
      throw new Error(`CHECK_PROVIDER_DUPLICATE: ${provider.providerId}`);
    }
    this.providers.set(provider.providerId, provider);
  }

  resolve(providerId: string): CheckProvider | null {
    return this.providers.get(providerId) ?? null;
  }
}

// One process-wide capability registry. The composition root and module
// installers resolve the same instance, so adding a module contributes only
// providers/declarations; it never adds a new dispatcher or runtime branch.
const factoryCheckProviders = new FactoryCheckProviderRegistry();

export function createStandardCheckProviderRegistry(): FactoryCheckProviderRegistry {
  return factoryCheckProviders;
}

export function registerFactoryCheckProvider(provider: CheckProvider): void {
  factoryCheckProviders.register(provider);
}

export function checkProviderRef(
  providerId: string,
  version: string,
  providerDigest: string,
) {
  return { providerId, version, providerDigest } as const;
}

export function buildCheckPlan(
  checkPlanId: string,
  checks: readonly {
    providerId: string;
    version: string;
    providerDigest: string;
    parameters?: Readonly<Record<string, unknown>>;
    repairTargetRoleOnFailure?: 'author' | 'reviewer';
    repairTargetRoleOnIndeterminate?: 'author' | 'reviewer';
    indeterminateDisposition?: 'repair' | 'human-required';
  }[] = [],
  options: { includeProductContract?: boolean } = {},
): CheckPlan {
  const version = '1.0.0';
  const includeProductContract = options.includeProductContract !== false;
  const entries = [
    ...(includeProductContract ? [{
      check: {
        providerId: PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
        version: PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
        providerDigest: PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST,
      },
      parameters: {},
      environmentRef: null,
    }] : []),
    ...checks.map(check => ({
      check: {
        providerId: check.providerId,
        version: check.version,
        providerDigest: check.providerDigest,
      },
      parameters: { ...(check.parameters ?? {}) },
      ...(check.repairTargetRoleOnFailure
        ? { repairTargetRoleOnFailure: check.repairTargetRoleOnFailure }
        : {}),
      ...(check.repairTargetRoleOnIndeterminate
        ? { repairTargetRoleOnIndeterminate: check.repairTargetRoleOnIndeterminate }
        : {}),
      ...(check.indeterminateDisposition
        ? { indeterminateDisposition: check.indeterminateDisposition }
        : {}),
      environmentRef: null,
    })),
  ];
  const decisionPolicyRef = 'factory.fail-closed-check-plan.v1';
  const decisionPolicyDigest = sha256Hex({ decisionPolicyRef, version });
  const unknownErrorPolicy = 'fail-closed' as const;
  return {
    checkPlanId,
    version,
    checkPlanDigest: sha256Hex({
      checkPlanId,
      version,
      entries,
      decisionPolicyRef,
      decisionPolicyDigest,
      unknownErrorPolicy,
    }),
    entries,
    decisionPolicyRef,
    decisionPolicyDigest,
    unknownErrorPolicy,
  };
}

export function buildProductContractCheckPlan(checkPlanId: string): CheckPlan {
  return buildCheckPlan(checkPlanId);
}
