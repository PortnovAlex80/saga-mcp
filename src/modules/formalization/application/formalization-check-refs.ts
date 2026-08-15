import { submissionValidatorCheckProviderRef } from '../../../process-modules/application/submission-validator-check-provider.js';
import { SRS_CONTRACT_VALIDATOR_VERSION } from './srs-contract-validator.js';
import { SRS_CONTRACT_REF } from '../domain/srs-contract.js';
import { ACCEPTANCE_CONTRACT_VALIDATOR_VERSION } from './acceptance-contract-validator.js';

const FORMALIZATION_SUBMISSION_VALIDATOR_VERSION = '1.0.0';

/** Pure declarative provider identities; safe for the Workshop manifest. */
export const FORMALIZATION_CHECK_REFS = {
  product: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.product-contract.v1',
    validatorVersion: FORMALIZATION_SUBMISSION_VALIDATOR_VERSION,
    nodeId: 'define-product-contract',
    requireManagedProduction: true,
  }),
  useCases: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.use-cases.v1',
    validatorVersion: FORMALIZATION_SUBMISSION_VALIDATOR_VERSION,
    nodeId: 'model-use-cases',
    requireManagedProduction: true,
  }),
  acceptance: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.acceptance-contract.v1',
    // Uses the ACTUAL validator version (1.1.0 after the TB-8 AC heading
    // check), not the shared 1.0.0 — the workshop manifest's binding
    // receipt compares declared vs resolved and a version drift is a
    // WORKSHOP_CAPABILITY_BINDING_MISMATCH startup failure.
    validatorVersion: ACCEPTANCE_CONTRACT_VALIDATOR_VERSION,
    nodeId: 'define-acceptance-contract',
    requireManagedProduction: true,
  }),
  reconciliation: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.reconciliation.v1',
    validatorVersion: FORMALIZATION_SUBMISSION_VALIDATOR_VERSION,
    nodeId: 'reconcile-what',
    requireManagedProduction: false,
  }),
  architecture: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.srs-contract.v1',
    validatorVersion: SRS_CONTRACT_VALIDATOR_VERSION,
    nodeId: 'define-architecture-contract',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  }),
} as const;
