import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { productDeliveryLifecycle } from './product-delivery-lifecycle.js';

/**
 * MVP product-construction lifecycle.
 *
 * It deliberately ends after the exact Development certificate and verified
 * integrated candidate exist. Release/deployment is a separate request and is
 * never an implicit tail of ordinary product construction.
 *
 * The v1 input temporarily retains the portable product-delivery input schema
 * for wire compatibility; its `delivery` member is ignored by this definition.
 * A later FactoryRequest envelope replaces that compatibility field.
 */
export const productBuildLifecycle: LifecycleDefinition = {
  ...productDeliveryLifecycle,
  identity: {
    name: 'product-build',
    version: '1.1.0',
    displayName: 'Product Build',
    description:
      'Builds and proves one locally runnable product revision; deployment and human acceptance are separate requests.',
  },
  stages: productDeliveryLifecycle.stages
    .filter(stage => stage.id !== 'delivery-release')
    .map(stage => stage.id !== 'solution-development'
      ? stage
      : {
          ...stage,
          outcomeRoutes: {
            ...stage.outcomeRoutes,
            verified: { type: 'terminal' as const, status: 'runnable-local' },
          },
          exitConditions: [
            'Development has frozen an immutable integrated candidate',
            'Factory-owned tests and a loopback start probe passed for the exact commit/tree',
          ],
        }),
};
