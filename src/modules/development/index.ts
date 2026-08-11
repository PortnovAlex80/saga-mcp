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
  createDevelopmentImplementationScopeCheckProvider,
  createDevelopmentVerificationCheckProvider,
  developmentReviewVerdictPayloadContract,
  developmentVerificationPayloadContract,
} from './application/development-check-providers.js';
import { registerProductPayloadContract } from '../../process-modules/application/product-payload-contract.js';
import { developmentProcessModule } from '../../process-modules/modules/development/development-process-module.js';
import {
  DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
  developmentContinuationProcessModule,
} from '../../process-modules/modules/development/development-continuation-process-module.js';
import { createDevelopmentContinuationTaskGraphHandler } from './infrastructure/development-continuation-installation.js';
import {
  DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
  developmentVerificationContinuationProcessModule,
} from '../../process-modules/modules/development/development-verification-continuation-process-module.js';
import { createDevelopmentVerificationAdoptionHandler } from './infrastructure/sqlite-development-verification-adoption.js';
import { installAccessibleCounterCheckProviders } from '../../infrastructure/verification/accessible-counter-check-providers.js';
import {
  createDevelopmentKernelHandlers as createVersionedDevelopmentKernelHandlers,
  createDevelopmentOutputResolver as createVersionedDevelopmentOutputResolver,
} from './application/development-installation.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from './domain/development-kernel-ports.js';
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
  /**
   * Override the verification check provider. The default provider always
   * returns 'unknown' for LM-authored assessments (by design — an LM
   * "passed" cannot become Factory acceptance without an independent
   * candidate-check receipt). Tests that use scripted workers may inject
   * a factory that builds a provider trusting the assessment contract when
   * the product is well-formed, bypassing the independent-receipt requirement.
   */
  verificationCheckProviderFactory?: (deps: {
    db: ModuleSharedDeps['db'];
    candidateSets: ModuleSharedDeps['candidateSetRepo'];
  }) => ReturnType<typeof createDevelopmentVerificationCheckProvider>;
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
    ?? new SqliteDevelopmentOutputRepository(db, [
      developmentProcessModule.identity,
      developmentContinuationProcessModule.identity,
      developmentVerificationContinuationProcessModule.identity,
    ]);
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
  registerFactoryCheckProvider(createDevelopmentImplementationScopeCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
    git,
  }));
  registerProductPayloadContract(developmentVerificationPayloadContract);
  registerProductPayloadContract(developmentReviewVerdictPayloadContract);
  registerFactoryCheckProvider(options.verificationCheckProviderFactory
    ? options.verificationCheckProviderFactory({
      db,
      candidateSets: sharedDeps.candidateSetRepo,
    })
    : createDevelopmentVerificationCheckProvider({
      db,
      candidateSets: sharedDeps.candidateSetRepo,
    }));
  registerFactoryCheckProvider(createReviewVerdictCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  for (const provider of installAccessibleCounterCheckProviders(
    db,
    sharedDeps.candidateSetRepo,
  )) registerFactoryCheckProvider(provider);
  registries.kernelHandlers.registerAll(createDevelopmentKernelHandlers(deps));
  const continuationHandlers = createVersionedDevelopmentKernelHandlers(
    deps,
    DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
  );
  const continuationFreeze = continuationHandlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate
  ];
  const continuationSettle = continuationHandlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.settle
  ];
  if (!continuationFreeze || !continuationSettle) {
    throw new Error('DEVELOPMENT_CONTINUATION_HANDLERS_INCOMPLETE');
  }
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.resolveContinuationTaskGraph,
    createDevelopmentContinuationTaskGraphHandler(db, deps),
  );
  const verificationContinuationHandlers = createVersionedDevelopmentKernelHandlers(
    deps,
    DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
  );
  const verificationContinuationSettle = verificationContinuationHandlers[
    DEVELOPMENT_KERNEL_HANDLER_IDS.settle
  ];
  if (!verificationContinuationSettle) {
    throw new Error('DEVELOPMENT_VERIFICATION_CONTINUATION_HANDLERS_INCOMPLETE');
  }
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.adoptVerificationBaseline,
    createDevelopmentVerificationAdoptionHandler(db, deps),
  );
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.settleVerificationContinuation,
    verificationContinuationSettle,
  );
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.freezeContinuationCandidate,
    continuationFreeze,
  );
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.settleContinuation,
    continuationSettle,
  );

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

  const verificationContinuationExecutor = new GenericFlowExecutor({
    moduleRef: developmentVerificationContinuationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createVersionedDevelopmentOutputResolver(
      outputRepository,
      DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
    ),
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });
  registries.moduleRegistry.register(developmentVerificationContinuationProcessModule);
  registries.installationRegistry.register({
    definition: developmentVerificationContinuationProcessModule,
    executor: verificationContinuationExecutor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  const continuationExecutor = new GenericFlowExecutor({
    moduleRef: developmentContinuationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createVersionedDevelopmentOutputResolver(
      outputRepository,
      DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
    ),
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });
  registries.moduleRegistry.register(developmentContinuationProcessModule);
  registries.installationRegistry.register({
    definition: developmentContinuationProcessModule,
    executor: continuationExecutor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, graph, outputRepository };
}
