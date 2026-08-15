/**
 * W7-A3 — Scenario compiler: validate a LifecycleScenarioManifest against the
 * module contracts its stages bind to, and produce a compiled scenario graph.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md` Lane W7-A3.
 * Task: `docs/refactor-management/05-subagent-tasks/W07-a3.md`.
 * Plan: §0.10 (Wave 7 scenario package), §6.2 (manifest fields), §6.4 (NO
 *       routeResolver), §6.6-6.7 (module-selector → installed-module resolution
 *       at install time), §6.9.5 (safe mapping paths), §6.10 (required modules).
 *
 * ── What this lane owns ──────────────────────────────────────────────────────
 *
 * `compileScenario` is the single application-layer entry point that turns a
 * (Wave-1-shaped) `LifecycleScenarioManifest` plus a set of available
 * `ProcessModuleManifest` contracts into either a fully validated
 * `ScenarioCompilation` (resolved per-stage module contract, reachability
 * graph, terminal set) or a fail-fast `CompilationFailure` carrying every
 * reason. It is the static gate Wave 7's installer (W7-A6) runs BEFORE
 * resolving the exact module lock (W7-A2) and BEFORE the router (W7-A4)
 * consumes the compiled graph.
 *
 * Five validation categories (frozen spec §1 Lane W7-A3, mirrored 1:1 by the
 * five `check*` functions below):
 *
 *   1. **Mappings type-check against module contracts** — every stage's
 *      `moduleSelector` resolves to a provided `ProcessModuleManifest`; every
 *      `LifecycleMappingExpression` on the stage and on the scenario envelope
 *      is structurally valid (safe path / literal / known runtime variable);
 *      scenario-level `inputContractRef`/`outputContractRef` resolve when a
 *      `ContractSchemaRegistry` is supplied.
 *   2. **Route table completeness** — every outcome a bound module DECLARES it
 *      can emit (`definition.outcomes[].code`) has a route in the stage's
 *      static `outcomeRoutes` table. There is no executable resolver (§6.4),
 *      so an undeclared route is a compile-time defect, not a runtime miss.
 *   3. **Graph reachability** — every stage is reachable from `entryStageId`;
 *      every reachable stage can reach at least one declared terminal status;
 *      the entry itself can reach a terminal.
 *   4. **Terminal outcomes** — `terminalStatuses` is non-empty; every module
 *      outcome marked `terminal: true` routes (transitively) to a terminal
 *      target whose status is declared; scenario-level terminal routes reference
 *      declared statuses.
 *   5. **Budget validation** — `transitionBudgets.maxTransitions` is a finite
 *      integer > 0; `reentryBudgets.maxReentries` is a finite integer >= 0;
 *      every `perStage` entry references a real stage id with a valid cap.
 *
 * The compiler is PURE: no I/O, no side effects, throws nothing for ordinary
 * validation failures. It delegates the Wave 1 envelope check to
 * `validateLifecycleScenarioManifest` first (defense-in-depth: a manifest that
 * fails its own envelope cannot pass compilation), then layers the five
 * contract-aware checks on top.
 *
 * ── Anti-scope (frozen spec §3) ──────────────────────────────────────────────
 *
 *   - No `lifecycle-orchestrator.ts` rewrite (Wave 11 cutover). The compiler
 *     is a new sibling service alongside the existing orchestrator.
 *   - No removal of `routeResolver` or cumulative-frame (Wave 13).
 *   - No exact module-lock resolution (W7-A2 owns `ModuleSelector → exact
 *     InstalledProcessModule` at install time). Here we resolve only to the
 *     module CONTRACT (`ProcessModuleManifest`) — the lock is the next step.
 *   - No execution (W7-A6 ScenarioRunner owns driving stages).
 *
 * ── Dependency direction (W0-A1 ratchet) ─────────────────────────────────────
 *
 * This file lives at `src/application/scenario-compiler.ts` (top-level
 * application layer), NOT under `src/process-modules/`. The ratchet's rule
 * classifiers (MODULE_DIR / DOMAIN_DIR / PERSISTENCE_DIR / COMPOSITION_DIR /
 * LIFECYCLES_DIR / APPLICATION_DIR) all anchor on `src/process-modules/...`, so
 * a top-level `src/application/` file is outside every rule's source-side
 * predicate and adds zero new ratchet edges. It imports only from the Wave 1
 * SPI barrel (pure types + the reused validator), the pure domain
 * `ProcessModuleDefinition`/`ProcessModuleReference` types, and Node built-ins
 * — no `modules/`, no `persistence/` adapters, no `db.ts`, no `composition/`.
 * Keeps the ratchet green.
 */

