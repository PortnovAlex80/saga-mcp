/**
 * W6-A1 — Module tool contribution installer (application layer).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md
 *       §1 row W6-A1, §2 exit gate, §3 anti-scope.
 * Plan: §0.9.3, §11.4 (ModuleToolContribution), §11.5 (installation validates
 *       tool collisions, handler coverage, capability dependencies, schema
 *       availability, and resource availability), §14.8.1.
 * Task: docs/refactor-management/05-subagent-tasks/W06-a1.md
 *
 * `installModuleToolContributions` is the single application-layer entry point
 * the composition root calls at startup to surface a package's
 * `ModuleToolContribution`s into the Wave 2 `ModuleToolRegistry`
 * (`installation/domain/registries.ts`). It:
 *
 *   1. validates every contribution structurally (reuses the Wave 1 SPI
 *      `validateModuleToolContribution`);
 *   2. validates the namespaced `logicalId` (plan §11.4.1: a namespaced
 *      logical identifier) — at least one namespace separator, a non-empty
 *      namespace (alias) segment and a non-empty tool-name segment, restricted
 *      to the surfaced namespace alphabet;
 *   3. validates the exact semver `version` (plan §11.4.1);
 *   4. resolves each contribution's live handler from a `HandlerRegistry` by
 *      the contribution's `handlerRef` (handler coverage — plan §11.5);
 *   5. registers each `(contribution, handler)` into the `ModuleToolRegistry`,
 *      which rejects a namespace collision (plan §11.5; token
 *      `MODULE_TOOL_NAMESPACE_COLLISION`) at register time.
 *
 * The installer is a thin orchestration over the Wave 2 registry layer: it
 * adds no new collision policy, no new registry state, and no gateway source
 * change (anti-scope §3). It is fail-fast: a batch with ANY structural,
 * namespace, version, or handler-coverage defect installs NOTHING and throws
 * `MODULE_TOOL_INSTALL_FAILED` carrying every reason. Only an all-valid batch
 * reaches the registry, so a partial install (some contributions registered,
 * others not) is impossible. Collision detection happens during the register
 * loop and is reported on the first colliding contribution with the registry's
 * own token.
 *
 * ── Anti-scope (frozen spec §3) ─────────────────────────────────────────────
 *
 *   - No `src/index.ts` rewrite (Wave 11 cutover). The integrator wires this
 *     service into the gateway at the Wave 6 checkpoint; this file only
 *     exposes the function + types via the application surface.
 *   - No removal of existing tools (Wave 13).
 *   - No module migration (Wave 8/9).
 *
 * ── Dependency direction (W0-A1 ratchet) ─────────────────────────────────────
 *
 * This file lives at `src/application/tool-contribution-installer.ts` (top-level
 * application layer), NOT under `src/process-modules/`. The ratchet's rule
 * classifiers (MODULE_DIR / DOMAIN_DIR / PERSISTENCE_DIR / COMPOSITION_DIR /
 * LIFECYCLES_DIR / APPLICATION_DIR) all anchor on `src/process-modules/...`, so
 * a top-level `src/application/` file is outside every rule's source-side
 * predicate and adds zero new ratchet edges. It imports only from the Wave 1
 * SPI barrel (pure types + the reused validator), the Wave 2 registry layer
 * (the `ModuleToolRegistry`/`HandlerRegistry` ports + their error tokens), and
 * Node built-ins — no `modules/`, no `persistence/` adapters, no `db.ts`, no
 * `composition/`. Keeps the ratchet green.
 */

import type {
  ModuleToolContribution,
  ValidationResult,
} from '../process-modules/domain/spi/index.js';
import { validateModuleToolContribution } from '../process-modules/domain/spi/index.js';

