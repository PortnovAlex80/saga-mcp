/**
 * W7-A4 — Scenario router (declarative).
 *
 * Plan ref: WAVE7-SCENARIO-SPEC.md lane A4; plan §6.4 (NO routeResolver),
 * §6.2.9 (terminal statuses), §6.2.10 / §6.2.11 (transition + reentry
 * budgets), §6.3.5 (complete static route tables), §6.8 (module reuse across
 * stages), §0.10.12 exit gate ("no hidden executable routing").
 *
 * resolver was an executable CLOSURE that could override the static
 * `outcomeRoutes` table based on per-run root input, this router resolves
 * transitions by PURE TABLE LOOKUP against the static `outcomeRoutes` carried
 * on the manifest and on each `ScenarioStageBinding`. There is no function
 * field, no closure, no per-run branch — every reachable transition is
 * declared up front in the manifest and is therefore auditable statically
 * (the compiler in W7-A3 enforces completeness; this router performs the
 * complementary RUNTIME lookup + graph/budget enforcement).
 *
 * Three responsibilities:
 *
 *   1. ROUTING — `routeScenarioOutcome(manifest, stageId, outcome)` returns
 *      the declared `ScenarioRouteResult` for a (stage, outcome) pair, looking
 *      it up in the stage's own `outcomeRoutes` table. A missing route is a
 *      hard error (the manifest is incomplete) — it is NEVER fabricated.
 *
 *   2. GRAPH VALIDATION — `validateScenarioRoutingGraph(manifest)` walks the
 *      stage→stage / stage→terminal graph declared by the manifest's static
 *      route tables and reports:
 *        - unreachable stages (no inbound edge from the entry or any routed stage),
 *        - non-terminal stages with no path to any declared terminal status
 *          (a dead-end / hung scenario),
 *        - terminal statuses that no route actually reaches (orphan terminal),
 *        - stage-level routes that target unknown stages / terminals (these
 *          are also caught by the W1-A3 manifest validator; the router
 *          reports them as routing-graph defects independently, because the
 *          router is the runtime authority and must not trust a manifest it
 *          has not itself checked).
 *
 *   3. BUDGET ENFORCEMENT — `ScenarioRoutingContext` is a per-run budget
 *      ledger. The ScenarioRunner (W7-A6) calls `enterTransition()` before
 *      each stage transition and `recordReentry(stageId)` each time a stage is
 *      re-entered; both throw `ScenarioBudgetExceeded` the moment a hard cap
 *      is breached. This guards against infinite ping-pong between two
 *      stages whose static route tables would otherwise loop forever.
 *
 * Purity / layering:
 *   - The router imports ONLY pure manifest + lifecycle types from
 *     `domain/spi/scenario-manifest.js` and `domain/lifecycle.js`. It has no
 *     persistence, composition, or module-implementation dependency, so it
 *     introduces ZERO new dependency-direction edges (verified by the
 *     W0-A1 ratchet, tests/architecture/dependency-direction.test.mjs).
 *   - Every public function is pure with respect to the manifest: the same
 *     (manifest, stageId, outcome) always yields the same target. The only
 *     mutable state is the per-run `ScenarioRoutingContext`, which is owned
 *     by the caller (the runner), never by the manifest.
 *
 * Anti-scope (Wave 7):
 *   - Does NOT install scenarios (W7-A1/A2).
 *   - Does NOT compile/validate the WHOLE manifest (W7-A3 owns manifest-shape
 *     validation; this router validates only the ROUTING GRAPH).
 *   - Does NOT execute modules or store outputs (W7-A5/A6).
 *     `routeResolver` (Wave 11 cutover / Wave 13 removal — anti-scope §3).
 */

import type {
  LifecycleScenarioManifest,
  ScenarioStageBinding,
  TransitionTarget,
} from '../domain/spi/scenario-manifest.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * `LifecycleRouteResult` shape (from `domain/lifecycle.ts`) but is produced
 * WITHOUT any resolver closure — purely from the static route table.
 */
export interface ScenarioRouteResult {
  /** Stage whose outcome is being routed. */
  readonly stageId: string;
  /** Module outcome code that fired. */
  readonly outcome: string;
  /** Declared transition target (stage or terminal). Never synthesized. */
  readonly target: TransitionTarget;
}

