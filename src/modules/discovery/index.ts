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
} from './application/discovery-production-cell-installation.js';
import { discoveryProcessModule } from '../../process-modules/modules/discovery/discovery-process-module.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

export interface RegisterDiscoveryOptions {}

export function registerDiscovery(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  _options?: RegisterDiscoveryOptions,
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
    }),
  );

  const executor = new GenericFlowExecutor({
    moduleRef: discoveryProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    transitionObligations: sharedDeps.transitionObligations,
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
