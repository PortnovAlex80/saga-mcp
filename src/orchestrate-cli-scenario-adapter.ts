/**
 * W11-A4 — orchestrate-cli scenario selection + compatibility adapter.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md lane A4.
 * Task: docs/refactor-management/05-subagent-tasks/W11-a4.md
 * Plan: §0.14 / Phase 13 cutover preparation (§0.14.11 serial gate).
 *
 * PURPOSE
 *   Wave 11 switches NEW Product Delivery runs to use installed scenarios
 *   (the Wave 7 ScenarioRunner path) while OLD pinned runs keep replaying
 *   through the legacy path (the existing SagaApplication.runEpisode). This
 *   file is the CLI-side selection + compatibility adapter that sits between
 *   `orchestrate-cli.ts` (the host) and the two execution paths.
 *
 *   The selection is FEATURE-DETECTED (spec §1, §3): if an installed scenario
 *   is resolvable for the run, the new path is taken; otherwise the run falls
 *   back to the legacy `SagaApplication.runEpisode` path. No legacy code is
 *   deleted in Wave 11 (anti-scope §5); both paths coexist. The serial
 *   cutover commit (spec §3) is the SINGLE integrator edit that wires this
 *   adapter into the live `orchestrate-cli.ts` hot path; until then this
 *   module is imported only by tests and by the integrator's wiring.
 *
 * WHAT THIS FILE OWNS (and nothing else)
 *   1. `CliScenarioSelection` — the resolved decision: which path, which
 *      scenario, why. Pure data; produced by `resolveCliScenarioSelection`.
 *   2. `resolveCliScenarioSelection` — feature-detects whether an installed
 *      scenario is available for the run and returns the selection. Pure
 *      with respect to its inputs; the only side effect is the optional
 *      compatibility-record callback (see point 4).
 *   3. `runEpisodeViaScenarioAdapter` — executes one episode through whichever
 *      path the selection dictates, translating the legacy
 *      `RunEpisodeCommand` shape into the scenario `RunScenarioCommand` shape
 *      for the new path, and projecting the scenario
 *      `ScenarioExecutionResult` back into the legacy
 *      `OrchestrationRunResult` shape so `orchestrate-cli.ts` sees one
 *      uniform result type regardless of path.
 *   4. `CompatibilityUseRecord` + `CompatibilityUseRecorder` — the optional
 *      hook every legacy-path use pulses. W11-A5 (legacy-run-inventory.ts)
 *   owns the concrete recorder; until that lane lands, callers pass `null`
 *      and no record is emitted. This keeps A4 testable in isolation while
 *      preserving the spec §4 exit-gate requirement that "legacy-run
 *      inventory records every compatibility-path use."
 *
 * LAYERING / DEPENDENCY DIRECTION
 *   This module imports ONLY:
 *     - the engine-neutral application port (`SagaApplication`,
 *       `RunEpisodeCommand`, `OrchestrationRunResult`);
 *     - the scenario runtime surface (`InstalledScenario`, `RunScenarioCommand`,
 *       `ScenarioExecutionResult`, `ScenarioRunner`) — all already present
 *       since Wave 7;
 *     - the legacy scenario adapter manifest
 *       (`legacyProductDeliveryScenarioFor`) so the legacy fallback path can
 *       name which compatibility manifest it would have used (for the
 *       compatibility record), WITHOUT executing through it.
 *   It does NOT import the Wave 11 sibling lanes (W11-A1 scenario package,
 *   W11-A2 composition loader, W11-A3 command adapters, W11-A5 inventory).
 *   Those are parallel lanes off the same checkpoint; importing them here
 *   would break the build in an isolated A4 worktree. The integrator's full
 *   Wave-11 gate run is where all siblings compose. The selection resolver
 *   accepts the installed-scenario provider as an injected port
 *   (`InstalledScenarioProvider`) so A2's composition loader can supply it
 *   without A4 depending on A2's module path.
 */

