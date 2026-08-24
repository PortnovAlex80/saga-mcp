/**
 * Documentation workshop registration (the LEGO contract).
 *
 * `registerDocumentation(registries, sharedDeps, options)` constructs the
 * module's concrete adapters (output repository, product reader, repository
 * observation, render provider), registers its kernel handlers and trusted
 * check provider, builds its `GenericFlowExecutor`, and registers the module
 * definition + installation. Called once from the composition root
 * (`product-lifecycle-runtime.ts`).
 */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { registerWorkshopCheckProvider } from '../../process-modules/application/workshop-capability-manifest.js';
import { documentationProcessModule } from '../../process-modules/modules/documentation/documentation-process-module.js';
import {
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST,
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
  createDocumentationCompletenessCheckProvider,
} from './application/documentation-check-providers.js';
import {
  createDocumentationKernelHandlers,
  createDocumentationOutputResolver,
} from './application/documentation-installation.js';
import { pdfKitDocumentationRenderProvider } from './application/pdf/pdfkit-documentation-render-provider.js';
import {
  createDocumentationProductReader,
  createGitDocumentationRepositoryObservation,
} from './infrastructure/documentation-infrastructure.js';
import { SqliteDocumentationOutputRepository } from './infrastructure/sqlite-documentation-output-repository.js';
import type {
  DocumentationOutputRepository,
  DocumentationRenderProvider,
  DocumentationRepositoryObservationPort,
} from './domain/documentation-kernel-ports.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

export interface DocumentationCompositionDependencies {
  renderProvider?: DocumentationRenderProvider;
  repositoryObservation?: DocumentationRepositoryObservationPort;
  outputRepository?: DocumentationOutputRepository;
}

export interface DocumentationRegistration {
  executor: GenericFlowExecutor;
  outputRepository: DocumentationOutputRepository;
}

/**
 * Register the Documentation Process Module. Mutates `registries` in place.
 */
export function registerDocumentation(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  options: DocumentationCompositionDependencies = {},
): DocumentationRegistration {
  const { db, certificateRepo } = sharedDeps;

  const outputRepository = options.outputRepository
    ?? new SqliteDocumentationOutputRepository(db);
  const renderProvider = options.renderProvider ?? pdfKitDocumentationRenderProvider;
  const repositoryObservation = options.repositoryObservation
    ?? createGitDocumentationRepositoryObservation(db);

  // Check-provider trust row (mirrors the development registration pattern):
  // fail loudly on drift instead of silently re-trusting a changed provider.
  const trust = db.prepare(
    `SELECT id,version,trust_basis,category,determinism,status
       FROM trusted_providers WHERE project_id IS NULL AND name=?`,
  ).all(DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID) as Array<{
    id: number; version: string | null; trust_basis: string;
    category: string; determinism: string; status: string;
  }>;
  const expectedTrust = `built-in:${DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST}`;
  if (trust.length === 0) {
    db.prepare(
      `INSERT INTO trusted_providers
        (project_id,name,version,category,trust_basis,determinism,scope,status)
       VALUES (NULL,?,?,'deterministic_evidence',?,'full','documentation-lineage','active')`,
    ).run(
      DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
      DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
      expectedTrust,
    );
  } else if (trust.length !== 1
      || trust[0]!.version !== DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION
      || trust[0]!.trust_basis !== expectedTrust
      || trust[0]!.category !== 'deterministic_evidence'
      || trust[0]!.determinism !== 'full'
      || trust[0]!.status !== 'active') {
    throw new Error('DOCUMENTATION_COMPLETENESS_PROVIDER_TRUST_DRIFT');
  }
  registerWorkshopCheckProvider(createDocumentationCompletenessCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));

  registries.kernelHandlers.registerAll(createDocumentationKernelHandlers({
    productReader: createDocumentationProductReader(db),
    renderProvider,
    repositoryObservation,
    outputRepository,
    certificateRepo,
  }));

  const executor = new GenericFlowExecutor({
    moduleRef: documentationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    transitionObligations: sharedDeps.transitionObligations,
    nodeExecutors: sharedDeps.nodeExecutors,
    recoveryCaseRepo: sharedDeps.recoveryCaseRepo,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createDocumentationOutputResolver(outputRepository),
    onWorkplaceVerified: sharedDeps.onWorkplaceVerified,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  registries.moduleRegistry.register(documentationProcessModule);
  registries.installationRegistry.register({
    definition: documentationProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, outputRepository };
}
