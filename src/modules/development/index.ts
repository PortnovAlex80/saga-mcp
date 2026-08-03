/**
 * Development module registration (the LEGO contract).
 *
 * `registerDevelopment(registries, sharedDeps, options)` constructs
 * Development's module-specific concrete adapters (task-graph store, ledger,
 * git/machine ports, output repository), registers its kernel handlers,
 * builds its `GenericFlowExecutor`, and registers the module definition +
 * installation. Called once from the composition root.
 *
 * Returns the executor plus the module graph (the composition root's runtime
 * surface exposes it as `runtimes.development`) and output repository.
 *
 * This file lives under `src/modules/` (the module-scoped tree); the SQLite-
 * substrate gates that cover `src/process-modules/modules/` do not apply here.
 */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { SqliteDevelopmentOutputRepository } from './infrastructure/development-persistence.js';
import { SqliteDevelopmentModuleStore } from './infrastructure/sqlite-development-settlement-state.js';
import { SqliteManagedProductionLedger } from '../../process-modules/persistence/sqlite-managed-production-ledger.js';
import { createGitPort, createMachinePort } from '../../infrastructure/process-modules/git-machine-ports.js';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../../process-modules/modules/development/development-settlement-policy.js';
import {
  createDevelopmentKernelHandlers,
  createDevelopmentOutputResolver,
} from '../../process-modules/modules/development/development-installation.js';
import { developmentProcessModule } from '../../process-modules/modules/development/development-process-module.js';
import type { DevelopmentModuleInstallationDependencies } from '../../process-modules/modules/development/development-kernel-ports.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

/**
 * Development-specific overrides. Mirrors the subset of
 * `DevelopmentCompositionDependencies` the composition root already forwards.
 *
 * Re-exported from the composition root as `DevelopmentCompositionDependencies`
 * for back-compat with the historical public option name.
 */
export interface DevelopmentCompositionDependencies {
  store?: DevelopmentModuleInstallationDependencies['graph']
    & DevelopmentModuleInstallationDependencies['taskGraph']
    & DevelopmentModuleInstallationDependencies['settlementState'];
  taskGraph?: DevelopmentModuleInstallationDependencies['taskGraph'];
  settlementState?: DevelopmentModuleInstallationDependencies['settlementState'];
  taskGraphPolicy?: DevelopmentModuleInstallationDependencies['taskGraphPolicy'];
  settlementPolicy?: DevelopmentModuleInstallationDependencies['settlementPolicy'];
  outputRepository?: DevelopmentModuleInstallationDependencies['outputRepository'];
}

/** Alias for {@link DevelopmentCompositionDependencies}. */
export type RegisterDevelopmentOptions = DevelopmentCompositionDependencies;

/** Module-specific artifacts the composition root exposes on its return surface. */
export interface DevelopmentRegistration {
  executor: GenericFlowExecutor;
  /** The task-graph store (also surfaces as `runtimes.development`). */
  graph: NonNullable<RegisterDevelopmentOptions['store']>;
  outputRepository: NonNullable<RegisterDevelopmentOptions['outputRepository']>;
}

/**
 * Register the Development Process Module. Mutates `registries` in place.
 */
export function registerDevelopment(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  options: RegisterDevelopmentOptions = {},
): DevelopmentRegistration {
  const { db, certificateRepo, managedNodeSubmissions, processProductRepo } = sharedDeps;

  const ledger = new SqliteManagedProductionLedger(db);
  // Inject the concrete process-product repository + git/machine ports from
  // the composition root so the Development module imports no SQLite adapter,
  // child_process, or node:os. Reuse the shared `processProductRepo`
  // (constructed in the composition root for the v2 executor wiring) instead
  // of a second instance over the same DB.
  const git = createGitPort();
  const machine = createMachinePort();
  const graph = options.store
    ?? new SqliteDevelopmentModuleStore(db, processProductRepo, git, machine);
  const taskGraphPolicy = options.taskGraphPolicy
    ?? new ReferenceDevelopmentTaskGraphPolicy();
  const outputRepository = options.outputRepository
    ?? new SqliteDevelopmentOutputRepository(db);
  const deps: DevelopmentModuleInstallationDependencies = {
    plannerSubmissions: managedNodeSubmissions,
    ledger,
    graph,
    taskGraph: options.taskGraph ?? graph,
    settlementState: options.settlementState ?? graph,
    taskGraphPolicy,
    settlementPolicy: options.settlementPolicy
      ?? new ReferenceDevelopmentSettlementPolicy(taskGraphPolicy),
    outputRepository,
    // The development settlement kernel AUTHORS its own certificate (issuing
    // it through this repo) and emits an explicit ModuleCompletion pointing at
    // the resulting certificateRef.
    certificateRepository: certificateRepo,
  };

  // Register kernel handlers.
  registries.kernelHandlers.registerAll(createDevelopmentKernelHandlers(deps));

  // Build the executor.
  const executor = new GenericFlowExecutor({
    moduleRef: developmentProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    recoveryCaseRepo: sharedDeps.recoveryCaseRepo,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createDevelopmentOutputResolver(outputRepository),
    v2: sharedDeps.executorV2Options,
  });

  // Register module definition + installation.
  registries.moduleRegistry.register(developmentProcessModule);
  registries.installationRegistry.register({
    definition: developmentProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, graph, outputRepository };
}
