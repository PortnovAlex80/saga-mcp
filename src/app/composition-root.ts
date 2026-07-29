import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { EngineAdministration } from '../application/ports/engine-administration.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createSagaApplication,
  createSagaControlApplication as createControlApplication,
  type SagaApplication,
  type SagaControlApplication,
} from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { asModuleInstallationId } from '../process-modules/installation/domain/installation.js';
import { Saga2Engine } from '../engines/saga2-engine.js';
import { Saga3DiscoveryEngine } from '../engines/saga3-discovery-engine.js';
import { SqliteSaga3DiscoveryRuntime } from '../saga3/persistence/sqlite-saga3-discovery-runtime.js';
import { Saga3DiscoveryNormalizationService } from '../saga3/application/discovery-normalization-service.js';
import { Saga3DiscoveryReadinessService } from '../saga3/application/discovery-readiness-service.js';
import { Saga3DiscoverySettlementService } from '../saga3/application/discovery-settlement-service.js';
import { Saga3DiscoveryDiagnosisService } from '../saga3/application/discovery-diagnosis-service.js';
import type { OrchestrationEngine } from '../application/ports/orchestration-engine.js';
import { LegacyEngineAdministration } from '../infrastructure/engine/legacy-engine-administration.js';
import {
  SqliteEpisodeRuntimeRepository,
  SqliteExecutionRuntimeRepository,
  SqliteTaskRuntimeRepository,
} from '../infrastructure/persistence/sqlite-saga2-runtime-repositories.js';
import { SqliteBoardProjectionReader } from '../infrastructure/projections/sqlite-board-projection-reader.js';
import { NodeSaga2HostRuntime } from '../infrastructure/runtime/node-saga2-host-runtime.js';
import { createLegacyClaudeWorkerExecutorFactory } from '../infrastructure/workers/legacy-claude-worker-executor-factory.js';
import { SqliteWorkspaceResolver } from '../infrastructure/workspaces/sqlite-workspace-resolver.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';
import {
  isSaga3DiscoveryMode,
  isSaga3DiscoveryGenericMode,
  isSaga3FormalizationMode,
  isSaga3LifecycleMode,
} from '../runtime/orchestration-mode.js';
import {
  ExistingOrchestrationEngineAdapter,
  ProcessModuleRuntimeEngine,
} from '../process-modules/application/process-module-runtime-engine.js';
import { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import {
  DISCOVERY_PROCESS_MODULE_REF,
  discoveryProcessModule,
} from '../process-modules/modules/discovery/discovery-process-module.js';
import { Saga3FormalizationEngine } from '../engines/saga3-formalization-engine.js';
import { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../process-modules/application/handlers/process-outcome-emitter.js';
import { KernelNodeExecutor } from '../process-modules/application/node-executors/kernel-node-executor.js';
import { LmNodeExecutor } from '../process-modules/application/node-executors/lm-node-executor.js';
import { GenericFlowExecutor } from '../process-modules/application/generic-flow-executor.js';
import { GenericFlowEngineAdapter } from '../process-modules/application/generic-flow-engine-adapter.js';
import { createDiscoveryKernelHandlers, createDiscoveryLmNodePersistence } from '../process-modules/modules/discovery/discovery-installation.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import { getDb } from '../db.js';
import {
  createProductLifecycleRuntime,
  type ProductLifecycleRuntimeOptions,
} from './product-lifecycle-runtime.js';

export type ProductLifecycleCompositionOverrides = Omit<
  ProductLifecycleRuntimeOptions,
  'workerExecutorFactory' | 'resolveWorkerContext'
>;

export interface Saga2CompositionOverrides {
  config?: SagaRuntimeConfig;
  workerExecutorFactory?: WorkerExecutorFactory;
  persistence?: Saga2RuntimePersistence;
  host?: Saga2HostRuntime;
  board?: BoardProjectionReader;
  engineAdministration?: EngineAdministration;
  /**
   * Explicit Delivery provider composition for saga3-lifecycle mode.
   * Standard Development/SQLite mechanics are supplied by the lifecycle
   * factory; no deployment success or human decision is silently selected.
   */
  productLifecycle?: ProductLifecycleCompositionOverrides;
  close?: () => void;
}

export type SagaControlCompositionOverrides = Pick<
  Saga2CompositionOverrides,
  'config' | 'board' | 'engineAdministration' | 'close'
>;

/**
 * Compose only tracker/admin capabilities.
 *
 * The control plane can start an isolated execution CLI without importing or
 * fabricating that CLI's Delivery providers.
 */
export function createSagaControlApplication(
  env: NodeJS.ProcessEnv = process.env,
  overrides: SagaControlCompositionOverrides = {},
): SagaControlApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const board = overrides.board ?? new SqliteBoardProjectionReader(config.dbPath);
  const engineAdministration = overrides.engineAdministration
    ?? new LegacyEngineAdministration({ config, baseEnv: env });
  return createControlApplication({
    board,
    engineAdministration,
    close: overrides.close ?? closeDb,
  });
}

/**
 * The only place that selects concrete Saga 2 runtime implementations.
 *
 * CLI and HTTP hosts consume SagaApplication and do not import the pump,
 * ClaudeBoardRunner, SQLite projection SQL, process control or environment.
 */
export function createSaga2Application(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Saga2CompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const persistence = overrides.persistence ?? {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };
  const workerExecutorFactory = overrides.workerExecutorFactory
    ?? createLegacyClaudeWorkerExecutorFactory({
      modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
    });
  const host = overrides.host ?? new NodeSaga2HostRuntime();
  const engine = selectEngine(
    config,
    persistence,
    workerExecutorFactory,
    host,
    overrides.productLifecycle,
  );
  const board = overrides.board ?? new SqliteBoardProjectionReader(config.dbPath);
  const engineAdministration = overrides.engineAdministration
    ?? new LegacyEngineAdministration({ config, baseEnv: env });

  return createSagaApplication({
    engine,
    board,
    engineAdministration,
    close: overrides.close ?? closeDb,
  });
}

/**
 * Selects the concrete orchestration engine behind the OrchestrationEngine port.
 *
 * This is the single composition-root switch (roadmap §5.2):
 *
 *   SAGA_ORCHESTRATION_MODE=saga3-discovery     -> ProcessModuleRuntimeEngine
 *                                                  -> Product Discovery module
 *                                                  -> Saga3DiscoveryEngine adapter
 *   SAGA_ORCHESTRATION_MODE=saga3-formalization -> Saga3FormalizationEngine
 *                                                  -> Formalization module
 *                                                  -> LegacyFormalizationProcessAdapter
 *                                                     (settlement + certificate shim)
 *   SAGA_ORCHESTRATION_MODE=v2|v3|saga2         -> Saga2Engine
 *
 * Both saga3-* modes mount a Process Module through the same
 * OrchestrationEngine port — the SPI universality proof. New modules can be
 * registered without extending the application-facing OrchestrationEngine
 * contract: each gets its own composition-root branch and its own
 * ProcessModuleExecutor implementation.
 */
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
  productLifecycle: ProductLifecycleCompositionOverrides | undefined,
): OrchestrationEngine {
  if (isSaga3LifecycleMode(config.orchestrationMode)) {
    if (!productLifecycle) {
      throw new Error(
        'SAGA3_LIFECYCLE_DEPENDENCIES_REQUIRED: createSaga2Application '
        + 'must receive overrides.productLifecycle with explicit Delivery '
        + 'preflight/publication/observation providers',
      );
    }
    // W13-AUDIT §18.9 / bug #4: when the composition loader pre-installed the
    // production packages (Seam A), rebuild the worker factory WITH pinned-
    // package workspace resolution so the materializer reads bytes from the
    // immutable store instead of the legacy workspaceRoot tree. resolveInstallationId
    // reads the ProcessRun pin set by the orchestrator (Seam B) from task metadata.
    const pinnedFactory = productLifecycle.packageInstallation
      ? createLegacyClaudeWorkerExecutorFactory({
        modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
        packageRegistry: productLifecycle.packageInstallation.registry,
        resolveInstallationId: assignment => {
          const meta = taskMetadataRecord(assignment);
          const runId = meta.process_run_id ?? nestedProcessWorkspaceField(meta, 'process_run_id');
          const n = Number(runId);
          if (!Number.isFinite(n) || n <= 0) return null;
          const row = getDb().prepare(
            'SELECT installation_id FROM saga3_process_runs WHERE id=?',
          ).get(n) as { installation_id?: number | null } | undefined;
          // ModuleInstallationId is a branded number; the DB PK is a plain number.
          const iid = row?.installation_id ?? null;
          return iid === null ? null : asModuleInstallationId(iid);
        },
        resolveNodeId: assignment => {
          const meta = taskMetadataRecord(assignment);
          const nodeId = meta.process_node_id;
          return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : null;
        },
      })
      : workerExecutorFactory;
    return createProductLifecycleRuntime({
      ...productLifecycle,
      workerExecutorFactory: pinnedFactory,
      resolveWorkerContext: context =>
        buildDiscoveryWorkerContext(config, persistence, host, context),
    }).engine;
  }

  // P6c: Universal ProcessModuleRuntime. Discovery исполняется как DATA через
  // GenericFlowExecutor — никакого Saga3DiscoveryEngine. Composition-root строит:
  //   1. KernelHandlerRegistry + регистрирует runtime-provided process-outcome-emitter;
  //   2. Discovery Pack подключает своё содержание через createDiscoveryKernelHandlers;
  //   3. Node executors (kernel + lm) поверх registry + WorkIntent projection;
  //   4. GenericFlowExecutor + GenericFlowEngineAdapter (bridge к OrchestrationEngine);
  //   5. ProcessModuleInstallationRegistry (handler-coverage валидируется при установке).
  // После зелёного E2E (шаг 7) ветка ниже становится primary, а legacy
  // 'saga3-discovery' branch удаляется (шаг 6).
  if (isSaga3DiscoveryGenericMode(config.orchestrationMode)) {
    return buildDiscoveryGenericEngine(config, persistence, workerExecutorFactory, host);
  }

  if (isSaga3DiscoveryMode(config.orchestrationMode)) {
    const runtimePersistence = new SqliteSaga3DiscoveryRuntime();
    const normalizationService = new Saga3DiscoveryNormalizationService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    const readinessService = new Saga3DiscoveryReadinessService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    // D4: kernel-only settlement service — no worker executor, no LM client.
    const settlementService = new Saga3DiscoverySettlementService({
      runtimePersistence,
    });
    // D5: advisory diagnosis service. Mirrors the readiness/settlement service
    // wiring: a bounded worker lifecycle over the runtime persistence port. The
    // diagnosis is ADVISORY ONLY — it never changes the D4 authoritative result.
    const diagnosisService = new Saga3DiscoveryDiagnosisService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    const discoveryEngine = new Saga3DiscoveryEngine({
      config,
      workerExecutorFactory,
      persistence,
      host,
      runtimePersistence,
      normalizationService,
      readinessService,
      settlementService,
      diagnosisService,
    });

    const registry = new ProcessModuleRegistry();
    registry.register(discoveryProcessModule);
    return new ProcessModuleRuntimeEngine(
      registry,
      DISCOVERY_PROCESS_MODULE_REF,
      new ExistingOrchestrationEngineAdapter(
        DISCOVERY_PROCESS_MODULE_REF,
        discoveryEngine,
        (_module, result) => {
          const certificateId = result.settlement?.certificateId;
          const proposalId = result.proposalId;
          return {
            code: result.outcome ?? result.reason,
            authority: result.outcomeAuthority ?? null,
            outputRef: certificateId !== undefined && certificateId !== null
              ? `certificate:${certificateId}`
              : proposalId !== undefined && proposalId !== null
                ? `proposal:${proposalId}`
                : null,
          };
        },
      ),
    );
  }

  // saga3-formalization mode. Mounts the Formalization Process Module and runs
  // the settlement+certificate THIN SHIM (one-shot, no poll-loop). The
  // formalization workers themselves are still driven by saga2 or saga-dispatch
  // — this branch only governs the ProcessRun + certificate lifecycle. This is
  // the universality proof: the SAME OrchestrationEngine port, the SAME
  // composition-root switch shape, NO changes to ProcessModuleRuntimeEngine.
  if (isSaga3FormalizationMode(config.orchestrationMode)) {
    const db = getDb();
    const processRunRepo = new SqliteProcessRunRepository(db);
    const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
    // The default case resolver: assumes the command's epicId is the formalization
    // epic; the discovery lineage is supplied via the command's metadata. This
    // is the operator-driven path (manual composition Discovery→Formalization).
    // The Lifecycle Orchestrator (P12) will automate this.
    return new Saga3FormalizationEngine({
      db,
      processRunRepo,
      certificateRepo,
      resolveFormalizationCase: command => {
        const meta = (command as { metadata?: Record<string, unknown> }).metadata ?? {};
        const discoveryEpicId = Number(meta.discoveryEpicId ?? 0);
        const discoveryCertificateRef = String(meta.discoveryCertificateRef ?? '');
        const discoveryCertificateHash = String(meta.discoveryCertificateHash ?? '');
        const discoveryOutcome = String(meta.discoveryOutcome ?? 'go');
        return {
          discoveryEpicId,
          formalizationEpicId: command.epicId,
          discoveryCertificateRef,
          discoveryCertificateHash,
          discoveryOutcome,
          initiatedBy: String(meta.initiatedBy ?? 'operator'),
        };
      },
    });
  }
  // Every other recognised mode (v2 / v3 / saga2) selects Saga2Engine. An
  // unknown mode never reaches here — parseOrchestrationMode rejects it at
  // config-load time, so there is no silent fallback to the wrong engine.
  return new Saga2Engine({
    config,
    workerExecutorFactory,
    persistence,
    host,
  });
}