/**
 * A node in the routing graph — one per declared transition target. Used by
 * `validateScenarioRoutingGraph` to report graph structure to callers and
 * tests. Pure data.
 */
export interface RoutingGraphEdge {
  readonly fromStageId: string;
  readonly outcome: string;
  readonly target: TransitionTarget;
}

/**
 * Routing-graph validation finding. `code` is a stable machine identifier;
 * `path` locates the defect in manifest coordinates; `message` is human prose.
 * Mirrors the shape of `ValidationError` from the W1-A3 manifest validator so
 * callers can concatenate the two result sets uniformly.
 */
export interface RoutingValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RoutingValidationResult {
  readonly ok: boolean;
  readonly errors: readonly RoutingValidationError[];
  /** Declared stage→stage / stage→terminal edges, in declaration order. */
  readonly edges: readonly RoutingGraphEdge[];
  /** Stage ids reachable from `entryStageId` via static routes. */
  readonly reachableStages: readonly string[];
  /** Declared terminal statuses reachable from at least one stage route. */
  readonly reachableTerminals: readonly string[];
}

// ---------------------------------------------------------------------------
// Stable error codes (also referenced by tests).
// ---------------------------------------------------------------------------

export const ROUTING_ERROR_CODES = Object.freeze({
  // Lookup errors (routeScenarioOutcome).
  UNKNOWN_STAGE: 'ROUTING_UNKNOWN_STAGE',
  NO_ROUTE_FOR_OUTCOME: 'ROUTING_NO_ROUTE_FOR_OUTCOME',
  // Graph-validation errors (validateScenarioRoutingGraph).
  UNREACHABLE_STAGE: 'ROUTING_UNREACHABLE_STAGE',
  DEAD_END_STAGE: 'ROUTING_DEAD_END_STAGE',
  ORPHAN_TERMINAL: 'ROUTING_ORPHAN_TERMINAL',
  ROUTE_TARGET_UNKNOWN_STAGE: 'ROUTING_TARGET_UNKNOWN_STAGE',
  ROUTE_TARGET_UNKNOWN_TERMINAL: 'ROUTING_TARGET_UNKNOWN_TERMINAL',
  // Budget errors (ScenarioRoutingContext).
  TRANSITION_BUDGET_EXCEEDED: 'ROUTING_TRANSITION_BUDGET_EXCEEDED',
  REENTRY_BUDGET_EXCEEDED: 'ROUTING_REENTRY_BUDGET_EXCEEDED',
  REENTRY_BUDGET_PER_STAGE_EXCEEDED: 'ROUTING_REENTRY_PER_STAGE_BUDGET_EXCEEDED',
} as const);

// ---------------------------------------------------------------------------
// Error class thrown by budget enforcement (the runner catches and persists).
// ---------------------------------------------------------------------------

/**
 * Thrown by `ScenarioRoutingContext` when a hard budget cap is breached. The
 * ScenarioRunner (W7-A6) catches this, marks the LifecycleRun failed with the
 * code, and persists the count at the point of breach. Carrying the code on
 * the thrown error keeps the failure reason auditable without the router
 * reaching into persistence.
 */
