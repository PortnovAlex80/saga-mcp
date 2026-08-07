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
    // The reconciler validates exact schema/cardinality before a GateRun can
    // start. This provider creates the immutable receipt for that core check.
    return 'passed';
  },
};

/**
 * Canonical fail-closed gate used by a Production Cell whose acceptance rule is
 * exactly its declared product contract. Keeping this construction in one
 * runtime-owned helper prevents every workshop from carrying a byte-different
 * copy of the same check plan while leaving product meaning in module data.
 */
export function buildProductContractCheckPlan(checkPlanId: string): CheckPlan {
  const version = '1.0.0';
  const entries = [{
    check: {
      providerId: PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
      version: PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
      providerDigest: PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST,
    },
    parameters: {},
    environmentRef: null,
  }];
  const decisionPolicyRef = 'factory.fail-closed-product-contract.v1';
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

export function createStandardCheckProviderRegistry(): CheckProviderRegistry {
  const providers = new Map<string, CheckProvider>([
    [productContractProvider.providerId, productContractProvider],
  ]);
  return { resolve: providerId => providers.get(providerId) ?? null };
}
