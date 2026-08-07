import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { EngineAdministration } from '../application/ports/engine-administration.js';
import type { WorkerHostRuntime } from '../application/ports/worker-host-runtime.js';
import type { FactoryRuntimePersistence } from '../application/ports/factory-runtime-persistence.js';
import type { WorkerExecutorFactory, WorkAssignmentPort } from '../application/ports/worker-executor.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSagaApplication,
  createSagaControlApplication as createControlApplication,
  type SagaApplication,
  type SagaControlApplication,
} from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { asModuleInstallationId } from '../process-modules/installation/domain/installation.js';
import type { ProductionInstallation } from '../process-modules/installation/production-install.js';
import type { OrchestrationEngine } from '../application/ports/orchestration-engine.js';
import { EngineProcessAdministration } from '../infrastructure/engine/engine-administration.js';
import {
  SqliteEpisodeRuntimeRepository,
  SqliteExecutionRuntimeRepository,
  SqliteTaskRuntimeRepository,
} from '../infrastructure/persistence/sqlite-factory-runtime-repositories.js';
import { SqliteBoardProjectionReader } from '../infrastructure/projections/sqlite-board-projection-reader.js';
import { NodeWorkerHostRuntime } from '../infrastructure/runtime/node-worker-host-runtime.js';
import { createPinnedClaudeWorkerExecutorFactory } from '../infrastructure/workers/claude-worker-executor-factory.js';
import { SqliteWorkAssignmentAdapter } from '../infrastructure/work/sqlite-work-assignment-adapter.js';
import {
  createExecutionRouteResolver,
  type ExecutionRouteResolverOptions,
} from '../application/routing/execution-route-resolver.js';
import type { RouteResolverFn } from '../infrastructure/work/sqlite-work-assignment-adapter.js';
import { setWorkerRouteResolver } from '../tools/dispatcher.js';
import { SqliteWorkspaceResolver } from '../infrastructure/workspaces/sqlite-workspace-resolver.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';
import {
  isFactoryLifecycleMode,
} from '../runtime/orchestration-mode.js';
import { getDb } from '../db.js';
import {
  prepareDevelopmentWorkspaceTemplate,
} from '../modules/development/application/development-workspace-preparation.js';
import {
  createProductLifecycleRuntime,
  type ProductLifecycleRuntimeOptions,
} from './product-lifecycle-runtime.js';

export type ProductLifecycleCompositionOverrides = Omit<
  ProductLifecycleRuntimeOptions,
  'workerExecutorFactory' | 'resolveWorkerContext'
>;

export interface FactoryCompositionOverrides {
  config?: SagaRuntimeConfig;
  workerExecutorFactory?: WorkerExecutorFactory;
  persistence?: FactoryRuntimePersistence;
  host?: WorkerHostRuntime;
  board?: BoardProjectionReader;
  engineAdministration?: EngineAdministration;
  /** Immutable module packages available to standalone generic module runs. */
  modulePackages?: ProductionInstallation;
  /**
   * Explicit Delivery provider composition for factory-lifecycle mode.
   * Standard Development/SQLite mechanics are supplied by the lifecycle
   * factory; no deployment success or human decision is silently selected.
   */
  productLifecycle?: ProductLifecycleCompositionOverrides;
  /**
   * Execution-route resolver options (routing cutover). When supplied, a route
   * resolver is constructed ONCE here (the single spawn-side authority) and
   * wired into BOTH the WorkAssignmentPort (so the route is frozen at claim)
   * and the MCP worker_next path. When omitted, the legacy model-route-only
   * path is used (every execution runs on the real claude CLI).
   */
  executionRouteResolverOptions?: ExecutionRouteResolverOptions;
  close?: () => void;
}

export type SagaControlCompositionOverrides = Pick<
  FactoryCompositionOverrides,
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
    ?? new EngineProcessAdministration({ config, baseEnv: env });
  return createControlApplication({
    board,
    engineAdministration,
    close: overrides.close ?? closeDb,
  });
}

/**
 *
 * CLI and HTTP hosts consume SagaApplication and do not import the pump,
 * ClaudeBoardRunner, SQLite projection SQL, process control or environment.
 */
