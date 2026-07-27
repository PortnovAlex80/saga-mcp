import type Database from 'better-sqlite3';
import type {
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../../application/ports/worker-executor.js';
import { getDb } from '../../db.js';
import type { Saga3DiscoveryRuntimePersistence } from '../../saga3/persistence/saga3-discovery-runtime-port.js';
import { SqliteSaga3DiscoveryRuntime } from '../../saga3/persistence/sqlite-saga3-discovery-runtime.js';
import { ExternalAdapterRegistry } from '../application/external-adapter-registry.js';
import { GenericFlowExecutor } from '../application/generic-flow-executor.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../application/handlers/process-outcome-emitter.js';
import { HumanInteractionRegistry } from '../application/human-interaction-registry.js';
import { KernelHandlerRegistry } from '../application/kernel-handler-registry.js';
import { LifecycleOrchestrationEngineAdapter } from '../application/lifecycle-orchestration-engine-adapter.js';
import { LifecycleOrchestrator } from '../application/lifecycle-orchestrator.js';
import type { NodeExecutor } from '../application/node-executor.js';
import { ExternalNodeExecutor } from '../application/node-executors/external-node-executor.js';
import { HumanNodeExecutor } from '../application/node-executors/human-node-executor.js';
import { KernelNodeExecutor } from '../application/node-executors/kernel-node-executor.js';
import { LmNodeExecutor } from '../application/node-executors/lm-node-executor.js';
import { ProcessOutputPayloadRegistry } from '../application/process-output-payload-registry.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} from '../lifecycles/product-delivery-lifecycle.js';
import { createBuiltInProcessModuleRegistry } from '../modules/catalog.js';
import {
  createDeliveryExternalAdapters,
  createDeliveryHumanInteractions,
  createDeliveryKernelHandlers,
  createDeliveryOutputPayloadResolver,
  createDeliveryOutputResolver,
} from '../modules/delivery/delivery-installation.js';
import type {
  DeliveryApprovalPort,
  DeliveryObservationPort,
  DeliveryPreflightStatePort,
  DeliveryPublicationPort,
  DeliverySettlementStatePort,
  DeliveryModuleInstallationDependencies,
  DeliveryOutputRepository,
} from '../modules/delivery/delivery-kernel-ports.js';
import type {
  DeliveryApprovalSource,
  DeliveryRuntimeProviders,
} from '../modules/delivery/delivery-provider-ports.js';
import { SqliteDeliveryOutputRepository } from '../modules/delivery/delivery-persistence.js';
import { deliveryProcessModule } from '../modules/delivery/delivery-process-module.js';
import { RELEASE_RECORD_SCHEMA } from '../modules/delivery/delivery-schemas.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../modules/delivery/delivery-settlement-policy.js';
import { SqliteDeliveryApprovalInbox } from '../modules/delivery/sqlite-delivery-approval-inbox.js';
import { SqliteDeliveryRuntime } from '../modules/delivery/sqlite-delivery-runtime.js';
import {
  createDevelopmentExternalAdapters,
  createDevelopmentKernelHandlers,
  createDevelopmentOutputPayloadResolver,
  createDevelopmentOutputResolver,
} from '../modules/development/development-installation.js';
import type {
  DevelopmentAcceptanceVerificationPort,
  DevelopmentCandidateIntegrationPort,
  DevelopmentImplementationWorksetPort,
  DevelopmentModuleInstallationDependencies,
  DevelopmentOutputRepository,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
} from '../modules/development/development-kernel-ports.js';
import { SqliteDevelopmentOutputRepository } from '../modules/development/development-persistence.js';
import { developmentProcessModule } from '../modules/development/development-process-module.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../modules/development/development-schemas.js';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../modules/development/development-settlement-policy.js';
import {
  SqliteDevelopmentRuntime,
  type SqliteDevelopmentRuntimeOptions,
} from '../modules/development/sqlite-development-runtime.js';
import {
  createDiscoveryKernelHandlers,
  createDiscoveryLmNodePersistence,
} from '../modules/discovery/discovery-installation.js';
import { discoveryProcessModule } from '../modules/discovery/discovery-process-module.js';
import {
  createFormalizationKernelHandlers,
  createFormalizationLifecycleOutputPayloadResolver,
  createFormalizationOutputResolver,
} from '../modules/formalization/formalization-installation.js';
import {
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} from '../modules/formalization/formalization-persistence.js';
import { formalizationProcessModule } from '../modules/formalization/formalization-process-module.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../modules/formalization/formalization-schemas.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from '../modules/formalization/sqlite-formalization-kernel.js';
import { createBuiltInProcessModuleInstallationRegistry } from '../modules/installations.js';
import { SqliteLifecycleRunRepository } from '../persistence/sqlite-lifecycle-run-repository.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../persistence/sqlite-managed-node-submission-repository.js';
import { SqliteManagedProductionLedger } from '../persistence/sqlite-managed-production-ledger.js';
import { SqliteNodeRunRepository } from '../persistence/sqlite-node-run-repository.js';
import { SqliteProcessOutcomeCertificateRepository } from '../persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteProcessRunRepository } from '../persistence/sqlite-process-run-repository.js';

export interface DevelopmentCompositionDependencies {
  runtime?: SqliteDevelopmentRuntime;
  taskGraph?: DevelopmentTaskGraphPort;
  implementationWorkset?: DevelopmentImplementationWorksetPort;
  candidateIntegration?: DevelopmentCandidateIntegrationPort;
  acceptanceVerification?: DevelopmentAcceptanceVerificationPort;
  settlementState?: DevelopmentSettlementStatePort;
  taskGraphPolicy?: DevelopmentModuleInstallationDependencies['taskGraphPolicy'];
  settlementPolicy?: DevelopmentModuleInstallationDependencies['settlementPolicy'];
  outputRepository?: DevelopmentOutputRepository;
  runtimeOptions?: Omit<
    SqliteDevelopmentRuntimeOptions,
    'workerExecutorFactory' | 'resolveWorkerContext' | 'db'
  >;
}

export type DeliveryProviderConfiguration =
  Omit<DeliveryRuntimeProviders, 'approval'> & {
    approval?: DeliveryApprovalSource;
  };

export interface DeliveryCompositionDependencies {
  runtime?: SqliteDeliveryRuntime;
  providers?: DeliveryProviderConfiguration;
  approvalInbox?: SqliteDeliveryApprovalInbox;
  preflightState?: DeliveryPreflightStatePort;
  approval?: DeliveryApprovalPort;
  publication?: DeliveryPublicationPort;
  observation?: DeliveryObservationPort;
  settlementState?: DeliverySettlementStatePort;
  preflightPolicy?: DeliveryModuleInstallationDependencies['preflightPolicy'];
  settlementPolicy?: DeliveryModuleInstallationDependencies['settlementPolicy'];
  outputRepository?: DeliveryOutputRepository;
}

export interface ProductLifecycleRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number | null;
  }) => WorkerExecutorFactoryContext;
  development?: DevelopmentCompositionDependencies;
  delivery: DeliveryCompositionDependencies;
  db?: Database.Database;
  discoveryRuntimePersistence?: Saga3DiscoveryRuntimePersistence;
}

