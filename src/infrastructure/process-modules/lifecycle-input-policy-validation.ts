/**
 * Concrete infrastructure adapter for the lifecycle's
 * `LifecycleInputPolicyValidationPort` (CONVEYOR Wave 7, Rule 3).
 *
 * The lifecycle must not import module policy-implementation directly, so it
 * reaches the three pure module-side hashing functions through this injected
 * port. Infrastructure depends inward (allowed): it wires the concrete module
 * hashing functions behind the port interface defined in the lifecycle.
 */
import type { LifecycleInputPolicyValidationPort } from '../../process-modules/lifecycles/product-delivery-lifecycle.js';
import {
  hashDeliveryReleasePolicy,
  hashDeliveryDeferredProfile,
} from '../../process-modules/modules/delivery/delivery-settlement-policy.js';
import { hashDevelopmentPolicy } from '../../process-modules/modules/development/development-settlement-policy.js';

export const lifecycleInputPolicyValidation: LifecycleInputPolicyValidationPort = {
  hashDevelopmentPolicy: (policy: unknown) =>
    hashDevelopmentPolicy(policy as never),
  hashDeliveryReleasePolicy: (policy: unknown) =>
    hashDeliveryReleasePolicy(policy as never),
  hashDeliveryDeferredProfile: (profile: unknown) =>
    hashDeliveryDeferredProfile(profile as never),
};
