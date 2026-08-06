/**
 * Product Delivery lifecycle composition root.
 *
 * Cross-module runtime mechanics are constructed once here. Each workshop
 * contributes its declaration, handlers and adapters through register<Name>().
 */

import type Database from 'better-sqlite3';
import type {
  WorkAssignmentPort,
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';
import type { FactoryDiscoveryRuntimePersistence } from '../modules/discovery/infrastructure/discovery-runtime-port.js';
import { SqliteFactoryDiscoveryRuntime } from '../modules/discovery/infrastructure/sqlite-discovery-runtime.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../process-modules/application/handlers/process-outcome-emitter.js';
import { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import { LifecycleOrchestrationEngineAdapter } from '../process-modules/application/lifecycle-orchestration-engine-adapter.js';
import { LifecycleOrchestrator } from '../process-modules/application/lifecycle-orchestrator.js';
import type {
  NodeExecutor,
  NodeProducts,
} from '../process-modules/application/node-executor.js';
import { HumanNodeExecutor } from '../process-modules/application/node-executors/human-node-executor.js';
import { KernelNodeExecutor } from '../process-modules/application/node-executors/kernel-node-executor.js';
import { LmNodeExecutor } from '../process-modules/application/node-executors/lm-node-executor.js';
import { receiptAwareLmPersistence } from '../process-modules/application/node-executors/receipt-aware-lm-persistence.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { lifecycleInputPolicyValidation } from '../infrastructure/process-modules/lifecycle-input-policy-validation.js';
import {
  canonicalizeProductDeliveryLifecycleInput,
  resolveProductDeliveryRepositories,
  resolveProductDeliveryStageInput,
} from './product-lifecycle-repository-bindings.js';
import { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { ProductionInstallation } from '../process-modules/installation/production-install.js';
import type { ResolveStageOutputPayload } from '../process-modules/application/lifecycle-orchestrator.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { lifecycleRefKey } from '../process-modules/persistence/lifecycle-run.js';
import { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteManagedProductionLedger } from '../process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteProcessProductRepository } from '../process-modules/persistence/sqlite-process-product-repository.js';
import { SqliteProcessProductRepositoryV2 } from '../process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteWorkplaceProductAdapter } from '../process-modules/persistence/sqlite-workplace-product-adapter.js';
import { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import { SqliteExactCandidateAcceptance } from '../process-modules/persistence/sqlite-exact-candidate-acceptance.js';
import { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';
import { SqliteWorkAssignmentAdapter } from '../infrastructure/work/sqlite-work-assignment-adapter.js';
import { createDiscoveryLmNodePersistence } from '../modules/discovery/application/discovery-installation.js';
import { createFormalizationLifecycleOutputPayloadResolver } from '../modules/formalization/application/formalization-installation.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../modules/formalization/domain/formalization-schemas.js';
import { createDevelopmentOutputPayloadResolver } from '../modules/development/application/development-installation.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../modules/development/domain/development-schemas.js';
import { createDeliveryOutputPayloadResolver } from '../modules/delivery/application/delivery-installation.js';
import { RELEASE_RECORD_SCHEMA } from '../modules/delivery/domain/delivery-schemas.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';
import { registerDiscovery } from '../modules/discovery/index.js';
import { registerFormalization } from '../modules/formalization/index.js';
import { registerDevelopment } from '../modules/development/index.js';
import { promoteTaskToDone } from '../lifecycle/work-assignment-core.js';
import { registerDelivery } from '../modules/delivery/index.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../modules/module-registration.js';
import type { DevelopmentCompositionDependencies } from '../modules/development/index.js';
import type {
  DeliveryCompositionDependencies,
  DeliveryProviderConfiguration,
} from '../modules/delivery/index.js';
import { SqliteResumeDirectiveRepository } from '../checkpoints/sqlite-resume-directive-repository.js';

export type { DevelopmentCompositionDependencies };
export type {
  DeliveryCompositionDependencies,
  DeliveryProviderConfiguration,
};

export interface ProductLifecycleRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number | null;
  }) => WorkerExecutorFactoryContext;
  concurrency?: number;
  workAssignment?: WorkAssignmentPort;
  development?: DevelopmentCompositionDependencies;
  delivery: DeliveryCompositionDependencies;
  db?: Database.Database;
  discoveryRuntimePersistence?: FactoryDiscoveryRuntimePersistence;
  packageInstallation?: ProductionInstallation;
  onLifecycleStarted?: (
    run: import('../process-modules/persistence/lifecycle-run.js').LifecycleRunRecord,
  ) => Promise<void> | void;
}

export function createProductLifecycleRuntime(
  options: ProductLifecycleRuntimeOptions,
) {
  assertCompositionDependencies(options);
  const db = options.db ?? getDb();

  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const recoveryCaseRepo = new SqliteRecoveryCaseRepository(db);
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const processProductRepo = new SqliteProcessProductRepository(db);
  const processProductRepoV2 = new SqliteProcessProductRepositoryV2(db);
  const workplaceProductPort = new SqliteWorkplaceProductAdapter(
    db,
    processProductRepoV2,
  );

  const lookupProduction = db.prepare(
    `SELECT output_schema AS schema, output_ref AS ref, output_hash AS hash,
            output_bindings AS bindingsText
       FROM factory_node_runs
      WHERE output_schema=? AND output_ref=? AND output_hash=?
        AND status='completed'
      LIMIT 1`,
  );
  const assemblerProductRepo = {
    getByProductRef: (ref: ProductRef) => {
      const product = workplaceProductPort.readProduct(ref);
      if (product !== null) {
        return {
          productRef: {
            schemaId: product.schema,
            ref: ref.ref,
            digest: product.contentHash,
          },
          payload: product.content,
        };
      }

      const nodeProduction = lookupProduction.get(
        ref.schemaId,
        ref.ref,
        ref.digest,
      ) as {
        schema: string | null;
        ref: string | null;
        hash: string | null;
        bindingsText: string | null;
      } | undefined;
      if (
        nodeProduction === undefined
        || nodeProduction.schema === null
        || nodeProduction.ref === null
        || nodeProduction.hash === null
      ) {
        if (ref.schemaId === 'factory.recovery-feedback.v1') {
          try {
            const recoveryRow = db.prepare(
              `SELECT feedback_snapshot, feedback_hash
                 FROM factory_recovery_attempts
                WHERE issue_ref=?
                ORDER BY attempt DESC
                LIMIT 1`,
            ).get(ref.ref) as {
              feedback_snapshot: string;
              feedback_hash: string;
            } | undefined;
            if (recoveryRow) {
              return {
                productRef: ref,
                payload: {
                  schema: ref.schemaId,
                  artifactRef: ref.ref,
                  contentHash: recoveryRow.feedback_hash,
                  bindings: JSON.parse(
                    recoveryRow.feedback_snapshot || '{}',
                  ),
                },
              };
            }
          } catch {
            // The recovery table may not exist for a fresh database.
          }
        }
        return null;
      }

      const bindings = nodeProduction.bindingsText
        ? JSON.parse(nodeProduction.bindingsText)
        : {};
      return {
        productRef: {
          schemaId: nodeProduction.schema,
          ref: nodeProduction.ref,
          digest: nodeProduction.hash,
        },
        payload: {
          schema: nodeProduction.schema,
          artifactRef: nodeProduction.ref,
          contentHash: nodeProduction.hash,
          bindings,
        },
      };
    },
  };

  const packageInstallation = options.packageInstallation;
  const resolvePackagePin = (moduleName: string): {
    packageIdentity: { name: string; version: string };
    installedDigest: string;
    flowIdentity: { flowId: string; flowVersion: string };
  } | null => {
    if (!packageInstallation) return null;
    const record = packageInstallation.records.get(moduleName);
    if (!record) return null;
    return {
      packageIdentity: { name: moduleName, version: record.version },
      installedDigest: record.packageDigest,
      flowIdentity: { flowId: moduleName, flowVersion: record.version },
    };
  };
  const executorV2Options = { productRepo: assemblerProductRepo, resolvePackagePin };

  const runtimePersistence = options.discoveryRuntimePersistence
    ?? new SqliteFactoryDiscoveryRuntime();
  const lmPersistence = receiptAwareLmPersistence(
    createDiscoveryLmNodePersistence(runtimePersistence),
    db,
  );
  const managedNodeSubmissions =
    new SqliteManagedNodeSubmissionRepository(db);
  const exactCandidateAcceptance = new SqliteExactCandidateAcceptance(db);
  const centralLedger = new SqliteManagedProductionLedger(db);

  const resolveNodeProducts = (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): NodeProducts | null => {
    const artifacts = centralLedger.listArtifactsForNodeInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
    );
    const traces = centralLedger.listTracesForNodeInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
    );
    const submission = managedNodeSubmissions.readLatestForNode(
      processRunId,
      moduleRef,
      nodeId,
    );
    if (artifacts.length === 0 && traces.length === 0 && submission === null) {
      return null;
    }
    return {
      artifacts: artifacts
        .filter((artifact): artifact is typeof artifact & { contentHash: string } =>
          artifact.contentHash !== null)
        .map(artifact => ({
          ledgerId: artifact.ledgerId,
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          artifactStatus: artifact.artifactStatus,
          contentHash: artifact.contentHash,
          operation: artifact.operation,
        })),
      traces: traces.map(trace => ({
        ledgerId: trace.ledgerId,
        traceId: trace.traceId,
        sourceId: trace.sourceId,
        targetType: trace.targetType,
        targetId: trace.targetId,
        linkType: trace.linkType,
        traceHash: trace.traceHash,
      })),
      submission,
    };
  };

  const kernelHandlers = new KernelHandlerRegistry();
  kernelHandlers.register(
    PROCESS_OUTCOME_EMITTER_HANDLER_ID,
    processOutcomeEmitter,
  );
  const humanInteractions = new HumanInteractionRegistry();
  const moduleRegistry = new ProcessModuleRegistry();
  const installationRegistry = new ProcessModuleInstallationRegistry({
    kernelHandlerRegistry: kernelHandlers,
    humanInteractionRegistry: humanInteractions,
  });

  const nodeExecutors = new Map<string, NodeExecutor>([
    ['kernel', new KernelNodeExecutor(
      kernelHandlers,
      exactCandidateAcceptance,
    )],
    ['lm', new LmNodeExecutor({
      persistence: lmPersistence,
      workerExecutorFactory: options.workerExecutorFactory,
      resolveWorkerContext: options.resolveWorkerContext,
      workAssignment:
        options.workAssignment ?? new SqliteWorkAssignmentAdapter(db),
    })],
    ['human', new HumanNodeExecutor(humanInteractions)],
  ]);

  const sharedDeps: ModuleSharedDeps = {
    db,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    recoveryCaseRepo,
    managedNodeSubmissions,
    processProductRepo,
    nodeExecutors,
    resolveNodeProducts,
    executorV2Options,
    runtimePersistence,
    exactCandidateAcceptance,
    workplaceProductPort,
    adoptedNodeResults: new SqliteResumeDirectiveRepository(db),

    onWorkplaceVerified: (processRunId, repairNodeId) => {
      const generationKey =
        `process-run:${processRunId}:node:${repairNodeId}`;
      const taskRow = db.prepare(
        `SELECT id
           FROM tasks
          WHERE generation_key=?
            AND current_execution_id IS NULL
            AND status IN (
              'todo','in_progress','review','review_in_progress','done'
            )
          ORDER BY id DESC
          LIMIT 1`,
      ).get(generationKey) as { id: number } | undefined;
      if (taskRow) promoteTaskToDone(db, taskRow.id);
    },
  };
  const registries: ModuleRegistries = {
    kernelHandlers,
    humanInteractions,
    moduleRegistry,
    installationRegistry,
  };

  const discoveryExecutor = registerDiscovery(registries, sharedDeps);
  const formalization = registerFormalization(registries, sharedDeps);
  const development = registerDevelopment(
    registries,
    sharedDeps,
    options.development ?? {},
  );
  const delivery = registerDelivery(
    registries,
    sharedDeps,
    options.delivery,
  );

  const resolversBySchema = new Map<string, ResolveStageOutputPayload>([
    [
      SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      createFormalizationLifecycleOutputPayloadResolver(
        formalization.solutionContractRepository,
      ),
    ],
    [
      VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      createDevelopmentOutputPayloadResolver(development.outputRepository),
    ],
    [
      RELEASE_RECORD_SCHEMA,
      createDeliveryOutputPayloadResolver(delivery.outputRepository),
    ],
  ]);
  const resolveOutputPayload: ResolveStageOutputPayload = async params => {
    const resolver = resolversBySchema.get(params.output.schema);
    if (!resolver) {
      throw new Error(
        `no output payload resolver for schema ${params.output.schema}`,
      );
    }
    return resolver(params);
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    onLifecycleStarted: options.onLifecycleStarted,
    processRunRepo,
    moduleRegistry,
    installationRegistry,
    resolveOutputPayload,
    resolveStageInput: ({ lifecycleRun, stage, input }) =>
      resolveProductDeliveryStageInput(db, {
        projectId: lifecycleRun.projectId,
        stage,
        input,
      }),
    ...(packageInstallation
      ? {
        resolveModuleInstallation: (moduleRef: {
          name: string;
          version: string;
        }) => {
          const record = packageInstallation.records.get(moduleRef.name);
          if (!record) {
            process.stderr.write(
              `[factory] resolveModuleInstallation: no record for '${moduleRef.name}'. `
              + `Available: ${[...packageInstallation.records.keys()].join(', ')}\n`,
            );
            return null;
          }
          return {
            installationId: record.id,
            packageDigest: record.packageDigest,
          };
        },
      }
      : {
        resolveModuleInstallation: () => {
          process.stderr.write(
            '[factory] resolveModuleInstallation: packageInstallation is undefined/null\n',
          );
          return null;
        },
      }),
  });

  const engine = new LifecycleOrchestrationEngineAdapter({
    definition: productDeliveryLifecycle,
    orchestrator,
    resolveInput(command) {
      let lifecycleInput = command.lifecycleInput;
      if (lifecycleInput === undefined) {
        if (!command.resumePaused) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: pass RunEpisodeCommand.lifecycleInput',
          );
        }
        const idempotencyKey = command.idempotencyKey
          ?? `product-delivery:epic:${command.epicId}`;
        const existing = lifecycleRunRepo.readByIdempotencyKey(
          command.projectId,
          lifecycleRefKey(productDeliveryLifecycle.identity),
          idempotencyKey,
        );
        if (!existing || existing.inputSnapshot === null) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: resume launch was requested but no durable '
            + `LifecycleRun input is persisted for idempotency key '${idempotencyKey}'`,
          );
        }
        lifecycleInput = JSON.parse(existing.inputSnapshot) as unknown;
      }

      const schema = command.lifecycleInputSchema
        ?? PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA;
      if (schema !== PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA) {
        throw new Error(
          `PRODUCT_LIFECYCLE_INPUT_SCHEMA_MISMATCH: expected `
          + `'${PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA}', got '${schema}'`,
        );
      }
      assertProductDeliveryLifecycleInput(
        lifecycleInput,
        lifecycleInputPolicyValidation,
      );
      const portableInput = canonicalizeProductDeliveryLifecycleInput(
        db,
        command.projectId,
        lifecycleInput,
      );
      resolveProductDeliveryRepositories(
        db,
        command.projectId,
        portableInput.development.repositories,
      );
      return {
        schema,
        payload: portableInput,
        initiatedBy:
          command.initiatedBy ?? 'product-lifecycle-orchestrator',
        idempotencyKey:
          command.idempotencyKey
          ?? `product-delivery:epic:${command.epicId}`,
        resumePaused: command.resumePaused,
      };
    },
  });

  return {
    engine,
    orchestrator,
    moduleRegistry,
    installationRegistry,
    resolveOutputPayload,
    kernelHandlers,
    humanInteractions,
    executors: {
      discovery: discoveryExecutor,
      formalization: formalization.executor,
      development: development.executor,
      delivery: delivery.executor,
    },
    packageInstallation,
    runtimes: {
      development: development.graph,
      delivery: delivery.runtime,
    },
    interactions: {
      deliveryApprovalInbox: delivery.approvalInbox,
    },
    repositories: {
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      lifecycleRunRepo,
      managedNodeSubmissions,
      formalizationBaselineRepository: formalization.baselineRepository,
      formalizationSolutionContractRepository:
        formalization.solutionContractRepository,
      developmentOutputRepository: development.outputRepository,
      deliveryOutputRepository: delivery.outputRepository,
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
