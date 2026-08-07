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
    // Schema/cardinality are checked by the Production Cell reconciler before
    // GateRun creation. This immutable receipt records that core check.
    return 'passed';
  },
};

/**
 * One shared registry for platform and package-installed CheckProviders.
 *
 * The core never switches on workshop/module identity. Module installers add
 * providers by opaque providerId; CheckPlans reference only the pinned
 * id/version/digest triple. Duplicate ids are rejected so a package cannot
 * silently shadow another package or a platform provider.
 */
export class FactoryCheckProviderRegistry implements CheckProviderRegistry {
  private readonly providers = new Map<string, CheckProvider>();

  constructor() {
    this.register(productContractProvider);
  }

  register(provider: CheckProvider): void {
    if (!provider.providerId.trim() || !provider.version.trim()) {
      throw new Error('CHECK_PROVIDER_IDENTITY_REQUIRED');
    }
    if (this.providers.has(provider.providerId)) {
      throw new Error(`CHECK_PROVIDER_DUPLICATE: ${provider.providerId}`);
    }
    this.providers.set(provider.providerId, provider);
  }

  resolve(providerId: string): CheckProvider | null {
    return this.providers.get(providerId) ?? null;
  }
}

export function createStandardCheckProviderRegistry(): FactoryCheckProviderRegistry {
  return new FactoryCheckProviderRegistry();
}

/** Canonical provider ref used when building module-owned CheckPlans. */
export function checkProviderRef(
  providerId: string,
  version: string,
  providerDigest: string,
) {
  return { providerId, version, providerDigest } as const;
}

/**
 * Build a fail-closed plan from an ordered set of pinned providers.
 * Product-contract integrity is included first unless explicitly disabled.
 */
export function buildCheckPlan(
  checkPlanId: string,
  checks: readonly {
    providerId: string;
    version: string;
    providerDigest: string;
    parameters?: Readonly<Record<string, unknown>>;
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
