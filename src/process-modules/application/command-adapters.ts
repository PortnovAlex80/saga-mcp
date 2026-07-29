/**
 * W11-A3 — Generic application command + result adapters.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md lane A3.
 * Plan: §0.14 / Phase 13 preparation, §13.22.
 *
 * # What this file owns
 *
 * Outer compatibility adapters (plan §13.22: "Current generic application
 * commands and results still contain mandatory project, epic, and
 * Discovery-oriented fields. These require outer compatibility adapters
 * around a generic scenario command and result.") around TWO existing
 * execution surfaces:
 *
 *   1. The legacy {@link RunLifecycleCommand} + {@link LifecycleExecutionResult}
 *      pair owned by `./lifecycle-orchestrator.ts` (the hot file Wave 11
 *      cutover rewrites — this adapter does NOT touch that file).
 *   2. The Wave 7 scenario {@link RunScenarioCommand} +
 *      {@link ScenarioExecutionResult} pair owned by `./scenario-runner.ts`.
 *
 * The generic surface this file exposes drops the MANDATORY `projectId` /
 * `epicId` fields that both underlying commands still require. In the generic
 * view those become OPTIONAL adapter fields: a caller that does not have (or
 * does not care about) project/epic scope supplies a scope resolver, and the
 * adapter synthesizes the concrete command the underlying orchestrator
 * demands. This is the §13.22 contract verbatim: project/epic become optional
 * ADAPTER fields, not mandatory command fields.
 *
 * # Why a NEW file (Wave 11 anti-scope)
 *
 * WAVE11-CUTOVER-SPEC.md §5 anti-scope: NO legacy code deletion and NO rewrite
 * of the existing orchestrator surfaces in this wave. Both paths must coexist
 * (spec §0 objective). This adapter is the explicit compatibility bridge: it
 * wraps the existing typed commands/results rather than editing them, so the
 * legacy `RunLifecycleCommand.projectId: number` (required) keeps its contract
 * while new generic callers reach the same runtime through the adapter.
 *
 * # Purity / dependency tier
 *
 * Application-layer adapter: it imports only the application command/result
 * TYPES it wraps (type-only — `import type`) plus the `LifecycleRunRecord` /
 * `LifecycleStageRunRecord` persistence record types and the
 * `ScenarioStageOutputRecord` declared by the scenario runner. It imports NO
 * sqlite adapter, NO `db.ts`, NO module implementation, NO composition root.
 * The dependency-direction ratchet
 * (`tests/architecture/dependency-direction.test.mjs`) enforces this — every
 * import here is a type-only import into the application layer, so it adds
 * zero Rule 1–6 edges.
 */

import type { LifecycleRunRecord } from '../persistence/lifecycle-run.js';
import type { LifecycleStageRunRecord } from '../persistence/lifecycle-run.js';
import type { RunLifecycleCommand, LifecycleExecutionResult } from './lifecycle-orchestrator.js';
import type {
  RunScenarioCommand,
  ScenarioExecutionResult,
  ScenarioStageOutputRecord,
} from './scenario-runner.js';

// ---------------------------------------------------------------------------
// Generic scope (§13.22).
//
// The generic command carries NO mandatory project/epic. A scope resolver
// supplies them when projecting to a concrete command. This is the §13.22
// decoupling: the generic application command is Discovery/board agnostic;
// the board scope is an ADAPTER concern, not a command-field concern.
// ---------------------------------------------------------------------------

/**
 * Optional scope adapter fields (§13.22). All fields optional: a generic run
 * that is not board-scoped supplies none of them.
 *
 * `projectId`/`epicId` are the two fields the legacy `RunLifecycleCommand`
 * and the Wave 7 `RunScenarioCommand` make MANDATORY. The generic view makes
 * them optional here; the adapter resolves them (defaulting to `0`/`null`)
 * when projecting to a concrete command. The default `0` matches what the
 * existing composition root passes for non-board invocations and is what the
 * `invocationContext` record persists verbatim — so a generic run replays
 * identically to a board-scoped run with `projectId = 0`.
 */