import type { SagaApplication } from './application/saga-application.js';
import type {
  OrchestrationRunResult,
  RunEpisodeCommand,
} from './application/ports/orchestration-engine.js';
import type { InstalledScenario } from './process-modules/application/scenario-runner.js';
import type { RunScenarioCommand } from './process-modules/application/scenario-runner.js';
import type { ScenarioExecutionResult } from './process-modules/application/scenario-runner.js';
import type { ScenarioRunner } from './process-modules/application/scenario-runner.js';
import type { LifecycleScenarioManifest } from './process-modules/domain/spi/scenario-manifest.js';
import { legacyProductDeliveryScenarioFor } from './process-modules/application/legacy-scenario-adapter.js';

// ---------------------------------------------------------------------------
// Compatibility-use recording (W11-A5 hook).
// ---------------------------------------------------------------------------

/**
 * One immutable record of a single compatibility-path use. Emitted by the
 * adapter every time a run is routed through the LEGACY path instead of the
 * installed-scenario path.
 *
 * W11-A5 (`application/legacy-run-inventory.ts`) owns the concrete store and
 * the retention policy. This type is defined HERE (in A4) so A4 does not
 * import A5; A5 consumes it. The fields are the minimum the spec §4 exit
 * gate requires ("legacy-run inventory records every compatibility-path
 * use"): who/what/when/why-legacy.
 */
export interface CompatibilityUseRecord {
  /** ISO 8601 timestamp the legacy path was taken. */
  readonly recordedAt: string;
  readonly projectId: number;
  readonly epicId: number | null;
  /** Why the legacy path was taken (see `SelectionReason`). */
  readonly reason: string;
  /**
   * The scenario identity the legacy path is equivalent to, when known. The
   * legacy Product Delivery lifecycle maps to one of the two compatibility
   * manifests (permissive/strict); we record which so the inventory can
   * group equivalent runs. Null when the run is not a Product Delivery run
   * (e.g. a Campaign run that has no legacy equivalent).
   */
  readonly equivalentScenarioIdentity: {
    readonly name: string;
    readonly version: string;
  } | null;
  /** Stable identifier of the source of the decision (always 'w11-a4-cli'). */
  readonly source: 'w11-a4-cli';
}

/**
 * Port the adapter pulses on every legacy-path use. Implemented by W11-A5's
 * inventory; until that lane lands, callers pass `null` and no record is
 * emitted. The adapter NEVER depends on a concrete implementation.
 */
export type CompatibilityUseRecorder = (record: CompatibilityUseRecord) => void;

// ---------------------------------------------------------------------------
// Installed-scenario provider (W11-A2 hook).
// ---------------------------------------------------------------------------

/**
 * Resolves the installed scenario to use for a run, if any. Implemented by
 * the W11-A2 composition loader (`application/composition-loader.ts`) against
 * the loaded package+scenario catalog; until that lane lands, callers pass
 * `null` and every run takes the legacy path.
 *
 * The provider is queried per-run (not once at startup) because the
 * installed-scenario set can change between runs in a long-lived CLI
 * process, and because the selection can depend on the run's project/epic
 * (different projects may have different scenarios installed).
 *
 * Returns `null` (not throws) when no scenario is installed for the run —
 * that is the normal legacy-fallback signal, not an error.
 */
export interface InstalledScenarioProvider {
  resolveInstalledScenario(context: {
    readonly projectId: number;
    readonly epicId: number | null;
  }): Promise<InstalledScenario | null> | InstalledScenario | null;
}

/**
 * The scenario runner factory port. The adapter does not construct the
 * runner itself (it has heavy persistence deps); the composition root
 * supplies it. `null` means "no scenario runner wired" → every run takes
 * the legacy path even if a scenario is installed.
 */
export type ScenarioRunnerProvider = (
  scenario: InstalledScenario,
) => ScenarioRunner | null;

// ---------------------------------------------------------------------------
// Selection — the feature-detected decision.
// ---------------------------------------------------------------------------

/**
 * Why a particular path was selected for a run. Stable strings so the
 * compatibility record and tests can assert without importing symbols.
 */
