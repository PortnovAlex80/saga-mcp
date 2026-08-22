import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { productDeliveryLifecycle } from './product-delivery-lifecycle.js';
import {
  sha256Hex,
} from '../../shared/canonical-json.js';
import type {
  OrderConstraintInjectionTable,
} from '../../shared/constraint-register.js';

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
    version: '1.2.0',
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

/**
 * ADR-090 (CC-IC-1): the frozen `runnable-local` terminal classification this
 * lifecycle owns, and the DECLARED, DIGEST-PINNED obligation injection table
 * mapped from it. The lifecycle that freezes the classification owns its
 * injection declaration — this is DATA, not engine inference:
 *
 *  - immutable and versioned: the table is content-addressed by
 *    RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST; a changed table is a
 *    new digest (an honest revision), and Discovery settlement cites the
 *    digest from the settlement record;
 *  - consumed READ-ONLY by Discovery settlement, which appends the mapped
 *    entries AFTER the proposal-derived block in the declared table order
 *    (whole-product synthesis first, then ordered smoke) — never interleaved;
 *  - domain-free (Conveyor Mental Model §3; master plan §4): no browser,
 *    canvas, frontend or any workshop-specific vocabulary lives here; the
 *    engine never infers obligations by rereading order or SRS prose.
 */
export const RUNNABLE_LOCAL_CLASSIFICATION = 'runnable-local';

export const RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE: OrderConstraintInjectionTable = {
  schemaVersion: 'factory.lifecycle-obligation-injection.v1',
  classification: RUNNABLE_LOCAL_CLASSIFICATION,
  entries: [
    {
      class: 'execution',
      kind: 'synthesis',
      text: 'the delivered product is synthesized and assembled as one whole that is runnable locally',
      evidence_ref: 'lifecycle.classification.runnable-local',
    },
    {
      class: 'execution',
      kind: 'ordered-smoke',
      text: 'an ordered smoke test performs the install step, then the start step, then reaches the running product',
      evidence_ref: 'lifecycle.classification.runnable-local',
    },
  ],
};

/** Content-addressed identity of the declared table (stable for this content). */
export const RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST: string = sha256Hex(
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
);

/** Content-addressed ref cited by Discovery settlement records. */
export const RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF = `lifecycle-obligation-injection:${RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST}`;
