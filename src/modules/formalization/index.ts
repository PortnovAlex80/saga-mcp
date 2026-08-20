/** Formalization module registration on the target Production Cell runtime. */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import {
  registerWorkshopCheckProvider,
  registerWorkshopPostAcceptanceEffect,
} from '../../process-modules/application/workshop-capability-manifest.js';
import {
  createReviewVerdictCheckProvider,
} from '../../process-modules/application/review-verdict-check-provider.js';
import {
  createFormalizationProductionCellKernelHandlers,
  createFormalizationOutputResolver,
} from './application/formalization-production-cell-installation.js';
import { registerFormalizationCheckProviders } from './application/formalization-check-providers.js';
import { readExactArtifactContent } from './application/artifact-content-reader.js';
import { createFormalizationAcceptProductsEffect } from './application/formalization-accept-products-effect.js';
import { SqliteSealedProductMaterialRepository } from '../../infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { assertPersistedAcceptedCandidateAuthority } from '../../infrastructure/workplace/sqlite-accepted-candidate-authority.js';
import { formalizationProcessModule } from '../../process-modules/modules/formalization/formalization-process-module.js';
import {
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} from './infrastructure/formalization-persistence.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from './infrastructure/sqlite-formalization-kernel.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

export interface RegisterFormalizationOptions {}

export interface FormalizationRegistration {
  executor: GenericFlowExecutor;
  baselineRepository: SqliteFormalizationBaselineRepository;
  solutionContractRepository: SqliteFormalizationSolutionContractRepository;
}
export function registerFormalization(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  _options?: RegisterFormalizationOptions,
): FormalizationRegistration {
  const { db } = sharedDeps;
  const baselineRepository = new SqliteFormalizationBaselineRepository(db);
  const solutionContractRepository =
    new SqliteFormalizationSolutionContractRepository(db);
  const graph = new SqliteFormalizationArtifactGraph(db);

  // One factory-wide quality registry. Formalization contributes providers by
  // opaque id; ProductionCellNodeExecutor never learns workshop vocabulary.
  registerFormalizationCheckProviders({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  });
  // ADR-053 Phase 1: payload contracts are installed from the single workshop
  // capability manifest by the orchestrator composition root, not per-module.
  registerWorkshopCheckProvider(createReviewVerdictCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  registerWorkshopPostAcceptanceEffect(
    createFormalizationAcceptProductsEffect(db, {
      assertPersisted: authority => assertPersistedAcceptedCandidateAuthority(db, authority),
      readSealedProduct: ref => new SqliteSealedProductMaterialRepository(db).readExact(ref),
    }),
  );

  registries.kernelHandlers.registerAll(
    createFormalizationProductionCellKernelHandlers({
      graph,
      baselineRepository,
      solutionContractRepository,
      settlementPolicy: new ReferenceFormalizationSettlementPolicy(),
      certificateRepository: sharedDeps.certificateRepo,
      readArtifactContent: artifactId => readExactArtifactContent(db, artifactId),
    }),
  );

  const executor = new GenericFlowExecutor({
    moduleRef: formalizationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    transitionObligations: sharedDeps.transitionObligations,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createFormalizationOutputResolver(solutionContractRepository),
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  registries.moduleRegistry.register(formalizationProcessModule);
  registries.installationRegistry.register({
    definition: formalizationProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, baselineRepository, solutionContractRepository };
}
