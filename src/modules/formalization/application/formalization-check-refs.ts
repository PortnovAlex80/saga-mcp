import { submissionValidatorCheckProviderRef } from '../../../process-modules/application/submission-validator-check-provider.js';
import { SRS_CONTRACT_VALIDATOR_VERSION } from './srs-contract-validator.js';
import { SRS_CONTRACT_REF } from '../domain/srs-contract.js';

// 1.1.0 — AC-drift remedy: the product validator enforces constraint
// dispositions; the acceptance/reconciliation validators enforce the
// coverage ratchet. Must equal the createFormalizationContractValidator /
// createAcceptanceContractValidator validatorVersion (the workshop manifest
// binds the executable providers by this digest).
const FORMALIZATION_SUBMISSION_VALIDATOR_VERSION = '1.1.0';

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
    validatorVersion: FORMALIZATION_SUBMISSION_VALIDATOR_VERSION,
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
