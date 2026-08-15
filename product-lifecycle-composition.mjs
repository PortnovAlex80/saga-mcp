/**
 * Product lifecycle composition for full Discovery → Formalization →
 * Development → Delivery testing.
 *
 * Development ports are NOT supplied here — the composition root
 * (product-lifecycle-runtime.ts) falls back to SqliteDevelopmentRuntime which
 * implements materializeValidatedTaskGraph, execute, integrateAndFreeze,
 * verify and buildSettlementInput against the real saga.db. This means
 * development tasks are materialized as real worker-claimable tasks, and
 * verification records real evidence.
 *
 * Delivery providers remain no-ops (throw if reached) until we wire real
 * publication/observation adapters.
 *
 * Usage:
 *   SAGA_ORCHESTRATION_MODE=saga3-lifecycle \
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./product-lifecycle-composition.mjs \
 *   node dist/orchestrate-cli.js <project_id> <epic_id> --concurrency=1 \
 *     --lifecycle-input=./lifecycle-input.json
 */
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from './dist/modules/development/domain/development-settlement-policy.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from './dist/modules/delivery/domain/delivery-settlement-policy.js';

const notReached = (label) => () => {
  throw new Error(
    `PRODUCT_LIFECYCLE_TEST_${label}_NOT_REACHED: the ${label} port was invoked. `
    + 'Supply a real provider to continue.',
  );
};

export function createProductLifecycleComposition(_context) {
  return {
    development: {
      taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
      settlementPolicy: new ReferenceDevelopmentSettlementPolicy(),
      // Deliberately OMITTED: taskGraph, implementationWorkset,
      // candidateIntegration, acceptanceVerification, settlementState.
      // The composition root falls back to SqliteDevelopmentRuntime which
      // implements all five against the real saga.db — materializing real
      // worker tasks, integrating branches, and recording verification evidence.
    },
    delivery: {
      preflightPolicy: new ReferenceDeliveryPreflightPolicy(),
      settlementPolicy: new ReferenceDeliverySettlementPolicy(),
      // Delivery is still no-op until we wire real publication/observation.
      preflightState: { buildPreflightSnapshot: notReached('preflightState') },
      approval: { decide: notReached('approval') },
      publication: { publishAndDeploy: notReached('publication') },
      observation: { observe: notReached('observation') },
      settlementState: { buildSettlementInput: notReached('deliverySettlementState') },
    },
  };
}