/**
 * Explicit composition for the complete product lifecycle.
 *
 * Runtime mechanics are shared. Module handlers/adapters are registrations.
 * Development's standard SQLite/task/Git adapter and all deterministic
 * policies are wired by default. Delivery's runtime mechanics and approval
 * inbox are also standard; only the actual preflight/publication/observation
 * providers remain explicit because composition must never fabricate an
 * external success or a human decision.
 */
export function createProductLifecycleRuntime(
  options: ProductLifecycleRuntimeOptions,
) {
  assertCompositionDependencies(options);
  const db = options.db ?? getDb();
  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const runtimePersistence = options.discoveryRuntimePersistence
    ?? new SqliteSaga3DiscoveryRuntime();
  const managedNodeSubmissions =
    new SqliteManagedNodeSubmissionRepository(db);

  const developmentConfig = options.development ?? {};
  const developmentRuntime = developmentConfig.runtime
    ?? new SqliteDevelopmentRuntime({
      workerExecutorFactory: options.workerExecutorFactory,
      resolveWorkerContext: context =>
        options.resolveWorkerContext(context),
      db,
      ...developmentConfig.runtimeOptions,
    });
  const developmentTaskGraphPolicy = developmentConfig.taskGraphPolicy
    ?? new ReferenceDevelopmentTaskGraphPolicy();
  const developmentOutputRepository = developmentConfig.outputRepository
    ?? new SqliteDevelopmentOutputRepository(db);
  const developmentDeps: DevelopmentModuleInstallationDependencies = {
    plannerSubmissions: managedNodeSubmissions,
    taskGraph: developmentConfig.taskGraph ?? developmentRuntime,
    implementationWorkset:
      developmentConfig.implementationWorkset ?? developmentRuntime,
    candidateIntegration:
      developmentConfig.candidateIntegration ?? developmentRuntime,
    acceptanceVerification:
      developmentConfig.acceptanceVerification ?? developmentRuntime,
    settlementState:
      developmentConfig.settlementState ?? developmentRuntime,
    taskGraphPolicy: developmentTaskGraphPolicy,
    settlementPolicy: developmentConfig.settlementPolicy
      ?? new ReferenceDevelopmentSettlementPolicy(
        developmentTaskGraphPolicy,
      ),
    outputRepository: developmentOutputRepository,
  };

  const deliveryConfig = options.delivery;
  const deliveryApprovalInbox = deliveryConfig.approvalInbox
    ?? new SqliteDeliveryApprovalInbox(db);
  const deliveryProviders: DeliveryRuntimeProviders | null =
    deliveryConfig.providers
      ? {
          ...deliveryConfig.providers,
          approval:
            deliveryConfig.providers.approval ?? deliveryApprovalInbox,
        }
      : null;
  const deliveryRuntime = deliveryConfig.runtime
    ?? (deliveryProviders
      ? new SqliteDeliveryRuntime({
        db,
        providers: deliveryProviders,
      })
      : null);
  const deliveryPreflightPolicy = deliveryConfig.preflightPolicy
    ?? new ReferenceDeliveryPreflightPolicy();
  const deliveryOutputRepository = deliveryConfig.outputRepository
    ?? new SqliteDeliveryOutputRepository(db);
  const deliveryDeps: DeliveryModuleInstallationDependencies = {
    preflightState: requireDeliveryPort(
      deliveryConfig.preflightState ?? deliveryRuntime,
      'preflightState',
    ),
    approval: requireDeliveryPort(
      deliveryConfig.approval ?? deliveryRuntime,
      'approval',
    ),
    publication: requireDeliveryPort(
      deliveryConfig.publication ?? deliveryRuntime,
      'publication',
    ),
    observation: requireDeliveryPort(
      deliveryConfig.observation ?? deliveryRuntime,
      'observation',
    ),
    settlementState: requireDeliveryPort(
      deliveryConfig.settlementState ?? deliveryRuntime,
      'settlementState',
    ),
    preflightPolicy: deliveryPreflightPolicy,
    settlementPolicy: deliveryConfig.settlementPolicy
      ?? new ReferenceDeliverySettlementPolicy(deliveryPreflightPolicy),
    outputRepository: deliveryOutputRepository,
  };

  const formalizationBaselineRepository =
    new SqliteFormalizationBaselineRepository(db);
  const formalizationSolutionContractRepository =
    new SqliteFormalizationSolutionContractRepository(db);
  const formalizationGraph = new SqliteFormalizationArtifactGraph(db);
  const formalizationLedger = new SqliteManagedProductionLedger(db);

  const kernelHandlers = new KernelHandlerRegistry();
  kernelHandlers.register(
    PROCESS_OUTCOME_EMITTER_HANDLER_ID,
    processOutcomeEmitter,
  );
  kernelHandlers.registerAll(createDiscoveryKernelHandlers({
    runtimePersistence,
  }));
  kernelHandlers.registerAll(createFormalizationKernelHandlers({
    ledger: formalizationLedger,
    graph: formalizationGraph,
    baselineRepository: formalizationBaselineRepository,
    solutionContractRepository: formalizationSolutionContractRepository,
    settlementPolicy: new ReferenceFormalizationSettlementPolicy(),
  }));
  kernelHandlers.registerAll(createDevelopmentKernelHandlers(developmentDeps));
  kernelHandlers.registerAll(createDeliveryKernelHandlers(deliveryDeps));

  const externalAdapters = new ExternalAdapterRegistry();
  externalAdapters.registerAll(
    createDevelopmentExternalAdapters(developmentDeps),
  );
  externalAdapters.registerAll(createDeliveryExternalAdapters(deliveryDeps));

  const humanInteractions = new HumanInteractionRegistry();
  humanInteractions.registerAll(createDeliveryHumanInteractions(deliveryDeps));

  const nodeExecutors = new Map<string, NodeExecutor>([
    ['kernel', new KernelNodeExecutor(kernelHandlers)],
    ['lm', new LmNodeExecutor({
      persistence: createDiscoveryLmNodePersistence(runtimePersistence),
      workerExecutorFactory: options.workerExecutorFactory,
      resolveWorkerContext: options.resolveWorkerContext,
    })],
    ['external', new ExternalNodeExecutor(externalAdapters)],
    ['human', new HumanNodeExecutor(humanInteractions)],
  ]);

  const executors = {
    discovery: new GenericFlowExecutor({
      moduleRef: discoveryProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
    }),
    formalization: new GenericFlowExecutor({
      moduleRef: formalizationProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      resolveOutput: createFormalizationOutputResolver(
        formalizationSolutionContractRepository,
      ),
    }),
    development: new GenericFlowExecutor({
      moduleRef: developmentProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      resolveOutput: createDevelopmentOutputResolver(
        developmentOutputRepository,
      ),
    }),
    delivery: new GenericFlowExecutor({
      moduleRef: deliveryProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      resolveOutput: createDeliveryOutputResolver(deliveryOutputRepository),
    }),
  };

  const moduleRegistry = createBuiltInProcessModuleRegistry();
  const installationRegistry =
    createBuiltInProcessModuleInstallationRegistry([
      { definition: discoveryProcessModule, executor: executors.discovery },
      {
        definition: formalizationProcessModule,
        executor: executors.formalization,
      },
      { definition: developmentProcessModule, executor: executors.development },
      { definition: deliveryProcessModule, executor: executors.delivery },
    ], {
      kernelHandlerRegistry: kernelHandlers,
      externalAdapterRegistry: externalAdapters,
      humanInteractionRegistry: humanInteractions,
    });

  const outputPayloadRegistry = new ProcessOutputPayloadRegistry();
  outputPayloadRegistry.register(
    SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
    createFormalizationLifecycleOutputPayloadResolver(
      formalizationSolutionContractRepository,
    ),
  );
  outputPayloadRegistry.register(
    VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
    createDevelopmentOutputPayloadResolver(developmentOutputRepository),
  );
  outputPayloadRegistry.register(
    RELEASE_RECORD_SCHEMA,
    createDeliveryOutputPayloadResolver(deliveryOutputRepository),
  );

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    processRunRepo,
    moduleRegistry,
    installationRegistry,
    outputPayloadRegistry,
  });
  const engine = new LifecycleOrchestrationEngineAdapter({
    definition: productDeliveryLifecycle,
    orchestrator,
    resolveInput(command) {
      if (command.lifecycleInput === undefined) {
        throw new Error(
          'PRODUCT_LIFECYCLE_INPUT_REQUIRED: pass RunEpisodeCommand.lifecycleInput',
        );
      }
      const schema = command.lifecycleInputSchema
        ?? PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA;
      if (schema !== PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA) {
        throw new Error(
          `PRODUCT_LIFECYCLE_INPUT_SCHEMA_MISMATCH: expected `
          + `'${PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA}', got '${schema}'`,
        );
      }
      assertProductDeliveryLifecycleInput(command.lifecycleInput);
      return {
        schema,
        payload: command.lifecycleInput,
        initiatedBy: command.initiatedBy ?? 'product-lifecycle-orchestrator',
        idempotencyKey:
          command.idempotencyKey ?? `product-delivery:epic:${command.epicId}`,
        resumePaused: command.resumePaused,
      };
    },
  });

  return {
    engine,
    orchestrator,
    moduleRegistry,
    installationRegistry,
    outputPayloadRegistry,
    kernelHandlers,
    externalAdapters,
    humanInteractions,
    executors,
    runtimes: {
      development: developmentRuntime,
      delivery: deliveryRuntime,
    },
    interactions: {
      deliveryApprovalInbox,
    },
    repositories: {
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      lifecycleRunRepo,
      managedNodeSubmissions,
      formalizationBaselineRepository,
      formalizationSolutionContractRepository,
      developmentOutputRepository,
      deliveryOutputRepository,
    },
  };
}

function assertCompositionDependencies(
  options: ProductLifecycleRuntimeOptions,
): void {
  const missing: string[] = [];
  if (!options.delivery) missing.push('delivery');
  if (!options.workerExecutorFactory) missing.push('workerExecutorFactory');
  if (!options.resolveWorkerContext) missing.push('resolveWorkerContext');
  if (missing.length > 0) {
    throw new Error(
      `PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: ${missing.join(', ')}`,
    );
  }
}

function requireDeliveryPort<T>(
  port: T | null | undefined,
  name: string,
): T {
  if (port) return port;
  throw new Error(
    `PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: delivery.${name}; `
    + 'provide a complete Delivery port set, a SqliteDeliveryRuntime, or '
    + 'delivery.providers for the standard runtime',
  );
}