// Registry PORTs + their error tokens. The PORTs are re-exported through the
// Wave 2 barrel (`installation/index.js`); the collision/lookup TOKENS are
// declared on `installation/domain/registries.ts` and intentionally NOT
// re-exported through the barrel (the barrel surfaces only the port +
// adapter types). We import the tokens from their owner file directly so we
// surface them verbatim without redefining the literals.
import type {
  ModuleToolRegistry,
  HandlerRegistry,
  HandlerInstance,
} from '../process-modules/installation/index.js';
import {
  MODULE_TOOL_NAMESPACE_COLLISION,
  MODULE_TOOL_NOT_REGISTERED,
  HANDLER_NOT_REGISTERED,
} from '../process-modules/installation/domain/registries.js';

// Re-exported so consumers can import the error tokens from a single surface.
export {
  // Wave 2 registry collision/lookup tokens — surfaced verbatim.
  MODULE_TOOL_NAMESPACE_COLLISION,
  MODULE_TOOL_NOT_REGISTERED,
  HANDLER_NOT_REGISTERED,
};

// ---------------------------------------------------------------------------
// Error tokens owned by this lane.
// ---------------------------------------------------------------------------

/**
 * Thrown by `installModuleToolContributions` when the batch is rejected BEFORE
 * any registration occurs — a structural, namespace, version, or
 * handler-coverage defect. The `message` lists every collected reason so the
 * operator sees the whole defect set in one report (fail-fast over the batch).
 */
export const MODULE_TOOL_INSTALL_FAILED = 'MODULE_TOOL_INSTALL_FAILED';

// ---------------------------------------------------------------------------
// Namespace alphabet + shape validation (plan §11.4.1).
// ---------------------------------------------------------------------------

/**
 * The surfaced namespace alphabet for a tool `logicalId`: lowercase ASCII
 * letters and digits, plus `.`, `_`, and `-`. The logical id is the surfaced
 * MCP tool name; restricting it to this alphabet keeps it stable across
 * transports (MCP tool names forbid spaces, slashes, and casing surprises).
 */
const LOGICAL_ID_ALPHABET_RE = /^[a-z0-9._-]+$/;

/**
 * Minimum number of namespace separators (`.`) a logical id must carry. `1`
 * means the id is `namespace.tool` at minimum — a bare `tool` with no
 * namespace (alias) segment is an authoring error (plan §11.4.1 "namespaced
 * logical identifier") because it would squat the global root and collide with
 * any future platform tool.
 */
const MIN_NAMESPACE_SEPARATORS = 1;

/**
 * Exact-semver pattern for a tool `version` (plan §11.4.1). Mirrors the
 * `parseSemver` shape used by the Wave 2 PackageRegistry
 * (`installation/domain/package-registry.ts`): digits-only `x.y.z`, no
 * prerelease/build suffixes. Tool versions are pinned exact at install time;
 * range resolution is the package-registry's concern, not the installer's.
 */
const TOOL_VERSION_RE = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * A single reason the installer rejected a contribution. Pure serializable
 * data (plan §3.5): no functions, no class instances. Carried in aggregate on
 * an {@link ModuleToolInstallError}.
 *
 * @property code       Stable machine-readable reason code.
 * @property logicalId  The contribution's logicalId (empty string if the
 *                      contribution was so malformed it had none).
 * @property field      Dot-path of the offending field, mirroring the Wave 1
 *                      `ValidationError.path` convention.
 * @property message    Human-readable explanation.
 */
export interface ModuleToolInstallReason {
  readonly code: string;
  readonly logicalId: string;
  readonly field: string;
  readonly message: string;
}

/**
 * Error thrown by `installModuleToolContributions`. Carries the full reason
 * set so the operator sees every defect in one report rather than fixing them
 * one at a time across re-runs.
 *
 * `reasons` is non-empty by construction (the installer only throws when at
 * least one reason was collected).
 */
export class ModuleToolInstallError extends Error {
  readonly reasons: readonly ModuleToolInstallReason[];