/**
 * P6c: build the Universal ProcessModuleRuntime for Discovery.
 *
 * The runtime core (GenericFlowExecutor + node executors + handler registry)
 * contains ZERO references to discovery-specific symbols. Discovery Pack plugs
 * its content in via createDiscoveryKernelHandlers (registered under the ids
 * declared in the descriptor) and via the execution profiles declared in
 * discoveryProcessModule. The same build path will serve Formalization,
 * Verification, … — only the module ref + handler registrations change.
 */
function buildDiscoveryGenericEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
): OrchestrationEngine {
  const db = getDb();
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const runtimePersistence = new SqliteSaga3DiscoveryRuntime();

  // 1. Kernel handler registry — runtime mechanics. Register the runtime-provided
  //    process-outcome-emitter, then let Discovery Pack register its content.
  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
  handlerRegistry.registerAll(createDiscoveryKernelHandlers({ runtimePersistence }));

  // 2. Catalog + Installation registries. Installation validation now checks
  //    kernel-handler coverage against the registry (fail-fast at startup).
  //    Wave 13 removed modules/catalog.ts; the discovery module definition is
  //    imported directly and registered inline.
  const discoveryModule = discoveryProcessModule;

  // 3. Node executors keyed by FlowNodeKind. LM executor needs the saga3
  //    runtime persistence (WorkIntent projection) — that adapter is generic by
  //    shape (parameterised in P6c step 2), only lives in saga3/ physically.
  const lmPersistence = createDiscoveryLmNodePersistence(runtimePersistence);
  const lmExecutor = new LmNodeExecutor({
    persistence: lmPersistence,
    workerExecutorFactory,
    resolveWorkerContext: (ctx) => buildDiscoveryWorkerContext(config, persistence, host, ctx),
  });
  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map<string, typeof kernelExecutor>([
    ['kernel', kernelExecutor],
    ['lm', lmExecutor as unknown as typeof kernelExecutor],
  ]);

  // 4. GenericFlowExecutor. Д6: NO settle callback — the Discovery settlement
  //    kernel handler builds the authoritative certificate envelope itself and
  //    carries it in the terminal production's bindings. Runtime only validates
  //    + atomically persists (Д7). resolveOutput is null: for Discovery the
  //    certificate IS the authoritative output.
  const genericExecutor = new GenericFlowExecutor({
    moduleRef: discoveryModule.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
  });

  // 5. Installation registry — validates the binding + handler coverage.
  const installationRegistry = new ProcessModuleInstallationRegistry(
    { kernelHandlerRegistry: handlerRegistry },
  );
  installationRegistry.register(
    { definition: discoveryModule, executor: genericExecutor },
  );
  // Sanity: the installation actually registered.
  installationRegistry.require(DISCOVERY_PROCESS_MODULE_REF);

  // 6. Bridge GenericFlowExecutor → OrchestrationEngine via the runtime wrapper.
  //    The module input payload carries the EPIC's product objective (real
  //    task description from the epic row) — not a hardcoded placeholder. The
  //    LM-node executor reads it from ctx.input so the worker sees the actual
  //    product brief the operator wrote when bootstrapping the epic.
  const adapter = new GenericFlowEngineAdapter({
    moduleRef: DISCOVERY_PROCESS_MODULE_REF,
    executor: genericExecutor,
    processRunRepo,
    resolveInputPayload: (command) => {
      const objective = runtimePersistence.readEpicObjective(command.epicId);
      return {
        epicId: command.epicId,
        projectId: command.projectId,
        epicName: objective?.name ?? '',
        // The epic description IS the product brief — what to discover. Empty
        // fallback is fine; the worker skill handles missing context.
        objective: objective?.description ?? objective?.name ?? '',
      };
    },
    resolveIdempotencyKey: (command) => `discovery-generic-epic-${command.epicId}`,
    finalStage: 'discovery',
    initiatedBy: 'generic-flow-runtime',
  });

  // 7. Catalog registry holding the discovery module. Wave 13 removed
  //    modules/catalog.ts; the registry is built inline from the discovery
  //    definition. The runtime engine resolves the module by ref from here.
  const catalog = new ProcessModuleRegistry();
  catalog.register(discoveryModule);

  return new ProcessModuleRuntimeEngine(
    catalog,
    DISCOVERY_PROCESS_MODULE_REF,
    adapter,
  );
}

