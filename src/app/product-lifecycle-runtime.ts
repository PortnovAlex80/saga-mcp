/**
 * Concrete Product Delivery lifecycle wiring (composition-root seam).
 *
 * # What this file owns
 *
 * The composition root for the Product Delivery lifecycle. It constructs the
 * SHARED deps once (databases, repositories, the shared node-executors map,
 * the centralized node-products resolver), then delegates the per-module
 * wiring to four `register<Name>()` functions — the LEGO contract: adding a
 * fifth module is one new register call, not 200 lines of inline wiring.
 *
 * # The LEGO contract
 *
 * Each module (`src/modules/<name>/index.ts`) exports a
 * `register<Name>(registries, sharedDeps, options)` function that constructs
 * its own concrete adapters, registers its kernel handlers, builds its
 * `GenericFlowExecutor`, and registers the module definition + installation.
 * This file holds the four registries + shared deps and calls them in order:
 *
 *   registerDiscovery(registries, sharedDeps);
 *   registerFormalization(registries, sharedDeps);
 *   registerDevelopment(registries, sharedDeps, options.development);
 *   registerDelivery(registries, sharedDeps, options.delivery);
 *
 * What STAYS in the composition root (cross-module, not module-specific):
 *   - the shared SQLite repositories (processRun / nodeRun / certificate /
 *     recoveryCase / managedNodeSubmissions / lifecycleRun);
 *   - the v2 executor product-repo bridge (with the NodeRun fallback);
 *   - the shared `nodeExecutors` map (kernel + lm + human executors);
 *   - the centralized `resolveNodeProducts` resolver;
 *   - the cross-module `process-outcome-emitter` kernel handler;
 *   - the `resolveOutputPayload` callback (binds the three module-specific
 *     payload resolvers by schema — needs results from all four registers);
 *   - the `LifecycleOrchestrator` + engine adapter.
 *
 * # Why `src/app/` is the correct home
 *
 * `src/app/` is the composition-root layer: `composition-root.ts` already lives
 * here and already imports the built-in module catalog + installations (it is
 * the single engine-selection switch). Colocating the Product Delivery wiring
 * here keeps every concrete composition decision in one layer. Crucially:
 *   - `src/app/` is NOT scanned by Rule 6 (Rule 6 scans
 *     `src/process-modules/composition/` only), so the wiring's module/sqlite
 *     imports do not appear as Rule 6 violations.
 *   - `src/app/` is NOT in the cutover NEW_CORE set
 *     (`tests/architecture/cutover-architecture-checks.test.mjs`), so the
 *     wiring's catalog/module imports are not "hidden fallbacks" — they are the
 *     legitimate legacy composition surface.
 *
 * # LEGO composition (saga4)
 *
 * This wiring body calls 4 register functions — one per module — that
 * populate shared registries (kernelHandlers, moduleRegistry,
 * installationRegistry). Adding a module = create directory + 1 register()
 * call. The legacy/scenario cutover path (composition-loader, legacy-run-
 * inventory, scenario adapters) was removed — the LEGO register path is
 * the sole composition mechanism.
 *
 * # Purity
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
import type { Saga3DiscoveryRuntimePersistence } from '../modules/discovery/infrastructure/discovery-runtime-port.js';
import { SqliteSaga3DiscoveryRuntime } from '../modules/discovery/infrastructure/sqlite-discovery-runtime.js';
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
import { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import {
  type ProductionInstallation,
} from '../process-modules/installation/production-install.js';
import type { ResolveStageOutputPayload } from '../process-modules/application/lifecycle-orchestrator.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { lifecycleRefKey } from '../process-modules/persistence/lifecycle-run.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
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
import {
  createFormalizationLifecycleOutputPayloadResolver,
} from '../modules/formalization/application/formalization-installation.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../modules/formalization/domain/formalization-schemas.js';
import {
  createDevelopmentOutputPayloadResolver,
} from '../modules/development/application/development-installation.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../modules/development/domain/development-schemas.js';
import {
  createDeliveryOutputPayloadResolver,
} from '../modules/delivery/application/delivery-installation.js';
import { RELEASE_RECORD_SCHEMA } from '../modules/delivery/domain/delivery-schemas.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';

// Module register functions (the LEGO contract).
import { registerDiscovery } from '../modules/discovery/index.js';
import { registerFormalization } from '../modules/formalization/index.js';
import { registerDevelopment } from '../modules/development/index.js';
import { promoteTaskToDone } from '../lifecycle/work-assignment-core.js';
import { registerDelivery } from '../modules/delivery/index.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../modules/module-registration.js';
// Import the per-module composition-dependency option types so they are in
// local scope for `ProductLifecycleRuntimeOptions` AND re-exported below for
// back-compat with the historical public option names (composition-root.ts).
import type { DevelopmentCompositionDependencies } from '../modules/development/index.js';
import type {
  DeliveryCompositionDependencies,
  DeliveryProviderConfiguration,
} from '../modules/delivery/index.js';
export type { DevelopmentCompositionDependencies };
export type { DeliveryCompositionDependencies, DeliveryProviderConfiguration };

export interface ProductLifecycleRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number | null;
  }) => WorkerExecutorFactoryContext;
  /** Global concurrency knob (--concurrency=N). Used by the LM executor. */
  concurrency?: number;
  /**
   * Atomic card-assignment port for LM-node worker launches: "infrastructure
   * atomically assigns the exact card before launching a worker". When wired,
   * the LmNodeExecutor pre-assigns the projected task through this port BEFORE
   * calling workerExecutor.start(), passing the AssignedWork as `assignment` —
   * ONE assignment path instead of two (pre-assigned vs claimScope-pinned).
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
   * Pre-installed production module packages. When provided, every ProcessRun
   * is pinned to the matching installation's immutable packageDigest and the
   * workspace materializer resolves resources from pinned bytes. The
   * composition loader (orchestrate-cli) installs the 4 modules ONCE before
   * constructing the runtime and passes the result here. Omitted in legacy /
   * test paths → runs stay unpinned (null) and workspace resolution falls back
   * to the legacy workspaceRoot lookup.
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
 * The composition root constructs the shared deps + registries once, then
 * delegates per-module wiring to the four `register<Name>()` functions
 * (`src/modules/<name>/index.ts`). Adding a module = one new register call.
 *
 * W13: the body was relocated verbatim from
 * `composition/product-lifecycle-runtime.ts` so the `composition/` directory
 * no longer carries Rule 6 edges. W14 (this revision) extracted the per-module
 * wiring into register functions.
 */
