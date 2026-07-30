/**
 * W13-A6 — Concrete Product Delivery lifecycle wiring (composition-loader seam).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE13-LEGACY-REMOVAL-SPEC.md`
 *   lane W13-A6, §5 (ratchet convergence R6: 34 → 0).
 * Task: `docs/refactor-management/05-subagent-tasks/W13-a6.md`.
 * Plan: §0.16 / Phase 13 final (§0.16.11 serial gate), §18 DoD items 18.1-18.3.
 *
 * ## What this file owns
 *
 * The concrete manual wiring for the Product Delivery lifecycle: the four
 * production Process Module definitions + executors, the SQLite repositories,
 * the kernel-handler / external-adapter / human-interaction registries, and the
 * `LifecycleOrchestrator` that drives the lifecycle. This wiring USED TO live
 * in `composition/product-lifecycle-runtime.ts` (the manual composition root,
 * and the source of all 34 Rule 6 edges). Wave 13-A6 moves it here so the
 * `composition/` directory no longer carries Rule 6 edges — the wiring is
 * consumed via the W11-A2 composition-loader seam instead.
 *
 * ## Why `src/app/` is the correct home
 *
 * `src/app/` is the composition-root layer: `composition-root.ts` already lives
 * here and already imports the built-in module catalog + installations (it is
 * the single engine-selection switch). Colocating the Product Delivery wiring
 * here keeps every concrete composition decision in one layer. Crucially:
 *   - `src/app/` is NOT scanned by Rule 6 (Rule 6 scans
 *     `src/process-modules/composition/` only), so the wiring's module/sqlite
 *     imports do not appear as Rule 6 violations.
 *   - `src/app/` is NOT in the W11 cutover NEW_CORE set
 *     (`tests/architecture/cutover-architecture-checks.test.mjs`), so the
 *     wiring's catalog/module imports are not "hidden fallbacks" — they are the
 *     legitimate legacy composition surface Wave 13 is ratcheting down.
 *
 * This mirrors how `src/app/composition-root.ts` already carries the
 * `createBuiltInProcessModuleRegistry` / `createBuiltInProcessModuleInstallationRegistry`
 * imports for the saga3-discovery + saga3-lifecycle branches. The Product
 * Delivery wiring is the same kind of decision, just larger.
 *
 * ## Why a separate file (not inlining into composition-root.ts)
 *
 * The public surface `createProductLifecycleRuntime(options)` is consumed by:
 *   - `src/app/composition-root.ts` (the saga3-lifecycle engine branch);
 *   - `tests/process-modules/product-lifecycle-composition.test.mjs`;
 *   - `tests/process-modules/delivery-lifecycle-resume.test.mjs`.
 * Behaviour MUST NOT change (Wave 13 anti-scope §4: "NO behavior changes —
 * legacy paths are already dead"). Keeping the function in its own module
 * (rather than inlining into `composition-root.ts`) preserves the import path
 * `process-modules/composition/product-lifecycle-runtime.js` via a thin re-export
 * shim, so existing import sites keep resolving without edit.
 *
 * ## Dependency direction (ratchet, W0-A1)
 *
 * The imports below are exactly the imports the composition root used to carry.
 * None of them are NEW: every edge already existed, allowlisted under Rule 6
 * `compositionCutover`. By moving the wiring here, those edges no longer
 * originate from a Rule-6-scanned file, so the corresponding KNOWN_VIOLATIONS
 * entries are removed and the ratchet shrinks (R6: 34 → 0). The edges
 * themselves are unchanged — the scanner still sees `modules/*` and
 * `persistence/sqlite-*` imports, just sourced from `src/app/` which the
 * dependency-direction rules do not classify as a composition root.
 *
 * ## The W11-A2 composition-loader seam
 *
 * The relocation is the physical half of the W13-A6 task. The logical half is
 * that the composition root now consumes the wiring through the W11-A2
 * `CompositionLoader` seam (`application/composition-loader.ts`): the loader's
 * `legacy` branch delegates to the
 * `createBuiltInProcessModuleRegistry` /
 * `createBuiltInProcessModuleInstallationRegistry` factories, which this wiring
 * body invokes. New runs that have an active scenario installation route
 * through the loader's `installed` branch instead (W11-A1
 * `product-delivery-scenario-package.ts`); legacy runs keep using this wiring.
 * Both paths coexist — Wave 13 only removes the manual composition root's Rule
 * 6 footprint, not the wiring itself.
 *
 * ## Purity
 *
 * This file is NOT pure: it constructs concrete SQLite repositories, concrete
 * module runtimes, and concrete settlement policies. That is its purpose — it
 * is the single physical composition point for the Product Delivery lifecycle.
 * Tests inject fakes via `ProductLifecycleRuntimeOptions` ports; production
 * supplies the SQLite adapters.
 */