export const SELECTION_REASON = Object.freeze({
  /**
   * An installed scenario was resolved AND a ScenarioRunner is wired → the
   * new Wave 7 scenario path is taken.
   */
  INSTALLED_SCENARIO: 'installed-scenario',
  /**
   * No installed scenario provider, or it resolved no scenario → the legacy
   * SagaApplication.runEpisode path is taken.
   */
  NO_INSTALLED_SCENARIO: 'no-installed-scenario',
  /**
   * A scenario was installed but no ScenarioRunner is wired (composition
   * root has not yet mounted the runner) → legacy path taken so the run is
   * not blocked by a half-wired cutover.
   */
  SCENARIO_RUNNER_NOT_WIRED: 'scenario-runner-not-wired',
  /**
   * The run explicitly requested the legacy path (e.g. operator forcing a
   * pinned legacy replay via env/flag). → legacy path taken.
   */
  LEGACY_FORCED: 'legacy-forced',
} as const);

export type SelectionReason = (typeof SELECTION_REASON)[keyof typeof SELECTION_REASON];

/**
 * The resolved execution selection for one CLI run. Pure data. Produced by
 * `resolveCliScenarioSelection`; consumed by `runEpisodeViaScenarioAdapter`.
 *
 * Carries enough provenance that the compatibility record (and operator
 * diagnostics) can explain WHY a run took the path it did without re-running
 * the resolver.
 */
export interface CliScenarioSelection {
  /** Which execution path this run will take. */
  readonly path: 'scenario' | 'legacy';
  /** Stable machine reason for the path (see `SELECTION_REASON`). */
  readonly reason: SelectionReason;
  /**
   * The installed scenario pinned to the run when `path === 'scenario'`.
   * Null for the legacy path. Carrying it on the selection means the runner
   * does not re-resolve (the resolver is the single decision point).
   */
  readonly installedScenario: InstalledScenario | null;
  /**
   * The legacy compatibility manifest this run is equivalent to, when the
   * legacy path is taken for a Product Delivery run. Derived from the run's
   * discoveryGate flag (permissive default). Null when not derivable. Used
   * only for the compatibility record — the legacy path does not execute
   * through this manifest.
   */
  readonly equivalentLegacyManifest: LifecycleScenarioManifest | null;
}

/**
 * Inputs to the selection resolver. Every field is optional except the run
 * coordinates so the resolver is callable from contexts that have wired only
 * some of the cutover pieces (the integrator lands them incrementally).
 */
export interface ResolveSelectionInputs {
  readonly projectId: number;
  readonly epicId: number | null;
  /** Optional: the W11-A2 composition-loader-backed scenario provider. */
  readonly installedScenarioProvider?: InstalledScenarioProvider | null;
  /** Optional: the composition-root scenario-runner factory. */
  readonly scenarioRunnerProvider?: ScenarioRunnerProvider | null;
  /**
   * Discovery gate mode for the legacy equivalent. Mirrors the legacy
   * `discoveryGate` field: `'permissive'` (default) or `'strict'`. Only
   * consulted to label the legacy equivalent manifest; it does not change
   * routing (routing is feature-detected, not flag-driven).
   */
  readonly discoveryGate?: 'permissive' | 'strict' | undefined;
  /**
   * Operator override to force the legacy path for this run (e.g. replaying
   * a pinned legacy run). When true the resolver short-circuits to legacy
   * without consulting the provider.
   */
  readonly forceLegacy?: boolean | undefined;
}

/**
 * Feature-detect the execution path for one CLI run.
 *
 * Decision order (first match wins):
 *   1. `forceLegacy` → LEGACY_FORCED.
 *   2. No `installedScenarioProvider` → NO_INSTALLED_SCENARIO.
 *   3. Provider resolves `null` → NO_INSTALLED_SCENARIO.
 *   4. No `scenarioRunnerProvider` → SCENARIO_RUNNER_NOT_WIRED.
 *   5. Runner provider returns `null` for the resolved scenario →
 *      SCENARIO_RUNNER_NOT_WIRED.
 *   6. Otherwise → INSTALLED_SCENARIO (new path).
 *
 * Async because the installed-scenario provider may be async (it reads the
 * loaded package catalog). Pure with respect to its inputs apart from that.
 *
 * The legacy-equivalent manifest is always derived for a legacy-path
 * selection so the compatibility record can name it; for the scenario path
 * it is null (the installed scenario IS the manifest of record).
 */