export function createFactoryApplication(
  env: NodeJS.ProcessEnv = process.env,
  overrides: FactoryCompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const persistence = overrides.persistence ?? {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };
  const packageInstallation = overrides.modulePackages
    ?? overrides.productLifecycle?.packageInstallation;

  // Routing cutover: construct the route resolver ONCE here. This is the single
  // spawn-side authority — it decides which backend (executor + provider +
  // model) runs each worker, by matching the task's (module, cell, role,
  // executionProfile) key against the policy. The resolver is frozen at claim
  // time (immutable per run), so a config edit mid-run cannot change the route
  // of an already-reserved execution.
  const routeResolver = overrides.executionRouteResolverOptions
    ? createExecutionRouteResolver(overrides.executionRouteResolverOptions)
    : null;
  const routeResolverFn: RouteResolverFn | undefined = routeResolver
    ? (key => routeResolver.resolve(key))
    : undefined;
  // Register the resolver globally so the MCP worker_next path (when a worker
  // calls worker_next directly) also freezes the route at claim. This is the
  // ONE route authority for every claim path.
  if (routeResolverFn) setWorkerRouteResolver(routeResolverFn);
  else setWorkerRouteResolver(null);

  // ONE WorkAssignmentPort for the whole factory, carrying the route resolver.
  // Both the lifecycle-node path (engine) and the dispatch-loop path use this
  // exact port — there is no second assignment authority.
  const workAssignment: WorkAssignmentPort = new SqliteWorkAssignmentAdapter(
    getDb(),
    routeResolverFn,
  );
  // Publish the port so the dispatch-loop (orchestrate-cli) reuses it instead
  // of constructing a second adapter. One spawn point, one assignment authority.
  lastFactoryWorkAssignment = workAssignment;

  // Claude worker factory is GONE — the only legal desk creator is
  // `materializePinnedWorkspace`, which resolves from an immutable package
  // snapshot. A missing packageInstallation is now a configuration error
  // (e.g. tests that did not wire `modulePackages`/`productLifecycle`).
  // Callers may still inject `overrides.workerExecutorFactory` to bypass.
  const workerExecutorFactory = overrides.workerExecutorFactory
    ?? (packageInstallation
      ? createPinnedWorkerFactory(persistence, packageInstallation, workAssignment, {
        realClaudePath: env.SAGA_REAL_CLAUDE_PATH,
        simulatorPath: env.SAGA_SIMULATOR_PATH,
      })
      : (() => {
        throw new Error(
          'PACKAGE_INSTALLATION_REQUIRED: createFactoryApplication did not receive '
          + 'overrides.modulePackages or overrides.productLifecycle.packageInstallation. '
          + 'Every Process Module execution resolves its WorkplaceDesk from an '
          + 'immutable pinned package snapshot.',
        );
      })());
  // Publish the factory so the dispatch-loop reuses it — one spawn point.
  lastFactoryWorkerExecutorFactory = workerExecutorFactory;
  const host = overrides.host ?? new NodeWorkerHostRuntime({
    workerPaths: config.orchestrationLogRoot
      ? {
          logRoot: config.orchestrationLogRoot,
          heartbeatLog: path.join(config.orchestrationLogRoot, 'worker-heartbeat.log'),
        }
      : undefined,
  });
  const engine = selectEngine(
    config,
    persistence,
    workerExecutorFactory,
    host,
    overrides.productLifecycle,
    packageInstallation,
  );
  const board = overrides.board ?? new SqliteBoardProjectionReader(config.dbPath);
  const engineAdministration = overrides.engineAdministration
    ?? new EngineProcessAdministration({ config, baseEnv: env });

  return createSagaApplication({
    engine,
    board,
    engineAdministration,
    close: overrides.close ?? closeDb,
  });
}

/**
 * Module-scoped handle to the single WorkAssignmentPort created by the most
 * recent createFactoryApplication call. The dispatch-loop (orchestrate-cli)
 * retrieves it via {@link getLastFactoryWorkAssignment} so it shares the SAME
 * assignment authority + route resolver as the lifecycle-node path — no second
 * SqliteWorkAssignmentAdapter is constructed. One spawn point, one assignment
 * authority.
 *
 * This is intentionally a side-channel rather than a SagaApplication field:
 * SagaApplication is an engine-neutral boundary and must not carry worker
 * assignment infrastructure.
 */
let lastFactoryWorkAssignment: WorkAssignmentPort | null = null;
let lastFactoryWorkerExecutorFactory: WorkerExecutorFactory | null = null;

/**
 * Retrieve the WorkAssignmentPort from the most recent createFactoryApplication
 * call. Used by the dispatch-loop so it does not construct a second adapter.
 */
export function getLastFactoryWorkAssignment(): WorkAssignmentPort | null {
  return lastFactoryWorkAssignment;
}

/**
 * Retrieve the WorkerExecutorFactory from the most recent createFactoryApplication
 * call. Used by the dispatch-loop so it shares the SAME factory as the
 * lifecycle-node path — one spawn point, one factory.
 */
export function getLastFactoryWorkerExecutorFactory(): WorkerExecutorFactory | null {
  return lastFactoryWorkerExecutorFactory;
}

/**
 * Selects the concrete orchestration engine behind the OrchestrationEngine port.
 *
 * saga4 cutover: the Product Lifecycle runtime is the SOLE engine. The
 * those engines are reachable only by direct construction in tests now.
 * `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` must be set so `overrides.productLifecycle`
 * carries the explicit Delivery preflight/publication/observation providers.
 */
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: FactoryRuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: WorkerHostRuntime,
  productLifecycle: ProductLifecycleCompositionOverrides | undefined,
  modulePackages: ProductionInstallation | undefined,
): OrchestrationEngine {
  void isFactoryLifecycleMode; // retained predicate; now trivially true
  if (!productLifecycle) {
    throw new Error(
      'PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED: createFactoryApplication '
      + 'must receive overrides.productLifecycle with explicit Delivery '
      + 'preflight/publication/observation providers. After the saga4 cutover '
      + 'the lifecycle runtime is the only engine; SAGA_PRODUCT_LIFECYCLE_COMPOSITION '
      + 'must be set (see orchestrate-cli.ts).',
    );
  }
  return createProductLifecycleRuntime({
    ...productLifecycle,
    workerExecutorFactory,
    resolveWorkerContext: context =>
      buildDiscoveryWorkerContext(config, persistence, host, context),
    concurrency: positiveConcurrency(process.env.SAGA_CONCURRENCY),
    packageInstallation: modulePackages
      ?? productLifecycle.packageInstallation,
  }).engine;
}