export interface GenericLifecycleScope {
  /** Logical product board the run belongs to. Omit for non-board runs. */
  readonly projectId?: number;
  /**
   * Epic (REQ episode) within the board. `null` is a real value (project-wide
   * run); `undefined` means "unspecified" and resolves to `null`.
   */
  readonly epicId?: number | null;
  /** Caller identity recorded on the run (who initiated it). */
  readonly initiatedBy?: string;
}

/**
 * Resolve a {@link GenericLifecycleScope} into the concrete
 * `(projectId, epicId, initiatedBy)` triple the underlying commands require.
 *
 * The default scope fills every absent field so the projected command always
 * satisfies the mandatory `projectId: number` / `epicId: number | null` /
 * `initiatedBy: string` contracts of `RunLifecycleCommand` and
 * `RunScenarioCommand`:
 *   - missing `projectId`  → `0`   (non-board sentinel used by the composition root)
 *   - missing `epicId`     → `null` (project-wide / no episode)
 *   - missing `initiatedBy`→ `'generic'`
 *
 * `null` epicId is preserved (it is a distinct, meaningful value from
 * "unspecified").
 *
 * Pure: no I/O, no allocation beyond the returned object literal.
 */
export function resolveGenericScope(
  scope: GenericLifecycleScope | undefined,
): { projectId: number; epicId: number | null; initiatedBy: string } {
  const s = scope ?? {};
  return {
    projectId: s.projectId ?? 0,
    epicId: s.epicId === undefined ? null : s.epicId,
    initiatedBy: s.initiatedBy ?? 'generic',
  };
}

// ---------------------------------------------------------------------------
// Generic command + result.
// ---------------------------------------------------------------------------

/**
 * Generic application command to start a lifecycle run (§13.22). Carries the
 * run inputs (schema/payload/idempotency) and an OPTIONAL scope — project/epic
 * are adapter fields, not mandatory command fields.
 *
 * `resumePaused` mirrors the explicit controller authority both underlying
 * commands accept; it is passed through verbatim by the adapters.
 */
export interface GenericRunLifecycleCommand {
  readonly inputSchema: string;
  readonly inputPayload: unknown;
  readonly idempotencyKey: string;
  /** Optional scope adapter fields (§13.22). See {@link GenericLifecycleScope}. */
  readonly scope?: GenericLifecycleScope;
  /** Explicit controller authority to resume a durable semantic/human pause. */
  readonly resumePaused?: boolean;
}

/**
 * Generic lifecycle execution result. Mirrors both
 * {@link LifecycleExecutionResult} and {@link ScenarioExecutionResult} minus
 * the surface-specific extras (`outputs` is scenario-only). The adapter
 * normalizes whichever underlying result it wrapped into this shape so a
 * generic caller treats legacy and scenario runs uniformly during the Wave 11
 * cutover.
 *
 * `source` records which underlying surface produced the result so the
 * cutover's compatibility-usage reporting (W11-A5/A8) can attribute every
 * generic result to its concrete path without re-deriving it.
 */
export interface GenericLifecycleExecutionResult {
  /** Which underlying execution surface produced this result. */
  readonly source: 'legacy-orchestrator' | 'scenario-runner';
  readonly lifecycleRun: LifecycleRunRecord;
  readonly stageRuns: readonly LifecycleStageRunRecord[];
  readonly status: LifecycleRunRecord['status'];
  readonly terminalStatus: string | null;
  readonly pausedAtStageId: string | null;
  /**
   * Public outputs produced during the run (scenario surface only — always
   * empty for legacy-orchestrator results, which have no public-output store).
   */
  readonly outputs: readonly ScenarioStageOutputRecord[];
}