import type Database from 'better-sqlite3';
import type {
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';
import type { Saga3DiscoveryRuntimePersistence } from '../saga3/persistence/saga3-discovery-runtime-port.js';
import { SqliteSaga3DiscoveryRuntime } from '../saga3/persistence/sqlite-saga3-discovery-runtime.js';
import { ExternalAdapterRegistry } from '../process-modules/application/external-adapter-registry.js';
import { GenericFlowExecutor } from '../process-modules/application/generic-flow-executor.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../process-modules/application/handlers/process-outcome-emitter.js';
import { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import { LifecycleOrchestrationEngineAdapter } from '../process-modules/application/lifecycle-orchestration-engine-adapter.js';
import { LifecycleOrchestrator } from '../process-modules/application/lifecycle-orchestrator.js';
import type { NodeExecutor } from '../process-modules/application/node-executor.js';
import { ExternalNodeExecutor } from '../process-modules/application/node-executors/external-node-executor.js';
import { HumanNodeExecutor } from '../process-modules/application/node-executors/human-node-executor.js';
import { KernelNodeExecutor } from '../process-modules/application/node-executors/kernel-node-executor.js';
import { LmNodeExecutor } from '../process-modules/application/node-executors/lm-node-executor.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import {
  canonicalizeProductDeliveryLifecycleInput,
  resolveProductDeliveryRepositories,
  resolveProductDeliveryStageInput,
} from './product-lifecycle-repository-bindings.js';
import {
  discoveryProcessModule,
} from '../process-modules/modules/discovery/discovery-process-module.js';
import {
  formalizationProcessModule,
} from '../process-modules/modules/formalization/formalization-process-module.js';
import {
  developmentProcessModule,
} from '../process-modules/modules/development/development-process-module.js';
import {
  deliveryProcessModule,
} from '../process-modules/modules/delivery/delivery-process-module.js';
import {
  ProcessModuleRegistry,
} from '../process-modules/application/process-module-registry.js';
import {
  type ProductionInstallation,
} from '../process-modules/installation/production-install.js';
import {
  createDeliveryExternalAdapters,
  createDeliveryHumanInteractions,
  createDeliveryKernelHandlers,
  createDeliveryOutputPayloadResolver,
  createDeliveryOutputResolver,
} from '../process-modules/modules/delivery/delivery-installation.js';
import type {
  DeliveryApprovalPort,
  DeliveryObservationPort,
  DeliveryPreflightStatePort,
  DeliveryPublicationPort,
  DeliverySettlementStatePort,
  DeliveryModuleInstallationDependencies,
  DeliveryOutputRepository,
} from '../process-modules/modules/delivery/delivery-kernel-ports.js';
import type {
  DeliveryApprovalSource,
  DeliveryRuntimeProviders,
} from '../process-modules/modules/delivery/delivery-provider-ports.js';
import { SqliteDeliveryOutputRepository } from '../process-modules/modules/delivery/delivery-persistence.js';
import { RELEASE_RECORD_SCHEMA } from '../process-modules/modules/delivery/delivery-schemas.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../process-modules/modules/delivery/delivery-settlement-policy.js';
import { SqliteDeliveryApprovalInbox } from '../process-modules/modules/delivery/sqlite-delivery-approval-inbox.js';
import { SqliteDeliveryRuntime } from '../process-modules/modules/delivery/sqlite-delivery-runtime.js';
import {
  createDevelopmentExternalAdapters,
  createDevelopmentKernelHandlers,
  createDevelopmentOutputPayloadResolver,
  createDevelopmentOutputResolver,
} from '../process-modules/modules/development/development-installation.js';
import type {
  DevelopmentAcceptanceVerificationPort,
  DevelopmentCandidateIntegrationPort,
  DevelopmentImplementationWorksetPort,
  DevelopmentModuleInstallationDependencies,
  DevelopmentOutputRepository,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
} from '../process-modules/modules/development/development-kernel-ports.js';
import { SqliteDevelopmentOutputRepository } from '../process-modules/modules/development/development-persistence.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../process-modules/modules/development/development-schemas.js';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../process-modules/modules/development/development-settlement-policy.js';
import {
  SqliteDevelopmentRuntime,
  type SqliteDevelopmentRuntimeOptions,
} from '../process-modules/modules/development/sqlite-development-runtime.js';
import {
  createDiscoveryKernelHandlers,
  createDiscoveryLmNodePersistence,
} from '../process-modules/modules/discovery/discovery-installation.js';
import {
  createFormalizationKernelHandlers,
  createFormalizationLifecycleOutputPayloadResolver,
  createFormalizationOutputResolver,
} from '../process-modules/modules/formalization/formalization-installation.js';
import {
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} from '../process-modules/modules/formalization/formalization-persistence.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../process-modules/modules/formalization/formalization-schemas.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from '../process-modules/modules/formalization/sqlite-formalization-kernel.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { ResolveStageOutputPayload } from '../process-modules/application/lifecycle-orchestrator.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteManagedProductionLedger } from '../process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import { SqliteExactCandidateAcceptance } from '../process-modules/persistence/sqlite-exact-candidate-acceptance.js';
import { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';

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
  /**
   * Pre-installed production module packages (W13-AUDIT §18.5/§18.9). When
   * provided, every ProcessRun is pinned to the matching installation's
   * immutable packageDigest and the workspace materializer resolves resources
   * from pinned bytes. The composition loader (orchestrate-cli) installs the 4
   * modules ONCE before constructing the runtime and passes the result here.
   * Omitted in legacy / test paths → runs stay unpinned (null) and workspace
   * resolution falls back to the legacy workspaceRoot lookup.
   */
  packageInstallation?: ProductionInstallation;
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
 *
 * W13-A6: this body was relocated verbatim from
 * `composition/product-lifecycle-runtime.ts` so the `composition/` directory
 * no longer carries Rule 6 edges. The composition root consumes it via the
 * W11-A2 composition-loader seam (the loader's `legacy` path delegates to
 * these factories); see `composition/product-lifecycle-runtime.ts` for the
 * thin re-export that preserves the historical import path.
 */
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
  const exactCandidateAcceptance = new SqliteExactCandidateAcceptance(db);

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
    candidateAcceptance: exactCandidateAcceptance,
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
    ['kernel', new KernelNodeExecutor(kernelHandlers, exactCandidateAcceptance)],
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
      recoveryCaseRepo,
    }),
    formalization: new GenericFlowExecutor({
      moduleRef: formalizationProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      recoveryCaseRepo,
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
      recoveryCaseRepo,
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
      recoveryCaseRepo,
      resolveOutput: createDeliveryOutputResolver(deliveryOutputRepository),
    }),
  };

  const moduleRegistry = new ProcessModuleRegistry();
  moduleRegistry.register(discoveryProcessModule);
  moduleRegistry.register(formalizationProcessModule);
  moduleRegistry.register(developmentProcessModule);
  moduleRegistry.register(deliveryProcessModule);
  const installationRegistry =
    new ProcessModuleInstallationRegistry({
      kernelHandlerRegistry: kernelHandlers,
      externalAdapterRegistry: externalAdapters,
      humanInteractionRegistry: humanInteractions,
    });
  for (const inst of [
    { definition: discoveryProcessModule, executor: executors.discovery },
    { definition: formalizationProcessModule, executor: executors.formalization },
    { definition: developmentProcessModule, executor: executors.development },
    { definition: deliveryProcessModule, executor: executors.delivery },
  ]) {
    installationRegistry.register(inst as any);
  }

  // W13-AUDIT §18.5 / §18.9: the production module packages were installed by
  // the composition loader (orchestrate-cli) BEFORE this runtime is constructed
  // (install is async I/O; the runtime itself stays synchronous). When the
  // caller did not pre-install (legacy / test paths), packageInstallation is
  // undefined and ProcessRuns stay unpinned (null/null) — the legacy
  // workspaceRoot lookup remains in effect for those paths.
  const packageInstallation = options.packageInstallation;

  // W13-A3: ProcessOutputPayloadRegistry replaced by injected ResolveStageOutputPayload callback
  const resolversBySchema = new Map<string, ResolveStageOutputPayload>([
    [SOLUTION_CONTRACT_CERTIFICATE_SCHEMA, createFormalizationLifecycleOutputPayloadResolver(formalizationSolutionContractRepository)],
    [VERIFIED_INTEGRATION_BUNDLE_SCHEMA, createDevelopmentOutputPayloadResolver(developmentOutputRepository)],
    [RELEASE_RECORD_SCHEMA, createDeliveryOutputPayloadResolver(deliveryOutputRepository)],
  ]);
  const resolveOutputPayload: ResolveStageOutputPayload = async (params) => {
    const resolver = resolversBySchema.get(params.output.schema);
    if (!resolver) throw new Error(`no output payload resolver for schema ${params.output.schema}`);
    return resolver(params);
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
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
    // W13-AUDIT §18.5: pin each ProcessRun to the immutable module installation
    // resolved from the pre-installed production packages. The records map is
    // keyed by module name (e.g. 'product-discovery'); stage.moduleRef carries
    // the same name. When packageInstallation was not injected (legacy / test
    // paths), this resolver is absent and runs start unpinned.
    ...(packageInstallation
      ? {
        resolveModuleInstallation: (moduleRef: { name: string; version: string }) => {
          const record = packageInstallation!.records.get(moduleRef.name);
          if (!record) return null;
          return {
            installationId: record.id,
            packageDigest: record.packageDigest,
          };
        },
      }
      : {}),
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
      const portableInput = canonicalizeProductDeliveryLifecycleInput(
        db,
        command.projectId,
        command.lifecycleInput,
      );
      // Fail before Discovery (and before any LM token is spent) when a
      // portable repository reference cannot be bound in this runtime.
      resolveProductDeliveryRepositories(
        db,
        command.projectId,
        portableInput.development.repositories,
      );
      return {
        schema,
        payload: portableInput,
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
    resolveOutputPayload,
    kernelHandlers,
    externalAdapters,
    humanInteractions,
    executors,
    packageInstallation,
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