export async function resolveCliScenarioSelection(
  inputs: ResolveSelectionInputs,
): Promise<CliScenarioSelection> {
  const gate = inputs.discoveryGate ?? 'permissive';
  const equivalentLegacy = legacyProductDeliveryScenarioFor(gate);

  if (inputs.forceLegacy) {
    return {
      path: 'legacy',
      reason: SELECTION_REASON.LEGACY_FORCED,
      installedScenario: null,
      equivalentLegacyManifest: equivalentLegacy,
    };
  }

  const provider = inputs.installedScenarioProvider ?? null;
  if (!provider) {
    return {
      path: 'legacy',
      reason: SELECTION_REASON.NO_INSTALLED_SCENARIO,
      installedScenario: null,
      equivalentLegacyManifest: equivalentLegacy,
    };
  }

  const resolved = await provider.resolveInstalledScenario({
    projectId: inputs.projectId,
    epicId: inputs.epicId,
  });
  if (!resolved) {
    return {
      path: 'legacy',
      reason: SELECTION_REASON.NO_INSTALLED_SCENARIO,
      installedScenario: null,
      equivalentLegacyManifest: equivalentLegacy,
    };
  }

  const runnerProvider = inputs.scenarioRunnerProvider ?? null;
  if (!runnerProvider) {
    return {
      path: 'legacy',
      reason: SELECTION_REASON.SCENARIO_RUNNER_NOT_WIRED,
      installedScenario: null,
      equivalentLegacyManifest: equivalentLegacy,
    };
  }
  const runner = runnerProvider(resolved);
  if (!runner) {
    return {
      path: 'legacy',
      reason: SELECTION_REASON.SCENARIO_RUNNER_NOT_WIRED,
      installedScenario: null,
      equivalentLegacyManifest: equivalentLegacy,
    };
  }

  return {
    path: 'scenario',
    reason: SELECTION_REASON.INSTALLED_SCENARIO,
    installedScenario: resolved,
    equivalentLegacyManifest: null,
  };
}

// ---------------------------------------------------------------------------
// Execution — run one episode through the selected path.
// ---------------------------------------------------------------------------

/**
 * The default input-schema identity for a Product Delivery scenario run.
 * Mirrors the legacy lifecycle input schema so the scenario runner and the
 * legacy engine accept the same input shape during the cutover.
 */
export const SCENARIO_INPUT_SCHEMA_DEFAULT =
  'saga3.product-delivery-lifecycle-input.v2';

/**
 * Build the scenario `RunScenarioCommand` from the legacy `RunEpisodeCommand`.
 *
 * The scenario command is a strict subset of the legacy command (it adds the
 * installed-scenario pin, which the runner takes separately). project/epic
 * become ordinary scope fields here — they are NOT mandatory scenario
 * concepts (spec §13.22, W11-A3), but Product Delivery always carries them,
 * so we forward them verbatim. `epicId` may be `null` for project-wide runs.
 *
 * Pure: produces a new object, does not mutate the input.
 */
export function buildScenarioCommand(
  command: RunEpisodeCommand,
): RunScenarioCommand {
  const inputSchema = command.lifecycleInputSchema ?? SCENARIO_INPUT_SCHEMA_DEFAULT;
  return {
    projectId: command.projectId,
    epicId: command.epicId,
    inputSchema,
    inputPayload: command.lifecycleInput ?? null,
    initiatedBy: command.initiatedBy ?? 'orchestrate-cli',
    idempotencyKey: command.idempotencyKey ?? defaultIdempotencyKey(command),
    resumePaused: command.resumePaused,
  };
}

/**
 * Stable default idempotency key when the legacy command did not supply one.
 * Matches the shape the legacy engines infer so a run started without an
 * explicit key is replay-compatible across the cutover.
 */
export function defaultIdempotencyKey(command: RunEpisodeCommand): string {
  return `product-delivery-project-${command.projectId}-epic-${command.epicId}`;
}

