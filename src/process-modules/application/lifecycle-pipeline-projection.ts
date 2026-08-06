/**
 * Lifecycle-agnostic pipeline projection.
 *
 * Pure projection that turns a durable `LifecycleRunRecord` (plus its
 * `StageRun`s and `Transition`s) into a flat, frontend-facing `PipelineView`:
 * the ordered pipeline of stages with per-stage runtime status, timing, and a
 * top-level terminal marker. It is fully LIFECYCLE-AGNOSTIC — there is no
 * switch/case on stage names or lifecycle names. All routing is read from the
 * declarative `definitionSnapshot` embedded on the run.
 *
 * Layering (clean architecture): this file owns its narrow read-model inputs
 * and imports only domain value types. It has no dependency on persistence,
 * SQLite or HTTP. Outer adapters may pass full repository records because
 * structural typing satisfies these deliberately small input contracts.
 *
 * The `PipelineView` shape is a FROZEN contract consumed by tracker-view; field
 * names, casing and nullability must not change without a coordinated frontend
 * update.
 */

import type {
  LifecycleDefinition,
  StageBinding,
  TransitionTarget,
} from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';

export type LifecyclePipelineStageRunStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface LifecyclePipelineRunInput {
  readonly id: number;
  readonly definitionSnapshot: string;
  readonly status: string;
  readonly currentStageId: string | null;
  readonly terminalStatus: string | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
}

export interface LifecyclePipelineStageRunInput {
  readonly stageId: string;
  readonly attempt: number;
  readonly status: LifecyclePipelineStageRunStatus;
  readonly localOutcome: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Frozen output contract (PipelineView).
// ---------------------------------------------------------------------------

/** {@name, version} reference to a registered Process Module. */
export interface ModuleRef {
  readonly name: string;
  readonly version: string;
}

/** The lifecycle identity this run belongs to. */
export interface LifecycleRef {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
}

/** Run-level summary carried straight off the durable LifecycleRunRecord. */
export interface RunSummary {
  readonly id: number;
  readonly status: string;
  readonly terminalStatus: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly error: string | null;
}

/**
 * One stage of the pipeline. The stage identity, order and module come from the
 * frozen definition snapshot; the runtime status/timing come from the latest
 * StageRun for that stage.
 */
export interface PipelineStageView {
  readonly stageId: string;
  readonly ordinal: number;
  readonly displayName: string;
  readonly module: ModuleRef;
  readonly status:
    | 'completed'
    | 'in_progress'
    | 'paused'
    | 'failed'
    | 'pending'
    | 'skipped';
  readonly localOutcome: string | null;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationS: number | null;
  readonly isLive: boolean;
}

/**
 * Set when the lifecycle ended at a stage via a terminal outcome route (or the
 * run reached a terminal status). `null` while the run is still in flight.
 */
export interface Terminal {
  readonly status: string;
  readonly atStageId: string;
  readonly outcome: string;
}

/**
 * The complete pipeline view served to the frontend. `terminal` is `null` for
 * view when the whole projection is `null` (no run exists for the epic).
 */
export interface PipelineView {
  readonly lifecycle: LifecycleRef;
  readonly run: RunSummary;
  readonly stages: readonly PipelineStageView[];
  readonly terminal: Terminal | null;
}

// ---------------------------------------------------------------------------
// Status mapping (LifecycleStageRunStatus -> PipelineStageView.status).
// ---------------------------------------------------------------------------

const COMPLETED_LIKE: ReadonlySet<LifecyclePipelineStageRunStatus> = new Set(['completed']);
const IN_PROGRESS_LIKE: ReadonlySet<LifecyclePipelineStageRunStatus> = new Set(['running']);
const PAUSED_LIKE: ReadonlySet<LifecyclePipelineStageRunStatus> = new Set(['paused']);
const FAILED_LIKE: ReadonlySet<LifecyclePipelineStageRunStatus> = new Set([
  'failed',
  'cancelled',
]);

type StageStatus =
  | 'completed'
  | 'in_progress'
  | 'paused'
  | 'failed'
  | 'pending'
  | 'skipped';

function mapStageStatus(runStatus: LifecyclePipelineStageRunStatus): StageStatus {
  if (COMPLETED_LIKE.has(runStatus)) return 'completed';
  if (IN_PROGRESS_LIKE.has(runStatus)) return 'in_progress';
  if (PAUSED_LIKE.has(runStatus)) return 'paused';
  if (FAILED_LIKE.has(runStatus)) return 'failed';
  // created (never observed to reach the bar once running) — treat as pending.
  return 'pending';
}

// ---------------------------------------------------------------------------
// Timestamp normalization.
// ---------------------------------------------------------------------------

/**
 * Normalize SQLite UTC datetime values to unambiguous ISO 8601. SQLite stores
 * these timestamps without a zone; emitting a trailing Z prevents browsers
 * from interpreting them as local time.
 */
function normalizeTimestamp(value: string | null): string | null {
  if (value === null) return null;
  // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SSZ"
  if (value.length === 19 && value.charAt(10) === ' ') {
    return `${value.slice(0, 10)}T${value.slice(11)}Z`;
  }
  // Also disambiguate an ISO-shaped value without an explicit zone.
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)) {
    return `${value}Z`;
  }
  return value;
}