  constructor(reasons: readonly ModuleToolInstallReason[]) {
    const list = reasons.length === 0
      ? '(no reasons)' as const
      : reasons.map((r) => `  - [${r.code}] ${r.logicalId || '(no logicalId)'} ${r.field}: ${r.message}`).join('\n');
    super(`${MODULE_TOOL_INSTALL_FAILED}: ${reasons.length} reason(s)\n${list}`);
    this.name = 'ModuleToolInstallError';
    this.reasons = reasons;
  }
}

/**
 * Result of a successful install. Pure serializable data: the count installed,
 * the logical ids installed (in registration order), and the logical ids that
 * were already present and re-registered idempotently (same contribution +
 * handler — see `ModuleToolRegistry.register`). Excluded from `installed` to
 * keep the two sets disjoint and unambiguous.
 *
 * @property installed         Logical ids newly registered in this call.
 * @property idempotent        Logical ids that were already present and whose
 *                             re-registration was a no-op.
 * @property count             `installed.length + idempotent.length`.
 */
export interface ModuleToolInstallResult {
  readonly installed: readonly string[];
  readonly idempotent: readonly string[];
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (module-local).
// ---------------------------------------------------------------------------

/**
 * Validate the namespaced shape of a tool `logicalId` (plan §11.4.1).
 *
 * Rules:
 *   1. Non-empty string.
 *   2. Restricted to the {@link LOGICAL_ID_ALPHABET_RE} alphabet.
 *   3. Carries at least {@link MIN_NAMESPACE_SEPARATORS} `.` separators — i.e.
 *      a namespace (alias) segment and a tool-name segment.
 *   4. Neither the namespace segment nor the tool-name segment is empty
 *      (rejects leading/trailing/consecutive dots like `.tool`, `ns.`, and
 *      `ns..tool`).
 *
 * Returns the parsed `{ namespace, name }` pair on success, or an error code
 * on failure. Pure: no exceptions, no side effects.
 */
function validateNamespacedLogicalId(
  logicalId: string,
): { ok: true; namespace: string; name: string } | { ok: false; code: string; message: string } {
  if (typeof logicalId !== 'string' || logicalId.length === 0) {
    return { ok: false, code: 'BAD_LOGICAL_ID', message: 'logicalId must be a non-empty string' };
  }
  if (!LOGICAL_ID_ALPHABET_RE.test(logicalId)) {
    return {
      ok: false,
      code: 'BAD_NAMESPACE_ALPHABET',
      message:
        "logicalId must contain only lowercase letters, digits, '.', '_', or '-'",
    };
  }
  const segments = logicalId.split('.');
  // A leading/trailing/consecutive dot (`'.tool'`, `'ns.'`, `'ns..tool'`)
  // produces an empty segment from split; reject any empty segment so the
  // namespace and the tool-name are both non-empty and there are no holes.
  for (const segment of segments) {
    if (segment.length === 0) {
      return {
        ok: false,
        code: 'EMPTY_NAMESPACE_SEGMENT',
        message:
          `logicalId '${logicalId}' has an empty namespace or tool-name segment (leading/trailing/consecutive dots are not allowed)`,
      };
    }
  }
  // segments.length === 1 means there was no '.' at all → missing namespace.
  // segments.length >= 2 guarantees at least one namespace segment + a tool name.
  if (segments.length - 1 < MIN_NAMESPACE_SEPARATORS) {
    return {
      ok: false,
      code: 'MISSING_NAMESPACE',
      message:
        `logicalId must carry at least ${MIN_NAMESPACE_SEPARATORS} namespace separator(s) '.' (got '${logicalId}' with ${segments.length - 1}); a bare tool name with no namespace (alias) segment is not allowed`,
    };
  }
  const name = segments[segments.length - 1];
  const namespace = segments.slice(0, -1).join('.');
  return { ok: true, namespace, name };
}

/**
 * Validate a tool `version` is an exact semver `x.y.z` (plan §11.4.1).
 */
function validateToolVersion(
  version: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof version !== 'string' || !TOOL_VERSION_RE.test(version)) {
    return {
      ok: false,
      message:
        `version must be an exact semver 'x.y.z' (digits only), got '${version}'`,
    };
  }
  return { ok: true };
}

