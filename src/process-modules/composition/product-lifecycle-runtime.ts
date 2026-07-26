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
  DeliveryModuleInstallationDependencies,
  DeliveryOutputRepository,
} from '../modules/delivery/delivery-kernel-ports.js';
import { SqliteDeliveryOutputRepository } from '../modules/delivery/delivery-persistence.js';
import { deliveryProcessModule } from '../modules/delivery/delivery-process-module.js';
import { RELEASE_RECORD_SCHEMA } from '../modules/delivery/delivery-schemas.js';
import {
  createDevelopmentExternalAdapters,
  createDevelopmentKernelHandlers,
  createDevelopmentOutputPayloadResolver,
  createDevelopmentOutputResolver,
} from '../modules/development/development-installation.js';
import type {
  DevelopmentModuleInstallationDependencies,
  DevelopmentOutputRepository,
} from '../modules/development/development-kernel-ports.js';
import { SqliteDevelopmentOutputRepository } from '../modules/development/development-persistence.js';
import { developmentProcessModule } from '../modules/development/development-process-module.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../modules/development/development-schemas.js';
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

type DevelopmentCompositionDependencies =
  Omit<
    DevelopmentModuleInstallationDependencies,
    'outputRepository' | 'plannerSubmissions'
  > & {
    outputRepository?: DevelopmentOutputRepository;
  };

type DeliveryCompositionDependencies =
  Omit<DeliveryModuleInstallationDependencies, 'outputRepository'> & {
    outputRepository?: DeliveryOutputRepository;
  };

export interface ProductLifecycleRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number | null;
  }) => WorkerExecutorFactoryContext;
  development: DevelopmentCompositionDependencies;
  delivery: DeliveryCompositionDependencies;
  db?: Database.Database;
  discoveryRuntimePersistence?: Saga3DiscoveryRuntimePersistence;
}

/**
 * Explicit composition for the complete product lifecycle.
 *
 * Runtime mechanics are shared. Module handlers/adapters are registrations.
 * Development and Delivery provider/state ports are mandatory: the factory
 * never fabricates a Git, CI, deployment, observation or human authority.
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

  const developmentOutputRepository = options.development.outputRepository
    ?? new SqliteDevelopmentOutputRepository(db);
  const deliveryOutputRepository = options.delivery.outputRepository
    ?? new SqliteDeliveryOutputRepository(db);
  const developmentDeps: DevelopmentModuleInstallationDependencies = {
    ...options.development,
    plannerSubmissions: managedNodeSubmissions,
    outputRepository: developmentOutputRepository,
  };
  const deliveryDeps: DeliveryModuleInstallationDependencies = {
    ...options.delivery,
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
  const requiredDevelopment = [
    'taskGraph',
    'implementationWorkset',
    'candidateIntegration',
    'acceptanceVerification',
    'settlementState',
    'taskGraphPolicy',
    'settlementPolicy',
  ] as const;
  const requiredDelivery = [
    'preflightState',
    'approval',
    'publication',
    'observation',
    'settlementState',
    'preflightPolicy',
    'settlementPolicy',
  ] as const;
  for (const key of requiredDevelopment) {
    if (!options.development?.[key]) missing.push(`development.${key}`);
  }
  for (const key of requiredDelivery) {
    if (!options.delivery?.[key]) missing.push(`delivery.${key}`);
  }
  if (!options.workerExecutorFactory) missing.push('workerExecutorFactory');
  if (!options.resolveWorkerContext) missing.push('resolveWorkerContext');
  if (missing.length > 0) {
    throw new Error(
      `PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: ${missing.join(', ')}`,
    );
  }
}