/**
 * Integer seconds between startedAt and completedAt, ONLY when completedAt is
 * present. Else null.
 */
function computeDurationS(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (completedAt === null || startedAt === null) return null;
  const normalizedStart = normalizeTimestamp(startedAt);
  const normalizedEnd = normalizeTimestamp(completedAt);
  if (normalizedStart === null || normalizedEnd === null) return null;
  const start = Date.parse(normalizedStart);
  const end = Date.parse(normalizedEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const delta = Math.round((end - start) / 1000);
  return delta >= 0 ? delta : null;
}

// ---------------------------------------------------------------------------
// Definition snapshot parsing.
// ---------------------------------------------------------------------------

/**
 * Parsed projection of a `StageBinding` as it appears in the canonical
 * `definitionSnapshot`. Only the fields the projection needs are read; the
 * mappings/conditions are intentionally ignored.
 */
interface DefinitionStage {
  readonly id: string;
  readonly displayName: string;
  readonly moduleRef: ProcessModuleReference;
  readonly outcomeRoutes: Readonly<Record<string, TransitionTarget>>;
}

interface ParsedDefinition {
  readonly identity: LifecycleRef;
  readonly entryStageId: string;
  readonly stages: readonly DefinitionStage[];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`LIFECYCLE_DEFINITION_INVALID: ${field} is not a string`);
  }
  return value;
}

function asModuleRef(value: unknown, field: string): ProcessModuleReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LIFECYCLE_DEFINITION_INVALID: ${field} is not an object`);
  }
  const obj = value as Record<string, unknown>;
  return {
    name: asString(obj.name, `${field}.name`),
    version: asString(obj.version, `${field}.version`),
  };
}

function asOutcomeRoutes(
  value: unknown,
  field: string,
): Readonly<Record<string, TransitionTarget>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LIFECYCLE_DEFINITION_INVALID: ${field} is not an object`);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, TransitionTarget> = {};
  for (const [outcome, target] of Object.entries(obj)) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(
        `LIFECYCLE_DEFINITION_INVALID: ${field}.${outcome} is not an object`,
      );
    }
    const t = target as Record<string, unknown>;
    if (t.type === 'stage') {
      out[outcome] = { type: 'stage', stageId: asString(t.stageId, `${field}.${outcome}.stageId`) };
    } else if (t.type === 'terminal') {
      out[outcome] = { type: 'terminal', status: asString(t.status, `${field}.${outcome}.status`) };
    } else {
      throw new Error(
        `LIFECYCLE_DEFINITION_INVALID: ${field}.${outcome}.type must be 'stage' or 'terminal'`,
      );
    }
  }
  return out;
}

/**
 * Parse the canonical JSON `definitionSnapshot` pinned on the run into the
 * subset of the LifecycleDefinition the projection consumes. Uses plain
 * JSON.parse: the snapshot was already canonicalized at start time, so a plain
 * read is sufficient and avoids importing the canonicalizer into this pure
 * module for no functional benefit.
 */
function parseDefinitionSnapshot(snapshot: string): ParsedDefinition {
  const raw = JSON.parse(snapshot) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('LIFECYCLE_DEFINITION_INVALID: snapshot is not an object');
  }
  const def = raw as LifecycleDefinition;
  const identity = def.identity;
  if (!identity || typeof identity !== 'object') {
    throw new Error('LIFECYCLE_DEFINITION_INVALID: identity missing');
  }
  const idObj = identity as unknown as Record<string, unknown>;
  const lifecycle: LifecycleRef = {
    name: asString(idObj.name, 'identity.name'),
    version: asString(idObj.version, 'identity.version'),
    displayName: asString(idObj.displayName, 'identity.displayName'),
    description: asString(idObj.description, 'identity.description'),
  };
  const entryStageId = asString(def.entryStageId, 'entryStageId');
  if (!Array.isArray(def.stages)) {
    throw new Error('LIFECYCLE_DEFINITION_INVALID: stages is not an array');
  }
  const stages: DefinitionStage[] = def.stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error(`LIFECYCLE_DEFINITION_INVALID: stages[${index}] is not an object`);
    }
    const s = stage as StageBinding;
    return {
      id: asString(s.id, `stages[${index}].id`),
      displayName: asString(s.displayName, `stages[${index}].displayName`),
      moduleRef: asModuleRef(s.moduleRef, `stages[${index}].moduleRef`),
      outcomeRoutes: asOutcomeRoutes(s.outcomeRoutes, `stages[${index}].outcomeRoutes`),
    };
  });
  return { identity: lifecycle, entryStageId, stages };
}

// ---------------------------------------------------------------------------
// Terminal detection.
// ---------------------------------------------------------------------------

interface TerminalMarker {
  readonly status: string;
  readonly atStageId: string;
  readonly outcome: string;
}

