import type { CandidateSetReaderPort } from '../../../application/ports/candidate-set-reader.js';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import { registerWorkshopCheckProvider } from '../../../process-modules/application/workshop-capability-manifest.js';
import {
  submissionValidatorCheckProvider,
} from '../../../process-modules/application/submission-validator-check-provider.js';
import { createAcceptanceContractValidator } from './acceptance-contract-validator.js';
import { createFormalizationContractValidator } from './formalization-contract-validator.js';
import {
  createSrsContractValidator,
} from './srs-contract-validator.js';
import { SRS_CONTRACT_REF } from '../domain/srs-contract.js';
export { FORMALIZATION_CHECK_REFS } from './formalization-check-refs.js';

export function registerFormalizationCheckProviders(input: {
  db: SqlDatabasePort;
  candidateSets: CandidateSetReaderPort;
}): void {
  const productValidator = createFormalizationContractValidator(
    input.db,
    'formalization.product-contract.v1',
    'define-product-contract',
    { product: true },
  );
  const useCaseValidator = createFormalizationContractValidator(
    input.db,
    'formalization.use-cases.v1',
    'model-use-cases',
    { product: true, useCases: true },
  );
  const acceptanceValidator = createAcceptanceContractValidator(input.db);
  const reconciliationValidator = createFormalizationContractValidator(
    input.db,
    'formalization.reconciliation.v1',
    'reconcile-what',
    { product: true, useCases: true, acceptance: true },
  );

  for (const entry of [
    { nodeId: 'define-product-contract', validator: productValidator, requireManagedProduction: true },
    { nodeId: 'model-use-cases', validator: useCaseValidator, requireManagedProduction: true },
    { nodeId: 'define-acceptance-contract', validator: acceptanceValidator, requireManagedProduction: true },
    { nodeId: 'reconcile-what', validator: reconciliationValidator, requireManagedProduction: false },
  ]) {
    registerWorkshopCheckProvider(submissionValidatorCheckProvider({
      db: input.db,
      candidateSets: input.candidateSets,
      validator: entry.validator,
      nodeId: entry.nodeId,
      requireManagedProduction: entry.requireManagedProduction,
    }));
  }
  registerWorkshopCheckProvider(submissionValidatorCheckProvider({
    db: input.db,
    candidateSets: input.candidateSets,
    validator: createSrsContractValidator(input.db),
    nodeId: 'define-architecture-contract',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  }));
}
