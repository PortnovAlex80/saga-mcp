/**
 * Discovery module registration (the LEGO contract).
 *
 * `registerDiscovery(registries, sharedDeps)` constructs Discovery's
 * module-specific concrete adapters, registers its kernel handlers, builds its
 * `GenericFlowExecutor`, and registers the module definition + installation
 * with the shared registries. Called once from the composition root.
 *
 * The Discovery module's runtime persistence (`runtimePersistence`) is a
 * SHARED prerequisite (the LM executor's
 * `createDiscoveryLmNodePersistence(runtimePersistence)` needs it), so the
 * composition root constructs it and passes it through `sharedDeps` — this
 * register function consumes it, not constructs it.
 *
 * This file lives under `src/modules/` (the module-scoped tree), not under
 * `src/process-modules/modules/`, so the architecture gates that forbid SQLite
 * substrate inside module files (`no-sqlite-in-modules.test.mjs`,
 * `dependency-direction.test.mjs`) do not apply here — this is a composition
 * seam, and it imports the same infrastructure adapters the composition root
 * already imports.
 */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { FactoryDiscoverySettlementService } from './application/discovery-settlement-service.js';
import { SqliteDiscoveryBriefProvisioning } from '../../infrastructure/process-modules/brief-provisioning-ports.js';
import { createDiscoveryKernelHandlers } from './application/discovery-installation.js';
import { discoveryProcessModule } from '../../process-modules/modules/discovery/discovery-process-module.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

/**
 * Options for Discovery registration. The composition root constructs the
 * default runtime persistence and forwards it via `sharedDeps.runtimePersistence`;
 * nothing module-specific is currently overridable here, but the param is kept
 * so future Discovery-only overrides do not change the call signature.
 */
export interface RegisterDiscoveryOptions {
  // intentionally empty — runtimePersistence is shared (LM executor needs it).
}

/**
 * Register the Discovery Process Module: kernel handlers + executor + module
 * definition + installation. Mutates `registries` in place. Returns the
 * executor so the composition root can expose it on its public surface.
 */
export function registerDiscovery(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  _options?: RegisterDiscoveryOptions,
): GenericFlowExecutor {
  const { db, runtimePersistence } = sharedDeps;

  // Module-specific concrete adapters (composition owns construction so the
  // module imports no getDb). `runtimePersistence` is shared (passed in via
  // sharedDeps because the LM executor also needs it).
  const settlementService = new FactoryDiscoverySettlementService({ runtimePersistence });
  const briefProvisioning = new SqliteDiscoveryBriefProvisioning(db);

  // Register kernel handlers.
  registries.kernelHandlers.registerAll(
    createDiscoveryKernelHandlers({
      runtimePersistence,
      briefProvisioning,
      settlementService,
    }),
  );

  // Build the executor.
  const executor = new GenericFlowExecutor({
    moduleRef: discoveryProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    recoveryCaseRepo: sharedDeps.recoveryCaseRepo,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    onWorkplaceVerified: sharedDeps.onWorkplaceVerified,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  // Register module definition + installation.
  registries.moduleRegistry.register(discoveryProcessModule);
  registries.installationRegistry.register({
    definition: discoveryProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return executor;
}