/**
 * Build the WorkerExecutorFactoryContext for one LM-node spawn. Mirrors the
 * legacy saga3-discovery engine's workspace resolution; the values come from
 * config + the episode's project repository (generic — no discovery literal).
 */
function buildDiscoveryWorkerContext(
  config: SagaRuntimeConfig,
  _persistence: Saga2RuntimePersistence,
  _host: Saga2HostRuntime,
  ctx: { projectId: number; epicId: number | null },
): import('../application/ports/worker-executor.js').WorkerExecutorFactoryContext {
  return {
    projectId: ctx.projectId,
    epicId: ctx.epicId ?? 0,
    workspaceRoot: process.cwd(),
    dbPath: config.dbPath,
    // sagaEntry MUST point at the MCP server (dist/index.js), not at the
    // currently running script. process.argv[1] is the orchestrate-cli entry
    // point when the engine is launched as `node dist/orchestrate-cli.js`, and
    // orchestrate-cli is NOT an MCP server. The runner writes this entry into
    // the per-execution `--mcp-config` (writeExecutionMcpConfig), claude then
    // spawns it as the `saga` stdio MCP child, and because orchestrate-cli does
    // not speak MCP it fails to register — the worker silently loses every
    // mcp__saga__* tool (task_get / proposal_submit / worker_done / ...).
    // Verified empirically: spawning dist/index.js with the same env lists
    // 70+ saga tools; spawning dist/orchestrate-cli.js lists none.
    // Resolve the entry from package.json bin.saga-mcp so it stays in lockstep
    // with the published artefact. SAGA_MCP_ENTRY overrides for tests / custom
    // installs.
    sagaEntry: resolveSagaMcpEntry(),
    sagaSkillRoot: process.cwd() + '/skills',
    lmStudioUrl: process.env.LM_STUDIO_URL ?? 'http://127.0.0.1:1234',
  };
}

