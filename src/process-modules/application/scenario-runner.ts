/**
 * ScenarioInstaller + ScenarioRunner — generic services that orchestrate a
 * `LifecycleScenarioManifest` end to end.
 *
 * # What this file owns
 *
 *   1. `ScenarioInstaller` — install a scenario manifest: validate it
 *      (delegates to the scenario compiler), resolve every `ModuleSelector`
 *      to an exact `InstalledProcessModule` against the package registry,
 *      persist the resulting `ScenarioModuleLock`, and return an
 *      `InstalledScenario` carrying the frozen lock + the manifest snapshot.
 *
 *   2. `ScenarioRunner` — execute an installed scenario: resolve the
 *      `ScenarioExecutionLease`, walk stages via the injected
 *      `ProcessModuleExecutor` (the existing SPI — no Runtime change), route
 *      outcomes through the static `outcomeRoutes` table (declarative router
 *      — NO `routeResolver` function anywhere), persist each public stage
 *      output once via the stage-output store (NO cumulative frame), and stop
 *      at the first terminal outcome.
 *
 * # Sibling-port declarations
 *
 * The sibling ports (module-lock, compiler, router, stage-output) are declared
 * HERE as consumer-side structural interfaces. TypeScript structural typing
 * makes these assignment-compatible with the canonical declarations. See
 * `docs/architecture/WAVE-LOG.md` (Wave 7) for the parallel-lane context.
 *
 * # Purity / dependency tier
 *
 * Application-layer orchestrator (like `lifecycle-orchestrator.ts`): it
 * imports application ports, persistence ports, and domain SPI types. It is
 * NOT pure domain — it coordinates ports. It does NOT import any `sqlite-*`
 * adapter, `db.ts`, `schema.ts`, or any `modules/*` module implementation.
 * The dependency-direction ratchet
 * (`tests/architecture/dependency-direction.test.mjs`) enforces this.
 */

import { randomUUID } from 'node:crypto';

import type {
  LifecycleIdentity,
  TransitionTarget,
} from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import type {
  LifecycleScenarioManifest,
  ModuleSelector,
  ScenarioStageBinding,
} from '../domain/spi/scenario-manifest.js';
import type {
  LifecycleExecutionLease,
  LifecycleRunRecord,
  LifecycleStageRunRecord,
  StartLifecycleCommand,
} from '../persistence/lifecycle-run.js';
import type { LifecycleRunRepository } from '../persistence/lifecycle-run-repository.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
  ProcessRunRecord,
} from '../persistence/process-run.js';
import type { ProcessRunRepository } from '../persistence/process-run-repository.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';

import type { ProcessModuleInstallation, ProcessModuleRunResult } from './process-module-executor.js';
import type { ProcessModuleInstallationRegistry } from './process-module-installation-registry.js';

// ---------------------------------------------------------------------------
// Sibling-port declarations — see module header policy.
// These mirror the canonical contracts structurally; TypeScript structural
// typing makes them assignment-compatible at integration time.
// ---------------------------------------------------------------------------

/**
 * Resolution of ONE scenario-stage `ModuleSelector` against the package
 * registry. Carries the exact installed module identity the scenario will
 * pin for that stage.
 *
 * `installationId` / `packageDigest` pin BOTH so an in-flight upgrade cannot
 * change behavior mid-run.
 */
export interface ScenarioModuleLockEntry {
  /** Stage id this resolution applies to (one of `manifest.stageBindings[].id`). */
  readonly stageId: string;
  /** The selector that was resolved. */
  readonly selector: ModuleSelector;
  /** Exact installed module identity. */
  readonly installedModuleRef: ProcessModuleReference;
  /** Installation row id pinned for replay. */
  readonly installationId: number;
  /** Content-addressed package digest pinned for replay. */
  readonly packageDigest: string;
}

/**
 * The complete module lock for one scenario: one entry per stage binding.
 * Immutable after the ScenarioInstaller writes it; the ScenarioRunner reads
 * it verbatim and refuses to run if any stage is missing.
 *
 * `lockDigest = sha256Hex(canonicalJson(entries))`. Any drift in any resolved
 * module identity changes the digest, making tampering detectable at run time.
 */
export interface ScenarioModuleLock {
  /** Scenario identity the lock was computed for. */
  readonly scenarioIdentity: LifecycleIdentity;
  /** Stable per-stage resolutions, indexed by `stageId`. Order = manifest order. */
  readonly entries: readonly ScenarioModuleLockEntry[];
  /** Content-addressed digest over `entries`. */
  readonly lockDigest: string;
}

/**
 * Result of module-selector resolution for a manifest. The installer passes
 * the manifest + the package registry to the resolver and receives a complete
 * `ScenarioModuleLock`. If a selector cannot be resolved (no installed module
 * matches the range, or the active installation is missing), the resolver
 * throws a typed error.
 *
 * The port is an async function (the package registry may resolve over I/O).
 */
export type ScenarioModuleLockResolver = (
  manifest: LifecycleScenarioManifest,
) => Promise<ScenarioModuleLock>;

/**
 * Persistence port for the scenario module lock (backed by the
 * `saga3_scenario_module_locks` table).
 *
 * Idempotent on `(scenarioIdentity, lockDigest)`: writing the same lock twice
 * returns the existing record. The installer writes once at install time; the
 * runner reads by scenario identity at run time.
 */
export interface ScenarioModuleLockStore {
  write(lock: ScenarioModuleLock): Promise<ScenarioModuleLock>;
  read(scenarioIdentity: LifecycleIdentity): Promise<ScenarioModuleLock | null>;
}

/**
 * Scenario-compiler validation result. The compiler validates a
 * `LifecycleScenarioManifest` end to end: manifest-shape validation (delegated
 * to `validateLifecycleScenarioManifest`), mapping type-checking against
 * module contracts, route-table completeness, graph reachability,
 * terminal-outcome coverage, and budget validation.
 *
 * The installer runs this BEFORE resolving any module selector, so a manifest
 * with a structurally broken route table is rejected without touching the
 * package registry.
 */
export interface ScenarioCompilationResult {
  readonly ok: boolean;
  readonly errors: readonly ScenarioCompilationError[];
}

export interface ScenarioCompilationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Scenario compiler port. Pure (no I/O): takes a manifest, returns a
 * validation result.
 */
