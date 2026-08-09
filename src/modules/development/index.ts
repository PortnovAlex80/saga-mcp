/** Development module registration. */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { registerFactoryCheckProvider } from '../../process-modules/application/standard-check-providers.js';
import { createReviewVerdictCheckProvider } from '../../process-modules/application/review-verdict-check-provider.js';
import { SqliteDevelopmentOutputRepository } from './infrastructure/development-persistence.js';
import { SqliteDevelopmentModuleStore } from './infrastructure/sqlite-development-settlement-state.js';
import { SqliteManagedProductionLedger } from '../../process-modules/persistence/sqlite-managed-production-ledger.js';
import { createGitPort, createMachinePort } from '../../infrastructure/process-modules/git-machine-ports.js';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from './domain/development-settlement-policy.js';
import {
  createDevelopmentKernelHandlers,
  createDevelopmentOutputResolver,
} from './application/development-production-cell-installation.js';
import {
  createDevelopmentTaskGraphCheckProvider,
} from './application/development-check-providers.js';
import { developmentProcessModule } from '../../process-modules/modules/development/development-process-module.js';
import type { DevelopmentModuleInstallationDependencies } from './domain/development-kernel-ports.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

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
export type RegisterDevelopmentOptions = DevelopmentCompositionDependencies;

export interface DevelopmentRegistration {
  executor: GenericFlowExecutor;
  graph: NonNullable<RegisterDevelopmentOptions['store']>;
  outputRepository: NonNullable<RegisterDevelopmentOptions['outputRepository']>;
}

export function registerDevelopment(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  options: RegisterDevelopmentOptions = {},
): DevelopmentRegistration {
  const { db, certificateRepo, managedNodeSubmissions, processProductRepo } = sharedDeps;

  const ledger = new SqliteManagedProductionLedger(db);
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
    certificateRepository: certificateRepo,
  };

  registerFactoryCheckProvider(createDevelopmentTaskGraphCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
    taskGraphPolicy,
  }));
  registerFactoryCheckProvider(createReviewVerdictCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  registries.kernelHandlers.registerAll(createDevelopmentKernelHandlers(deps));

  const executor = new GenericFlowExecutor({
    moduleRef: developmentProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createDevelopmentOutputResolver(outputRepository),
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });

  registries.moduleRegistry.register(developmentProcessModule);
  registries.installationRegistry.register({
    definition: developmentProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, graph, outputRepository };
}