/**
 * Determine whether the run ended at a stage via a terminal outcome route.
 *
 * Lifecycle-agnostic: we look at the LATEST StageRun that has a localOutcome,
 * and ask whether that outcome's route in the definition is `{type:'terminal'}`.
 * We also honor `run.terminalStatus` / terminal `run.status` as a fallback so a
 * run that was failed/cancelled by an operator still surfaces a terminal block.
 */
function detectTerminal(
  definition: ParsedDefinition,
  run: LifecyclePipelineRunInput,
  orderedRuns: readonly LifecyclePipelineStageRunInput[],
): TerminalMarker | null {
  // 1) Route-driven terminal: the most recent stage with an outcome routed to
  //    a terminal target. Walk the definition order and take the highest-ordinal
  //    stage that actually has a completed-with-outcome run whose route is
  //    terminal.
  for (let i = definition.stages.length - 1; i >= 0; i -= 1) {
    const stage = definition.stages[i];
    const stageRuns = orderedRuns.filter(r => r.stageId === stage.id);
    if (stageRuns.length === 0) continue;
    // highest attempt wins for "the current verdict"
    const latest = stageRuns.reduce((a, b) => (a.attempt > b.attempt ? a : b));
    if (latest.localOutcome === null) continue;
    const route = stage.outcomeRoutes[latest.localOutcome];
    if (route && route.type === 'terminal') {
      return {
        status: route.status,
        atStageId: stage.id,
        outcome: latest.localOutcome,
      };
    }
  }

  // 2) Run-level terminal fallback: failed/cancelled with a terminalStatus.
  if (
    (run.status === 'failed' || run.status === 'cancelled')
    && run.terminalStatus !== null
  ) {
    const atStageId = run.currentStageId ?? definition.entryStageId;
    // recover an outcome from the latest run at the current stage if present
    const latestAtCurrent = orderedRuns
      .filter(r => r.stageId === atStageId)
      .reduce<LifecyclePipelineStageRunInput | null>(
        (a, b) => (a === null || b.attempt > a.attempt ? b : a),
        null,
      );
    return {
      status: run.terminalStatus,
      atStageId,
      outcome: latestAtCurrent?.localOutcome ?? run.terminalStatus,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stage assembly.
// ---------------------------------------------------------------------------

/**
 * Build the ordered pipeline of stage views by merging each definition stage
 * with its runtime StageRun(s).
 */
function buildStages(
  definition: ParsedDefinition,
  orderedRuns: readonly LifecyclePipelineStageRunInput[],
  terminal: TerminalMarker | null,
): readonly PipelineStageView[] {
  const terminalIndex = terminal
    ? definition.stages.findIndex(s => s.id === terminal.atStageId)
    : -1;

  return definition.stages.map((stage, index) => {
    const stageRuns = orderedRuns.filter(r => r.stageId === stage.id);
    if (stageRuns.length === 0) {
      // No run for this definition stage.
      const isAfterTerminal =
        terminal !== null && index > terminalIndex && terminalIndex >= 0;
      return {
        stageId: stage.id,
        ordinal: index + 1,
        displayName: stage.displayName,
        module: stage.moduleRef,
        status: isAfterTerminal ? 'skipped' : 'pending',
        localOutcome: null,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        durationS: null,
        isLive: false,
      };
    }

    // Rework: multiple StageRuns same stageId -> highest attempt is the bar.
    const latest = stageRuns.reduce((a, b) => (a.attempt > b.attempt ? a : b));
    const status = mapStageStatus(latest.status);
    const startedAt = normalizeTimestamp(latest.startedAt);
    const completedAt = normalizeTimestamp(latest.completedAt);
    const isLive = status === 'in_progress' && startedAt !== null;

    return {
      stageId: stage.id,
      ordinal: index + 1,
      displayName: stage.displayName,
      module: stage.moduleRef,
      status,
      localOutcome: latest.localOutcome,
      attempt: latest.attempt,
      startedAt,
      completedAt,
      // durationS is null while the stage is live (frontend ticks it).
      durationS: isLive ? null : computeDurationS(latest.startedAt, latest.completedAt),
      isLive,
    };
  });
}

// ---------------------------------------------------------------------------
// Public pure projection.
// ---------------------------------------------------------------------------

/**
 * Pure projection of one LifecycleRun plus its StageRuns into a
 * `PipelineView`. No IO, no DB, no HTTP. Deterministic.
 *
 */
export function projectPipeline(
  run: LifecyclePipelineRunInput,
  stageRuns: readonly LifecyclePipelineStageRunInput[],
): PipelineView {
  const definition = parseDefinitionSnapshot(run.definitionSnapshot);
  const terminal = detectTerminal(definition, run, stageRuns);
  const stages = buildStages(definition, stageRuns, terminal);

  return {
    lifecycle: definition.identity,
    run: {
      id: run.id,
      status: run.status,
      terminalStatus: run.terminalStatus,
      startedAt: normalizeTimestamp(run.startedAt),
      updatedAt: normalizeTimestamp(run.updatedAt),
      error: run.error,
    },
    stages,
    terminal,
  };
}
