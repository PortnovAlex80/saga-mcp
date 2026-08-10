import { sha256Hex } from '../../../shared/canonical-json.js';

export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID =
  'factory.accessible-counter-sandbox-check.v1';
export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION = '1.0.0';
export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID,
  version: ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION,
  harness: 'isolated-exact-git-tree-counter-dom-storage-keyboard-aria-v1',
});

export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID =
  'factory.authorized-verification-observer.v1';
export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION = '1.0.0';
export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID,
  version: AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION,
  invariant: 'exact-candidate-method-plan-and-criterion-observer-authorization',
});