/**
 * Project a scenario `ScenarioExecutionResult` into the legacy
 * `OrchestrationRunResult` shape so `orchestrate-cli.ts` and its callers see
 * one uniform result type regardless of which path executed the run.
 *
 * Mapping rules (spec §1: both paths coexist, results are uniform):
 *   - `reason`: a terminal non-failed status → 'completed'; a paused status
 *     → 'paused'; anything else → 'failed'. This matches how the legacy
 *     lifecycle-orchestrator projects LifecycleRun status into run reason.
 *   - `finalStage`: the run's current stage id (or '<terminal>' when the
 *     run reached a terminal status with no current stage).
 *   - `lifecycleRun`: projected verbatim from the scenario result so the
 *     durable run identity is preserved across the cutover.
 *
 * Pure: produces a new object.
 */
export function projectScenarioResultToRunResult(
  scenarioResult: ScenarioExecutionResult,
  command: RunEpisodeCommand,
): OrchestrationRunResult {
  const run = scenarioResult.lifecycleRun;
  const reason = lifecycleStatusToRunReason(run.status);
  return {
    projectId: command.projectId,
    epicId: command.epicId,
    finalStage: run.currentStageId ?? '<terminal>',
    endedAt: new Date().toISOString(),
    reason,
    cycles: scenarioResult.stageRuns.length,
    lastError: null,
    lifecycleRun: {
      id: run.id,
      ref: `${run.lifecycle.name}@${run.lifecycle.version}`,
      status: run.status,
      currentStageId: run.currentStageId,
      terminalStatus: scenarioResult.terminalStatus,
    },
  };
}

/**
 * Map a LifecycleRun status to the legacy `OrchestrationRunReason`. Mirrors
 * the projection the legacy lifecycle-orchestrator uses so a run that
 * completes via the scenario path reports the same reason it would have via
 * the legacy path.
 */
function lifecycleStatusToRunReason(
  status: LifecycleRunStatusForProjection,
): OrchestrationRunResult['reason'] {
  // 'completed' covers terminal success statuses; 'paused' covers durable
  // semantic/human pauses; everything else is a failure projection.
  if (status === 'completed') return 'completed';
  if (status === 'paused') return 'paused';
  // Terminal failure statuses (failed/cancelled/rejected/...) and any
  // non-terminal status reaching here (should not happen post-run, but
  // defended) project to 'failed' so the CLI exits non-zero.
  return 'failed';
}

/**
 * The subset of LifecycleRunRecord['status'] this module reasons about. Kept
 * local (not imported) to avoid coupling this adapter to the persistence
 * record shape; the scenario runner already validates the concrete status.
 */
type LifecycleRunStatusForProjection = string;

/**
 * Inputs to `runEpisodeViaScenarioAdapter`. Every collaborator is a port;
 * the adapter owns no concrete wiring.
 */