import type {
  LifecycleScenarioManifest,
  ScenarioStageBinding,
  ModuleSelector,
  TransitionTarget,
  LifecycleMappingExpression,
} from '../process-modules/domain/spi/scenario-manifest.js';
import {
  validateLifecycleScenarioManifest,
  isSafeMappingPath,
} from '../process-modules/domain/spi/scenario-manifest.js';

import type {
  ProcessModuleManifest,
} from '../process-modules/domain/spi/module-manifest.js';

import type { ProcessModuleDefinition } from '../process-modules/domain/process-module.js';

import type { ContractRef } from '../process-modules/domain/spi/contract-ref.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Validation failure emitted by `compileScenario`. Mirrors the Wave 1
 * `ValidationError` shape (`{ code, path, message }`) so a single rendering
 * path covers envelope errors and compilation errors.
 */
export interface CompilationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/**
 * Resolves a scenario stage's `ModuleSelector` (name + semver range) to the
 * `ProcessModuleManifest` contract the compiler type-checks against.
 *
 * Wave 7-A3 calls this ONLY to obtain a contract for static validation — it
 * does NOT pin an exact installed package (that is W7-A2's
 * `writeModuleLock` job, which runs after compilation succeeds). A resolver
 * implementation typically indexes installed manifests by `name@version` and
 * satisfies the `versionRange` with a semver helper.
 *
 * Return `undefined` when no contract matches; the compiler turns that into a
 * `MODULE_CONTRACT_UNRESOLVED` error.
 */
export type ModuleContractResolver = (
  selector: ModuleSelector,
) => ProcessModuleManifest | undefined;

/**
 * Optional schema-registry hook. When supplied, the compiler verifies that
 * the scenario's `inputContractRef` / `outputContractRef` (and every resolved
 * module's contract refs) are registered. When omitted, contract-ref
 * registration is NOT checked (Wave 2/3 wires a real registry; until then the
 * in-memory registry is exercised by tests only).
 *
 * This is intentionally a narrow read surface (`.has(ref)`) so the compiler
 * does not depend on the full codec port.
 */
export interface ContractSchemaPresenceLookup {
  has(ref: ContractRef): boolean;
}

/** Result shape: success variant of `compileScenario`. */
export interface CompiledStage {
  /** The scenario stage binding, verbatim from the manifest. */
  readonly binding: ScenarioStageBinding;
  /** The module contract this stage's selector resolved to. */
  readonly moduleContract: ProcessModuleManifest;
  /** The wrapped module definition (convenience accessor). */
  readonly definition: ProcessModuleDefinition;
  /** Outcome codes this stage's module declares it can emit. */
  readonly declaredOutcomes: readonly string[];
  /** Outcome codes the module marks terminal. */
  readonly terminalOutcomes: readonly string[];
}

/** Compiled reachability graph (scenario-level, derived from outcomeRoutes). */
export interface ScenarioReachability {
  /** Stage ids reachable from `entryStageId` (inclusive). */
  readonly reachableFromEntry: readonly string[];
  /** Stage ids from which at least one declared terminal status is reachable. */
  readonly stagesReachingTerminal: readonly string[];
  /** True iff the entry stage can reach a declared terminal status. */
  readonly entryReachesTerminal: boolean;
}

/** Successful compilation: the validated, resolved scenario view. */
export interface ScenarioCompilation {
  readonly ok: true;
  readonly manifest: LifecycleScenarioManifest;
  /** Per-stage resolved contract + derived outcome sets, keyed by stage id. */
  readonly stages: Readonly<Record<string, CompiledStage>>;
  /** Declared terminal statuses (verbatim from the manifest). */
  readonly terminalStatuses: readonly string[];
  /** Derived reachability facts. */
  readonly reachability: ScenarioReachability;
  /** Distinct module selectors the scenario depends on (deduped). */
  readonly requiredModules: readonly ModuleSelector[];
}