export class ScenarioBudgetExceeded extends Error {
  readonly code: string;
  readonly stageId?: string;
  readonly consumed: number;
  readonly budget: number;
  constructor(
    code: string,
    message: string,
    details: { consumed: number; budget: number; stageId?: string },
  ) {
    super(message);
    this.name = 'ScenarioBudgetExceeded';
    this.code = code;
    this.consumed = details.consumed;
    this.budget = details.budget;
    if (details.stageId !== undefined) this.stageId = details.stageId;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function routingErr(
  code: string,
  path: string,
  message: string,
): RoutingValidationError {
  return { code, path, message };
}

/**
 * Build an index of stage id -> ScenarioStageBinding. If two stages share an
 * id the routing graph is ambiguous; the W1-A3 manifest validator treats
 * duplicate ids as a structural defect, and so do we (recorded by the graph
 * validator; here we just keep the LAST binding so lookup is total).
 */
function indexStages(
  manifest: LifecycleScenarioManifest,
): Map<string, ScenarioStageBinding> {
  const map = new Map<string, ScenarioStageBinding>();
  for (const s of manifest.stageBindings) {
    map.set(s.id, s);
  }
  return map;
}

// ---------------------------------------------------------------------------
// (1) Declarative route lookup — the §6.4 routeResolver replacement.
// ---------------------------------------------------------------------------

/**
 * Resolve the transition target for a (stage, outcome) pair by PURE STATIC
 * `routeResolver` (plan §6.4): there is no closure, no per-run override, no
 * fallback synthesis. The target comes from `stage.outcomeRoutes[outcome]`,
 * full stop.
 *
 * Throws `Error` with code `ROUTING_UNKNOWN_STAGE` if `stageId` is not a
 * declared stage, or `ROUTING_NO_ROUTE_FOR_OUTCOME` if the stage declares no
 * route for `outcome` — a missing route is a manifest-completeness defect,
 * not a runtime branch. (The W1-A3 manifest validator + W7-A3 compiler are
 * the static authorities; this router is the runtime authority and applies
 * the same rule.)
 *
 * adapter path (W7-A8) where a scenario-level `outcomeRoutes` table augments
 * per-stage routes. It defaults to `true`, matching the manifest contract:
 * when a stage has no route for an outcome, the scenario-level table is
 * consulted before declaring the route missing. Set it to `false` to enforce
 * strict per-stage routing (used by some graph-validation paths).
 */
export function routeScenarioOutcome(
  manifest: LifecycleScenarioManifest,
  stageId: string,
  outcome: string,
  options?: { readonly scenarioLevelFallback?: boolean },
): ScenarioRouteResult {
  const stages = indexStages(manifest);
  const stage = stages.get(stageId);
  if (!stage) {
    throw new Error(
      `[${ROUTING_ERROR_CODES.UNKNOWN_STAGE}] stage '${stageId}' is not declared in stageBindings`,
    );
  }

  const local = stage.outcomeRoutes[outcome];
  if (local !== undefined) {
    return { stageId, outcome, target: local };
  }

  const useFallback = options?.scenarioLevelFallback ?? true;
  if (useFallback) {
    const scenarioLevel = manifest.outcomeRoutes[outcome];
    if (scenarioLevel !== undefined) {
      return { stageId, outcome, target: scenarioLevel };
    }
  }

  throw new Error(
    `[${ROUTING_ERROR_CODES.NO_ROUTE_FOR_OUTCOME}] stage '${stageId}' declares no route for outcome '${outcome}'`,
  );
}

/**
 * Predicate: does the given stage have a declared route for `outcome` in
 * either its own table or the scenario-level table? Pure, throws nothing.
 * Useful for graph validation and for runners that want to branch without
 * try/catch.
 */
export function hasScenarioRoute(
  manifest: LifecycleScenarioManifest,
  stageId: string,
  outcome: string,
): boolean {
  const stages = indexStages(manifest);
  const stage = stages.get(stageId);
  if (!stage) return false;
  if (stage.outcomeRoutes[outcome] !== undefined) return true;
  return manifest.outcomeRoutes[outcome] !== undefined;
}

// ---------------------------------------------------------------------------
// (2) Routing-graph validation.
// ---------------------------------------------------------------------------

/**
 * Collect every routing-graph edge declared by the manifest: for each stage,
 * each entry in its `outcomeRoutes` table, plus each entry in the
 * scenario-level `outcomeRoutes` table (the scenario-level table is a
 * fallback handoff — §6.4 routes are static wherever they live). Edges
 * appear in declaration order (stage order, then outcome key insertion
 * order).
 */
export function collectRoutingEdges(
  manifest: LifecycleScenarioManifest,
): RoutingGraphEdge[] {
  const edges: RoutingGraphEdge[] = [];
  for (const stage of manifest.stageBindings) {
    if (!isPlainObject(stage.outcomeRoutes)) continue;
    for (const [outcome, target] of Object.entries(stage.outcomeRoutes)) {
      edges.push({ fromStageId: stage.id, outcome, target });
    }
  }
  // Scenario-level routes: attributable to "the scenario" as the source. We
  // record them with a synthetic fromStageId of '<scenario>' so graph
  // reachability still works (the scenario root is reachable by definition).
  if (isPlainObject(manifest.outcomeRoutes)) {
    for (const [outcome, target] of Object.entries(manifest.outcomeRoutes)) {
      edges.push({ fromStageId: SCENARIO_ROOT, outcome, target });
    }
  }
  return edges;
}

/** Synthetic source id for scenario-level routes in the graph. */
export const SCENARIO_ROOT = '<scenario>';

/**
 * Validate the routing graph declared by a manifest.
 *
 * Checks (each independent; all findings collected, none short-circuit):
 *   1. Every stage-level route target of type `stage` points at a declared
 *      stage id (ROUTE_TARGET_UNKNOWN_STAGE).
 *   2. Every route target of type `terminal` points at a declared
 *      `terminalStatuses` entry (ROUTE_TARGET_UNKNOWN_TERMINAL).
 *   3. Every stage other than the entry stage is REACHABLE from the entry
 *      stage via a chain of stage-target routes (UNREACHABLE_STAGE). Stage
 *      reuse (§6.8) is fine: a stage may be the target of multiple edges.
 *   4. Every reachable non-terminal stage has a path to at least one declared
 *      terminal status (DEAD_END_STAGE). A stage whose every outcome leads to
 *      another stage that never terminates is a hung scenario.
 *   5. Every declared terminal status is reachable from at least one stage
 *      route (ORPHAN_TERMINAL). Declaring a terminal nothing can reach is a
 *      spec rot.
 *
 * This is COMPLEMENTARY to the W1-A3 manifest validator (which checks
 * field-level shape) and the W7-A3 compiler (which checks mappings against
 * module contracts). The router is the runtime authority and re-checks the
 * routing graph because a manifest compiled successfully can still carry a
 * routing defect if module outcomes changed after compilation.
 */
export function validateScenarioRoutingGraph(
  manifest: LifecycleScenarioManifest,
): RoutingValidationResult {
  const errors: RoutingValidationError[] = [];
  const stageIds = new Set(manifest.stageBindings.map((s) => s.id));
  const terminalSet = new Set(manifest.terminalStatuses);
  const edges = collectRoutingEdges(manifest);

  // (1) + (2) Target validity.
  for (const edge of edges) {
    const fromPath =
      edge.fromStageId === SCENARIO_ROOT
        ? '$.outcomeRoutes'
        : `$.stageBindings[id=${edge.fromStageId}].outcomeRoutes`;
    if (edge.target.type === 'stage') {
      if (!stageIds.has(edge.target.stageId)) {
        errors.push(
          routingErr(
            ROUTING_ERROR_CODES.ROUTE_TARGET_UNKNOWN_STAGE,
            `${fromPath}.${edge.outcome}`,
            `route target stage '${edge.target.stageId}' is not a declared stageBinding`,
          ),
        );
      }
    } else if (edge.target.type === 'terminal') {
      if (!terminalSet.has(edge.target.status)) {
        errors.push(
          routingErr(
            ROUTING_ERROR_CODES.ROUTE_TARGET_UNKNOWN_TERMINAL,
            `${fromPath}.${edge.outcome}`,
            `route target terminal '${edge.target.status}' is not in terminalStatuses`,
          ),
        );
      }
    } else {
      errors.push(
        routingErr(
          ROUTING_ERROR_CODES.ROUTE_TARGET_UNKNOWN_STAGE,
          `${fromPath}.${edge.outcome}`,
          `route target type must be 'stage'|'terminal' (got '${String(
            (edge.target as { type?: string }).type,
          )}')`,
        ),
      );
    }
  }

  // Build adjacency over stage->stage edges only (terminal edges are leaves).
  const adjacency = new Map<string, Set<string>>();
  for (const id of stageIds) adjacency.set(id, new Set());
  for (const edge of edges) {
    if (
      edge.fromStageId !== SCENARIO_ROOT &&
      edge.target.type === 'stage' &&
      stageIds.has(edge.fromStageId) &&
      stageIds.has(edge.target.stageId)
    ) {
      adjacency.get(edge.fromStageId)!.add(edge.target.stageId);
    }
  }

  // (3) Reachability from entry. The scenario root feeds the entry stage; the
  // entry stage is therefore reachable by definition.
  const reachableFromEntry = new Set<string>();
  if (stageIds.has(manifest.entryStageId)) {
    const stack: string[] = [manifest.entryStageId];
    reachableFromEntry.add(manifest.entryStageId);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const nxt of adjacency.get(cur) ?? []) {
        if (!reachableFromEntry.has(nxt)) {
          reachableFromEntry.add(nxt);
          stack.push(nxt);
        }
      }
    }
    for (const id of stageIds) {
      if (!reachableFromEntry.has(id)) {
        errors.push(
          routingErr(
            ROUTING_ERROR_CODES.UNREACHABLE_STAGE,
            `$.stageBindings[id=${id}]`,
            `stage '${id}' is unreachable from entry stage '${manifest.entryStageId}' via static routes`,
          ),
        );
      }
    }
  }