/**
 * Build the WorkerExecutorFactoryContext for one LM-node spawn. Mirrors the
 * config + the episode's project repository (generic — no discovery literal).
 */
function buildDiscoveryWorkerContext(
  config: SagaRuntimeConfig,
  persistence: FactoryRuntimePersistence,
  host: WorkerHostRuntime,
  ctx: { projectId: number; epicId: number | null },
): import('../application/ports/worker-executor.js').WorkerExecutorFactoryContext {
  const workspace = persistence.workspaces.resolve(ctx.projectId);
  if (!workspace.projectExists) {
    throw new Error(`PROJECT_NOT_FOUND: project ${ctx.projectId}`);
  }
  if (!workspace.workspaceRoot) {
    throw new Error(
      `PROJECT_WORKSPACE_NOT_FOUND: project ${ctx.projectId} has no active local checkout`,
    );
  }
  const sagaRepoRoot = process.env.SAGA_REPO_ROOT ?? process.cwd();
  return {
    projectId: ctx.projectId,
    epicId: ctx.epicId ?? 0,
    workspaceRoot: workspace.workspaceRoot,
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
    sagaSkillRoot: `${sagaRepoRoot}/skills`,
    claudePath: config.claudePath,
    logRoot: host.workerPaths.logRoot,
    heartbeatLog: host.workerPaths.heartbeatLog,
    lmStudioUrl: config.lmStudioUrl,
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
 * Build the existing Claude worker adapter against immutable module packages.
 * This is host wiring shared by standalone module runs and lifecycle scenarios;
 * module-specific behavior remains in the package definition and handlers.
 *
 * Routing cutover: the WorkAssignmentPort is now supplied by the caller so the
 * SAME port (with the SAME route resolver) is shared between the lifecycle node
 * path and the dispatch-loop path. There is ONE spawn point, ONE assignment
 * authority, and ONE route resolver — not two parallel factories.
 */
function createPinnedWorkerFactory(
  persistence: FactoryRuntimePersistence,
  installation: ProductionInstallation,
  workAssignment: WorkAssignmentPort,
  executorPaths: { realClaudePath?: string; simulatorPath?: string } = {},
): WorkerExecutorFactory {
  return createPinnedClaudeWorkerExecutorFactory({
    modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
    packageRegistry: installation.registry,
    packageSnapshots: installation.packages,
    resolveInstallationId: assignment => {
      const runId = processRunIdFromAssignment(assignment);
      if (runId === null) return null;
      const row = getDb().prepare(
        'SELECT installation_id FROM factory_process_runs WHERE id=?',
      ).get(runId) as { installation_id?: number | null } | undefined;
      const id = row?.installation_id ?? null;
      return id === null ? null : asModuleInstallationId(id);
    },
    resolvePackageDigest: assignment => {
      const runId = processRunIdFromAssignment(assignment);
      if (runId === null) return null;
      const row = getDb().prepare(
        'SELECT package_digest FROM factory_process_runs WHERE id=?',
      ).get(runId) as { package_digest?: string | null } | undefined;
      return row?.package_digest ?? null;
    },
    resolveNodeId: assignment => {
      const nodeId = taskMetadataRecord(assignment).process_node_id;
      return typeof nodeId === 'string' && nodeId.length > 0 ? nodeId : null;
    },
    workspaceTemplatePreparers: new Map([
      ['solution-development@1.0.0', prepareDevelopmentWorkspaceTemplate],
    ]),
    // CONVEYOR: route card assignment through the atomic WorkAssignmentPort —
    // the card is assigned + fenced in one IMMEDIATE transaction before the
    // worker process is spawned, closing the loose-preselector race window.
    // The port is supplied by the caller (createFactoryApplication) so the
    // dispatch-loop path shares the SAME assignment authority + route resolver.
    workAssignment,
    // Routing cutover: explicit executor backend paths. The runner selects the
    // binary from the FROZEN executor_kind; these two paths are the targets.
    realClaudePath: executorPaths.realClaudePath,
    simulatorPath: executorPaths.simulatorPath,
  });
}

function processRunIdFromAssignment(
  assignment: { task?: { metadata?: unknown } },
): number | null {
  const metadata = taskMetadataRecord(assignment);
  const raw = metadata.process_run_id
    ?? nestedProcessWorkspaceField(metadata, 'process_run_id');
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Best-effort JSON parse for task.metadata. Returns null on failure (mirrors
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

function positiveConcurrency(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}
