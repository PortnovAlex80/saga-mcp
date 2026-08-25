/** Discovery module registration on the universal Production Cell runtime. */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { registerWorkshopCheckProvider } from '../../process-modules/application/workshop-capability-manifest.js';
import {
  createDiscoveryProposalCheckProvider,
  createDiscoveryReadinessCheckProvider,
} from './application/discovery-check-providers.js';
import {
  createDiscoveryOutputResolver,
  createDiscoveryProductionCellKernelHandlers,
  type DiscoveryProductionCellInstallationDeps,
} from './application/discovery-production-cell-installation.js';
import { discoveryProcessModule } from '../../process-modules/modules/discovery/discovery-process-module.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

/**
 * ADR-090 (CC-IC-1): the DI pass-through of the pinned lifecycle-definition
 * reader and the declared injection tables into Discovery settlement. Pure
 * composition threading — the port/repository itself is implemented in
 * `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts` and
 * injected by `src/app/product-lifecycle-runtime.ts`; Discovery constructs
 * no repository and holds no ambient default.
 */
export interface RegisterDiscoveryOptions {
  lifecycleDefinitionReader?: DiscoveryProductionCellInstallationDeps['lifecycleDefinitionReader'];
  lifecycleInjectionDeclarations?: DiscoveryProductionCellInstallationDeps['lifecycleInjectionDeclarations'];
  lifecycleInjectionRequiredClassifications?: DiscoveryProductionCellInstallationDeps['lifecycleInjectionRequiredClassifications'];
}

export function registerDiscovery(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  options: RegisterDiscoveryOptions = {},
): GenericFlowExecutor {
  registerWorkshopCheckProvider(createDiscoveryProposalCheckProvider({
    db: sharedDeps.db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  registerWorkshopCheckProvider(createDiscoveryReadinessCheckProvider({
    db: sharedDeps.db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));

  registries.kernelHandlers.registerAll(
    createDiscoveryProductionCellKernelHandlers({
      db: sharedDeps.db,
      certificates: sharedDeps.certificateRepo,
      lifecycleDefinitionReader: options.lifecycleDefinitionReader
        ?? failClosedLifecycleReader(),
      lifecycleInjectionDeclarations: options.lifecycleInjectionDeclarations ?? [],
      lifecycleInjectionRequiredClassifications:
        options.lifecycleInjectionRequiredClassifications ?? [],
    }),
  );

  const executor = new GenericFlowExecutor({
    moduleRef: discoveryProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    transitionObligations: sharedDeps.transitionObligations,
    settleDrain: sharedDeps.settleDrain,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    resolveOutput: createDiscoveryOutputResolver(sharedDeps.db),
    v2: sharedDeps.executorV2Options,
  });

  registries.moduleRegistry.register(discoveryProcessModule);
  registries.installationRegistry.register({
    definition: discoveryProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return executor;
}

/**
 * ADR-090 (CC-IC-1): there is NO ambient/default fallback for the pinned
 * lifecycle-definition reader. A composition that registers Discovery
 * settlement without injecting the typed port fails loudly at registration
 * time (fail-closed wiring), never silently at run time.
 */
function failClosedLifecycleReader(): never {
  throw new Error(
    'DISCOVERY_SETTLEMENT_LIFECYCLE_READER_REQUIRED: registerDiscovery was called '
    + 'without options.lifecycleDefinitionReader — inject the typed pinned-read port '
    + '(no ambient default exists)',
  );
}