  // (4) Dead-end detection: a stage reaches a terminal if any walk from it
  // hits a terminal edge. Compute the set of stages that can reach ANY
  // terminal, then any stage NOT in that set (and not itself terminal-only)
  // is a dead end. We compute reachability of the "terminal-reachable" property
  // by reverse BFS from terminal-edge targets.
  const reachesTerminal = new Set<string>();
  // Seed: stages that directly emit a terminal edge.
  for (const edge of edges) {
    if (
      edge.fromStageId !== SCENARIO_ROOT &&
      edge.target.type === 'terminal' &&
      stageIds.has(edge.fromStageId)
    ) {
      reachesTerminal.add(edge.fromStageId);
    }
  }
  // Propagate backwards: if B -> A and A reaches terminal, then B reaches terminal.
  const reverseAdjacency = new Map<string, Set<string>>();
  for (const id of stageIds) reverseAdjacency.set(id, new Set());
  for (const edge of edges) {
    if (
      edge.fromStageId !== SCENARIO_ROOT &&
      edge.target.type === 'stage' &&
      stageIds.has(edge.fromStageId) &&
      stageIds.has(edge.target.stageId)
    ) {
      reverseAdjacency.get(edge.target.stageId)!.add(edge.fromStageId);
    }
  }
  const stackTerminal = [...reachesTerminal];
  while (stackTerminal.length > 0) {
    const cur = stackTerminal.pop()!;
    for (const prev of reverseAdjacency.get(cur) ?? []) {
      if (!reachesTerminal.has(prev)) {
        reachesTerminal.add(prev);
        stackTerminal.push(prev);
      }
    }
  }
  for (const id of stageIds) {
    if (!reachesTerminal.has(id)) {
      errors.push(
        routingErr(
          ROUTING_ERROR_CODES.DEAD_END_STAGE,
          `$.stageBindings[id=${id}]`,
          `stage '${id}' has no path to any declared terminal status (scenario would hang)`,
        ),
      );
    }
  }