/**
 * Reduce a Wave 1 {@link ValidationResult} into installer reasons. The Wave 1
 * validator returns one {@link ValidationError} per defect; this maps each onto
 * an {@link ModuleToolInstallReason} anchored at the contribution's logicalId.
 */
function reasonsFromValidationResult(
  logicalId: string,
  result: ValidationResult,
): ModuleToolInstallReason[] {
  if (result.ok) return [];
  return result.errors.map((e) => ({
    code: e.code,
    logicalId,
    field: e.path,
    message: e.message,
  }));
}

// ---------------------------------------------------------------------------
// installModuleToolContributions — the entry point.
// ---------------------------------------------------------------------------

/**
 * Install a batch of {@link ModuleToolContribution}s from a package into the
 * Wave 2 {@link ModuleToolRegistry}, binding each to its live handler resolved
 * from the {@link HandlerRegistry} by the contribution's `handlerRef`.
 *
 * Validation order (fail-fast over the WHOLE batch):
 *   1. Structural — `validateModuleToolContribution` (Wave 1 SPI, reused).
 *   2. Namespace  — `logicalId` is namespaced with a non-empty namespace
 *      (alias) segment and tool-name segment, alphabet-restricted.
 *   3. Version    — exact semver `x.y.z`.
 *   4. Handler    — `handlerRef` resolves to a live handler in the
 *      {@link HandlerRegistry} (handler coverage, plan §11.5).
 *
 * If any of 1-4 fails for ANY contribution, NOTHING is registered and a
 * {@link ModuleToolInstallError} carrying every reason is thrown. This makes a
 * partial install impossible: the registry never sees a half-valid batch.
 *
 * Once all four pass for every contribution, the installer registers them in
 * array order. Registration delegates collision detection to
 * `ModuleToolRegistry.register`, which throws with the
 * `MODULE_TOOL_NAMESPACE_COLLISION` token if a DIFFERENT contribution is
 * already bound under the same `logicalId` (plan §11.5). Re-registering the
 * exact same contribution + handler is a documented no-op (idempotent) and is
 * reported in `result.idempotent`, NOT `result.installed`.
 *
 * Note on atomicity: structural/namespace/version/handler validation is
 * all-or-nothing (the batch is rejected wholesale before any register call).
 * Collision detection, by contrast, happens DURING the register loop and is
 * surfaced on the first colliding contribution. A collision therefore leaves
 * the contributions registered BEFORE it in the registry. This mirrors the
 * Wave 2 registry's own contract (it is the single owner of the surfaced
 * namespace and rejects collisions at register time) and the plan §11.5
 * placement of collision detection at "installation" — i.e. at register time,
 * not at pre-validation time. Operators resolve a collision by fixing the
 * offending manifest and re-running; the registry's idempotent re-register
 * makes a re-run safe for the already-installed contributions.
 *
 * @param contributions  The package's tool contributions to install. May be
 *                       empty (a no-op install returning count 0 is valid).
 * @param registries     The registry bundle: `moduleToolRegistry` receives the
 *                       contributions; `handlerRegistry` resolves each
 *                       contribution's `handlerRef` to its live handler.
 * @returns              {@link ModuleToolInstallResult} describing what landed.
 * @throws {ModuleToolInstallError}
 *                       On any structural/namespace/version/handler defect.
 *                       See {@link ModuleToolInstallError.reasons}.
 * @throws {Error}       With message prefix `MODULE_TOOL_NAMESPACE_COLLISION`
 *                       (re-thrown verbatim from `ModuleToolRegistry.register`)
 *                       if a different contribution already owns a logicalId.
 */