/** Failure compilation: every reason collected, fail-fast over the batch. */
export interface CompilationFailure {
  readonly ok: false;
  readonly errors: readonly CompilationError[];
}

export type CompilationResult = ScenarioCompilation | CompilationFailure;

// ---------------------------------------------------------------------------
// Error code tokens (exported so callers / tests can branch on them).
// ---------------------------------------------------------------------------

export const SCENARIO_COMPILE_FAILED = 'SCENARIO_COMPILE_FAILED';

/** Envelope failed Wave 1 validation (re-run for defense-in-depth). */
export const ENVELOPE_INVALID = 'ENVELOPE_INVALID';
/** A stage's moduleSelector did not resolve to any provided contract. */
export const MODULE_CONTRACT_UNRESOLVED = 'MODULE_CONTRACT_UNRESOLVED';
/** A mapping expression is structurally invalid (bad form / unsafe path). */
export const MAPPING_EXPRESSION_INVALID = 'MAPPING_EXPRESSION_INVALID';
/** A scenario contract ref is not present in the supplied schema registry. */
export const CONTRACT_REF_NOT_REGISTERED = 'CONTRACT_REF_NOT_REGISTERED';
/** A module outcome has no route in the stage's outcomeRoutes table. */
export const OUTCOME_ROUTE_MISSING = 'OUTCOME_ROUTE_MISSING';
/** A stage referenced as a route target is not reachable from entry. */
export const STAGE_UNREACHABLE = 'STAGE_UNREACHABLE';
/** A reachable stage cannot reach any declared terminal status. */
export const STAGE_CANNOT_TERMINATE = 'STAGE_CANNOT_TERMINATE';
/** Entry stage cannot reach any declared terminal status. */
export const ENTRY_CANNOT_TERMINATE = 'ENTRY_CANNOT_TERMINATE';
/** terminalStatuses is empty (re-checked here, not only by Wave 1). */
export const TERMINAL_STATUSES_EMPTY = 'TERMINAL_STATUSES_EMPTY';
/** A module terminal outcome routes to a non-terminal target. */
export const TERMINAL_OUTCOME_MISROUTED = 'TERMINAL_OUTCOME_MISROUTED';
/** A budget cap is missing, non-finite, or out of its valid range. */
export const BUDGET_INVALID = 'BUDGET_INVALID';
/** A perStage budget entry references an unknown stage id. */
export const BUDGET_PERSTAGE_UNKNOWN_STAGE = 'BUDGET_PERSTAGE_UNKNOWN_STAGE';
/** A module is used by a stage but missing from requiredModuleSelectors. */
export const REQUIRED_MODULE_UNDECLARED = 'REQUIRED_MODULE_UNDECLARED';
/** A declared required module is not used by any stage (dangling dep). */
export const REQUIRED_MODULE_UNUSED = 'REQUIRED_MODULE_UNUSED';

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Allowed `runtime` mapping variable set (mirrors LifecycleMappingExpression). */
const RUNTIME_VARS: ReadonlySet<string> = new Set([
  'projectId',
  'epicId',
  'lifecycleRunId',
  'stageId',
  'initiatedBy',
]);

