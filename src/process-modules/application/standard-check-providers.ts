import { sha256Hex } from '../../shared/canonical-json.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
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

export function createStandardCheckProviderRegistry(): CheckProviderRegistry {
  const providers = new Map<string, CheckProvider>([
    [productContractProvider.providerId, productContractProvider],
  ]);
  return { resolve: providerId => providers.get(providerId) ?? null };
}