export async function installModuleToolContributions(
  contributions: readonly ModuleToolContribution[],
  registries: {
    readonly moduleToolRegistry: ModuleToolRegistry;
    readonly handlerRegistry: HandlerRegistry;
  },
): Promise<ModuleToolInstallResult> {
  // ----- Phase 1: validate the WHOLE batch before touching the registry. ---
  const reasons: ModuleToolInstallReason[] = [];

  // Pre-resolve handlers into a parallel array so a handler-coverage defect is
  // reported alongside the structural defects and the batch is still rejected
  // wholesale. Resolution is read-only on the HandlerRegistry.
  const resolvedHandlers: (HandlerInstance | undefined)[] = new Array(
    contributions.length,
  );

  for (let i = 0; i < contributions.length; i++) {
    const contribution = contributions[i];

    // 1. Structural validation (Wave 1 SPI, reused — canonical serializability
    //    + every field + enum enforcement on idempotency/sideEffect).
    const logicalIdForReport =
      contribution && typeof contribution === 'object' && typeof contribution.logicalId === 'string'
        ? contribution.logicalId
        : '';
    const structural = await validateModuleToolContribution(contribution);
    reasons.push(...reasonsFromValidationResult(logicalIdForReport, structural));

    // Even if structural validation failed, attempt the namespace/version
    // checks so the operator sees every defect for this contribution in one
    // report. Guard each on the field being a usable string.
    // 2. Namespace validation.
    if (structural.ok || typeof contribution.logicalId === 'string') {
      const ns = validateNamespacedLogicalId(contribution.logicalId);
      if (!ns.ok) {
        reasons.push({
          code: ns.code,
          logicalId: contribution.logicalId,
          field: 'logicalId',
          message: ns.message,
        });
      }
    }
    // 3. Version validation.
    if (structural.ok || typeof contribution.version === 'string') {
      const ver = validateToolVersion(contribution.version);
      if (!ver.ok) {
        reasons.push({
          code: 'BAD_TOOL_VERSION',
          logicalId: contribution.logicalId,
          field: 'version',
          message: ver.message,
        });
      }
    }

    // 4. Handler coverage — resolve the handlerRef to a live handler. The
    //    HandlerRegistry indexes by HandlerRef.logicalId; the contribution's
    //    handlerRef is the opaque string declared on the manifest, which the
    //    composition root also registered under the same logicalId. We build a
    //    minimal HandlerRef view and let the registry resolve-or-throw, then
    //    convert its HANDLER_NOT_REGISTERED throw into a collected reason so
    //    the whole batch's defect set is reported at once.
    if (structural.ok) {
      try {
        resolvedHandlers[i] = registries.handlerRegistry.resolve({
          logicalId: contribution.handlerRef,
          version: contribution.version,
          // digest is advisory for HandlerRegistry lookup (it indexes by
          // logicalId only — see registries.ts). An empty digest keeps the
          // value canonical-serializable and avoids inventing a hash.
          digest: '',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reasons.push({
          code: 'HANDLER_NOT_FOUND',
          logicalId: contribution.logicalId,
          field: 'handlerRef',
          message: `no handler registered for handlerRef '${contribution.handlerRef}' (${msg})`,
        });
      }
    }
  }

  if (reasons.length > 0) {
    throw new ModuleToolInstallError(reasons);
  }

  // ----- Phase 2: register every validated contribution. -------------------
  const installed: string[] = [];
  const idempotent: string[] = [];
  for (let i = 0; i < contributions.length; i++) {
    const contribution = contributions[i];
    const handler = resolvedHandlers[i] as HandlerInstance;
    const wasPresent = registries.moduleToolRegistry.has(contribution.logicalId);
    // ModuleToolRegistry.register is the single owner of collision detection
    // (plan §11.5). It throws MODULE_TOOL_NAMESPACE_COLLISION on a different
    // contribution under the same logicalId; it is a no-op on the exact same
    // contribution + handler. We let both behaviors propagate verbatim.
    registries.moduleToolRegistry.register(contribution, handler);
    if (wasPresent) {
      idempotent.push(contribution.logicalId);
    } else {
      installed.push(contribution.logicalId);
    }
  }

  return Object.freeze({
    installed: Object.freeze(installed),
    idempotent: Object.freeze(idempotent),
    count: installed.length + idempotent.length,
  });
}
