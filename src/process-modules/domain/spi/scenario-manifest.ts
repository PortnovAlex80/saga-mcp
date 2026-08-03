/**
 * LifecycleScenarioManifest — the one genuinely new domain aggregate of its
 * lane.
 *
 * This file owns the LifecycleScenarioManifest aggregate plus its validator.
 * It deliberately REUSES the existing pure lifecycle types via import — it
 * does NOT redefine `LifecycleIdentity`, `StageBinding`, `TransitionTarget`,
 * or `LifecycleMappingExpression` (those live in `domain/lifecycle.ts` and are
 * shared with the legacy LifecycleDefinition surface). The genuinely new
 * contribution is the *scenario envelope*: a frozen, route-resolver-free,
 * budgeted, terminal-aware manifest that the scenario runtime consumes.
 *
 * Purity contract:
 *   - Every field is plain JSON-serializable data.
 *   - NO function fields (in particular, NO `routeResolver` — see the
 *     `ROUTE_RESOLVER_FORBIDDEN` validation rule).
 *   - `validateLifecycleScenarioManifest` calls `assertCanonicalSerializable`
 *     first, so a manifest carrying a Map/Set/Symbol/function/undefined-in-array
 *     /class-instance/non-finite-number is rejected before any structural rule.
 *
 * Sibling dependencies (declared in sibling lanes):
 *   - `./canonical-serialization.js` — `assertCanonicalSerializable`.
 *   - `./contract-ref.js`            — `ContractRef`.
 *   - `./tool-contribution.js`       — `CapabilityRequirement`.
 *
 * See `docs/architecture/WAVE-LOG.md` (Wave 1) for the parallel-lane context.
 */

import type { LifecycleIdentity } from '../lifecycle.js';
import type { LifecycleMappingExpression } from '../lifecycle.js';
import type { StageBinding } from '../lifecycle.js';
import type { TransitionTarget } from '../lifecycle.js';
import type { ContractRef } from './contract-ref.js';
import type { CapabilityRequirement } from './tool-contribution.js';
import { assertCanonicalSerializable } from './canonical-serialization.js';

// ---------------------------------------------------------------------------
// Re-exports — so consumers of the scenario manifest can import every reused
// pure type from one place without each lane having to know they live in
// `domain/lifecycle.ts`. The new types below compose these.
// ---------------------------------------------------------------------------

export type {
  LifecycleIdentity,
  StageBinding,
  TransitionTarget,
  LifecycleMappingExpression,
} from '../lifecycle.js';

// ---------------------------------------------------------------------------
// ModuleSelector.
//
// A scenario stage binds to a MODULE CONTRACT by name + semver range, NOT to a
// concrete installed package. The exact installed identity is resolved at
// install time against the package registry. This keeps the manifest stable
// across patch upgrades and is what lets a single scenario reuse the same
// module package in two stages with different mappings.
// ---------------------------------------------------------------------------

/**
 * Reference to a module contract by name + semver range. Resolved to an exact
 * installed package identity at install time. Pure string pair — no behavior.
 */
export interface ModuleSelector {
  /** Module name (matches `ProcessModuleReference.name`). */
  readonly name: string;
  /** Semver range string (e.g. `^1.0.0`, `~2.3.0`, `*`). Resolved at install time. */
  readonly versionRange: string;
}

// ---------------------------------------------------------------------------
// ScenarioStageBinding.
//
// Extends `StageBinding` (the existing domain type) with a `moduleSelector`.
// We EXTEND rather than compose so existing `StageBinding` consumers are not
// broken and the contract-by-name is structural on the base type. The added
// field carries the semver RANGE; `moduleRef` on the base still carries the
// concrete version the scenario author validated against (kept for
// traceability and so a fixture that only populates `moduleRef` maps cleanly).
// ---------------------------------------------------------------------------

/**
 * A `StageBinding` enriched with the module CONTRACT selector (name + range)
 * the scenario pins this stage to. Inherits every `StageBinding` field
 * verbatim (id, displayName, moduleRef, inputMapping, outputMapping,
 * outcomeRoutes, entryConditions, exitConditions).
 */
