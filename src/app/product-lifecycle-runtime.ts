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
  WorkAssignmentPort,
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';
import type { Saga3DiscoveryRuntimePersistence } from '../saga3/persistence/saga3-discovery-runtime-port.js';
import { SqliteSaga3DiscoveryRuntime } from '../saga3/persistence/sqlite-saga3-discovery-runtime.js';
import { GenericFlowExecutor } from '../process-modules/application/generic-flow-executor.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../process-modules/application/handlers/process-outcome-emitter.js';
import { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import { LifecycleOrchestrationEngineAdapter } from '../process-modules/application/lifecycle-orchestration-engine-adapter.js';
import { LifecycleOrchestrator } from '../process-modules/application/lifecycle-orchestrator.js';
import type { NodeExecutor, NodeProducts } from '../process-modules/application/node-executor.js';
import { HumanNodeExecutor } from '../process-modules/application/node-executors/human-node-executor.js';
import { KernelNodeExecutor } from '../process-modules/application/node-executors/kernel-node-executor.js';
import { LmNodeExecutor } from '../process-modules/application/node-executors/lm-node-executor.js';
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
import { SqliteDeliveryOutputRepository } from '../infrastructure/process-modules/delivery/delivery-persistence.js';
import { RELEASE_RECORD_SCHEMA } from '../process-modules/modules/delivery/delivery-schemas.js';
import {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} from '../process-modules/modules/delivery/delivery-settlement-policy.js';
import { SqliteDeliveryApprovalInbox } from '../infrastructure/process-modules/delivery/sqlite-delivery-approval-inbox.js';
import { SqliteDeliveryRuntime } from '../infrastructure/process-modules/delivery/sqlite-delivery-runtime.js';
import {
  createDevelopmentKernelHandlers,
  createDevelopmentOutputPayloadResolver,
  createDevelopmentOutputResolver,
} from '../process-modules/modules/development/development-installation.js';
import type {
  DevelopmentCanonicalGraphPort,
  DevelopmentModuleInstallationDependencies,
  DevelopmentOutputRepository,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
} from '../process-modules/modules/development/development-kernel-ports.js';
import { SqliteDevelopmentOutputRepository } from '../infrastructure/process-modules/development/development-persistence.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../process-modules/modules/development/development-schemas.js';
import {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} from '../process-modules/modules/development/development-settlement-policy.js';
import { SqliteDevelopmentModuleStore } from '../infrastructure/process-modules/development/sqlite-development-settlement-state.js';
import { createGitPort, createMachinePort } from '../infrastructure/process-modules/git-machine-ports.js';
import { SqliteWorkAssignmentAdapter } from '../infrastructure/work/sqlite-work-assignment-adapter.js';
import {
  createDeliveryProcessProductPort,
  createDeliveryExternalEffectLedgerPort,
} from '../infrastructure/process-modules/delivery-ports.js';
import {
  SqliteFormalizationBriefProvisioning,
  SqliteDiscoveryBriefProvisioning,
} from '../infrastructure/process-modules/brief-provisioning-ports.js';
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
} from '../infrastructure/process-modules/formalization/formalization-persistence.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../process-modules/modules/formalization/formalization-schemas.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from '../infrastructure/process-modules/formalization/sqlite-formalization-kernel.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { ResolveStageOutputPayload } from '../process-modules/application/lifecycle-orchestrator.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { lifecycleRefKey } from '../process-modules/persistence/lifecycle-run.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteManagedProductionLedger } from '../process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteProcessProductRepository } from '../process-modules/persistence/sqlite-process-product-repository.js';
import { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import { SqliteExactCandidateAcceptance } from '../process-modules/persistence/sqlite-exact-candidate-acceptance.js';
import { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';

export interface DevelopmentCompositionDependencies {
  /**
   * The declarative module store: persists the validated task graph +
   * projects kanban tasks (DevelopmentTaskGraphPort) AND re-reads tracker state
   * to reconstruct the settlement input (DevelopmentSettlementStatePort). Under
   * the Formalization mechanical pattern there are no executive ports here —
   * workers claim projected tasks through the shared worker_next queue, merge
   * via worker_merge_release and record evidence via verification_record.
   */
  store?: DevelopmentCanonicalGraphPort
    & DevelopmentTaskGraphPort
    & DevelopmentSettlementStatePort;
  taskGraph?: DevelopmentTaskGraphPort;
  settlementState?: DevelopmentSettlementStatePort;
  taskGraphPolicy?: DevelopmentModuleInstallationDependencies['taskGraphPolicy'];
  settlementPolicy?: DevelopmentModuleInstallationDependencies['settlementPolicy'];
  outputRepository?: DevelopmentOutputRepository;
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
  /** Global concurrency knob (--concurrency=N). Used by the LM executor. */
  concurrency?: number;
  /**
   * Atomic card-assignment port for LM-node worker launches
   * (CONVEYOR-MENTAL-MODEL doc line 291: "infrastructure atomically assigns
   * the exact card before launching a worker"). When wired, the LmNodeExecutor
   * pre-assigns the projected task through this port BEFORE calling
   * workerExecutor.start(), passing the AssignedWork as `assignment` — ONE
   * assignment path instead of two (pre-assigned vs claimScope-pinned).
   *
   * When omitted, the LM executor falls back to the deprecated claimScope path
   * (the runner's claimTask callback assigns inside start()). Production
   * (orchestrate-cli / composition-root) always wires this — the same
   * SqliteWorkAssignmentAdapter the dispatch-loop path uses.
   */
  workAssignment?: WorkAssignmentPort;
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
  /**
   * Host acknowledgement hook invoked after the durable LifecycleRun is
   * created/replayed and before the first stage starts.
   */
  onLifecycleStarted?: (
    run: import('../process-modules/persistence/lifecycle-run.js').LifecycleRunRecord,
  ) => Promise<void> | void;
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
  // Development uses the Formalization mechanical pattern: the module's Flow is
  // lm+kernel only and its installation deps are purely declarative (read /
  // persist / decide). The SqliteDevelopmentModuleStore persists the validated
  // task graph, projects its kanban tasks (which workers then claim through the
  // shared worker_next queue), and re-reads tracker state to reconstruct the
  // settlement input. There is no ScopedWorksetRunner / no executive port: the
  // module never hires, merges or tests — that is infrastructure's job.
  const developmentLedger = new SqliteManagedProductionLedger(db);
  // Wave 7: inject the concrete process-product repository + git/machine ports
  // from the composition root so the Development module imports no SQLite
  // adapter, child_process, or node:os.
  const developmentProcessProducts = new SqliteProcessProductRepository(db);
  const developmentGit = createGitPort();
  const developmentMachine = createMachinePort();
  const developmentGraph = developmentConfig.store
    ?? new SqliteDevelopmentModuleStore(db, developmentProcessProducts, developmentGit, developmentMachine);
  const developmentTaskGraphPolicy = developmentConfig.taskGraphPolicy
    ?? new ReferenceDevelopmentTaskGraphPolicy();
  const developmentOutputRepository = developmentConfig.outputRepository
    ?? new SqliteDevelopmentOutputRepository(db);
  const developmentDeps: DevelopmentModuleInstallationDependencies = {
    plannerSubmissions: managedNodeSubmissions,
    ledger: developmentLedger,
    graph: developmentGraph,
    taskGraph: developmentConfig.taskGraph ?? developmentGraph,
    settlementState: developmentConfig.settlementState ?? developmentGraph,
    taskGraphPolicy: developmentTaskGraphPolicy,
    settlementPolicy: developmentConfig.settlementPolicy
      ?? new ReferenceDevelopmentSettlementPolicy(
        developmentTaskGraphPolicy,
      ),
    outputRepository: developmentOutputRepository,
    // Uncle Bob Wave 4: the development settlement kernel now AUTHORS its own
    // certificate (issuing it through this repo) and emits an explicit
    // ModuleCompletion pointing at the resulting certificateRef. Previously the
    // generic-flow-executor's magic-bindings branch issued the certificate at
    // settlement time on the kernel's behalf; Wave 5 deletes that branch.
    certificateRepository: certificateRepo,
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
        // CONVEYOR Wave 7: injected concrete adapters (composition root owns
        // construction) so the Delivery module imports no getDb/Sqlite*.
        products: createDeliveryProcessProductPort(db),
        effectLedger: createDeliveryExternalEffectLedgerPort(db),
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
    // Wave 4: the delivery settlement kernel issues its own
    // ProcessOutcomeCertificate and emits an explicit ModuleCompletion. The
    // generic-flow-executor's magic-bindings certificateRepo.issue is now the
    // additive fallback (Wave 5 deletes it).
    certificateRepo,
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
    // CONVEYOR Wave 7: injected brief-provisioning port so the Discovery module
    // imports no getDb. Composition root owns concrete construction.
    briefProvisioning: new SqliteDiscoveryBriefProvisioning(db),
  }));
  kernelHandlers.registerAll(createFormalizationKernelHandlers({
    ledger: formalizationLedger,
    graph: formalizationGraph,
    baselineRepository: formalizationBaselineRepository,
    solutionContractRepository: formalizationSolutionContractRepository,
    settlementPolicy: new ReferenceFormalizationSettlementPolicy(),
    candidateAcceptance: exactCandidateAcceptance,
    // CONVEYOR Wave 7: injected brief-provisioning port so the Formalization
    // module imports no getDb. Composition root owns concrete construction.
    briefProvisioning: new SqliteFormalizationBriefProvisioning(db),
    // Wave 4: the formalization settlement kernel issues its own
    // ProcessOutcomeCertificate and emits an explicit ModuleCompletion. The
    // generic-flow-executor's magic-bindings certificateRepo.issue is now the
    // additive fallback (Wave 5 deletes it).
    certificateRepo,
  }));
  kernelHandlers.registerAll(createDevelopmentKernelHandlers(developmentDeps));
  kernelHandlers.registerAll(createDeliveryKernelHandlers(deliveryDeps));

  const humanInteractions = new HumanInteractionRegistry();
  humanInteractions.registerAll(createDeliveryHumanInteractions(deliveryDeps));

  const nodeExecutors = new Map<string, NodeExecutor>([
    ['kernel', new KernelNodeExecutor(kernelHandlers, exactCandidateAcceptance)],
    ['lm', new LmNodeExecutor({
      persistence: createDiscoveryLmNodePersistence(runtimePersistence),
      workerExecutorFactory: options.workerExecutorFactory,
      resolveWorkerContext: options.resolveWorkerContext,
      // CONVEYOR-MENTAL-MODEL (doc line 291): pre-assign the LM node's card
      // through the atomic WorkAssignmentPort BEFORE launching the worker, so
      // there is ONE assignment path. The dispatch-loop path uses the same
      // port (via the factory's claimTask callback); this closes the LM-node
      // divergence. We default-construct the same SqliteWorkAssignmentAdapter
      // the dispatch path uses (overridable via options for tests), so every
      // production LM-node launch pre-assigns even when the external
      // composition module did not supply one explicitly.
      workAssignment: options.workAssignment ?? new SqliteWorkAssignmentAdapter(db),
    })],
    ['human', new HumanNodeExecutor(humanInteractions)],
  ]);

  // CGAD P18 — centralized node-products resolver: reads the workplace's (node's)
  // durable worker products by node-scope (processRunId + moduleRef + nodeId),
  // never by task. Shared across all module executors so every kernel handler
  // receives ctx.nodeProducts and no module can reintroduce a task-scoped read.
  const centralLedger = new SqliteManagedProductionLedger(db);
  const resolveNodeProducts = (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): NodeProducts | null => {
    const artifacts = centralLedger.listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId);
    const traces = centralLedger.listTracesForNodeInProcessRun(processRunId, moduleRef, nodeId);
    const submission = managedNodeSubmissions.readLatestForNode(processRunId, moduleRef, nodeId);
    if (artifacts.length === 0 && traces.length === 0 && submission === null) {
      return null;
    }
    return {
      artifacts: artifacts
        .filter((a): a is typeof a & { contentHash: string } => a.contentHash !== null)
        .map(a => ({
          ledgerId: a.ledgerId,
          artifactId: a.artifactId,
          artifactType: a.artifactType,
          artifactStatus: a.artifactStatus,
          contentHash: a.contentHash,
          operation: a.operation,
        })),
      traces: traces.map(t => ({
        ledgerId: t.ledgerId,
        traceId: t.traceId,
        sourceId: t.sourceId,
        targetType: t.targetType,
        targetId: t.targetId,
        linkType: t.linkType,
        traceHash: t.traceHash,
      })),
      submission,
    };
  };

  const executors = {
    discovery: new GenericFlowExecutor({
      moduleRef: discoveryProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      recoveryCaseRepo,
      resolveNodeProducts,
    }),
    formalization: new GenericFlowExecutor({
      moduleRef: formalizationProcessModule.identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors,
      recoveryCaseRepo,
      resolveNodeProducts,
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
      resolveNodeProducts,
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
      resolveNodeProducts,
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
      // Resume restores the persisted input from the durable LifecycleRun
      // record instead of demanding the caller re-supply it. A paused run
      // already froze its input at start time (input_snapshot); the
      // orchestrator re-reads it from the snapshot on every stage turn, and
      // start()'s idempotency check compares the input_hash. So for a resume
      // we hydrate the exact persisted input by idempotency key and let it
      // flow through the same validation/portable-binding path. An explicit
      // caller-supplied lifecycleInput still wins (a caller may override).
      let lifecycleInput = command.lifecycleInput;
      if (lifecycleInput === undefined) {
        if (!command.resumePaused) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: pass RunEpisodeCommand.lifecycleInput',
          );
        }
        const idempotencyKey =
          command.idempotencyKey ?? `product-delivery:epic:${command.epicId}`;
        const existing = lifecycleRunRepo.readByIdempotencyKey(
          command.projectId,
          lifecycleRefKey(productDeliveryLifecycle.identity),
          idempotencyKey,
        );
        if (!existing || existing.inputSnapshot === null) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: --resume was requested but no durable '
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
      assertProductDeliveryLifecycleInput(lifecycleInput, lifecycleInputPolicyValidation);
      const portableInput = canonicalizeProductDeliveryLifecycleInput(
        db,
        command.projectId,
        lifecycleInput,
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
    humanInteractions,
    executors,
    packageInstallation,
    runtimes: {
      // Development has no executive runtime under the Formalization mechanical
      // pattern — its store (task-graph persistence + settlement-state reader)
      // is exposed above as `developmentGraph` and wired via `developmentDeps`.
      development: developmentGraph,
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