export type ScenarioCompiler = (
  manifest: LifecycleScenarioManifest,
) => ScenarioCompilationResult;

/**
 * Declarative router. Resolves the next transition target for a stage
 * outcome by looking it up in the manifest's STATIC `outcomeRoutes` table —
 * there is NO `routeResolver` function anywhere. The router may ALSO enforce
 * transition+reentry budgets (declared on the manifest) and throw when a
 * budget is exhausted.
 *
 * The router is injected (not called as a free function) so the runner does
 * not import the router module directly — keeps the file's sibling-port
 * surface uniform.
 */
export interface ScenarioRouter {
  resolveTransition(params: {
    readonly manifest: LifecycleScenarioManifest;
    readonly stage: ScenarioStageBinding;
    readonly outcome: string;
    /** Prior transitions in this run, for budget enforcement. */
    readonly transitionHistory: readonly ScenarioTransitionRecord[];
    /** Reentry count per stage id so far in this run. */
    readonly reentryCounts: Readonly<Record<string, number>>;
  }): TransitionTarget;
}

/**
 * Budget-exhaustion error. Thrown by the router when
 * `manifest.transitionBudgets.maxTransitions` or
 * `reentryBudgets.maxReentries` (or a per-stage cap) is exceeded.
 */
export class ScenarioBudgetExhaustedError extends Error {
  constructor(
    readonly budget: 'transition' | 'reentry',
    readonly stageId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioBudgetExhaustedError';
  }
}

/**
 * A stored public stage output. Content-addressed: `contentHash` is
 * `sha256Hex` of the canonical output payload, so the same logical output
 * stored twice collapses to one row.
 */
export interface ScenarioStageOutputRecord {
  readonly scenarioRunId: number;
  readonly stageId: string;
  /** Schema id from the producing module's output contract. */
  readonly outputSchema: string;
  /** Content-addressed reference (mirror of ProcessModuleOutput.artifactRef). */
  readonly artifactRef: string;
  readonly contentHash: string;
  /** The mapped public output payload (after outputMapping). */
  readonly payload: unknown;
}

/**
 * Stage-output store port. Persists each public stage output ONCE, keyed by
 * `(scenarioRunId, stageId, contentHash)`. Replays return the existing row;
 * the runner never re-stores an already-persisted output.
 *
 * The store also exposes the run's lifecycle variables (projectId, epicId,
 * initiatedBy, lifecycleRunId, stageRunId) so mappings can resolve
 * `{ runtime: ... }` expressions without a cumulative frame.
 */
export interface ScenarioOutputStore {
  /** Persist a public stage output. Idempotent on content-hash. */
  storeOutput(record: ScenarioStageOutputRecord): Promise<ScenarioStageOutputRecord>;
  /** List every public output produced by a run, in stage order. */
  listOutputs(scenarioRunId: number): Promise<readonly ScenarioStageOutputRecord[]>;
}

/**
 * One recorded transition in a scenario run (router history). Used for budget
 * enforcement and audit. Mirrors the legacy `LifecycleTransitionRecord` but
 * carries only the scenario-relevant fields.
 */
export interface ScenarioTransitionRecord {
  readonly fromStageId: string;
  readonly outcome: string;
  readonly target: TransitionTarget;
  readonly stageRunId: number;
}

// ---------------------------------------------------------------------------
// InstalledScenario (ScenarioInstaller output).
// ---------------------------------------------------------------------------

/**
 * The frozen, lock-pinned description of an installed scenario. This is what
 * the ScenarioRunner consumes. Carries:
 *   - the manifest snapshot (canonical JSON, hashed);
 *   - the resolved module lock (one InstalledProcessModule per stage);
 *   - the resolved `ProcessModuleInstallation` per stage (looked up against
 *     the existing `ProcessModuleInstallationRegistry` so the runner can drive
 *     the executor without re-resolving).
 *
 * `manifestHash` content-addresses the manifest snapshot; `lockDigest`
 * content-addresses the lock. Both are persisted on the LifecycleRun so an
 * in-flight upgrade cannot change behavior mid-run.
 */
export interface InstalledScenario {
  readonly manifest: LifecycleScenarioManifest;
  readonly manifestSnapshot: string;
  readonly manifestHash: string;
  readonly lock: ScenarioModuleLock;
  /**
   * Per-stage installation binding, indexed by `stageId`. Resolved by the
   * installer against `ProcessModuleInstallationRegistry.require(...)` AFTER
   * the lock is written, so the runner never has to resolve at run time.
   */
  readonly installationsByStageId: Readonly<Record<string, ProcessModuleInstallation>>;
}

// ---------------------------------------------------------------------------
// ScenarioInstaller errors.
// ---------------------------------------------------------------------------

/** Error code constants. Stable so callers can match without importing. */

/** Compiler returned `{ ok: false }`. */
export const SCENARIO_INSTALL_MANIFEST_INVALID = 'SCENARIO_INSTALL_MANIFEST_INVALID';
/** A `ModuleSelector` could not be resolved to an active installation. */
export const SCENARIO_INSTALL_MODULE_UNRESOLVED = 'SCENARIO_INSTALL_MODULE_UNRESOLVED';
/** A resolved installation is not registered in the ProcessModuleInstallationRegistry. */
export const SCENARIO_INSTALL_NOT_INSTALLED = 'SCENARIO_INSTALL_NOT_INSTALLED';
/** The lock store rejected the write (collision with a different digest). */
export const SCENARIO_INSTALL_LOCK_WRITE_FAILED = 'SCENARIO_INSTALL_LOCK_WRITE_FAILED';

export class ScenarioInstallerError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ScenarioInstallerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// ScenarioInstaller options + deps.
// ---------------------------------------------------------------------------

/**
 * Injected dependencies for the ScenarioInstaller. Every collaborator is a
 * PORT — the installer owns no storage and no module-implementation imports.
 */
export interface ScenarioInstallerDeps {
  /** Compiler — pure manifest validation. */
  readonly compiler: ScenarioCompiler;
  /** Lock resolver — resolves selectors against the package registry. */
  readonly lockResolver: ScenarioModuleLockResolver;
  /** Lock store — persists the resolved lock. */
  readonly lockStore: ScenarioModuleLockStore;
  /**
   * Existing ProcessModuleInstallationRegistry. The installer resolves each
   * `installedModuleRef` against it so the runner receives a fully-bound
   * `InstalledScenario` and never has to look up an executor at run time.
   */
  readonly installationRegistry: ProcessModuleInstallationRegistry;
}