// ---------------------------------------------------------------------------
// Command adapters (generic → concrete).
//
// Pure projections: take a generic command, return the concrete command the
// underlying orchestrator/runner demands. No behavior, no I/O — the call site
// still invokes the orchestrator/runner itself. This keeps the adapter a thin
// compatibility bridge (§13.22), not a new execution path.
// ---------------------------------------------------------------------------

/**
 * Adapter: project a {@link GenericRunLifecycleCommand} into the concrete
 * {@link RunLifecycleCommand} the legacy `LifecycleOrchestrator.run(...)`
 * requires.
 *
 * Project/epic/initiatedBy are resolved from the generic command's optional
 * {@link GenericLifecycleScope} via {@link resolveGenericScope}; every other
 * field is passed through verbatim.
 *
 * Pure. Throws nothing.
 */
export function adaptCommandToLegacy(
  command: GenericRunLifecycleCommand,
): RunLifecycleCommand {
  const scope = resolveGenericScope(command.scope);
  return {
    projectId: scope.projectId,
    epicId: scope.epicId,
    inputSchema: command.inputSchema,
    inputPayload: command.inputPayload,
    initiatedBy: scope.initiatedBy,
    idempotencyKey: command.idempotencyKey,
    ...(command.resumePaused === undefined ? {} : { resumePaused: command.resumePaused }),
  };
}

/**
 * Adapter: project a {@link GenericRunLifecycleCommand} into the concrete
 * {@link RunScenarioCommand} the Wave 7 `ScenarioRunner.run(...)` requires.
 *
 * Scope resolution is identical to {@link adaptCommandToLegacy}; the two
 * underlying commands share the same `(projectId, epicId, initiatedBy)`
 * invocation-context shape by design (the scenario runner was built to mirror
 * the legacy command — see `scenario-runner.ts` §`RunScenarioCommand`).
 *
 * Pure. Throws nothing.
 */
export function adaptCommandToScenario(
  command: GenericRunLifecycleCommand,
): RunScenarioCommand {
  const scope = resolveGenericScope(command.scope);
  return {
    projectId: scope.projectId,
    epicId: scope.epicId,
    inputSchema: command.inputSchema,
    inputPayload: command.inputPayload,
    initiatedBy: scope.initiatedBy,
    idempotencyKey: command.idempotencyKey,
    ...(command.resumePaused === undefined ? {} : { resumePaused: command.resumePaused }),
  };
}

// ---------------------------------------------------------------------------
// Result adapters (concrete → generic).
//
// Pure normalizers: take a typed result from either underlying surface and
// return the generic {@link GenericLifecycleExecutionResult}. The legacy
// result has no `outputs` field (it has no public-output store), so the
// adapter synthesizes an empty array; the scenario result's `outputs` are
// passed through verbatim.
// ---------------------------------------------------------------------------

/**
 * Adapter: normalize a legacy {@link LifecycleExecutionResult} into a
 * {@link GenericLifecycleExecutionResult}. `source` is stamped
 * `'legacy-orchestrator'` and `outputs` is empty (the legacy orchestrator has
 * no public stage-output store).
 *
 * Pure. Throws nothing.
 */
export function adaptLegacyResult(
  result: LifecycleExecutionResult,
): GenericLifecycleExecutionResult {
  return {
    source: 'legacy-orchestrator',
    lifecycleRun: result.lifecycleRun,
    stageRuns: result.stageRuns,
    status: result.status,
    terminalStatus: result.terminalStatus,
    pausedAtStageId: result.pausedAtStageId,
    outputs: EMPTY_OUTPUTS,
  };
}

/**
 * Adapter: normalize a scenario {@link ScenarioExecutionResult} into a
 * {@link GenericLifecycleExecutionResult}. `source` is stamped
 * `'scenario-runner'` and the scenario's public `outputs` are passed through
 * verbatim.
 *
 * Pure. Throws nothing.
 */
