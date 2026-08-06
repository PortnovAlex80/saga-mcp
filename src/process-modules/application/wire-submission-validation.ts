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
import { createFormalizationContractValidator } from '../../modules/formalization/application/formalization-contract-validator.js';
import { SRS_CONTRACT_REF } from '../../modules/formalization/domain/srs-contract.js';

const FORMALIZATION_MODULE_REF = 'solution-formalization@1.0.0';
const DISCOVERY_MODULE_REF = 'product-discovery@3.0.2';

export function wireSubmissionValidation(
  policyRegistry: NodeSubmissionPolicyRegistry,
  validatorRegistry: NodeSubmissionValidatorRegistry,
  db: Database.Database,
): void {
  // --- Validators ---
  // AC: dedicated validator (structured gaps for AC-specific edges).
  validatorRegistry.register(createAcceptanceContractValidator(db));
  // SRS: dedicated validator (checks §12 section + criticality validity).
  validatorRegistry.register(createSrsContractValidator(db));
  // Product, UC, Reconciliation: generic formalization contract validator.
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.product-contract.v1', 'define-product-contract',
    { product: true },
  ));
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.use-cases.v1', 'model-use-cases',
    { product: true, useCases: true },
  ));
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.reconciliation.v1', 'reconcile-what',
    { product: true, useCases: true, acceptance: true },
  ));

  // --- Formalization policies ---
  // ALL five formalization LM-nodes now have required validators. The SRS
  // node additionally pins its contract version — the validator compares the
  // pinned ref against its own canonical SRS_CONTRACT_REF and rejects with
  // SRS_CONTRACT_VERSION_MISMATCH if they differ. This detects the case where
  // the author produced an SRS under one contract version and the validator
  // is checking under another.
  const formalizationPolicies: Array<[string, string]> = [
    ['define-product-contract', 'formalization.product-contract.v1'],
    ['model-use-cases', 'formalization.use-cases.v1'],
    ['define-acceptance-contract', 'formalization.acceptance-contract.v1'],
    ['reconcile-what', 'formalization.reconciliation.v1'],
  ];
  for (const [nodeId, validatorId] of formalizationPolicies) {
    policyRegistry.register(FORMALIZATION_MODULE_REF, nodeId, {
      mode: 'required',
      validatorId,
    });
  }
  // SRS policy: version-pinned.
  policyRegistry.register(FORMALIZATION_MODULE_REF, 'define-architecture-contract', {
    mode: 'required',
    validatorId: 'formalization.srs-contract.v1',
    contractRef: SRS_CONTRACT_REF,
  });

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