// ---------------------------------------------------------------------------
// ScenarioInstaller.
// ---------------------------------------------------------------------------

/**
 * `ScenarioInstaller` — pure orchestrator that turns a
 * `LifecycleScenarioManifest` into a frozen, lock-pinned
 * {@link InstalledScenario}.
 *
 * Stateless: holds no mutable fields. Construct once, call `install` any
 * number of times. All storage and resolution is delegated to the injected
 * {@link ScenarioInstallerDeps}.
 *
 * Install pipeline:
 *   1. `compiler.validate(manifest)`           — reject invalid.
 *   2. `lockResolver.resolve(manifest)`        — ModuleSelector → exact
 *                                                InstalledProcessModule per
 *                                                stage.
 *   3. `installationRegistry.require(ref)`     — bind each resolved module
 *                                                to its ProcessModuleInstallation.
 *   4. `lockStore.write(lock)`                 — persist the lock.
 *   5. return `InstalledScenario`               — manifest snapshot + hash,
 *                                                lock, per-stage installation.
 */
export class ScenarioInstaller {
  /**
   * Install `manifest` as a frozen, lock-pinned {@link InstalledScenario}.
   *
   * Failure modes surface as {@link ScenarioInstallerError} with a stable code:
   *   - {@link SCENARIO_INSTALL_MANIFEST_INVALID} — compiler rejected.
   *   - {@link SCENARIO_INSTALL_MODULE_UNRESOLVED} — a selector has no active
   *     installation matching its range.
   *   - {@link SCENARIO_INSTALL_NOT_INSTALLED} — the resolved module ref is not
   *     in the ProcessModuleInstallationRegistry (catalogued without executor).
   *   - {@link SCENARIO_INSTALL_LOCK_WRITE_FAILED} — lock store rejected.
   */
  async install(
    manifest: LifecycleScenarioManifest,
    deps: ScenarioInstallerDeps,
  ): Promise<InstalledScenario> {
    // Step 1 — compile / validate. The compiler runs the manifest validator
    // plus mapping type-checking, route completeness, graph reachability,
    // terminal-outcome coverage, and budget validation. A manifest that fails
    // here never touches the package registry.
    const compilation = deps.compiler(manifest);
    if (!compilation.ok) {
      throw new ScenarioInstallerError(
        SCENARIO_INSTALL_MANIFEST_INVALID,
        `scenario manifest failed compilation: ${compilation.errors
          .map((e) => `${e.path} [${e.code}] ${e.message}`)
          .join('; ')}`,
        compilation.errors,
      );
    }

    // Step 2 — resolve module selectors against the package registry. The
    // resolver produces one ScenarioModuleLockEntry per stage binding; an
    // unresolved selector (no active installation in range) throws a typed
    // error which we wrap as SCENARIO_INSTALL_MODULE_UNRESOLVED.
    let lock: ScenarioModuleLock;
    try {
      lock = await deps.lockResolver(manifest);
    } catch (e) {
      // If the resolver already produced a typed installer-shaped error, pass
      // it through; otherwise wrap with the canonical code.
      if (e instanceof ScenarioInstallerError) throw e;
      throw new ScenarioInstallerError(
        SCENARIO_INSTALL_MODULE_UNRESOLVED,
        `failed to resolve scenario module selectors: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }

    // Defensive: the lock MUST cover every stage. The lock resolver enforces
    // this, but we re-check here so a buggy resolver cannot produce a
    // runnable-but-broken scenario.
    const expectedStageIds = new Set(manifest.stageBindings.map((s) => s.id));
    const resolvedStageIds = new Set(lock.entries.map((e) => e.stageId));
    for (const stageId of expectedStageIds) {
      if (!resolvedStageIds.has(stageId)) {
        throw new ScenarioInstallerError(
          SCENARIO_INSTALL_MODULE_UNRESOLVED,
          `module lock is missing a resolution entry for stage '${stageId}'`,
          { stageId },
        );
      }
    }

    // Step 3 — bind each resolved module ref to its ProcessModuleInstallation.
    // The runner needs the executor (ProcessModuleExecutor) per stage; we
    // resolve against the existing registry here so run-time dispatch is a
    // plain Map lookup. A catalogued-but-not-installed module cannot run; the
    // installer surfaces this as SCENARIO_INSTALL_NOT_INSTALLED at install
    // time, not at first stage execution.
    const installationsByStageId: Record<string, ProcessModuleInstallation> = {};
    for (const entry of lock.entries) {
      let installation: ProcessModuleInstallation;
      try {
        installation = deps.installationRegistry.require(entry.installedModuleRef);
      } catch (e) {
        throw new ScenarioInstallerError(
          SCENARIO_INSTALL_NOT_INSTALLED,
          `resolved module ${entry.installedModuleRef.name}@${entry.installedModuleRef.version} for stage '${entry.stageId}' is not installed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          { stageId: entry.stageId, moduleRef: entry.installedModuleRef },
        );
      }
      installationsByStageId[entry.stageId] = installation;
    }