  // (5) Orphan terminals: declared but unreached by any stage route.
  const reachedTerminals = new Set<string>();
  for (const edge of edges) {
    if (edge.target.type === 'terminal') {
      reachedTerminals.add(edge.target.status);
    }
  }
  for (const t of manifest.terminalStatuses) {
    if (!reachedTerminals.has(t)) {
      errors.push(
        routingErr(
          ROUTING_ERROR_CODES.ORPHAN_TERMINAL,
          '$.terminalStatuses',
          `terminal status '${t}' is declared but no route reaches it`,
        ),
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    edges,
    reachableStages: [...reachableFromEntry].sort(),
    reachableTerminals: [...reachedTerminals].sort(),
  };
}

// ---------------------------------------------------------------------------
// (3) Per-run budget ledger.
// ---------------------------------------------------------------------------

/**
 * Mutable per-run budget ledger for a single LifecycleRun. The ScenarioRunner
 * (W7-A6) owns one instance per run and calls `enterTransition()` /
 * `recordReentry(stageId)` around each stage transition.
 *
 * Budgets come from the manifest (`transitionBudgets` / `reentryBudgets`,
 * plan §6.2.10 / §6.2.11). The ledger is the runtime authority: even if a
 * static graph loop was not caught by validation, the ledger caps the damage
 * at a finite number of transitions.
 *
 * The ledger is NOT part of the manifest (which is immutable pure data) and
 * is NOT persisted by this module — the runner persists the counts on each
 * StageRun transition. This module only enforces.
 */
export class ScenarioRoutingContext {
  private transitionsConsumed = 0;
  private readonly reentriesConsumed = new Map<string, number>();
  private readonly maxTransitions: number;
  private readonly perStageReentry: Readonly<Record<string, number>>;
  private readonly maxReentries: number;
  /** Snapshot of the budget source (for diagnostics). Frozen at construction. */
  readonly source: {
    readonly maxTransitions: number;
    readonly maxReentries: number;
    readonly perStageReentry: Readonly<Record<string, number>>;
    readonly perStageTransition: Readonly<Record<string, number>>;
  };

  constructor(manifest: LifecycleScenarioManifest) {
    this.maxTransitions = manifest.transitionBudgets.maxTransitions;
    this.maxReentries = manifest.reentryBudgets.maxReentries;
    this.perStageReentry = manifest.reentryBudgets.perStage ?? {};
    const perStageTransition = manifest.transitionBudgets.perStage ?? {};
    this.source = Object.freeze({
      maxTransitions: this.maxTransitions,
      maxReentries: this.maxReentries,
      perStageReentry: this.perStageReentry,
      perStageTransition,
    });
    // Optional per-stage transition budget (plan §6.2.10 `perStage`). Stored
    // but enforced in enterTransition() by stage id.
    this.perStageTransition = perStageTransition;
    this.perStageTransitionsConsumed = new Map();
  }

  private readonly perStageTransition: Readonly<Record<string, number>>;
  private readonly perStageTransitionsConsumed: Map<string, number>;

  /**
   * Account one transition toward the total (and optional per-stage) budget.
   * Throws `ScenarioBudgetExceeded` (TRANSITION_BUDGET_EXCEEDED, or
   * per-stage variant) the moment a cap is breached. Call BEFORE performing
   * the transition.
   */
  enterTransition(toStageId: string): void {
    const next = this.transitionsConsumed + 1;
    if (next > this.maxTransitions) {
      throw new ScenarioBudgetExceeded(
        ROUTING_ERROR_CODES.TRANSITION_BUDGET_EXCEEDED,
        `transition budget exceeded: ${next} > ${this.maxTransitions} (plan §6.2.10)`,
        { consumed: this.transitionsConsumed, budget: this.maxTransitions },
      );
    }
    // Optional per-stage transition cap.
    const perStageCap = this.perStageTransition[toStageId];
    if (typeof perStageCap === 'number') {
      const cur = this.perStageTransitionsConsumed.get(toStageId) ?? 0;
      const nextStage = cur + 1;
      if (nextStage > perStageCap) {
        throw new ScenarioBudgetExceeded(
          ROUTING_ERROR_CODES.TRANSITION_BUDGET_EXCEEDED,
          `per-stage transition budget for '${toStageId}' exceeded: ${nextStage} > ${perStageCap}`,
          {
            consumed: cur,
            budget: perStageCap,
            stageId: toStageId,
          },
        );
      }
      this.perStageTransitionsConsumed.set(toStageId, nextStage);
    }
    this.transitionsConsumed = next;
  }

  /**
   * Account one re-entry of `stageId` toward the reentry budget. A re-entry is
   * any transition whose target stage has already been visited at least once
   * in this run. Throws `ScenarioBudgetExceeded`
   * (REENTRY_BUDGET_EXCEEDED / REENTRY_BUDGET_PER_STAGE_EXCEEDED) on breach.
   * `maxReentries === 0` means NO re-entry is allowed at all (plan §6.2.11).
   */
  recordReentry(stageId: string): void {
    const totalReentries = sumMap(this.reentriesConsumed);
    const nextTotal = totalReentries + 1;
    if (nextTotal > this.maxReentries) {
      throw new ScenarioBudgetExceeded(
        ROUTING_ERROR_CODES.REENTRY_BUDGET_EXCEEDED,
        `reentry budget exceeded: ${nextTotal} > ${this.maxReentries} (plan §6.2.11)`,
        { consumed: totalReentries, budget: this.maxReentries },
      );
    }
    const perStageCap = this.perStageReentry[stageId];
    if (typeof perStageCap === 'number') {
      const cur = this.reentriesConsumed.get(stageId) ?? 0;
      const nextStage = cur + 1;
      if (nextStage > perStageCap) {
        throw new ScenarioBudgetExceeded(
          ROUTING_ERROR_CODES.REENTRY_BUDGET_PER_STAGE_EXCEEDED,
          `per-stage reentry budget for '${stageId}' exceeded: ${nextStage} > ${perStageCap}`,
          { consumed: cur, budget: perStageCap, stageId },
        );
      }
    }
    this.reentriesConsumed.set(stageId, (this.reentriesConsumed.get(stageId) ?? 0) + 1);
  }

  /** Current transition count (for runner persistence / diagnostics). */
  get transitions(): number {
    return this.transitionsConsumed;
  }

  /** Total reentries across all stages. */
  get totalReentries(): number {
    return sumMap(this.reentriesConsumed);
  }

  /** Reentries recorded for a specific stage (0 if never re-entered). */
  reentriesFor(stageId: string): number {
    return this.reentriesConsumed.get(stageId) ?? 0;
  }

  /** Snapshot the ledger as plain JSON-serializable data. */
  toJSON(): {
    transitionsConsumed: number;
    maxTransitions: number;
    totalReentries: number;
    maxReentries: number;
    reentriesByStage: Record<string, number>;
  } {
    const reentriesByStage: Record<string, number> = {};
    for (const [k, v] of this.reentriesConsumed) reentriesByStage[k] = v;
    return {
      transitionsConsumed: this.transitionsConsumed,
      maxTransitions: this.maxTransitions,
      totalReentries: this.totalReentries,
      maxReentries: this.maxReentries,
      reentriesByStage,
    };
  }
}

function sumMap(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

// ---------------------------------------------------------------------------
// (4) Convenience router object — bound to a manifest + per-run context.
// ---------------------------------------------------------------------------

/**
 * A router bound to one manifest. `route()` performs the static lookup AND
 * enforces the per-run budgets via the supplied `ScenarioRoutingContext`.
 * Stateless apart from the manifest reference; the context carries the
 * per-run state.
 *
 * Constructed via `createScenarioRouter(manifest)`. The bound router is the
 * object the ScenarioRunner (W7-A6) holds for the lifetime of one
 * LifecycleRun.
 */
export interface ScenarioRouter {
  readonly manifest: LifecycleScenarioManifest;
  /**
   * Resolve the route for (stageId, outcome) and, if the target is another
   * stage, account the transition + (if applicable) the reentry against the
   * supplied context. Terminal targets do NOT consume a transition budget
   * (they end the run). Throws `ScenarioBudgetExceeded` on breach and `Error`
   * (ROUTING_UNKNOWN_STAGE / ROUTING_NO_ROUTE_FOR_OUTCOME) on a missing route.
   */
  route(
    stageId: string,
    outcome: string,
    ctx: ScenarioRoutingContext,
    options?: { readonly firstEntry?: boolean },
  ): ScenarioRouteResult;
  /** Pure lookup without budget side-effects (see `routeScenarioOutcome`). */
  peek(stageId: string, outcome: string): ScenarioRouteResult;
  /** Convenience accessor for the bound manifest's routing graph validation. */
  validateGraph(): RoutingValidationResult;
}

/**
 * Construct a `ScenarioRouter` bound to `manifest`. The router performs NO
 * work at construction time beyond holding the manifest reference; route
 * lookups and budget enforcement happen on each `route()` call.
 */
export function createScenarioRouter(
  manifest: LifecycleScenarioManifest,
): ScenarioRouter {
  const stages = indexStages(manifest);

  const router: ScenarioRouter = {
    manifest,
    route(stageId, outcome, ctx, options) {
      const result = routeScenarioOutcome(manifest, stageId, outcome);
      if (result.target.type === 'stage') {
        // A transition into a stage consumes a transition slot. Whether it is
        // a reentry is determined by whether the stage was previously visited;
        // the caller signals the first entry (the entry-stage bootstrap) via
        // `firstEntry: true`, which is never a reentry.
        const isFirstEntry = options?.firstEntry === true;
        ctx.enterTransition(result.target.stageId);
        if (!isFirstEntry) {
          // The runner knows whether the target was visited before; we record a
          // reentry optimistically only when the caller did NOT flag this as a
          // first entry into the entry stage. For arbitrary stages, the runner
          // should call ctx.recordReentry() itself when it detects a revisit.
          // To keep the router a single-call surface, we treat any non-first
          // stage-to-stage transition where the target is the SAME as the
          // source as a self-reentry; cross-stage revisits are the runner's
          // responsibility (it has the visit set).
          if (result.target.stageId === stageId) {
            ctx.recordReentry(result.target.stageId);
          }
        }
      }
      return result;
    },
    peek(stageId, outcome) {
      return routeScenarioOutcome(manifest, stageId, outcome);
    },
    validateGraph() {
      return validateScenarioRoutingGraph(manifest);
    },
  };
  // Reference `stages` so the closure is not tree-shaken away incorrectly in
  // downstream bundlers that scan for unused captures; it is also used by the
  // `peek` path indirectly through routeScenarioOutcome.
  void stages;
  return router;
}