export interface ScenarioStageBinding extends StageBinding {
  /** Contract selector this stage resolves against at install time. */
  readonly moduleSelector: ModuleSelector;
}

// ---------------------------------------------------------------------------
// Policies.
//
// The manifest declares the field SHAPES only; the runtime implements the
// behaviors. Each policy is a tagged union stub `{ kind; params? }` so the
// manifest can name a strategy without binding to an executor. `kind` is a
// free-form string for now (registered strategy names arrive with the runtime
// binding); `params` is an opaque readonly record of plain-serializable
// values.
// ---------------------------------------------------------------------------

/**
 * Tagged policy stub. The manifest carries the declaration; the runtime binds
 * `kind` to a registered strategy and interprets `params`. Pure data.
 */
export interface ScenarioPolicyDeclaration {
  readonly kind: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Bundle of scenario-level policy declarations. Each field is optional in
 * spirit but the bundle itself is required so the manifest names every slot
 * (a missing slot means "default", represented explicitly as `undefined`).
 */
export interface ScenarioPolicies {
  readonly retry?: ScenarioPolicyDeclaration;
  readonly pause?: ScenarioPolicyDeclaration;
  readonly cancellation?: ScenarioPolicyDeclaration;
  readonly escalation?: ScenarioPolicyDeclaration;
}

// ---------------------------------------------------------------------------
// Budgets.
// ---------------------------------------------------------------------------

/**
 * Hard cap on total stage transitions for a single scenario run. Guards
 * against routing loops where a buggy module outcome table would otherwise
 * ping-pong between stages forever. `maxTransitions` MUST be > 0.
 */
export interface TransitionBudgets {
  readonly maxTransitions: number;
  readonly perStage?: Readonly<Record<string, number>>;
}

/**
 * Hard cap on how many times a single stage may be re-entered within one run
 * (distinct from total transitions). `maxReentries` MUST be >= 0 (0 = no
 * re-entry allowed at all).
 */
export interface ReentryBudgets {
  readonly maxReentries: number;
  readonly perStage?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// LifecycleScenarioManifest — the aggregate.
//
// Read-only by construction. Every field is plain serializable data. The type
// is intentionally written as a flat interface (not a class instance) so it
// survives canonical JSON round-trip byte-identically.
// ---------------------------------------------------------------------------

/**
 * The one genuinely new domain aggregate of its lane. A frozen, declarative,
 * route-resolver-free description of a multi-stage lifecycle scenario.
 *
 * The manifest is the single artifact a scenario author writes; the runtime
 * installs it (resolving module selectors against the package registry) and
 * executes it (looking transitions up in the static `outcomeRoutes` tables —
 * there is NO executable resolver anywhere).
 */
export interface LifecycleScenarioManifest {
  /** Schema version of this manifest envelope itself. */
  readonly manifestFormatVersion: string;

  /** Scenario identity. Reused verbatim from `domain/lifecycle.ts`. */
  readonly identity: LifecycleIdentity;

  /** Input contract the scenario root input must conform to. */
  readonly inputContractRef: ContractRef;
  /** Output contract the terminal productions must conform to. */
  readonly outputContractRef: ContractRef;

  /** Stage id where execution begins. MUST exist in `stageBindings`. */
  readonly entryStageId: string;

  /** Stage bindings, each pinning a module contract selector. */
  readonly stageBindings: readonly ScenarioStageBinding[];

  /**
   * Scenario-level outcome routes (terminal handoffs out of the whole
   * scenario). Deterministic static table — no resolver.
   */
  readonly outcomeRoutes: Readonly<Record<string, TransitionTarget>>;

  /**
   * Scenario-root input field mappings and terminal output mappings. Safe
   * own-property paths only (validated by `isSafeMappingPath`).
   */
  readonly inputMappings: Readonly<Record<string, LifecycleMappingExpression>>;
  readonly outputMappings: Readonly<Record<string, LifecycleMappingExpression>>;

  /** Declared terminal statuses. MUST be non-empty. */
  readonly terminalStatuses: readonly string[];

  /** Scenario-level policy bundle (declared here, run by the runtime). */
  readonly scenarioPolicies: ScenarioPolicies;