export interface RunEpisodeViaScenarioAdapterInputs {
  /** The host application (legacy path executor). */
  readonly application: SagaApplication;
  /** The resolved selection (from `resolveCliScenarioSelection`). */
  readonly selection: CliScenarioSelection;
  /** The legacy run command from the CLI. */
  readonly command: RunEpisodeCommand;
  /**
   * The scenario-runner provider (composition root). Required when
   * `selection.path === 'scenario'`; ignored for the legacy path.
   */
  readonly scenarioRunnerProvider?: ScenarioRunnerProvider | null;
  /**
   * Optional compatibility-use recorder (W11-A5). When the legacy path is
   * taken, one `CompatibilityUseRecord` is emitted. Null/undefined → no
   * record emitted (the A4 worktree has no A5 yet; the integrator wires it).
   */
  readonly compatibilityRecorder?: CompatibilityUseRecorder | null;
  /** Override the clock for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Execute one episode through the path dictated by `selection`.
 *
 * - `selection.path === 'scenario'` → translate the command, obtain the
 *   runner, execute via `ScenarioRunner.run`, project the result back.
 * - `selection.path === 'legacy'` → delegate to
 *   `application.runEpisode(command)` unchanged, then pulse the
 *   compatibility recorder once (the whole point of the W11-A5 inventory is
 *   that every legacy-path use is recorded).
 *
 * Both branches return the uniform `OrchestrationRunResult` so the caller
 * (`orchestrate-cli.ts`) needs no path-specific handling.
 *
 * Throws if the selection dictates the scenario path but no runner can be
 * obtained — that is an inconsistent selection (the resolver should not
 * produce a scenario selection without a resolvable runner). We re-check
 * here rather than trusting the resolver because the runner provider may
 * have become unavailable between resolution and execution.
 */
export async function runEpisodeViaScenarioAdapter(
  inputs: RunEpisodeViaScenarioAdapterInputs,
): Promise<OrchestrationRunResult> {
  const { application, selection, command } = inputs;

  if (selection.path === 'scenario' && selection.installedScenario) {
    const runnerProvider = inputs.scenarioRunnerProvider ?? null;
    if (!runnerProvider) {
      throw new Error(
        'SCENARIO_RUNNER_PROVIDER_REQUIRED: selection chose the scenario ' +
          'path but no scenarioRunnerProvider was supplied to execute it',
      );
    }
    const runner = runnerProvider(selection.installedScenario);
    if (!runner) {
      throw new Error(
        'SCENARIO_RUNNER_UNAVAILABLE: scenarioRunnerProvider returned null ' +
          'for the resolved installed scenario',
      );
    }
    const scenarioCommand = buildScenarioCommand(command);
    const scenarioResult = await runner.run(
      selection.installedScenario,
      scenarioCommand,
    );
    return projectScenarioResultToRunResult(scenarioResult, command);
  }

  // Legacy path. Delegate unchanged and record the compatibility use.
  const result = await application.runEpisode(command);
  recordCompatibilityUse(inputs, selection);
  return result;
}

/**
 * Emit one compatibility-use record for a legacy-path run, if a recorder is
 * wired. Pure with respect to the run result; the only effect is the
 * recorder callback. Swallows recorder errors so a faulty inventory can never
 * break a run (the record is best-effort observability, not a gate).
 */
function recordCompatibilityUse(
  inputs: RunEpisodeViaScenarioAdapterInputs,
  selection: CliScenarioSelection,
): void {
  const recorder = inputs.compatibilityRecorder ?? null;
  if (!recorder) return;
  const now = inputs.now ?? (() => new Date());
  const equivalent = selection.equivalentLegacyManifest;
  const record: CompatibilityUseRecord = {
    recordedAt: now().toISOString(),
    projectId: inputs.command.projectId,
    epicId: inputs.command.epicId,
    reason: selection.reason,
    equivalentScenarioIdentity: equivalent
      ? { name: equivalent.identity.name, version: equivalent.identity.version }
      : null,
    source: 'w11-a4-cli',
  };
  try {
    recorder(record);
  } catch {
    // Best-effort: a faulty inventory recorder must not fail the run. The
    // spec §4 exit gate requires the record to be attempted, not guaranteed.
  }
}

// ---------------------------------------------------------------------------
// Convenience: resolve + execute in one call.
// ---------------------------------------------------------------------------

/**
 * Resolve the selection for a run and execute it through the chosen path.
 *
 * This is the single entry point the integrator's serial cutover commit
 * calls from `orchestrate-cli.ts` (replacing the direct
 * `application.runEpisode` call). It bundles resolution + execution so the
 * host needs no path-specific logic.
 *
 * `resolveInputs` carries the selection inputs (provider/runner/flags);
 * `compatibilityRecorder` is forwarded to the executor for legacy-path
 * recording.
 */
export async function resolveAndRunEpisode(
  application: SagaApplication,
  command: RunEpisodeCommand,
  resolveInputs: Omit<ResolveSelectionInputs, 'projectId' | 'epicId'>,
  options: {
    readonly scenarioRunnerProvider?: ScenarioRunnerProvider | null;
    readonly compatibilityRecorder?: CompatibilityUseRecorder | null;
    readonly now?: () => Date;
  } = {},
): Promise<OrchestrationRunResult> {
  const selection = await resolveCliScenarioSelection({
    ...resolveInputs,
    projectId: command.projectId,
    epicId: command.epicId,
  });
  return runEpisodeViaScenarioAdapter({
    application,
    selection,
    command,
    scenarioRunnerProvider: options.scenarioRunnerProvider ?? null,
    compatibilityRecorder: options.compatibilityRecorder ?? null,
    now: options.now,
  });
}
