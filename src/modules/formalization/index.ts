/** Formalization module registration on the target Production Cell runtime. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function readExactArtifactContent(
  db: ModuleSharedDeps['db'],
  artifactId: number,
): string {
  const row = db.prepare(
    `SELECT a.path,a.content_hash,r.local_path
       FROM artifacts a
       JOIN project_repositories r ON r.id=a.project_repository_id
      WHERE a.id=?`,
  ).get(artifactId) as {
    path: string;
    content_hash: string | null;
    local_path: string;
  } | undefined;
  if (!row || !row.content_hash || !row.local_path) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE: ${artifactId}`);
  }
  const filePath = join(row.local_path, row.path.split('#')[0]!);
  const content = readFileSync(filePath, 'utf8');
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  if (actual !== row.content_hash) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_DRIFT: ${artifactId}`);
  }
  return content;
}
