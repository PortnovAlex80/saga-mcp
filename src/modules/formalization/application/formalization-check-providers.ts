import type Database from 'better-sqlite3';
import type { SqliteCandidateSetRepository } from '../../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import {
  registerFactoryCheckProvider,
} from '../../../process-modules/application/standard-check-providers.js';
import {
  submissionValidatorCheckProvider,
  submissionValidatorCheckProviderRef,
} from '../../../process-modules/application/submission-validator-check-provider.js';
import { createAcceptanceContractValidator } from './acceptance-contract-validator.js';
import { createFormalizationContractValidator } from './formalization-contract-validator.js';
import { createSrsContractValidator } from './srs-contract-validator.js';
import { SRS_CONTRACT_REF } from '../domain/srs-contract.js';

const VERSION = '1.0.0';

export const FORMALIZATION_CHECK_REFS = {
  product: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.product-contract.v1',
    validatorVersion: VERSION,
    nodeId: 'define-product-contract',
    requireManagedProduction: true,
  }),
  useCases: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.use-cases.v1',
    validatorVersion: VERSION,
    nodeId: 'model-use-cases',
    requireManagedProduction: true,
  }),
  acceptance: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.acceptance-contract.v1',
    validatorVersion: VERSION,
    nodeId: 'define-acceptance-contract',
    requireManagedProduction: true,
  }),
  reconciliation: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.reconciliation.v1',
    validatorVersion: VERSION,
    nodeId: 'reconcile-what',
    requireManagedProduction: true,
  }),
  architecture: submissionValidatorCheckProviderRef({
    validatorId: 'formalization.srs-contract.v1',
    validatorVersion: VERSION,
    nodeId: 'define-architecture-contract',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  }),
} as const;

export function registerFormalizationCheckProviders(input: {
  db: Database.Database;
  candidateSets: SqliteCandidateSetRepository;
}): void {
  const validators = [
    {
      nodeId: 'define-product-contract',
      validator: createFormalizationContractValidator(
        input.db,
        'formalization.product-contract.v1',
        'define-product-contract',
        { product: true },
      ),
    },
    {
      nodeId: 'model-use-cases',
      validator: createFormalizationContractValidator(
        input.db,
        'formalization.use-cases.v1',
        'model-use-cases',
        { product: true, useCases: true },
      ),
    },
    {
      nodeId: 'define-acceptance-contract',
      validator: createAcceptanceContractValidator(input.db),
    },
    {
      nodeId: 'reconcile-what',
      validator: createFormalizationContractValidator(
        input.db,
        'formalization.reconciliation.v1',
        'reconcile-what',
        { product: true, useCases: true, acceptance: true },
      ),
    },
  ];

  for (const entry of validators) {
    registerFactoryCheckProvider(submissionValidatorCheckProvider({
      db: input.db,
      candidateSets: input.candidateSets,
      validator: entry.validator,
      nodeId: entry.nodeId,
      requireManagedProduction: true,
    }));
  }
  registerFactoryCheckProvider(submissionValidatorCheckProvider({
    db: input.db,
    candidateSets: input.candidateSets,
    validator: createSrsContractValidator(input.db),
    nodeId: 'define-architecture-contract',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  }));
}