function resolveSagaMcpEntry(): string {
  const explicit = process.env.SAGA_MCP_ENTRY;
  if (explicit) return explicit;
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {
      bin?: Record<string, string> | string;
      main?: string;
    };
    const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['saga-mcp'];
    if (binPath) {
      return fileURLToPath(new URL(`../../${binPath}`, import.meta.url));
    }
    if (pkg.main) {
      return fileURLToPath(new URL(`../../${pkg.main}`, import.meta.url));
    }
  } catch {
    // fall through to the hard-coded path
  }
  return fileURLToPath(new URL('../../dist/index.js', import.meta.url));
}

/**
 * Best-effort JSON parse for task.metadata. Returns null on failure (mirrors
 * the defensive parse in legacy-claude-worker-executor-factory's prepareWorkspace).
 */
function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Read a task's metadata as a Record (parsing JSON if stored as a string).
 * RunnerAssignment.task.metadata is loosely typed; this normalizes it.
 */
function taskMetadataRecord(assignment: { task?: { metadata?: unknown } }): Record<string, unknown> {
  const raw = assignment?.task?.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    return safeParseJson(raw) ?? {};
  }
  return {};
}

/**
 * Read a field nested under metadata.process_workspace.<field> (the workspace
 * projection sometimes records the run id there).
 */
function nestedProcessWorkspaceField(
  meta: Record<string, unknown>,
  field: string,
): unknown {
  const pw = meta.process_workspace;
  if (pw && typeof pw === 'object' && !Array.isArray(pw)) {
    return (pw as Record<string, unknown>)[field];
  }
  return undefined;
}
