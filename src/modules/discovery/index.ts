/** Discovery module registration on the universal Production Cell runtime. */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { registerFactoryCheckProvider } from '../../process-modules/application/standard-check-providers.js';
import {
  createDiscoveryProposalCheckProvider,
  createDiscoveryReadinessCheckProvider,
} from './application/discovery-check-providers.js';
import {
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
  registerFactoryCheckProvider(createDiscoveryProposalCheckProvider({
    db: sharedDeps.db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  registerFactoryCheckProvider(createDiscoveryReadinessCheckProvider({
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
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  registries.moduleRegistry.register(discoveryProcessModule);
  registries.installationRegistry.register({
    definition: discoveryProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return executor;
}