export function adaptScenarioResult(
  result: ScenarioExecutionResult,
): GenericLifecycleExecutionResult {
  return {
    source: 'scenario-runner',
    lifecycleRun: result.lifecycleRun,
    stageRuns: result.stageRuns,
    status: result.status,
    terminalStatus: result.terminalStatus,
    pausedAtStageId: result.pausedAtStageId,
    outputs: result.outputs,
  };
}

/**
 * Frozen empty array reused as the `outputs` default for legacy results so the
 * adapter allocates nothing on the hot path and the returned `outputs` field
 * is always a stable readonly reference.
 */
const EMPTY_OUTPUTS: readonly ScenarioStageOutputRecord[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// High-level adapter helpers (command → run → generic result).
//
// These wrap an underlying `run(...)` callable so a generic caller can stay
// entirely on the generic surface: pass a generic command + the concrete
// orchestrator/runner, receive a generic result. They exist for ergonomics;
// the projection-only adapters above remain the canonical, testable bridge.
// ---------------------------------------------------------------------------

/**
 * Adapter: run `definition` via the legacy {@link LifecycleOrchestrator} using
 * a {@link GenericRunLifecycleCommand}, returning a
 * {@link GenericLifecycleExecutionResult}. The caller passes the orchestrator
 * instance (no orchestrator import here — keeps this file free of any concrete
 * service dependency beyond the command/result types it adapts).
 *
 * Convenience wrapper over {@link adaptCommandToLegacy} +
 * {@link adaptLegacyResult}; behaviorally identical to calling those two
 * directly around `orchestrator.run(...)`.
 */
export async function runLifecycleGeneric(
  orchestrator: {
    run(
      definition: Parameters<LifecycleOrchestratorLike['run']>[0],
      command: RunLifecycleCommand,
    ): Promise<LifecycleExecutionResult>;
  },
  definition: Parameters<LifecycleOrchestratorLike['run']>[0],
  command: GenericRunLifecycleCommand,
): Promise<GenericLifecycleExecutionResult> {
  const result = await orchestrator.run(definition, adaptCommandToLegacy(command));
  return adaptLegacyResult(result);
}

/**
 * Adapter: run `scenario` via the Wave 7 {@link ScenarioRunner} using a
 * {@link GenericRunLifecycleCommand}, returning a
 * {@link GenericLifecycleExecutionResult}.
 *
 * Convenience wrapper over {@link adaptCommandToScenario} +
 * {@link adaptScenarioResult}.
 */
export async function runScenarioGeneric(
  runner: {
    run(
      scenario: Parameters<ScenarioRunnerLike['run']>[0],
      command: RunScenarioCommand,
    ): Promise<ScenarioExecutionResult>;
  },
  scenario: Parameters<ScenarioRunnerLike['run']>[0],
  command: GenericRunLifecycleCommand,
): Promise<GenericLifecycleExecutionResult> {
  const result = await runner.run(scenario, adaptCommandToScenario(command));
  return adaptScenarioResult(result);
}

// ---------------------------------------------------------------------------
// Structural service-shape declarations.
//
// The high-level helpers above take the orchestrator/runner by structural
// shape (only the `run(...)` method is needed) rather than by class import, so
// this file imports NO concrete service class. The two `*Like` interfaces
// declare the minimal slice of each service's shape the helpers rely on. They
// are structurally assignment-compatible with `LifecycleOrchestrator` and
// `ScenarioRunner` respectively; TypeScript verifies that at the call site.
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of `LifecycleOrchestrator` for
 * {@link runLifecycleGeneric}. Declared locally (not imported) so this file
 * has no value import of the orchestrator class — only the command/result
 * type imports above.
 */
interface LifecycleOrchestratorLike {
  run(
    definition: unknown,
    command: RunLifecycleCommand,
  ): Promise<LifecycleExecutionResult>;
}

/**
 * Minimal structural view of `ScenarioRunner` for {@link runScenarioGeneric}.
 */
interface ScenarioRunnerLike {
  run(
    scenario: unknown,
    command: RunScenarioCommand,
  ): Promise<ScenarioExecutionResult>;
}
