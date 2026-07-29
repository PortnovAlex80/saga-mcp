/**
 * W11-A4 — process-modules MCP tool scenario selection adapter.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md lane A4.
 * Task: docs/refactor-management/05-subagent-tasks/W11-a4.md
 * Plan: §0.14 / Phase 13 cutover preparation (§0.14.11 serial gate).
 *
 * PURPOSE
 *   The CLI-side adapter (`orchestrate-cli-scenario-adapter.ts`) selects and
 *   executes one run through the installed-scenario or legacy path. This
 *   file is the MCP-tool-side companion: it exposes the SAME selection
 *   decision to operators via the saga MCP gateway, so an operator can
 *   preview which path a run WILL take and inspect the cutover wiring state
 *   without launching a run.
 *
 *   Two read-only tools:
 *     scenario_selection_resolve  — resolve the path for a (project, epic)
 *                                   run given the current wiring; returns the
 *                                   selection (path/reason/scenario) plus the
 *                                   equivalent legacy manifest identity.
 *     scenario_selection_status   — report which cutover pieces are wired
 *                                   (installed-scenario provider present?
 *                                   scenario runner provider present?) so an
 *                                   operator can see how far the cutover has
 *                                   progressed for this deployment.
 *
 *   Both tools are READ-ONLY and have NO side effects. They never execute a
 *   run, never persist, and never pulse the compatibility recorder. The
 *   cutover spec §1 requires the selection to be feature-detected and
 *   auditable; these tools make the detection result inspectable.
 *
 * WIRING (integrator's serial cutover commit, spec §3)
 *   The selection machinery depends on two optional cutover pieces supplied
 *   by sibling lanes:
 *     - W11-A2 composition loader → `InstalledScenarioProvider`.
 *     - composition root           → `ScenarioRunnerProvider`.
 *   These are NOT imported here (parallel lanes; importing them would break
 *   the build in an isolated A4 worktree). Instead the tool module holds two
 *   module-level slots, `installedScenarioProviderSlot` and
 *   `scenarioRunnerProviderSlot`, that the integrator's wiring populates at
 *   startup. Until populated, every selection resolves to the legacy path,
 *   exactly as the spec requires for a not-yet-cut-over deployment.
 *
 * LAYERING
 *   This module imports the CLI adapter's pure selection resolver + types
 *   (re-using the single decision point — no duplicated logic) and the MCP
 *   Tool/ToolHandler shapes. It introduces ZERO new dependency-direction
 *   edges: the CLI adapter is a sibling `src/` file (not a module impl,
 *   persistence adapter, or lifecycle scenario file), and the scenario
 *   types come from the already-present Wave 7 surface.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  resolveCliScenarioSelection,
  SELECTION_REASON,
  type CliScenarioSelection,
  type InstalledScenarioProvider,
  type ScenarioRunnerProvider,
} from '../orchestrate-cli-scenario-adapter.js';
import type { ToolHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Cutover wiring slots.
//
// Module-level singletons, populated by the integrator's serial cutover
// commit (spec §3) from src/index.ts startup. They mirror the lazy-singleton
// pattern used by src/tools/process-modules.ts (`_resetProcessRunRepository
// ForTests`) and src/tools/lifecycle-runs.ts. Tests reset them between
// cases; production sets them once at boot.
// ---------------------------------------------------------------------------

let installedScenarioProviderSlot: InstalledScenarioProvider | null = null;
let scenarioRunnerProviderSlot: ScenarioRunnerProvider | null = null;

/**
 * Wire the installed-scenario provider (W11-A2 composition loader). Called
 * once at MCP server startup by the integrator's cutover commit. Passing
 * `null` clears the slot (used by tests).
 *
 * Idempotent: the last call wins. The provider is consulted per-run by the
 * selection resolver, so a long-lived MCP server picks up a re-wired
 * provider without restart.
 */
export function setInstalledScenarioProvider(
  provider: InstalledScenarioProvider | null,
): void {
  installedScenarioProviderSlot = provider;
}

/**
 * Wire the scenario-runner provider (composition root). Same lifecycle as
 * the installed-scenario provider.
 */
export function setScenarioRunnerProvider(
  provider: ScenarioRunnerProvider | null,
): void {
  scenarioRunnerProviderSlot = provider;
}

/**
 * Reset both wiring slots. Production never calls this; tests call it between
 * cases so one case's wiring does not leak into the next.
 */
export function _resetScenarioSelectionWiringForTests(): void {
  installedScenarioProviderSlot = null;
  scenarioRunnerProviderSlot = null;
}

