/** Development module registration. */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import { registerWorkshopCheckProvider } from '../../process-modules/application/workshop-capability-manifest.js';
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
  createDevelopmentReplanGraphCheckProvider,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
} from './application/development-check-providers.js';
import { developmentProcessModule } from '../../process-modules/modules/development/development-process-module.js';
import {
  DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
  developmentContinuationProcessModule,
  DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF,
  developmentReplanContinuationProcessModule,
} from '../../process-modules/modules/development/development-continuation-process-module.js';
import { createDevelopmentContinuationTaskGraphHandler } from './infrastructure/development-continuation-installation.js';
import { supersedeRemainingCycleTasks } from './application/replan-supersede.js';
import {
  DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
  developmentVerificationContinuationProcessModule,
} from '../../process-modules/modules/development/development-verification-continuation-process-module.js';
import { createDevelopmentVerificationAdoptionHandler } from './infrastructure/sqlite-development-verification-adoption.js';
import { installAccessibleCounterCheckProviders } from '../../infrastructure/verification/accessible-counter-check-providers.js';
import {
  createLocalRunnabilityCheckProvider,
  ensureLocalRunnabilityProviderTrust,
} from '../../infrastructure/verification/local-runnability-check-provider.js';
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
      developmentReplanContinuationProcessModule.identity,
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

  registerWorkshopCheckProvider(createDevelopmentTaskGraphCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
    taskGraphPolicy,
  }));
  registerWorkshopCheckProvider(createDevelopmentImplementationScopeCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
    git,
  }));
  // RE-PLAN CYCLE (REPLAN-CYCLE-TZ §2) — the cycle-2 planner gate check
  // (parallelism anti-pattern + shared-surface extraction). Inert outside
  // replan continuation runs.
  registerWorkshopCheckProvider(createDevelopmentReplanGraphCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  // ADR-053 Phase 1: payload contracts are installed from the single workshop
  // capability manifest by the orchestrator composition root, not per-module.
  registerWorkshopCheckProvider(options.verificationCheckProviderFactory
    ? options.verificationCheckProviderFactory({
      db,
      candidateSets: sharedDeps.candidateSetRepo,
    })
    : createDevelopmentVerificationCheckProvider({
      db,
      candidateSets: sharedDeps.candidateSetRepo,
    }));
  const verificationTrust = db.prepare(
    `SELECT id,version,trust_basis,category,determinism,status
       FROM trusted_providers WHERE project_id IS NULL AND name=?`,
  ).all(DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID) as Array<{
    id: number; version: string | null; trust_basis: string;
    category: string; determinism: string; status: string;
  }>;
  const expectedVerificationTrust = `built-in:${DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST}`;
  if (verificationTrust.length === 0) {
    db.prepare(
      `INSERT INTO trusted_providers
        (project_id,name,version,category,trust_basis,determinism,scope,status)
       VALUES (NULL,?,?,'deterministic_evidence',?,'full','verification-lineage','active')`,
    ).run(
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
      expectedVerificationTrust,
    );
  } else if (verificationTrust.length !== 1
      || verificationTrust[0]!.version !== DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION
      || verificationTrust[0]!.trust_basis !== expectedVerificationTrust
      || verificationTrust[0]!.category !== 'deterministic_evidence'
      || verificationTrust[0]!.determinism !== 'full'
      || verificationTrust[0]!.status !== 'active') {
    throw new Error('DEVELOPMENT_VERIFICATION_PROVIDER_TRUST_DRIFT');
  }
  registerWorkshopCheckProvider(createReviewVerdictCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  ensureLocalRunnabilityProviderTrust(db);
  registerWorkshopCheckProvider(createLocalRunnabilityCheckProvider({
    db,
    candidateSets: sharedDeps.candidateSetRepo,
  }));
  for (const provider of installAccessibleCounterCheckProviders(
    db,
    sharedDeps.candidateSetRepo,
  )) registerWorkshopCheckProvider(provider);
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
    transitionObligations: sharedDeps.transitionObligations,
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
    transitionObligations: sharedDeps.transitionObligations,
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
    transitionObligations: sharedDeps.transitionObligations,
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

  // RE-PLAN CYCLE (REPLAN-CYCLE-TZ §4+§5) — the cycle-2 resolver wraps the
  // standard resolveTaskGraph handler: remaining cycle-1 tasks are superseded
  // (metadata.$.superseded_by + cancelled cards + drained projections) in the
  // SAME kernel step that materializes the cycle-2 graph, so zero cycle-1
  // workers can wake beside cycle 2.
  const replanHandlers = createVersionedDevelopmentKernelHandlers(
    deps,
    DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF,
  );
  const replanResolver = replanHandlers[DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph];
  if (!replanResolver) {
    throw new Error('DEVELOPMENT_REPLAN_RESOLVER_INCOMPLETE');
  }
  registries.kernelHandlers.register(
    DEVELOPMENT_KERNEL_HANDLER_IDS.resolveReplanTaskGraph,
    ctx => {
      const replanContext = (ctx.frame.runInput as { replanContext?: { cycle1ProcessRunId?: unknown } })
        ?.replanContext;
      const cycle1ProcessRunId = Number(replanContext?.cycle1ProcessRunId);
      if (!Number.isInteger(cycle1ProcessRunId) || cycle1ProcessRunId <= 0) {
        throw new Error('DEVELOPMENT_REPLAN_CYCLE1_RUN_INVALID: the cycle-2 case must carry replanContext.cycle1ProcessRunId');
      }
      supersedeRemainingCycleTasks(db, {
        cycle1ProcessRunId,
        cycle2RunId: ctx.processRunId,
      });
      return replanResolver(ctx);
    },
  );

  // RE-PLAN CYCLE (REPLAN-CYCLE-TZ §4) — the cycle-2 continuation variant:
  // enters through the 'replan-task-graph' planner cell; kernel handlers are
  // the already-registered development handlers (the resolver node references
  // the standard resolveTaskGraph handler id).
  const replanContinuationExecutor = new GenericFlowExecutor({
    moduleRef: developmentReplanContinuationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    transitionObligations: sharedDeps.transitionObligations,
    nodeExecutors: sharedDeps.nodeExecutors,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createVersionedDevelopmentOutputResolver(
      outputRepository,
      DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF,
    ),
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
    v2: sharedDeps.executorV2Options,
  });
  registries.moduleRegistry.register(developmentReplanContinuationProcessModule);
  registries.installationRegistry.register({
    definition: developmentReplanContinuationProcessModule,
    executor: replanContinuationExecutor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, graph, outputRepository };
}
