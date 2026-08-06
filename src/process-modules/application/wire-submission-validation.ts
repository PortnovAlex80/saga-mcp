/**
 * Wire the mandatory node submission validation registries.
 *
 * Called once at composition time. Registers:
 *   - the formalization acceptance-contract validator (the priority shift-left
 *     gate that closes the AC repair-loop root cause)
 *   - policy declarations for every LM-node across all modules
 *
 * Formalization's `define-acceptance-contract` is `required` (full validator).
 * The other four formalization LM-nodes and all Discovery/Development LM-nodes
 * are declared `legacy-unvalidated` — they are allowed to proceed (with a
 * telemetry warning) but their migration to real validators is tracked by
 * ticket. New modules cannot use `legacy-unvalidated` (enforced by an
 * architecture test).
 */

import type Database from 'better-sqlite3';
import type {
  NodeSubmissionPolicyRegistry,
  NodeSubmissionValidatorRegistry,
} from './node-submission-policy.js';
import { createAcceptanceContractValidator } from '../../modules/formalization/application/acceptance-contract-validator.js';
import { createSrsContractValidator } from '../../modules/formalization/application/srs-contract-validator.js';

const FORMALIZATION_MODULE_REF = 'solution-formalization@1.0.0';
const DISCOVERY_MODULE_REF = 'product-discovery@3.0.2';

export function wireSubmissionValidation(
  policyRegistry: NodeSubmissionPolicyRegistry,
  validatorRegistry: NodeSubmissionValidatorRegistry,
  db: Database.Database,
): void {
  // --- Validators ---
  validatorRegistry.register(createAcceptanceContractValidator(db));
  validatorRegistry.register(createSrsContractValidator(db));

  // --- Formalization policies ---
  // define-acceptance-contract + define-architecture-contract: full validators.
  policyRegistry.register(
    FORMALIZATION_MODULE_REF,
    'define-acceptance-contract',
    { mode: 'required', validatorId: 'formalization.acceptance-contract.v1' },
  );
  policyRegistry.register(
    FORMALIZATION_MODULE_REF,
    'define-architecture-contract',
    { mode: 'required', validatorId: 'formalization.srs-contract.v1' },
  );
  // The other three formalization LM-nodes: legacy-unvalidated pending migration.
  for (const nodeId of [
    'define-product-contract',
    'model-use-cases',
    'reconcile-what',
  ]) {
    policyRegistry.register(
      FORMALIZATION_MODULE_REF,
      nodeId,
      {
        mode: 'legacy-unvalidated',
        migrationTicket: `FORMALIZATION-${nodeId.toUpperCase()}-SUBMISSION-VALIDATION`,
      },
    );
  }

  // --- Discovery policies ---
  for (const nodeId of ['produce-proposal', 'assess-readiness']) {
    policyRegistry.register(
      DISCOVERY_MODULE_REF,
      nodeId,
      {
        mode: 'legacy-unvalidated',
        migrationTicket: 'DISCOVERY-SUBMISSION-VALIDATION',
      },
    );
  }
}