  /** Every distinct module contract this scenario depends on. */
  readonly requiredModuleSelectors: readonly ModuleSelector[];

  /** Optional capability requirements imported from tool-contribution.js. */
  readonly capabilityRequirements?: readonly CapabilityRequirement[];

  /** Hard caps protecting against runaway transitions / re-entries. */
  readonly transitionBudgets: TransitionBudgets;
  readonly reentryBudgets: ReentryBudgets;

  // Intentionally NO `routeResolver` field. The type must be structurally
  // incapable of carrying an executable route resolver. The validator
  // additionally rejects any object that has a `routeResolver` own key
  // (defense-in-depth against plain-object literals smuggled in).
}

// ---------------------------------------------------------------------------
// ValidationResult (mirrors the SPI validator contract).
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

function ok(): ValidationResult {
  return { ok: true, errors: [] };
}

function fail(errors: ValidationError[]): ValidationResult {
  return { ok: false, errors };
}

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

// ---------------------------------------------------------------------------
// isSafeMappingPath.
//
// A mapping path is a dotted own-property traversal (e.g.
// `stages.draft.output.campaignDraft`). It MUST NOT traverse the prototype
// chain: the segments `__proto__`, `prototype`, and `constructor` are
// forbidden because they enable prototype-pollution reads / writes when the
// path is later dereferenced against a runtime frame. This is the same rule
// conceptually applied by the existing `lifecycle-mapper.ts` at runtime; here
// we make it a pure predicate so the manifest validator can enforce it
// statically, before any runtime dereference happens.
// ---------------------------------------------------------------------------

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * True iff `path` is a string of non-empty own-property segments separated by
 * `.`, none of which is `__proto__`, `prototype`, or `constructor`.
 *
 * Accepts the two object-shaped `LifecycleMappingExpression` variants
 * (`{ literal }` / `{ runtime }`) — those are validated structurally by the
 * canonical check and need no path scan; only the string form is a path.
 */
export function isSafeMappingPath(path: unknown): boolean {
  if (typeof path !== 'string') return true; // non-path expression; not our job here
  if (path.length === 0) return false;
  const segments = path.split('.');
  for (const seg of segments) {
    if (seg.length === 0) return false;
    if (UNSAFE_PATH_SEGMENTS.has(seg)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// validateLifecycleScenarioManifest.
//
// Order of checks:
//   1. Structural absence of `routeResolver` — reject any object that carries
//      the key, even if its value is undefined/null.
//   2. assertCanonicalSerializable — rejects functions/Maps/Sets/Symbols/
//      undefined-in-arrays/class-instances/non-finite-numbers. Throws on the
//      first forbidden value (the canonical-serialization contract is
//      fail-fast); we translate the throw into a ValidationFailure.
//   3. entryStageId exists in stageBindings.
//   4. terminalStatuses non-empty.
//   5. Every outcomeRoutes target resolves to a declared stage or terminal.
//   6. Every stage's outcomeRoutes target resolves similarly.
//   7. Mapping paths are safe (inputMappings, outputMappings, and every
//      stage's inputMapping/outputMapping).
//   8. Budgets: transitionBudgets.maxTransitions > 0;
//      reentryBudgets.maxReentries >= 0.
// ---------------------------------------------------------------------------

const ROUTE_RESOLVER_KEY = 'routeResolver';

/**
 * Validate a `LifecycleScenarioManifest`-shaped value against every serial +
 * structural rule. Pure: returns a `ValidationResult`, throws nothing. The
 * canonical-serialization pre-check is delegated to
 * `assertCanonicalSerializable` from `canonical-serialization.js`.
 *
 * Check ordering rationale:
 *   (1) `routeResolver` KEY absence is checked FIRST, before the canonical-
 *       serializability gate. The routeResolver-forbidden rule is a manifest-
 *       SHAPE rule: the type must be structurally incapable of carrying a
 *       route resolver. A manifest that smuggles a `routeResolver` key is
 *       malformed even if the key's value happens to be a non-serializable
 *       function (the function is a second, independent violation). Checking
 *       the key first guarantees the rule always produces its own error code,
 *       regardless of what the value is.
 *   (2) Canonical serializability runs second and short-circuits the remaining
 *       value-level structural checks — there is no point checking budget
 *       numbers if a value somewhere is already a Map/Symbol/function.
 */
export function validateLifecycleScenarioManifest(
  m: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(m)) {
    errors.push(err('NOT_OBJECT', '$', 'manifest must be a plain object'));
    return fail(errors);
  }

  const manifest = m as Record<string, unknown>;

  // (1) Structural absence of routeResolver. Checked BEFORE the canonical
  // gate so the routeResolver-forbidden rule fires with its own error code
  // even when the smuggled value is itself non-serializable.
  if (Object.prototype.hasOwnProperty.call(manifest, ROUTE_RESOLVER_KEY)) {
    errors.push(
      err(
        'ROUTE_RESOLVER_FORBIDDEN',
        '$.routeResolver',
        'a LifecycleScenarioManifest must not carry a routeResolver key ' +
          '(routes are declarative static outcomeRoutes only)',
      ),
    );
  }

  // (2) Canonical serializability serial gate. Runs after the routeResolver
  // key check; short-circuits the remaining value-level rules.
  try {
    assertCanonicalSerializable(m);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push(err('NOT_CANONICAL_SERIALIZABLE', '$', message));
    return fail(errors);
  }

  // Stage index built from whatever stageBindings the manifest carries.
  const stageIds = new Set<string>();
  const stageBindings = manifest.stageBindings;
  if (Array.isArray(stageBindings)) {
    for (const s of stageBindings) {
      if (isPlainObject(s) && typeof (s as { id?: unknown }).id === 'string') {
        stageIds.add((s as { id: string }).id);
      }
    }
  }

  // Terminal status set.
  const terminalStatuses = manifest.terminalStatuses;
  const terminalSet = new Set<string>();
  if (Array.isArray(terminalStatuses)) {
    for (const t of terminalStatuses) {
      if (typeof t === 'string') terminalSet.add(t);
    }
  }

  // (3) entryStageId exists in stageBindings.
  const entryStageId = manifest.entryStageId;
  if (typeof entryStageId === 'string' && entryStageId.length > 0) {
    if (!stageIds.has(entryStageId)) {
      errors.push(
        err(
          'ENTRY_STAGE_MISSING',
          '$.entryStageId',
          `entryStageId "${entryStageId}" does not match any stageBinding id`,
        ),
      );
    }
  } else {
    errors.push(
      err('ENTRY_STAGE_MISSING', '$.entryStageId', 'entryStageId must be a non-empty string'),
    );
  }

  // (4) terminalStatuses non-empty.
  if (terminalSet.size === 0) {
    errors.push(
      err(
        'TERMINAL_STATUSES_EMPTY',
        '$.terminalStatuses',
        'terminalStatuses must declare at least one terminal status',
      ),
    );
  }

  // (5) Scenario-level outcomeRoutes targets resolve to a stage or a terminal.
  collectOutcomeRouteErrors(
    manifest.outcomeRoutes,
    '$.outcomeRoutes',
    stageIds,
    terminalSet,
    errors,
  );

  // (6) Per-stage outcomeRoutes + mapping-path safety.
  if (Array.isArray(stageBindings)) {
    let i = 0;
    for (const s of stageBindings) {
      const path = `$.stageBindings[${i}]`;
      if (!isPlainObject(s)) {
        errors.push(err('STAGE_NOT_OBJECT', path, 'stage binding must be a plain object'));
        i++;
        continue;
      }
      const stage = s as Record<string, unknown>;
      collectOutcomeRouteErrors(
        stage.outcomeRoutes,
        `${path}.outcomeRoutes`,
        stageIds,
        terminalSet,
        errors,
      );
      collectMappingPathErrors(stage.inputMapping, `${path}.inputMapping`, errors);
      collectMappingPathErrors(stage.outputMapping, `${path}.outputMapping`, errors);
      i++;
    }
  } else {
    errors.push(
      err('STAGE_BINDINGS_NOT_ARRAY', '$.stageBindings', 'stageBindings must be an array'),
    );
  }

  // (7) Scenario-level mapping paths.
  collectMappingPathErrors(manifest.inputMappings, '$.inputMappings', errors);
  collectMappingPathErrors(manifest.outputMappings, '$.outputMappings', errors);

  // (8) Budgets.
  const tb = manifest.transitionBudgets;
  if (isPlainObject(tb)) {
    const maxT = (tb as { maxTransitions?: unknown }).maxTransitions;
    if (typeof maxT !== 'number' || !Number.isFinite(maxT) || maxT <= 0) {
      errors.push(
        err(
          'TRANSITION_BUDGET_INVALID',
          '$.transitionBudgets.maxTransitions',
          'transitionBudgets.maxTransitions must be a finite number > 0',
        ),
      );
    }
  } else {
    errors.push(
      err('TRANSITION_BUDGET_INVALID', '$.transitionBudgets', 'transitionBudgets must be an object'),
    );
  }

  const rb = manifest.reentryBudgets;
  if (isPlainObject(rb)) {
    const maxR = (rb as { maxReentries?: unknown }).maxReentries;
    if (typeof maxR !== 'number' || !Number.isFinite(maxR) || maxR < 0) {
      errors.push(
        err(
          'REENTRY_BUDGET_INVALID',
          '$.reentryBudgets.maxReentries',
          'reentryBudgets.maxReentries must be a finite number >= 0',
        ),
      );
    }
  } else {
    errors.push(
      err('REENTRY_BUDGET_INVALID', '$.reentryBudgets', 'reentryBudgets must be an object'),
    );
  }

  return errors.length === 0 ? ok() : fail(errors);
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Push one ValidationError per outcome-route target that does not resolve to a
 * declared stage id or a declared terminal status. Operates on either the
 * scenario-level `outcomeRoutes` or a stage's `outcomeRoutes`.
 */
function collectOutcomeRouteErrors(
  routes: unknown,
  basePath: string,
  stageIds: Set<string>,
  terminalSet: Set<string>,
  errors: ValidationError[],
): void {
  if (!isPlainObject(routes)) return; // shape-checked elsewhere if needed
  const obj = routes as Record<string, unknown>;
  for (const [outcome, target] of Object.entries(obj)) {
    if (!isPlainObject(target)) {
      errors.push(
        err(
          'OUTCOME_ROUTE_TARGET_INVALID',
          `${basePath}.${outcome}`,
          'route target must be a plain object with type "stage"|"terminal"',
        ),
      );
      continue;
    }
    const t = target as { type?: unknown; stageId?: unknown; status?: unknown };
    if (t.type === 'stage') {
      if (typeof t.stageId !== 'string' || !stageIds.has(t.stageId)) {
        errors.push(
          err(
            'OUTCOME_ROUTE_TARGET_INVALID',
            `${basePath}.${outcome}`,
            `stage target "${String(t.stageId)}" does not match any stageBinding id`,
          ),
        );
      }
    } else if (t.type === 'terminal') {
      if (typeof t.status !== 'string' || !terminalSet.has(t.status)) {
        errors.push(
          err(
            'OUTCOME_ROUTE_TARGET_INVALID',
            `${basePath}.${outcome}`,
            `terminal target "${String(t.status)}" is not a declared terminalStatus`,
          ),
        );
      }
    } else {
      errors.push(
        err(
          'OUTCOME_ROUTE_TARGET_INVALID',
          `${basePath}.${outcome}`,
          `route target type must be "stage"|"terminal" (got "${String(t.type)}")`,
        ),
      );
    }
  }
}

/**
 * Push one ValidationError per mapping-path (string-valued entry) that fails
 * `isSafeMappingPath`. Object-valued entries (`{ literal }` / `{ runtime }`)
 * are left to the canonical check — they carry no path.
 */
function collectMappingPathErrors(
  mapping: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (mapping === undefined) return; // optional field
  if (!isPlainObject(mapping)) return; // shape-checked elsewhere if needed
  const obj = mapping as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && !isSafeMappingPath(value)) {
      errors.push(
        err(
          'UNSAFE_MAPPING_PATH',
          `${basePath}.${key}`,
          `mapping path "${value}" traverses a forbidden segment ` +
            '(__proto__|prototype|constructor)',
        ),
      );
    }
  }
}
