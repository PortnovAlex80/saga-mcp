/**
 * Wire the mandatory node submission validation registries.
 *
 * Called once at composition time. Registers:
 *   - the formalization acceptance-contract validator (the priority shift-left
 *     gate that closes the AC repair-loop root cause)
 *   - policy declarations for every LM-node across all modules
 *
 * Formalization nodes use domain validators. Discovery and Development
 * publish typed Production Cell products that are checked by their cell gate
 * and deterministic settlement.
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
const DEVELOPMENT_MODULE_REFS = [
  'solution-development@1.1.0',
  'solution-development@1.2.0',
  'solution-development@1.4.0',
  'solution-development@1.4.1',
  'solution-development@1.4.2',
  'solution-development@1.4.3',
] as const;
const DEVELOPMENT_CONTINUATION_MODULE_REF = 'solution-development-managed@1.1.0';
const DEVELOPMENT_VERIFICATION_CONTINUATION_MODULE_REF =
  'solution-development-verification-continuation@1.0.0';

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
      requireManagedProduction: nodeId !== 'reconcile-what',
    });
  }
  // SRS policy: version-pinned.
  policyRegistry.register(FORMALIZATION_MODULE_REF, 'define-architecture-contract', {
    mode: 'required',
    validatorId: 'formalization.srs-contract.v1',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  });

  // --- Discovery policies ---
  for (const nodeId of ['produce-proposal', 'assess-readiness']) {
    policyRegistry.register(
      DISCOVERY_MODULE_REF,
      nodeId,
      {
        mode: 'none',
        rationale: 'typed Production Cell product; validated by cell gate and Discovery settlement',
      },
    );
  }

  // Development workers publish typed JSON products. Their schema/cardinality
  // is checked by the Production Cell gate and their domain lineage is checked
  // again by deterministic settlement, so the artifact-graph validator is not
  // applicable to these nodes.
  for (const nodeId of [
    'plan-task-graph',
    'implement-work-items',
    'certify-product-readiness',
    'verify-acceptance',
  ]) {
    for (const moduleRef of DEVELOPMENT_MODULE_REFS) {
      policyRegistry.register(moduleRef, nodeId, {
        mode: 'none',
        rationale: 'typed Production Cell product; validated by cell gate and Development settlement',
      });
    }
  }
  for (const nodeId of ['implement-work-items', 'verify-acceptance']) {
    policyRegistry.register(DEVELOPMENT_CONTINUATION_MODULE_REF, nodeId, {
      mode: 'none',
      rationale: 'managed textual Product Cell product; validated by Factory materialization, cell gates and Development settlement',
    });
  }
  policyRegistry.register(DEVELOPMENT_VERIFICATION_CONTINUATION_MODULE_REF, 'verify-acceptance', {
    mode: 'none',
    rationale: 'provider-led evidence over an immutable adopted candidate; validated by current cell gates and deterministic settlement',
  });
}