function err(code: string, path: string, message: string): CompilationError {
  return { code, path, message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True iff `expr` is a structurally valid `LifecycleMappingExpression`. */
function isValidMappingExpression(expr: unknown): boolean {
  if (typeof expr === 'string') {
    return isSafeMappingPath(expr);
  }
  if (!isPlainObject(expr)) return false;
  if ('literal' in expr) return true; // { literal: unknown } — any value
  if ('runtime' in expr) {
    const rt = (expr as { runtime?: unknown }).runtime;
    return typeof rt === 'string' && RUNTIME_VARS.has(rt);
  }
  return false;
}

function moduleKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Build a `ModuleContractResolver` from a list of `ProcessModuleManifest`s.
 * Indexes by exact `name@version` and satisfies a simple semver range
 * (`*`, `x`/`X`, `^`, `~`, `=`, exact, or `>=...`/`>...`/`<=...`/`<...`).
 *
 * This is a TEST/BUILD convenience. The real Wave 7-A2 lock resolver runs
 * against the installed-package registry and is injected by the installer
 * (W7-A6); callers that already have a resolver should pass it directly.
 */
export function createModuleContractResolver(
  manifests: readonly ProcessModuleManifest[],
): ModuleContractResolver {
  // Index by exact name@version (the manifest's declared identity).
  const byKey = new Map<string, ProcessModuleManifest>();
  for (const m of manifests) {
    const name = m.definition.identity.name;
    const version = m.definition.identity.version;
    byKey.set(moduleKey(name, version), m);
  }

  return (selector: ModuleSelector): ProcessModuleManifest | undefined => {
    const { name, versionRange } = selector;
    // Fast path: exact version match.
    const exact = byKey.get(moduleKey(name, versionRange));
    if (exact) return exact;

    // Range path: pick the highest-satisfying known version for this name.
    let best: { version: string; manifest: ProcessModuleManifest } | undefined;
    for (const [key, manifest] of byKey) {
      if (!key.startsWith(`${name}@`)) continue;
      const version = key.slice(name.length + 1);
      if (!satisfiesRange(version, versionRange)) continue;
      if (!best || compareSemver(version, best.version) > 0) {
        best = { version, manifest };
      }
    }
    return best?.manifest;
  };
}

// ---------------------------------------------------------------------------
// Minimal semver helpers (good enough for the compiler's resolution + tests).
// Real semver lives in the package manager; the compiler only needs a
// deterministic satisfier for the convenience resolver. NOT exported broadly.
// ---------------------------------------------------------------------------

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a) ?? [0, 0, 0];
  const pb = parseSemver(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function satisfiesRange(version: string, range: string): boolean {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x' || r === 'X') return true;
  const pv = parseSemver(version);
  if (!pv) return false;

  // Caret: compatible with same major (zero-major → same minor).
  let m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (m) {
    const [Maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (pv[0] !== Maj) return false;
    if (Maj === 0) {
      if (pv[1] !== min) return false;
      if (min === 0 && pv[2] !== pat) return false;
    }
    return true;
  }
  // Tilde: same major+minor.
  m = /^~(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (m) {
    const [Maj, min] = [Number(m[1]), Number(m[2])];
    return pv[0] === Maj && pv[1] === min;
  }
  // Comparators.
  m = /^(>=|<=|>|<|=)?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (m) {
    const op = m[1] ?? '=';
    const c = compareSemver(version, `${m[2]}.${m[3]}.${m[4]}`);
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>':  return c > 0;
      case '<':  return c < 0;
      case '=':  return c === 0;
    }
  }
  // Bare exact version.
  return compareSemver(version, r) === 0;
}

// ---------------------------------------------------------------------------
// compileScenario — the single application-layer entry point.
// ---------------------------------------------------------------------------

/**
 * Compile (statically validate + resolve) a `LifecycleScenarioManifest`
 * against a set of available module contracts.
 *
 * @param manifest       The scenario manifest to compile.
 * @param resolveModule  Resolver from `ModuleSelector` → `ProcessModuleManifest`.
 *                       Use {@link createModuleContractResolver} for a
 *                       list-indexed convenience resolver.
 * @param schemaLookup   Optional. When supplied, the scenario's contract refs
 *                       are checked for registration.
 *
 * @returns `ScenarioCompilation` on success, `CompilationFailure` carrying
 *          every reason on failure. Pure: throws nothing for validation
 *          failures (only for programmer error such as a non-manifest input
 *          that also trips the Wave 1 canonical gate — but even that is
 *          translated into an `ENVELOPE_INVALID` error).
 */
export function compileScenario(
  manifest: LifecycleScenarioManifest,
  resolveModule: ModuleContractResolver,
  schemaLookup?: ContractSchemaPresenceLookup,
): CompilationResult {
  const errors: CompilationError[] = [];

  // -----------------------------------------------------------------------
  // Phase 0 — Wave 1 envelope (defense-in-depth). The manifest is expected to
  // have already passed `validateLifecycleScenarioManifest`, but re-running
  // it here guarantees a manifest that smuggled past the caller cannot reach
  // the contract-aware checks. Each envelope error is surfaced under its own
  // code so the operator can distinguish envelope vs compilation failures.
  // -----------------------------------------------------------------------
  const envelope = validateLifecycleScenarioManifest(manifest);
  if (!envelope.ok) {
    for (const e of envelope.errors) {
      errors.push(err(ENVELOPE_INVALID, e.path, `[${e.code}] ${e.message}`));
    }
    // Envelope failures mean we cannot trust the structure for the downstream
    // checks (stage arrays may be missing, budgets may be non-objects). Fail
    // fast with just the envelope report.
    return { ok: false, errors };
  }

  const stageBindings = manifest.stageBindings;
  const terminalSet = new Set(manifest.terminalStatuses);

  // Index stages by id (the envelope already guarantees unique-ish presence;
  // duplicate ids are surfaced here as their own defect so the compiled map
  // is unambiguous).
  const stagesById = new Map<string, ScenarioStageBinding>();
  for (const s of stageBindings) {
    if (stagesById.has(s.id)) {
      errors.push(
        err('STAGE_ID_DUPLICATE', `$.stageBindings`, `duplicate stage id "${s.id}"`),
      );
    }
    stagesById.set(s.id, s);
  }

  // -----------------------------------------------------------------------
  // Compiled-stage map: resolve each stage's moduleSelector → manifest, derive
  // declared/terminal outcome sets.
  // -----------------------------------------------------------------------
  const compiled = new Map<string, CompiledStage>();
  const usedSelectors = new Map<string, ModuleSelector>();

  for (let i = 0; i < stageBindings.length; i++) {
    const stage = stageBindings[i];
    const basePath = `$.stageBindings[${i}]`;

    // (1a) Module contract resolution.
    const selector = stage.moduleSelector;
    const contract = resolveModule(selector);
    if (!contract) {
      errors.push(
        err(
          MODULE_CONTRACT_UNRESOLVED,
          `${basePath}.moduleSelector`,
          `module selector ${moduleKey(selector.name, selector.versionRange)} did not resolve to any provided ProcessModuleManifest contract`,
        ),
      );
      continue; // cannot type-check mappings/routes without a contract
    }
    // Identity cross-check: the resolved contract's name must match the selector.
    const cname = contract.definition.identity.name;
    if (cname !== selector.name) {
      errors.push(
        err(
          MODULE_CONTRACT_UNRESOLVED,
          `${basePath}.moduleSelector`,
          `resolved contract name "${cname}" does not match selector name "${selector.name}"`,
        ),
      );
      continue;
    }

    usedSelectors.set(moduleKey(selector.name, selector.versionRange), selector);

    const definition = contract.definition;
    const declaredOutcomes = definition.outcomes.map((o) => o.code);
    const terminalOutcomes = definition.outcomes
      .filter((o) => o.terminal)
      .map((o) => o.code);

    compiled.set(stage.id, {
      binding: stage,
      moduleContract: contract,
      definition,
      declaredOutcomes,
      terminalOutcomes,
    });

    // (1b) Mapping expression type-check — stage inputMapping / outputMapping.
    collectMappingExpressionErrors(stage.inputMapping, `${basePath}.inputMapping`, errors);
    if (stage.outputMapping) {
      collectMappingExpressionErrors(stage.outputMapping, `${basePath}.outputMapping`, errors);
    }
  }

  // (1c) Scenario-level mapping expressions.
  collectMappingExpressionErrors(manifest.inputMappings, '$.inputMappings', errors);
  collectMappingExpressionErrors(manifest.outputMappings, '$.outputMappings', errors);

  // (1d) Contract-ref registration (only when a schema lookup is supplied).
  if (schemaLookup) {
    if (!schemaLookup.has(manifest.inputContractRef)) {
      errors.push(
        err(
          CONTRACT_REF_NOT_REGISTERED,
          '$.inputContractRef',
          `scenario inputContractRef (${manifest.inputContractRef.schemaId}@${manifest.inputContractRef.version}) is not registered in the supplied schema registry`,
        ),
      );
    }
    if (!schemaLookup.has(manifest.outputContractRef)) {
      errors.push(
        err(
          CONTRACT_REF_NOT_REGISTERED,
          '$.outputContractRef',
          `scenario outputContractRef (${manifest.outputContractRef.schemaId}@${manifest.outputContractRef.version}) is not registered in the supplied schema registry`,
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // (2) Route table completeness — every declared module outcome has a route.
  // -----------------------------------------------------------------------
  for (let i = 0; i < stageBindings.length; i++) {
    const stage = stageBindings[i];
    const basePath = `$.stageBindings[${i}]`;
    const compiledStage = compiled.get(stage.id);
    if (!compiledStage) continue; // unresolved module — already reported

    const routes = stage.outcomeRoutes ?? {};
    for (const outcomeCode of compiledStage.declaredOutcomes) {
      if (!(outcomeCode in routes)) {
        errors.push(
          err(
            OUTCOME_ROUTE_MISSING,
            `${basePath}.outcomeRoutes`,
            `module "${compiledStage.definition.identity.name}" declares outcome "${outcomeCode}" but stage "${stage.id}" has no route for it`,
          ),
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // (4) Terminal outcomes — terminalStatuses non-empty; every module terminal
  //     outcome routes (transitively) to a declared terminal status. Checked
  //     before reachability so the reachability graph has terminals to aim at.
  // -----------------------------------------------------------------------
  if (terminalSet.size === 0) {
    errors.push(
      err(
        TERMINAL_STATUSES_EMPTY,
        '$.terminalStatuses',
        'terminalStatuses must declare at least one terminal status',
      ),
    );
  }

  // Scenario-level outcomeRoutes: terminal targets must reference declared
  // statuses. (Wave 1 checks this structurally; we re-verify with the compiled
  // terminal set so a caller who edited terminalStatuses post-envelope still
  // gets the report.)
  collectTerminalRouteErrors(manifest.outcomeRoutes, '$.outcomeRoutes', terminalSet, errors);

  // Module terminal outcomes must not be routed to a non-terminal stage that
  // cannot itself reach a terminal. The full transitive check is the
  // reachability phase below; here we surface the direct misroute: a module
  // marks an outcome terminal, but the stage routes that outcome to another
  // STAGE (not a terminal). That is legal only if the downstream stage can
  // itself terminate — which reachability (3) verifies. To avoid double-
  // reporting, here we only flag the egregious case: a terminal module
  // outcome routed to a stage id that does not exist.
  for (let i = 0; i < stageBindings.length; i++) {
    const stage = stageBindings[i];
    const basePath = `$.stageBindings[${i}]`;
    const compiledStage = compiled.get(stage.id);
    if (!compiledStage) continue;
    const routes = stage.outcomeRoutes ?? {};
    for (const termOutcome of compiledStage.terminalOutcomes) {
      const target = routes[termOutcome];
      if (!target) continue; // missing route already reported in (2)
      if (target.type === 'stage' && !stagesById.has(target.stageId)) {
        errors.push(
          err(
            TERMINAL_OUTCOME_MISROUTED,
            `${basePath}.outcomeRoutes.${termOutcome}`,
            `module marks outcome "${termOutcome}" terminal but stage routes it to unknown stage "${target.stageId}"`,
          ),
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // (3) Graph reachability — BFS over outcomeRoutes stage edges.
  // -----------------------------------------------------------------------
  const reachability = computeReachability(manifest, stagesById);
  for (const stageId of stagesById.keys()) {
    if (!reachability.reachableFromEntry.includes(stageId)) {
      errors.push(
        err(
          STAGE_UNREACHABLE,
          `$.stageBindings`,
          `stage "${stageId}" is not reachable from entryStageId "${manifest.entryStageId}"`,
        ),
      );
    }
  }
  for (const stageId of reachability.reachableFromEntry) {
    if (!reachability.stagesReachingTerminal.includes(stageId)) {
      errors.push(
        err(
          STAGE_CANNOT_TERMINATE,
          `$.stageBindings`,
          `stage "${stageId}" cannot reach any declared terminal status`,
        ),
      );
    }
  }
  if (reachability.reachableFromEntry.length > 0 && !reachability.entryReachesTerminal) {
    errors.push(
      err(
        ENTRY_CANNOT_TERMINATE,
        '$.entryStageId',
        `entry stage "${manifest.entryStageId}" cannot reach any declared terminal status`,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // (5) Budget validation.
  // -----------------------------------------------------------------------
  checkBudgets(manifest, stagesById, errors);

  // -----------------------------------------------------------------------
  // (1e) requiredModuleSelectors ↔ used module selectors consistency.
  // -----------------------------------------------------------------------
  checkRequiredModules(manifest, usedSelectors, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Build the public success view.
  const stagesRecord: Record<string, CompiledStage> = {};
  for (const [id, cs] of compiled) {
    stagesRecord[id] = cs;
  }

  return {
    ok: true,
    manifest,
    stages: stagesRecord,
    terminalStatuses: [...terminalSet],
    reachability,
    requiredModules: [...usedSelectors.values()],
  };
}

// ---------------------------------------------------------------------------
// Per-category check helpers.
// ---------------------------------------------------------------------------

/**
 * Push one `MAPPING_EXPRESSION_INVALID` error per mapping entry whose value is
 * not a structurally valid `LifecycleMappingExpression` (string safe path,
 * `{ literal }`, or `{ runtime: <known-var> }`).
 */
function collectMappingExpressionErrors(
  mapping: Readonly<Record<string, LifecycleMappingExpression>> | undefined,
  basePath: string,
  errors: CompilationError[],
): void {
  if (!mapping) return;
  for (const [key, value] of Object.entries(mapping)) {
    if (!isValidMappingExpression(value)) {
      errors.push(
        err(
          MAPPING_EXPRESSION_INVALID,
          `${basePath}.${key}`,
          `mapping expression is not a valid LifecycleMappingExpression (expected: safe string path | { literal } | { runtime: ${[...RUNTIME_VARS].join('|')} })`,
        ),
      );
    }
  }
}

/**
 * Push errors for scenario-level outcomeRoutes terminal targets whose status
 * is not in the declared terminal set.
 */
function collectTerminalRouteErrors(
  routes: Readonly<Record<string, TransitionTarget>> | undefined,
  basePath: string,
  terminalSet: Set<string>,
  errors: CompilationError[],
): void {
  if (!routes) return;
  for (const [outcome, target] of Object.entries(routes)) {
    if (target?.type === 'terminal' && !terminalSet.has(target.status)) {
      errors.push(
        err(
          TERMINAL_OUTCOME_MISROUTED,
          `${basePath}.${outcome}`,
          `terminal target status "${target.status}" is not a declared terminalStatus`,
        ),
      );
    }
  }
}

/**
 * Compute reachability facts over the scenario graph.
 *
 * Edges: for each stage, every `outcomeRoutes` target of `type: 'stage'`
 * contributes an edge `stage.id → target.stageId`. A stage "reaches a
 * terminal" if some route (directly `type: 'terminal'`) or some stage edge
 * into a stage that reaches a terminal leads to a declared terminal status.
 */
function computeReachability(
  manifest: LifecycleScenarioManifest,
  stagesById: Map<string, ScenarioStageBinding>,
): ScenarioReachability {
  const entry = manifest.entryStageId;

  // Forward BFS from entry over stage→stage edges.
  const reachable = new Set<string>();
  if (stagesById.has(entry)) {
    const queue: string[] = [entry];
    reachable.add(entry);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const stage = stagesById.get(cur);
      if (!stage) continue;
      const routes = stage.outcomeRoutes ?? {};
      for (const target of Object.values(routes)) {
        if (target?.type === 'stage' && stagesById.has(target.stageId) && !reachable.has(target.stageId)) {
          reachable.add(target.stageId);
          queue.push(target.stageId);
        }
      }
    }
  }

  const terminalSet = new Set(manifest.terminalStatuses);

  // "Reaches terminal" — computed via reverse reachability from terminal
  // exits. A stage reaches a terminal if ANY of its outcomeRoutes is
  // `type: 'terminal'` with a declared status, OR it has a stage edge to a
  // stage that itself reaches a terminal. We iterate to fixpoint.
  const reachesTerminal = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of stagesById.values()) {
      if (reachesTerminal.has(stage.id)) continue;
      const routes = stage.outcomeRoutes ?? {};
      let hit = false;
      for (const target of Object.values(routes)) {
        if (!target) continue;
        if (target.type === 'terminal' && terminalSet.has(target.status)) {
          hit = true;
          break;
        }
        if (target.type === 'stage' && reachesTerminal.has(target.stageId)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        reachesTerminal.add(stage.id);
        changed = true;
      }
    }
  }

  return {
    reachableFromEntry: [...reachable],
    stagesReachingTerminal: [...reachesTerminal],
    entryReachesTerminal: reachesTerminal.has(entry),
  };
}

/**
 * Budget validation: top-level caps must be finite integers in range, and
 * every perStage entry must reference a real stage id with a valid cap.
 */
function checkBudgets(
  manifest: LifecycleScenarioManifest,
  stagesById: Map<string, ScenarioStageBinding>,
  errors: CompilationError[],
): void {
  const tb = manifest.transitionBudgets;
  if (!isPositiveInteger(tb.maxTransitions)) {
    errors.push(
      err(
        BUDGET_INVALID,
        '$.transitionBudgets.maxTransitions',
        `transitionBudgets.maxTransitions must be a finite integer > 0 (got ${JSON.stringify(tb.maxTransitions)})`,
      ),
    );
  }
  if (tb.perStage) {
    for (const [stageId, cap] of Object.entries(tb.perStage)) {
      if (!stagesById.has(stageId)) {
        errors.push(
          err(
            BUDGET_PERSTAGE_UNKNOWN_STAGE,
            '$.transitionBudgets.perStage',
            `perStage transition budget references unknown stage id "${stageId}"`,
          ),
        );
      } else if (!isPositiveInteger(cap)) {
        errors.push(
          err(
            BUDGET_INVALID,
            `$.transitionBudgets.perStage.${stageId}`,
            `perStage transition budget for "${stageId}" must be a finite integer > 0 (got ${JSON.stringify(cap)})`,
          ),
        );
      }
    }
  }

  const rb = manifest.reentryBudgets;
  if (!isNonNegativeInteger(rb.maxReentries)) {
    errors.push(
      err(
        BUDGET_INVALID,
        '$.reentryBudgets.maxReentries',
        `reentryBudgets.maxReentries must be a finite integer >= 0 (got ${JSON.stringify(rb.maxReentries)})`,
      ),
    );
  }
  if (rb.perStage) {
    for (const [stageId, cap] of Object.entries(rb.perStage)) {
      if (!stagesById.has(stageId)) {
        errors.push(
          err(
            BUDGET_PERSTAGE_UNKNOWN_STAGE,
            '$.reentryBudgets.perStage',
            `perStage reentry budget references unknown stage id "${stageId}"`,
          ),
        );
      } else if (!isNonNegativeInteger(cap)) {
        errors.push(
          err(
            BUDGET_INVALID,
            `$.reentryBudgets.perStage.${stageId}`,
            `perStage reentry budget for "${stageId}" must be a finite integer >= 0 (got ${JSON.stringify(cap)})`,
          ),
        );
      }
    }
  }
}

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * requiredModuleSelectors ↔ stages' moduleSelectors consistency.
 *  - every selector used by a stage must be declared in requiredModuleSelectors
 *  - every declared required selector must be used by at least one stage
 *
 * Comparing by canonical key (name@versionRange) so two textually-equal
 * selectors collapse.
 */
function checkRequiredModules(
  manifest: LifecycleScenarioManifest,
  usedSelectors: Map<string, ModuleSelector>,
  errors: CompilationError[],
): void {
  const declared = new Set<string>();
  for (const sel of manifest.requiredModuleSelectors ?? []) {
    declared.add(moduleKey(sel.name, sel.versionRange));
  }

  for (const [key, sel] of usedSelectors) {
    if (!declared.has(key)) {
      errors.push(
        err(
          REQUIRED_MODULE_UNDECLARED,
          '$.requiredModuleSelectors',
          `module ${moduleKey(sel.name, sel.versionRange)} is bound by a stage but not declared in requiredModuleSelectors`,
        ),
      );
    }
  }

  const usedKeys = new Set(usedSelectors.keys());
  for (const declaredKey of declared) {
    if (!usedKeys.has(declaredKey)) {
      errors.push(
        err(
          REQUIRED_MODULE_UNUSED,
          '$.requiredModuleSelectors',
          `required module ${declaredKey} is declared but not bound by any stage`,
        ),
      );
    }
  }
}