    // Step 4 — persist the lock. Idempotent on (scenarioIdentity, lockDigest);
    // the store returns the existing record on replay. A different digest for
    // the same scenario identity is a write failure (the caller decides
    // whether to retire the old lock — the installer does NOT auto-replace).
    try {
      await deps.lockStore.write(lock);
    } catch (e) {
      if (e instanceof ScenarioInstallerError) throw e;
      throw new ScenarioInstallerError(
        SCENARIO_INSTALL_LOCK_WRITE_FAILED,
        `lock store rejected write for scenario ${lock.scenarioIdentity.name}@${lock.scenarioIdentity.version}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }

    // Step 5 — assemble the InstalledScenario. The manifest snapshot is
    // canonicalJson(manifest) so manifestHash matches what the LifecycleRun
    // will pin at run start.
    const manifestSnapshot = canonicalJson(manifest);
    const manifestHash = sha256Hex(manifest);
    return {
      manifest,
      manifestSnapshot,
      manifestHash,
      lock,
      installationsByStageId,
    };
  }
}

/**
 * Stateless convenience wrapper around {@link ScenarioInstaller.install} for
 * callers that don't need to hold an installer instance.
 */
export async function installScenario(
  manifest: LifecycleScenarioManifest,
  deps: ScenarioInstallerDeps,
): Promise<InstalledScenario> {
  return new ScenarioInstaller().install(manifest, deps);
}

// ---------------------------------------------------------------------------
// ScenarioRunner — command, result, options, errors.
// ---------------------------------------------------------------------------

/**
 * Command to start one scenario run. Mirrors the legacy `RunLifecycleCommand`
 * shape (projectId/epicId/inputSchema/inputPayload/initiatedBy/idempotencyKey)
 * but adds the `InstalledScenario` to pin against, so the runner never
 * re-resolves modules or re-validates the manifest.
 */
export interface RunScenarioCommand {
  readonly projectId: number;
  readonly epicId: number | null;
  readonly inputSchema: string;
  readonly inputPayload: unknown;
  readonly initiatedBy: string;
  readonly idempotencyKey: string;
  /** Explicit controller authority to resume a durable semantic/human pause. */
  readonly resumePaused?: boolean;
}

/**
 * Result of one scenario run. Mirrors `LifecycleExecutionResult` so a caller
 * can treat the new and legacy surfaces uniformly.
 */
export interface ScenarioExecutionResult {
  readonly lifecycleRun: LifecycleRunRecord;
  readonly stageRuns: readonly LifecycleStageRunRecord[];
  readonly status: LifecycleRunRecord['status'];
  readonly terminalStatus: string | null;
  readonly pausedAtStageId: string | null;
  /** Public outputs produced during this run. */
  readonly outputs: readonly ScenarioStageOutputRecord[];
}

/**
 * Injected dependencies for the ScenarioRunner. Every collaborator is a PORT.
 */
export interface ScenarioRunnerDeps {
  readonly lifecycleRunRepo: LifecycleRunRepository;
  readonly processRunRepo: ProcessRunRepository;
  /** Declarative router (NO routeResolver function). */
  readonly router: ScenarioRouter;
  /** Public stage-output store. */
  readonly outputStore: ScenarioOutputStore;
  readonly now?: () => Date;
  /** Primarily configurable for deterministic lease/watchdog tests. */
  readonly leaseDurationMs?: number;
}

// ---------------------------------------------------------------------------
// ScenarioRunner errors.
// ---------------------------------------------------------------------------

export class ScenarioRunBusyError extends Error {
  constructor(readonly scenarioRunId: number) {
    super(`ScenarioRun ${scenarioRunId} is already owned by another executor`);
    this.name = 'ScenarioRunBusyError';
  }
}

export class ScenarioLeaseLostError extends Error {
  constructor(readonly scenarioRunId: number) {
    super(`ScenarioRun ${scenarioRunId} execution lease was lost`);
    this.name = 'ScenarioLeaseLostError';
  }
}

const SCENARIO_LEASE_MS = 120_000;

// ---------------------------------------------------------------------------
// ScenarioRunner.
// ---------------------------------------------------------------------------

/**
 * `ScenarioRunner` — generic scenario execution service. Walks the stages of
 * an {@link InstalledScenario}, drives each stage's
 * `ProcessModuleExecutor.execute(...)` (the existing SPI — NO Runtime
 * change), routes outcomes through the static `outcomeRoutes` table via the
 * injected router (NO `routeResolver` function), persists each public output
 * once via the output store (NO cumulative frame), and stops at the first
 * terminal outcome.
 *
 * The runner reuses the EXISTING `LifecycleRunRepository` +
 * `ProcessRunRepository` ports so durability, lease management, and replay
 * semantics are byte-compatible with the legacy orchestrator.
 *
 * Lease / watchdog / failure handling mirror the legacy orchestrator's
 * proven implementation; the genuinely new behavior is (a) no
 * `routeResolver`, (b) per-stage public output storage instead of a
 * cumulative frame, and (c) complete lock pinning at start.
 */
export class ScenarioRunner {
  private readonly lifecycleRunRepo: LifecycleRunRepository;
  private readonly processRunRepo: ProcessRunRepository;
  private readonly router: ScenarioRouter;
  private readonly outputStore: ScenarioOutputStore;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;

  constructor(deps: ScenarioRunnerDeps) {
    this.lifecycleRunRepo = deps.lifecycleRunRepo;
    this.processRunRepo = deps.processRunRepo;
    this.router = deps.router;
    this.outputStore = deps.outputStore;
    this.now = deps.now ?? (() => new Date());
    this.leaseDurationMs = deps.leaseDurationMs ?? SCENARIO_LEASE_MS;
    if (!Number.isFinite(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('ScenarioRunner leaseDurationMs must be positive');
    }
  }

  /**
   * Execute `scenario` according to `command`. Drives stages until a terminal
   * outcome is reached, the transition/reentry budget is exhausted, or the
   * lease is lost.
   *
   * Returns a {@link ScenarioExecutionResult} carrying the final LifecycleRun
   * row, its StageRuns, the terminal status (if any), and the public outputs
   * stored during the run.
   */
  async run(
    scenario: InstalledScenario,
    command: RunScenarioCommand,
  ): Promise<ScenarioExecutionResult> {
    const manifest = scenario.manifest;

    // 1. Start (or replay) the LifecycleRun. The manifest snapshot + hash are
    //    pinned on the run row so an in-flight upgrade cannot change behavior.
    //    We use the manifest identity as the lifecycle identity so the run is
    //    keyed by scenario name+version exactly like a legacy LifecycleRun is
    //    keyed by lifecycle name+version.
    const started = this.lifecycleRunRepo.start({
      lifecycle: manifest.identity,
      definitionSnapshot: scenario.manifestSnapshot,
      definitionHash: scenario.manifestHash,
      entryStageId: manifest.entryStageId,
      input: {
        schema: command.inputSchema,
        payload: command.inputPayload,
        contentHash: sha256Hex(command.inputPayload),
      },
      invocationContext: {
        projectId: command.projectId,
        epicId: command.epicId,
        initiatedBy: command.initiatedBy,
        idempotencyKey: command.idempotencyKey,
      },
    } satisfies StartLifecycleCommand);

    if (isLifecycleTerminal(started.record.status)) {
      return this.result(started.record);
    }
    let runnable = started.record;
    if (runnable.status === 'paused') {
      if (!command.resumePaused) return this.result(runnable);
      runnable = this.lifecycleRunRepo.resume(runnable.id, runnable.version);
    }

    // 2. Acquire the execution lease. Single-driver fence; a second executor
    //    attempting the same run sees ScenarioRunBusyError.
    const owner = randomUUID();
    const lease = this.lifecycleRunRepo.acquireExecutionLease(
      runnable.id,
      owner,
      this.now().toISOString(),
      this.leaseExpiry(),
    );
    if (!lease) throw new ScenarioRunBusyError(runnable.id);

    // Per-run router history + reentry counters (used by the router for
    // budget enforcement). Built up as stages complete.
    const transitionHistory: ScenarioTransitionRecord[] = [];
    const reentryCounts: Record<string, number> = {};

    try {
      // Bounded stage loop: the manifest's own transitionBudgets.maxTransitions
      // is enforced by the router, but we add a hard ceiling of
      // (stages * 4 + 8) as defense-in-depth so a buggy router can never
      // produce an infinite loop here. This mirrors the legacy orchestrator's
      // ceiling.
      const maxStages = manifest.stageBindings.length * 4 + 8;
      for (let step = 0; step < maxStages; step += 1) {
        let lifecycleRun = this.requireLifecycleRun(started.record.id);
        if (isLifecycleTerminal(lifecycleRun.status)) return this.result(lifecycleRun);
        this.heartbeat(started.record.id, lease);
        lifecycleRun = this.requireLifecycleRun(started.record.id);
        if (isLifecycleTerminal(lifecycleRun.status)) return this.result(lifecycleRun);

        const stage = this.requireStage(manifest, lifecycleRun.currentStageId);
        const installation = scenario.installationsByStageId[stage.id];
        if (!installation) {
          // Should be impossible — the installer bound every stage. Fail the
          // run loudly rather than silently misroute.
          throw new Error(
            `SCENARIO_RUN_STAGE_UNBOUND: stage '${stage.id}' has no installation binding`,
          );
        }

        // 3. Build the stage input. Reuse the legacy pattern: if a StageRun
        //    already exists with frozen input (replay after pause/crash), use
        //    that; otherwise map from the durable frame. The frame is built
        //    from the output store (public outputs only — NO cumulative
        //    frame) plus the root input.
        const rootInput = JSON.parse(lifecycleRun.inputSnapshot) as unknown;
        const runtime = this.mappingRuntime(lifecycleRun, stage.id);
        const durableFrame = await this.buildFrame(rootInput, lifecycleRun.id, manifest);
        const frozenStageRun = this.lifecycleRunRepo.readCurrentStageRun(lifecycleRun.id);
        const stageInput = frozenStageRun
          ? (JSON.parse(frozenStageRun.inputSnapshot) as unknown)
          : mapLifecycleValues(stage.inputMapping, durableFrame, runtime);

        const bindingSnapshot = canonicalJson(stage);
        const ensuredStage = this.lifecycleRunRepo.ensureStageRun({
          lifecycleRunId: lifecycleRun.id,
          stageId: stage.id,
          moduleRef: stage.moduleRef,
          bindingSnapshot,
          bindingHash: sha256Hex(stage),
          inputSchema: installation.definition.inputContract.id,
          inputPayload: stageInput,
          inputHash: sha256Hex(stageInput),
        }, lease);
        let stageRun = ensuredStage.record;

        // 4. Start (or replay) the ProcessRun for this stage. The run is
        //    pinned to the scenario module lock via installationId +
        //    packageDigest so the in-flight module identity cannot drift.
        const lockEntry = scenario.lock.entries.find((e) => e.stageId === stage.id);
        const processStart = this.processRunRepo.start({
          moduleRef: stage.moduleRef,
          input: {
            schema: stageRun.inputSchema,
            payload: stageInput,
            contentHash: stageRun.inputHash,
          },
          executorKind: installation.executor.kind,
          projectedStage: installation.definition.identity.kind,
          installationId: lockEntry?.installationId ?? null,
          packageDigest: lockEntry?.packageDigest ?? null,
          invocationContext: {
            projectId: lifecycleRun.projectId,
            epicId: lifecycleRun.epicId,
            initiatedBy: lifecycleRun.initiatedBy,
            idempotencyKey: `scenario:${lifecycleRun.id}:stage-run:${stageRun.id}`,
          },
        });
        stageRun = this.lifecycleRunRepo.bindProcessRun(
          lifecycleRun.id,
          stageRun.id,
          processStart.record.id,
          lease,
        );
        this.lifecycleRunRepo.markStageRunning(
          lifecycleRun.id,
          stageRun.id,
          lease,
        );

        // 5. Drive the executor (existing SPI — no Runtime change). The
        //    watchdog keeps the lease alive while the module runs.
        const processResult = await this.executeOrReplayProcess(
          installation,
          lifecycleRun,
          stageRun,
          stageInput,
          lease,
        );
        if (processResult.kind === 'paused') {
          const paused = this.lifecycleRunRepo.pauseStage(
            lifecycleRun.id,
            stageRun.id,
            processResult.error,
            lease,
          );
          return this.result(paused);
        }
        if (processResult.kind === 'failed') {
          const failed = this.lifecycleRunRepo.fail(
            lifecycleRun.id,
            stageRun.id,
            processResult.error,
            lease,
          );
          return this.result(failed);
        }

        const persistedResult = processResult.result;

        // 6. Route the outcome through the STATIC table via the injected
        //    router. NO routeResolver function is consulted anywhere. The
        //    router enforces transition + reentry budgets declared on the
        //    manifest.
        let route: TransitionTarget;
        try {
          route = this.router.resolveTransition({
            manifest,
            stage,
            outcome: persistedResult.outcome,
            transitionHistory,
            reentryCounts,
          });
        } catch (e) {
          if (e instanceof ScenarioBudgetExhaustedError) {
            const failed = this.lifecycleRunRepo.fail(
              lifecycleRun.id,
              stageRun.id,
              `scenario budget exhausted (${e.budget})`,
              lease,
            );
            return this.result(failed);
          }
          throw e;
        }

        // 7. Store the public stage output ONCE via the output store (NO
        //    cumulative frame). The outputMapping produces the public payload;
        //    the store content-addresses it and deduplicates on hash.
        const needsHandoff = route.type === 'stage';
        const outcomeFrame = {
          ...durableFrame,
          processOutcome: {
            ...resultSnapshot(persistedResult),
          },
        };
        const mappedOutput = stage.outputMapping
          ? mapLifecycleValues(stage.outputMapping, outcomeFrame, runtime)
          : {};
        if (persistedResult.output) {
          await this.outputStore.storeOutput({
            scenarioRunId: lifecycleRun.id,
            stageId: stage.id,
            outputSchema: persistedResult.output.schema,
            artifactRef: persistedResult.output.artifactRef,
            contentHash: persistedResult.output.contentHash,
            payload: mappedOutput,
          });
        }

        // 8. Build the next-stage command (if routing to another stage) and
        //    complete the current stage atomically.
        const handoffFrame = withStageOutput(
          durableFrame,
          stage.id,
          mappedOutput,
          persistedResult,
          stageRun.id,
          processStart.record.id,
        );
        const nextStageCommand = needsHandoff
          ? this.buildNextStageCommand(
            manifest,
            route as Extract<TransitionTarget, { type: 'stage' }>,
            handoffFrame,
            lifecycleRun,
            scenario,
          )
          : null;

        const handoffHash = sha256Hex(handoffFrame);
        const decisionHash = sha256Hex({
          lifecycleRunId: lifecycleRun.id,
          stageRunId: stageRun.id,
          outcome: persistedResult.outcome,
          target: route,
          handoffHash,
        });

        this.lifecycleRunRepo.completeStage({
          lifecycleRunId: lifecycleRun.id,
          stageRunId: stageRun.id,
          expectedStageId: stage.id,
          transitionKey: `scenario:${lifecycleRun.id}:stage-run:${stageRun.id}:outcome`,
          outcome: persistedResult.outcome,
          authority: persistedResult.authority,
          output: persistedResult.output,
          certificate: persistedResult.certificate,
          resultSnapshot: resultSnapshot(persistedResult),
          mappedOutput,
          target: route,
          handoffSnapshot: handoffFrame,
          handoffHash,
          decisionHash,
          nextStage: nextStageCommand,
        }, lease);

        // Record the transition for router budget enforcement on the next
        // iteration. Increment the destination's reentry counter when routing
        // to a stage (terminal targets do not reenter).
        transitionHistory.push({
          fromStageId: stage.id,
          outcome: persistedResult.outcome,
          target: route,
          stageRunId: stageRun.id,
        });
        if (route.type === 'stage') {
          reentryCounts[route.stageId] = (reentryCounts[route.stageId] ?? 0) + 1;
        }
      }

      // Loop ceiling hit without a terminal outcome: the router's budget
      // should have caught this first, but fail loudly regardless.
      const failed = this.lifecycleRunRepo.fail(
        started.record.id,
        this.lifecycleRunRepo.readCurrentStageRun(started.record.id)?.id ?? null,
        'Scenario flow exceeded its bounded stage count',
        lease,
      );
      return this.result(failed);
    } catch (error) {
      if (isScenarioLeaseError(error)) {
        throw new ScenarioLeaseLostError(started.record.id);
      }
      if (isRecoverableExecutionContention(error)) throw error;
      const current = this.lifecycleRunRepo.read(started.record.id);
      if (current && !isLifecycleTerminal(current.status)) {
        try {
          const failed = this.lifecycleRunRepo.fail(
            current.id,
            current.currentStageRunId,
            (error as Error).message ?? String(error),
            lease,
          );
          return this.result(failed);
        } catch (failError) {
          if ((failError as Error).message === 'LIFECYCLE_LEASE_LOST') {
            throw new ScenarioLeaseLostError(started.record.id);
          }
        }
      }
      throw error;
    } finally {
      this.lifecycleRunRepo.releaseExecutionLease(started.record.id, lease);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers — mirror the legacy orchestrator's proven implementation
  // (lease watchdog, frame assembly, mapping runtime). Kept private so the
  // public surface stays narrow.
  // -------------------------------------------------------------------------

  private async executeOrReplayProcess(
    installation: ProcessModuleInstallation,
    lifecycleRun: LifecycleRunRecord,
    stageRun: LifecycleStageRunRecord,
    stageInput: unknown,
    lease: LifecycleExecutionLease,
  ): Promise<
    | { kind: 'completed'; result: ProcessModuleRunResult }
    | { kind: 'paused'; error: string }
    | { kind: 'failed'; error: string }
  > {
    if (stageRun.processRunId === null) {
      return { kind: 'failed', error: 'StageRun has no bound ProcessRun' };
    }
    let process = this.processRunRepo.read(stageRun.processRunId);
    if (!process) return { kind: 'failed', error: 'Bound ProcessRun is missing' };
    if (process.status === 'completed') {
      return { kind: 'completed', result: processRecordToResult(process) };
    }
    if (process.status === 'failed' || process.status === 'cancelled') {
      return {
        kind: 'failed',
        error: process.error ?? `ProcessRun ${process.id} is ${process.status}`,
      };
    }
    const processRunId = process.id;

    try {
      this.heartbeat(lifecycleRun.id, lease);
      await this.withLeaseWatchdog(
        lifecycleRun.id,
        lease,
        () => installation.executor.execute(installation.definition, {
          projectId: lifecycleRun.projectId,
          epicId: lifecycleRun.epicId,
          processRunId,
          inputPayload: stageInput,
          inputHash: stageRun.inputHash,
          initiatedBy: lifecycleRun.initiatedBy,
        }),
      );
      this.heartbeat(lifecycleRun.id, lease);
    } catch (error) {
      process = this.processRunRepo.read(processRunId);
      if (process?.status === 'paused') {
        return {
          kind: 'paused',
          error: process.error ?? (error as Error).message ?? 'ProcessRun paused',
        };
      }
      if (process?.status === 'failed' || process?.status === 'cancelled') {
        return {
          kind: 'failed',
          error: process.error ?? (error as Error).message ?? `ProcessRun ${process.status}`,
        };
      }
      throw error;
    }
    process = this.processRunRepo.read(processRunId);
    if (!process) return { kind: 'failed', error: 'ProcessRun disappeared after execution' };
    if (process.status === 'paused') {
      return { kind: 'paused', error: process.error ?? 'ProcessRun paused' };
    }
    if (process.status !== 'completed') {
      return {
        kind: 'failed',
        error: `Process executor returned while ProcessRun ${process.id} is '${process.status}'`,
      };
    }
    return { kind: 'completed', result: processRecordToResult(process) };
  }

  private buildNextStageCommand(
    manifest: LifecycleScenarioManifest,
    target: Extract<TransitionTarget, { type: 'stage' }>,
    handoffFrame: Record<string, unknown>,
    lifecycleRun: LifecycleRunRecord,
    scenario: InstalledScenario,
  ) {
    const next = this.requireStage(manifest, target.stageId);
    const installation = scenario.installationsByStageId[next.id];
    if (!installation) {
      throw new Error(
        `SCENARIO_RUN_NEXT_STAGE_UNBOUND: next stage '${next.id}' has no installation binding`,
      );
    }
    const runtime = this.mappingRuntime(lifecycleRun, next.id);
    const inputPayload = mapLifecycleValues(next.inputMapping, handoffFrame, runtime);
    const bindingSnapshot = canonicalJson(next);
    return {
      stageId: next.id,
      moduleRef: next.moduleRef,
      bindingSnapshot,
      bindingHash: sha256Hex(next),
      inputSchema: installation.definition.inputContract.id,
      inputPayload,
      inputHash: sha256Hex(inputPayload),
    };
  }

  /**
   * Build the durable mapping frame from the output store (public outputs
   * only — NO cumulative frame) plus the root input.
   *
   * The frame shape is intentionally the SAME shape the legacy orchestrator
   * produces (`{ ...root, lifecycleInput, stages: { [stageId]: {...} } }`)
   * so existing `LifecycleMappingExpression` paths like
   * `stages.draft.output.campaignDraft` keep resolving identically. The
   * per-stage entries are sourced from the output store (one row per public
   * output) rather than from a monolithic cumulative frame that re-persists
   * every prior stage on every transition.
   */
  private async buildFrame(
    rootInput: unknown,
    lifecycleRunId: number,
    manifest: LifecycleScenarioManifest,
  ): Promise<Record<string, unknown>> {
    const root = isRecord(rootInput) ? { ...rootInput } : { value: rootInput };
    const stages: Record<string, unknown> = {};
    // Include the manifest's stage ids so mapping paths that reference a stage
    // which has not yet produced output resolve to an empty object rather than
    // throwing — matches legacy orchestrator behavior (the mapping layer throws
    // LIFECYCLE_MAPPING_SOURCE_MISSING only when a path is dereferenced).
    const completedStageRuns = new Map(
      this.lifecycleRunRepo.listStageRuns(lifecycleRunId)
        .filter((s) => s.status === 'completed')
        .map((s) => [s.stageId, s]),
    );
    const publicOutputs = await this.outputStore.listOutputs(lifecycleRunId);
    const outputsByStageId = new Map<string, ScenarioStageOutputRecord>();
    for (const o of publicOutputs) {
      // Keep the first (deterministic manifest order is preserved by the store).
      if (!outputsByStageId.has(o.stageId)) outputsByStageId.set(o.stageId, o);
    }
    for (const binding of manifest.stageBindings) {
      const stageRun = completedStageRuns.get(binding.id);
      const publicOutput = outputsByStageId.get(binding.id);
      if (!stageRun) continue;
      const result = stageRun.resultSnapshot ?? {};
      stages[binding.id] = {
        ...(publicOutput ? (isRecord(publicOutput.payload) ? publicOutput.payload as Record<string, unknown> : { value: publicOutput.payload }) : {}),
        output: publicOutput
          ? (isRecord(publicOutput.payload) ? publicOutput.payload as Record<string, unknown> : { value: publicOutput.payload })
          : (stageRun.mappedOutput ?? {}),
        stageRunId: stageRun.id,
        processRunId: stageRun.processRunId,
        processOutcome: result,
      };
    }
    return {
      ...root,
      lifecycleInput: rootInput,
      stages,
    };
  }

  private mappingRuntime(
    lifecycleRun: LifecycleRunRecord,
    stageId: string,
  ): LifecycleMappingRuntime {
    return {
      projectId: lifecycleRun.projectId,
      epicId: lifecycleRun.epicId,
      lifecycleRunId: lifecycleRun.id,
      stageId,
      initiatedBy: lifecycleRun.initiatedBy,
    };
  }

  private heartbeat(lifecycleRunId: number, lease: LifecycleExecutionLease): void {
    if (!this.lifecycleRunRepo.renewExecutionLease(
      lifecycleRunId,
      lease,
      this.leaseExpiry(),
    )) {
      throw new ScenarioLeaseLostError(lifecycleRunId);
    }
  }

  private async withLeaseWatchdog<T>(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
    work: () => Promise<T>,
  ): Promise<T> {
    const heartbeatEveryMs = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    let leaseError: unknown = null;
    let leaseWasLost = false;
    const watchdog = setInterval(() => {
      if (leaseWasLost) return;
      try {
        this.heartbeat(lifecycleRunId, lease);
      } catch (error) {
        leaseWasLost = true;
        leaseError = error;
      }
    }, heartbeatEveryMs);
    watchdog.unref();

    let result: T | undefined;
    let workError: unknown = null;
    let workFailed = false;
    try {
      result = await work();
    } catch (error) {
      workFailed = true;
      workError = error;
    } finally {
      clearInterval(watchdog);
    }

    if (leaseWasLost) throw leaseError;
    if (workFailed) throw workError;
    return result as T;
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseDurationMs).toISOString();
  }

  private requireStage(
    manifest: LifecycleScenarioManifest,
    stageId: string | null,
  ): ScenarioStageBinding {
    if (!stageId) throw new Error('Scenario has no current stage');
    const stage = manifest.stageBindings.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error(`Scenario stage '${stageId}' is missing`);
    return stage;
  }

  private requireLifecycleRun(id: number): LifecycleRunRecord {
    const run = this.lifecycleRunRepo.read(id);
    if (!run) throw new Error(`LifecycleRun ${id} is missing`);
    return run;
  }

  private async result(run: LifecycleRunRecord): Promise<ScenarioExecutionResult> {
    const outputs = await this.outputStore.listOutputs(run.id);
    return {
      lifecycleRun: run,
      stageRuns: this.lifecycleRunRepo.listStageRuns(run.id),
      status: run.status,
      terminalStatus: run.terminalStatus,
      pausedAtStageId: run.status === 'paused' ? run.currentStageId : null,
      outputs,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (file-local).
// ---------------------------------------------------------------------------

/**
 * Local re-declaration of the lifecycle mapping runtime + mapper, so this
 * file does not import the legacy `lifecycle-mapper.ts` hot path (keeps the
 * sibling-port surface uniform and avoids a structural edge into the legacy
 * orchestrator's helper file). The implementation is byte-identical to the
 * canonical `mapLifecycleValues` — same path semantics, same unsafe-segment
 * guard, same literal/runtime expression handling.
 */
interface LifecycleMappingRuntime {
  projectId: number;
  epicId: number | null;
  lifecycleRunId: number;
  stageId: string;
  initiatedBy: string;
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function mapLifecycleValues(
  mapping: Readonly<Record<string, LifecycleMappingExpressionValue>>,
  source: Record<string, unknown>,
  runtime: LifecycleMappingRuntime,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [targetPath, expression] of Object.entries(mapping)) {
    setTargetPath(target, targetPath, resolveExpression(expression, source, runtime));
  }
  return target;
}

type LifecycleMappingExpressionValue =
  | string
  | { readonly literal: unknown }
  | {
    readonly runtime:
    | 'projectId'
    | 'epicId'
    | 'lifecycleRunId'
    | 'stageId'
    | 'initiatedBy';
  };

function resolveExpression(
  expression: LifecycleMappingExpressionValue,
  source: Record<string, unknown>,
  runtime: LifecycleMappingRuntime,
): unknown {
  if (typeof expression === 'string') {
    return resolveLifecyclePath(source, expression);
  }
  if ('literal' in expression) return cloneJson(expression.literal);
  return runtime[expression.runtime];
}

function resolveLifecyclePath(
  source: Record<string, unknown>,
  path: string,
): unknown {
  if (path === '$') return source;
  if (!path.startsWith('$.')) {
    throw new Error(
      `LIFECYCLE_MAPPING_INVALID_PATH: '${path}' must be '$' or start with '$.'`,
    );
  }
  const segments = path.slice(2).split('.');
  let cursor: unknown = source;
  for (const segment of segments) {
    if (
      !segment
      || UNSAFE_PATH_SEGMENTS.has(segment)
      || !isRecord(cursor)
      || !Object.hasOwn(cursor, segment)
    ) {
      throw new Error(`LIFECYCLE_MAPPING_SOURCE_MISSING: '${path}'`);
    }
    cursor = cursor[segment];
  }
  return cloneJson(cursor);
}

function setTargetPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  if (segments.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
  }
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
    if (!Object.hasOwn(cursor, segment)) {
      const nested: Record<string, unknown> = {};
      cursor[segment] = nested;
      cursor = nested;
      continue;
    }
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      throw new Error(`LIFECYCLE_MAPPING_TARGET_COLLISION: '${path}'`);
    }
    cursor = existing;
  }
  const finalSegment = segments[segments.length - 1];
  if (!finalSegment) throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
  if (Object.hasOwn(cursor, finalSegment)) {
    throw new Error(`LIFECYCLE_MAPPING_TARGET_DUPLICATE: '${path}'`);
  }
  cursor[finalSegment] = cloneJson(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    throw new Error('LIFECYCLE_MAPPING_VALUE_UNDEFINED');
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function processRecordToResult(process: ProcessRunRecord): ProcessModuleRunResult {
  if (process.status !== 'completed' || !process.localOutcome) {
    throw new Error(`ProcessRun ${process.id} has no persisted completed outcome`);
  }
  const output: ProcessModuleOutput | null = process.outputRef === null
    ? null
    : {
      schema: process.outputSchema ?? '',
      artifactRef: process.outputRef,
      contentHash: process.outputHash ?? '',
    };
  const certificate: ProcessModuleCertificateRef | null = process.certificateRef === null
    ? null
    : {
      schema: process.certificateSchema ?? '',
      certificateRef: process.certificateRef,
      certificateHash: process.certificateHash ?? '',
    };
  return {
    outcome: process.localOutcome,
    output,
    certificate,
    authority: process.authority,
  };
}

function resultSnapshot(result: ProcessModuleRunResult): Record<string, unknown> {
  return {
    code: result.outcome,
    outcome: result.outcome,
    authority: result.authority,
    output: result.output,
    certificate: result.certificate,
    outputRef: result.output?.artifactRef ?? result.certificate?.certificateRef ?? null,
    outputHash: result.output?.contentHash ?? result.certificate?.certificateHash ?? null,
    outputSchema: result.output?.schema ?? result.certificate?.schema ?? null,
    certificateRef: result.certificate?.certificateRef ?? null,
    certificateHash: result.certificate?.certificateHash ?? null,
    certificateSchema: result.certificate?.schema ?? null,
  };
}

function withStageOutput(
  frame: Record<string, unknown>,
  stageId: string,
  mappedOutput: Record<string, unknown>,
  result: ProcessModuleRunResult,
  stageRunId: number,
  processRunId: number,
): Record<string, unknown> {
  const existingStages = isRecord(frame.stages) ? frame.stages : {};
  // The per-stage entry exposes the mapped public output BOTH at the top level
  // (legacy `stages.<id>.<field>` convention) AND under an explicit `output`
  // key (`stages.<id>.output.<field>`, the convention the stage-output store
  // uses). Both path shapes resolve identically because `output` aliases the
  // same payload object.
  const snapshot = resultSnapshot(result);
  return {
    ...frame,
    processOutcome: snapshot,
    stages: {
      ...existingStages,
      [stageId]: {
        ...mappedOutput,
        output: mappedOutput,
        stageRunId,
        processRunId,
        processOutcome: snapshot,
      },
    },
  };
}

function isLifecycleTerminal(status: LifecycleRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isScenarioLeaseError(error: unknown): boolean {
  return error instanceof ScenarioLeaseLostError
    || errorMessage(error) === 'LIFECYCLE_LEASE_LOST';
}

function isRecoverableExecutionContention(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = errorMessage(error);
  return name === 'ProcessRunBusyError'
    || name === 'NodeExecutionLeaseLostError'
    || message.startsWith('PROCESS_RUN_CONCURRENT_TRANSITION:');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