export function createProductLifecycleRuntime(
  options: ProductLifecycleRuntimeOptions,
) {
  assertCompositionDependencies(options);
  const db = options.db ?? getDb();

  // ---------------------------------------------------------------------
  // SHARED deps — constructed ONCE, shared across all four modules.
  // ---------------------------------------------------------------------
  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const recoveryCaseRepo = new SqliteRecoveryCaseRepository(db);
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const processProductRepo = new SqliteProcessProductRepository(db);
  const processProductRepoV2 = new SqliteProcessProductRepositoryV2(db);
  // T8 — WorkplaceProductPort: universal cross-module product handoff ("one
  // desk for all workshops"). A THIN WRAPPER over the existing
  // saga3_process_products table (via SqliteProcessProductRepositoryV2). Purely
  // ADDITIVE — no new tables, no schema changes, no change to the four legacy
  // submit tools. Constructed here and shared via sharedDeps so future module
  // code CAN submit/read cross-module products through one lingua-franca port.
  const workplaceProductPort = new SqliteWorkplaceProductAdapter(
    db,
    processProductRepoV2,
  );
  // Wire the v2 driver-neutral envelope path (driver-neutral execution-context
  // envelopes + explicit ModuleCompletion persistence via completeV2) into all
  // four executors below. `SqliteNodeRunRepository` implements
  // `NodeRunRepositoryV2` (startV2/completeV2/readByExactCursor), so
  // `v2ChannelFor` returns a live channel and the v2 path activates
  // unconditionally for fresh runs. `processProductRepoV2` is the
  // exact-by-ProductRef port (`getByProductRef`) the assembler consumes — it
  // shares the same `saga3_process_products` table as the v1 repo. Manifest
  // pins are left to the packageInstallation resolver (forwarded by the
  // assembler's legacy fallback) — null here is the documented
  // 'legacy:unpinned' sentinel when the installed digest is not surfaced on
  // ProcessRunRecord.
  const lookupProduction = db.prepare(
    `SELECT output_schema AS schema, output_ref AS ref, output_hash AS hash,
            output_bindings AS bindingsText
       FROM saga3_node_runs
      WHERE output_schema=? AND output_ref=? AND output_hash=?
        AND status='completed'
      LIMIT 1`,
  );
  const assemblerProductRepo = {
    getByProductRef: (ref: ProductRef) => {
      // T8 — Primary path routed through WorkplaceProductPort.readProduct,
      // closing the "port has no consumers" finding. The port delegates to the
      // SAME SqliteProcessProductRepositoryV2.getByProductRef over the SAME
      // saga3_process_products table — the lookup is identical; only the read
      // surface changes. The port's exact-match guarantee means the returned
      // schema/contentHash equal the matched row's reference.schema/hash, and
      // the matched artifact_ref equals the queried ref.ref (so productRef.ref
      // is reconstructed from the input ref, not the port's narrower return).
      // content maps 1:1 to row.payload for executor-written products: the
      // port's unwrapBindings only transforms workplace-port-submitted
      // primitives ({value: x} shape), which assembler predecessor refs never
      // target (they point to recordProduct-written envelopes).
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
      // Fallback: resolve from durable NodeRun rows (settlement productions).
      const nr = lookupProduction.get(ref.schemaId, ref.ref, ref.digest) as
        | { schema: string | null; ref: string | null; hash: string | null; bindingsText: string | null }
        | undefined;
      if (nr === undefined || nr.schema === null || nr.ref === null || nr.hash === null) {
        // Fallback: recovery-feedback products are persisted in saga3_recovery_attempts,
        // not in saga3_node_runs or the product store. The verify→repair loop forwards
        // a recovery-feedback product (schema 'saga3.recovery-feedback.v1', ref
        // 'recovery-case:<id>:attempt:<n>') that production must resolve here.
        if (ref.schemaId === 'saga3.recovery-feedback.v1') {
          try {
            const recoveryRow = db.prepare(
              `SELECT feedback_snapshot, feedback_hash, issue_ref FROM saga3_recovery_attempts
               WHERE issue_ref = ? ORDER BY attempt DESC LIMIT 1`,
            ).get(ref.ref) as { feedback_snapshot: string; feedback_hash: string } | undefined;
            if (recoveryRow) {
              return {
                productRef: ref,
                payload: {
                  schema: ref.schemaId,
                  artifactRef: ref.ref,
                  contentHash: recoveryRow.feedback_hash,
                  bindings: JSON.parse(recoveryRow.feedback_snapshot || '{}'),
                },
              };
            }
          } catch {
            // Table may not exist on fresh DBs without recovery history.
          }
        }
        return null;
      }
      const bindings = nr.bindingsText ? JSON.parse(nr.bindingsText) : {};
      return {
        productRef: {
          schemaId: nr.schema,
          ref: nr.ref,
          digest: nr.hash,
        },
        payload: {
          schema: nr.schema,
          artifactRef: nr.ref,
          contentHash: nr.hash,
          bindings,
        },
      };
    },
  };
  const executorV2Options = {
    productRepo: assemblerProductRepo,
  };
  const runtimePersistence = options.discoveryRuntimePersistence
    ?? new SqliteSaga3DiscoveryRuntime();
  const managedNodeSubmissions =
    new SqliteManagedNodeSubmissionRepository(db);
  const exactCandidateAcceptance = new SqliteExactCandidateAcceptance(db);

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

  // ---------------------------------------------------------------------
  // REGISTRIES — constructed once, populated by the four register calls.
  // ---------------------------------------------------------------------
  const kernelHandlers = new KernelHandlerRegistry();
  // Cross-module handler (NOT module-specific) — stays in the composition root.
  kernelHandlers.register(
    PROCESS_OUTCOME_EMITTER_HANDLER_ID,
    processOutcomeEmitter,
  );
  const humanInteractions = new HumanInteractionRegistry();
  const moduleRegistry = new ProcessModuleRegistry();
  const installationRegistry =
    new ProcessModuleInstallationRegistry({
      kernelHandlerRegistry: kernelHandlers,
      humanInteractionRegistry: humanInteractions,
    });

  // ---------------------------------------------------------------------
  // SHARED node executors — must be constructed AFTER kernelHandlers exists
  // (kernel executor references it) and AFTER runtimePersistence /
  // exactCandidateAcceptance (shared prerequisites). Stays in the composition
  // root because it is cross-module.
  // ---------------------------------------------------------------------
  const nodeExecutors = new Map<string, NodeExecutor>([
    ['kernel', new KernelNodeExecutor(kernelHandlers, exactCandidateAcceptance)],
    ['lm', new LmNodeExecutor({
      persistence: createDiscoveryLmNodePersistence(runtimePersistence),
      workerExecutorFactory: options.workerExecutorFactory,
      resolveWorkerContext: options.resolveWorkerContext,
      // Pre-assign the LM node's card through the atomic WorkAssignmentPort
      // BEFORE launching the worker, so there is ONE assignment path. The
      // dispatch-loop path uses the same port (via the factory's claimTask
      // callback); this closes the LM-node divergence. We default-construct
      // the same SqliteWorkAssignmentAdapter the dispatch path uses
      // (overridable via options for tests), so every production LM-node
      // launch pre-assigns even when the external composition module did not
      // supply one explicitly.
      workAssignment: options.workAssignment ?? new SqliteWorkAssignmentAdapter(db),
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
    // Kernel-gate: promote task pending_verification → done when the kernel
    // verifier accepts the work. This is the ONLY path from
    // pending_verification to done. The callback receives (processRunId,
    // repairNodeId) — the repairNodeId is the LM node whose task needs
    // promotion. The generationKey ties the task to the same processRun +
    // node, so we find it deterministically.
    onWorkplaceVerified: (processRunId, repairNodeId) => {
      const generationKey = `process-run:${processRunId}:node:${repairNodeId}`;
      const taskRow = db.prepare(
        'SELECT id FROM tasks WHERE generation_key=? AND status=\'pending_verification\'',
      ).get(generationKey) as { id: number } | undefined;
      if (taskRow) {
        promoteTaskToDone(db, taskRow.id);
      }
    },
  };
  const registries: ModuleRegistries = {
    kernelHandlers,
    humanInteractions,
    moduleRegistry,
    installationRegistry,
  };

  // ---------------------------------------------------------------------
  // LEGO contract — four register calls, one per module.
  // ---------------------------------------------------------------------
  const discoveryExecutor = registerDiscovery(registries, sharedDeps);
  const formalization = registerFormalization(registries, sharedDeps);
  const development = registerDevelopment(registries, sharedDeps, options.development ?? {});
  const delivery = registerDelivery(registries, sharedDeps, options.delivery);

  // ---------------------------------------------------------------------
  // resolveOutputPayload — cross-module callback that binds each module's
  // payload resolver by schema. Needs results from the formalization /
  // development / delivery registers, so it stays here.
  // ---------------------------------------------------------------------
  const resolversBySchema = new Map<string, ResolveStageOutputPayload>([
    [SOLUTION_CONTRACT_CERTIFICATE_SCHEMA, createFormalizationLifecycleOutputPayloadResolver(formalization.solutionContractRepository)],
    [VERIFIED_INTEGRATION_BUNDLE_SCHEMA, createDevelopmentOutputPayloadResolver(development.outputRepository)],
    [RELEASE_RECORD_SCHEMA, createDeliveryOutputPayloadResolver(delivery.outputRepository)],
  ]);
  const resolveOutputPayload: ResolveStageOutputPayload = async (params) => {
    const resolver = resolversBySchema.get(params.output.schema);
    if (!resolver) throw new Error(`no output payload resolver for schema ${params.output.schema}`);
    return resolver(params);
  };

  // The production module packages were installed by the composition loader
  // (orchestrate-cli) BEFORE this runtime is constructed (install is async
  // I/O; the runtime itself stays synchronous). When the caller did not
  // pre-install (legacy / test paths), packageInstallation is undefined and
  // ProcessRuns stay unpinned (null/null) — the legacy workspaceRoot lookup
  // remains in effect for those paths.
  const packageInstallation = options.packageInstallation;

  // ---------------------------------------------------------------------
  // ORCHESTRATOR + engine — cross-module, stays in the composition root.
  // ---------------------------------------------------------------------
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
    // Pin each ProcessRun to the immutable module installation resolved from
    // the pre-installed production packages. The records map is keyed by
    // module name (e.g. 'product-discovery'); stage.moduleRef carries the
    // same name. When packageInstallation was not injected (legacy / test
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
    executors: {
      discovery: discoveryExecutor,
      formalization: formalization.executor,
      development: development.executor,
      delivery: delivery.executor,
    },
    packageInstallation,
    runtimes: {
      // Development has no executive runtime under the Formalization mechanical
      // pattern — its store (task-graph persistence + settlement-state reader)
      // is exposed as `development.graph` and wired via the register deps.
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
      formalizationSolutionContractRepository: formalization.solutionContractRepository,
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