/**
 * Snapshot of the cutover wiring state. Returned by
 * `scenario_selection_status`. Pure data.
 */
export interface ScenarioSelectionWiringStatus {
  readonly installedScenarioProviderWired: boolean;
  readonly scenarioRunnerProviderWired: boolean;
  /**
   * Coarse cutover phase derived from the wiring:
   *   'not-started' — neither piece wired → every run takes the legacy path.
   *   'partial'     — provider wired but no runner → runs still legacy
   *                   (SCENARIO_RUNNER_NOT_WIRED) but the provider is
   *                   consulted, so the selection reason distinguishes
   *                   'no scenario installed' from 'runner missing'.
   *   'ready'       — both wired → new runs with an installed scenario take
   *                   the scenario path; legacy fallback remains for runs
   *                   with no installed scenario or forced-legacy.
   */
  readonly cutoverPhase: 'not-started' | 'partial' | 'ready';
}

/**
 * Read the current cutover wiring state. Pure; no side effects.
 */
export function readScenarioSelectionWiringStatus(): ScenarioSelectionWiringStatus {
  const providerWired = installedScenarioProviderSlot !== null;
  const runnerWired = scenarioRunnerProviderSlot !== null;
  const cutoverPhase: ScenarioSelectionWiringStatus['cutoverPhase'] =
    providerWired && runnerWired
      ? 'ready'
      : providerWired || runnerWired
        ? 'partial'
        : 'not-started';
  return {
    installedScenarioProviderWired: providerWired,
    scenarioRunnerProviderWired: runnerWired,
    cutoverPhase,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing helpers (mirror the conventions in process-modules.ts).
// ---------------------------------------------------------------------------

function requiredInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} is required (positive integer)`);
  }
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when provided`);
  }
  return value;
}

function parseDiscoveryGate(
  args: Record<string, unknown>,
): 'permissive' | 'strict' | undefined {
  const raw = args.discovery_gate;
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'permissive' || raw === 'strict') return raw;
  throw new Error(
    "discovery_gate must be 'permissive' or 'strict' when provided",
  );
}

function parseBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') {
    throw new Error(`${key} must be a boolean when provided`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Tool: scenario_selection_resolve
// ---------------------------------------------------------------------------

/**
 * Public projection of a selection for the MCP response. Strips the heavy
 * `installedScenario` object (which carries manifests, locks, installations
 * — too large and too internal for an operator-facing tool) and keeps only
 * the decision + the identities an operator needs to reason about routing.
 */
export interface ScenarioSelectionResolveResult {
  readonly path: CliScenarioSelection['path'];
  readonly reason: CliScenarioSelection['reason'];
  /** Human-readable explanation of the decision (stable wording for tests). */
  readonly explanation: string;
  /**
   * Identity of the installed scenario that WILL execute, when path is
   * 'scenario'. Null for the legacy path.
   */
  readonly installedScenarioIdentity: {
    readonly name: string;
    readonly version: string;
  } | null;
  /**
   * Identity of the legacy compatibility manifest this run is equivalent to,
   * when path is 'legacy'. Null for the scenario path (the installed
   * scenario IS the manifest of record).
   */
  readonly equivalentLegacyScenarioIdentity: {
    readonly name: string;
    readonly version: string;
  } | null;
  /** Snapshot of the wiring that produced this selection. */
  readonly wiring: ScenarioSelectionWiringStatus;
}

/**
 * Resolve the execution path for a (project, epic) run WITHOUT executing it.
 *
 * Uses the SAME `resolveCliScenarioSelection` the CLI adapter uses — this is
 * the single decision point, surfaced read-only. The operator can call this
 * before launching a run to confirm whether it will take the scenario or
 * legacy path under the current wiring.
 */
async function handleScenarioSelectionResolve(
  args: Record<string, unknown>,
): Promise<ScenarioSelectionResolveResult> {
  const projectId = requiredInteger(args, 'project_id');
  const epicId = optionalInteger(args, 'epic_id');
  const discoveryGate = parseDiscoveryGate(args);
  const forceLegacy = parseBoolean(args, 'force_legacy');

  const selection = await resolveCliScenarioSelection({
    projectId,
    epicId,
    installedScenarioProvider: installedScenarioProviderSlot,
    scenarioRunnerProvider: scenarioRunnerProviderSlot,
    discoveryGate,
    forceLegacy,
  });

  return projectSelectionForTool(selection);
}

/**
 * Project a `CliScenarioSelection` into the operator-facing
 * `ScenarioSelectionResolveResult`. Pure. Exposed so the CLI adapter and
 * this tool module share one projection (no duplicated wording).
 */
export function projectSelectionForTool(
  selection: CliScenarioSelection,
): ScenarioSelectionResolveResult {
  const installedIdentity = selection.installedScenario
    ? {
        name: selection.installedScenario.manifest.identity.name,
        version: selection.installedScenario.manifest.identity.version,
      }
    : null;
  const equivalentLegacy = selection.equivalentLegacyManifest
    ? {
        name: selection.equivalentLegacyManifest.identity.name,
        version: selection.equivalentLegacyManifest.identity.version,
      }
    : null;
  return {
    path: selection.path,
    reason: selection.reason,
    explanation: explanationFor(selection),
    installedScenarioIdentity: installedIdentity,
    equivalentLegacyScenarioIdentity: equivalentLegacy,
    wiring: readScenarioSelectionWiringStatus(),
  };
}

/**
 * Stable human-readable explanation of a selection. Wording is fixed so tests
 * can assert on fragments without coupling to prose rewrites.
 */
function explanationFor(selection: CliScenarioSelection): string {
  switch (selection.reason) {
    case SELECTION_REASON.INSTALLED_SCENARIO: {
      const id = selection.installedScenario!.manifest.identity;
      return (
        `New run will execute through the installed scenario ` +
        `${id.name}@${id.version} (Wave 7 ScenarioRunner path).`
      );
    }
    case SELECTION_REASON.NO_INSTALLED_SCENARIO:
      return (
        'No installed scenario provider is wired, or it resolved no scenario ' +
        'for this run. The run will take the legacy ' +
        'SagaApplication.runEpisode path.'
      );
    case SELECTION_REASON.SCENARIO_RUNNER_NOT_WIRED:
      return (
        'A scenario is installed but no ScenarioRunner is wired in the ' +
        'composition root. The run will take the legacy path so it is not ' +
        'blocked by a half-wired cutover.'
      );
    case SELECTION_REASON.LEGACY_FORCED:
      return (
        'The run explicitly requested the legacy path (force_legacy). The ' +
        'run will take the legacy SagaApplication.runEpisode path.'
      );
    default:
      return `Unknown selection reason: ${String(selection.reason)}.`;
  }
}

// ---------------------------------------------------------------------------
// Tool: scenario_selection_status
// ---------------------------------------------------------------------------

/**
 * Report the cutover wiring state. Pure; no inputs.
 */
function handleScenarioSelectionStatus(): ScenarioSelectionWiringStatus {
  return readScenarioSelectionWiringStatus();
}

// ---------------------------------------------------------------------------
// Tool definitions + handler map (consumed by src/index.ts after the
// integrator's serial cutover commit wires them into ALL_TOOLS/ALL_HANDLERS).
// ---------------------------------------------------------------------------

export const definitions: Tool[] = [
  {
    name: 'scenario_selection_resolve',
    description:
      'W11-A4 cutover: resolve which execution path a Product Delivery run '
      + 'WILL take — the installed-scenario path (Wave 7 ScenarioRunner) or '
      + 'the legacy SagaApplication.runEpisode path — WITHOUT executing it. '
      + 'Read-only. Use this to preview routing before launching a run, or '
      + 'to audit why a run took the path it did. The selection is '
      + 'feature-detected from the current cutover wiring.',
    annotations: {
      title: 'Scenario Selection: Resolve',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'integer',
          minimum: 1,
          description: 'Project the run belongs to.',
        },
        epic_id: {
          type: 'integer',
          minimum: 1,
          description: 'Optional epic scope. Null = project-wide run.',
        },
        discovery_gate: {
          type: 'string',
          enum: ['permissive', 'strict'],
          description:
            "Discovery gate mode for the legacy-equivalent manifest label. "
            + "'permissive' (default) or 'strict'. Does not change routing.",
        },
        force_legacy: {
          type: 'boolean',
          description:
            'Operator override to force the legacy path for this run '
            + '(e.g. replaying a pinned legacy run).',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'scenario_selection_status',
    description:
      'W11-A4 cutover: report which cutover pieces are wired in this '
      + 'deployment — the installed-scenario provider (W11-A2 composition '
      + 'loader) and the scenario-runner provider (composition root). '
      + 'Read-only. Returns a coarse cutover phase '
      + "(not-started / partial / ready) so an operator can see how far the "
      + 'cutover has progressed.',
    annotations: {
      title: 'Scenario Selection: Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  scenario_selection_resolve: handleScenarioSelectionResolve,
  scenario_selection_status: handleScenarioSelectionStatus,
};
