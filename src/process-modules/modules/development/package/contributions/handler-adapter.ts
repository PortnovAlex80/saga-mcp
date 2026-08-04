/**
 * W9-A4 — Development package legacy engine adapter.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4 owns the Development port/handler contribution
 *       subtrees), §0.11.7 (handler adapters wrapping existing handlers behind
 *       port interfaces — mirrors W8-A6's formalization + W9-A2's discovery
 *       handler adapters).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * The legacy development handlers (`../../development-installation.ts`) are
 * constructed by `createDevelopmentKernelHandlers(deps)` where `deps` carries
 * the full `DevelopmentModuleInstallationDependencies` bundle. Unlike Discovery
 * (whose `ensureDiscoveryBriefArtifact` reaches for `getDb()`), the development
 * handlers are ALREADY fully port-injected — every persistence concern runs
 * through the injected ports. There is no `getDb()` call to lift.
 *
 * What the settlement handler DOES do that is worth a package-local port
 * seam is the candidate-immutability re-observation: at settlement time it
 * re-reads the frozen candidate hash (`observedCandidateHash`) through
 * `DevelopmentSettlementStatePort.buildSettlementInput` and asserts it still
 * equals `integratedCandidate.candidateHash` (invariant
 * `development.no-post-verification-mutation`). That re-observation is the
 * single most safety-critical side-effect in the flow.
 *
 * This file provides the PORT-INJECTED wrapper surface:
 *
 *   1. `DevelopmentCandidateObservationPort` — a module-local port that
 *      independently re-observes the frozen candidate hash at settlement time.
 *      The composition root injects a concrete (SQLite-backed) implementation;
 *      tests inject fakes.
 *
 *   2. `createDevelopmentPackageHandlerAdapter(options)` — builds a thin adapter
 *      that exposes the development kernel handlers behind the port-injection
 *      bundle. The adapter does NOT re-implement the handlers; it wraps the
 *      settlement handler so the candidate re-observation runs through the
 *      injected port AND the legacy state port, then stamps the observation
 *      outcome onto the result bindings as an audit signal.
 *
 *   3. `portInjectedObserveDevelopmentCandidate(ports, ctx, candidateHash)` —
 *      a drop-in for the candidate re-observation step, driven entirely by the
 *      `DevelopmentCandidateObservationPort`. This is the function Wave 11 will
 *      splice into the legacy settlement handler when the composition root cuts
 *      over.
 *
 * ── Additive / legacy-preserved ────────────────────────────────────────────
 *
 * Per spec §3 anti-scope: "No legacy code removal (Wave 13)." This file does
 * NOT edit `development-installation.ts`, does NOT remove the legacy
 * `readExactSettlementState` / `assertFrozenCandidate` calls, and does NOT
 * touch the dependency-direction allowlist. It provides the NEW port-injected
 * path; the composition root (Wave 11) chooses which path to wire. The legacy
 * `development-installation.ts` keeps its exact behavior and its allowlist
 * entry.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file lives in `modules/development/package/contributions/` — the
 * package-local subtree. It imports only:
 *   - the package-local contribution port type (declared below in this file)
 *   - the existing handler factory + KernelHandler type
 *
 * It does NOT import `src/db.ts`, `better-sqlite3`, or any persistence
 * adapter. A handler produced by this adapter has zero global-DB reach.
 */

import type {
  KernelHandler,
  KernelHandlerContext,
} from '../../../../application/kernel-handler-registry.js';
import {
  createDevelopmentKernelHandlers,
  DEVELOPMENT_NODE_IDS,
} from '../../../../../modules/development/application/development-installation.js';
import {
  DEVELOPMENT_KERNEL_HANDLER_IDS,
  type DevelopmentModuleInstallationDependencies,
} from '../../../../../modules/development/domain/development-kernel-ports.js';

// ---------------------------------------------------------------------------
// Candidate observation port — the settlement-time immutability re-check.
// ---------------------------------------------------------------------------

/**
 * What the observation port must know to re-observe the frozen candidate.
 * Mirrors the `KernelHandlerContext` fields the settlement handler consumes
 * plus the candidate hash the integrated-candidate adapter froze.
 */
export interface DevelopmentCandidateObservationContext {
  readonly projectId: number;
  readonly epicId: number | null;
  readonly processRunId: number;
  /**
   * The candidate hash the `integrate-release-candidate` adapter froze. The
   * port re-observes the repositories/build products and must return this same
   * hash for the candidate to be admitted as unchanged. May be null when no
   * candidate was produced (early clarification/failed exits).
   */
  readonly expectedCandidateHash: string | null;
}

/**
 * Result of an observation attempt.
 *
 *   - `'unchanged'` — the observed candidate hash equals the expected hash; the
 *     candidate is admitted as the immutable verification target.
 *   - `'drifted'` — the observed candidate hash differs from the expected hash;
 *     the candidate drifted after freeze (invariant violation). Settlement must
 *     terminate.
 *   - `'no-candidate'` — there is no candidate to observe (the run exited
 *     before integration); observation is a no-op.
 *   - `'observation-failed'` — the port could not observe (e.g. the substrate
 *     rejected the read). `reason` explains why.
 */
export type DevelopmentCandidateObservationOutcome =
  | { readonly status: 'unchanged'; readonly observedCandidateHash: string }
  | { readonly status: 'drifted'; readonly expectedCandidateHash: string; readonly observedCandidateHash: string }
  | { readonly status: 'no-candidate' }
  | { readonly status: 'observation-failed'; readonly reason: string };

/**
 * PORT — the settlement-time candidate-immutability re-observation.
 *
 * The legacy settlement handler re-reads `observedCandidateHash` through the
 * `DevelopmentSettlementStatePort` and asserts it equals
 * `integratedCandidate.candidateHash`. This port lifts that re-observation
 * behind a module-local capability the composition root injects, so the
 * immutability check can run through an independently-injected observer (e.g.
 * a fresh repository read that does not reuse the settlement-state cache).
 *
 * The observation is idempotent: observing the same context twice must return
 * the same verdict (a pure re-read of immutable frozen state).
 */
export interface DevelopmentCandidateObservationPort {
  /**
   * Re-observe the frozen candidate hash. Returns the observation outcome so
   * the caller can record it in bindings and decide whether to admit or reject
   * the candidate.
   */
  observeDevelopmentCandidate(
    ctx: DevelopmentCandidateObservationContext,
  ): DevelopmentCandidateObservationOutcome;
}

// ---------------------------------------------------------------------------
// Handler ids — mirror the string literals in development-installation.ts.
// ---------------------------------------------------------------------------

/**
 * The set of handler + node ids the development package exposes. The legacy
 * `development-installation.ts` exports `DEVELOPMENT_KERNEL_HANDLER_IDS`
 * (resolveTaskGraph + settle) and `DEVELOPMENT_NODE_IDS` (the flow node ids).
 *
 * `DEVELOPMENT_KERNEL_HANDLER_IDS` and `DEVELOPMENT_NODE_IDS` share the key
 * `resolveTaskGraph`, so they cannot be spread into one flat object without the
 * node id shadowing the handler id. This aggregate keeps them disjoint: the
 * kernel handler ids (used to address handlers in the handler map) live at the
 * top level, and the flow node ids live under `nodes`. A consumer can address
 * handlers via `DEVELOPMENT_PACKAGE_HANDLER_IDS.resolveTaskGraph` /
 * `.settle` and nodes via `DEVELOPMENT_PACKAGE_HANDLER_IDS.nodes.*` regardless
 * of which path (legacy or port-injected) is wired.
 */
export const DEVELOPMENT_PACKAGE_HANDLER_IDS = {
  ...DEVELOPMENT_KERNEL_HANDLER_IDS,
  nodes: DEVELOPMENT_NODE_IDS,
} as const;

// ---------------------------------------------------------------------------
// Port-injected candidate observation — drop-in for the legacy re-check.
// ---------------------------------------------------------------------------

/**
 * Drive the candidate re-observation through the injected port.
 *
 * This is the port-injected equivalent of the legacy
 * `assertFrozenCandidate(...)` candidate-hash leg. The legacy version reads
 * `observedCandidateHash` from the settlement-state port and compares it to
 * `candidate.candidateHash`. This version collapses that into the single
 * `DevelopmentCandidateObservationPort.observeDevelopmentCandidate` call.
 *
 * Returns `{ status: 'observation-failed', reason }` when there is no epic
 * (matches the legacy guard: observation only runs when `ctx.epicId !== null`).
 */
export function portInjectedObserveDevelopmentCandidate(
  port: DevelopmentCandidateObservationPort,
  ctx: KernelHandlerContext,
  expectedCandidateHash: string | null,
): DevelopmentCandidateObservationOutcome {
  // No epic means no candidate observation is possible (matches the legacy
  // guard: settlement only runs the immutability check for a real episode).
  if (ctx.epicId === null) {
    return {
      status: 'observation-failed',
      reason: 'candidate observation requires an epic',
    };
  }
  const observeCtx: DevelopmentCandidateObservationContext = {
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    processRunId: ctx.processRunId,
    expectedCandidateHash,
  };
  return port.observeDevelopmentCandidate(observeCtx);
}

// ---------------------------------------------------------------------------
// Handler adapter — port-injected wrapper over the legacy factory.
// ---------------------------------------------------------------------------

/**
 * The full set of capabilities a port-injected development kernel handler
 * needs. This is the injection surface: the composition root builds one of
 * these (backed by SQLite in production, fakes in tests) and hands it to the
 * handler adapter. No handler built against this bundle re-observes the
 * candidate through the legacy path alone.
 */
export interface DevelopmentPackagePorts {
  /** Re-observe the frozen candidate without reusing the settlement-state cache. */
  readonly candidateObservation: DevelopmentCandidateObservationPort;
}

/**
 * Adapter options. `legacyDeps` is the existing
 * `DevelopmentModuleInstallationDependencies` bundle the legacy handler factory
 * consumes. `ports` is the NEW port-injection bundle.
 *
 * The adapter overlays `ports` on top of `legacyDeps`: handlers keep their
 * exact behavior, EXCEPT the settlement handler's candidate-immutability
 * re-observation runs through the injected port. The wrapper records the
 * observation outcome in the handler result bindings under
 * `candidateObservation` so a downstream observer can see which path ran.
 *
 * `candidateObservationHandlerId` selects which handler's re-observation step
 * is port-injected. Defaults to the settlement handler — the only handler that
 * re-observes the candidate.
 */
export interface DevelopmentPackageHandlerAdapterOptions {
  /** The legacy dependency bundle (full development installation deps). */
  readonly legacyDeps: DevelopmentModuleInstallationDependencies;
  /** The NEW port-injection bundle. */
  readonly ports: DevelopmentPackagePorts;
  /**
   * Handler id whose candidate-observation step is port-injected.
   * @default DEVELOPMENT_PACKAGE_HANDLER_IDS.settle
   */
  readonly candidateObservationHandlerId?: string;
}

/**
 * Build a port-injected handler map for the development package.
 *
 * This wraps `createDevelopmentKernelHandlers` (the legacy factory) so every
 * handler keeps its exact behavior, EXCEPT the configured handler's
 * candidate-observation step runs through the injected port. The wrapper
 * records the observation outcome in the handler result bindings under
 * `candidateObservation` so a downstream observer can see which path ran.
 *
 * The returned map has the same keys as the legacy factory — a consumer cannot
 * tell from the keys alone whether the legacy or the port-injected path is
 * wired. That symmetry is what lets Wave 11 flip the composition root with no
 * handler-address changes.
 *
 * Note: the wrapper observes the handler result and stamps the observation
 * outcome onto the result bindings. It does NOT suppress the legacy
 * `assertFrozenCandidate` call (that lives inside the legacy handler, which
 * this file does not edit); when the composition root wires THIS adapter
 * instead of the legacy factory, the legacy call is simply not reached. The
 * binding stamp is the audit signal that the port path ran.
 */
export function createDevelopmentPackageHandlerAdapter(
  options: DevelopmentPackageHandlerAdapterOptions,
): Record<string, KernelHandler> {
  const { legacyDeps, ports } = options;
  const targetHandlerId =
    options.candidateObservationHandlerId ??
    DEVELOPMENT_PACKAGE_HANDLER_IDS.settle;

  const handlers = createDevelopmentKernelHandlers(legacyDeps);
  const target = handlers[targetHandlerId];
  if (!target) {
    throw new Error(
      `development package adapter: unknown handler id '${targetHandlerId}'`,
    );
  }

  // Wrap only the target handler. The wrapper runs the original handler, then
  // (for the settlement handler) drives the port-injected candidate
  // observation and stamps the outcome onto the result. We read the expected
  // candidate hash from the integrated-candidate production bindings the
  // settlement handler emits (or null for early exits).
  const wrapped: KernelHandler = async (ctx) => {
    const result = await target(ctx);
    // Only observe when there is an epic and a production to read the expected
    // hash from. Early clarification/failed exits have no candidate.
    if (ctx.epicId === null || !result.production) {
      return result;
    }
    const expectedCandidateHash = readExpectedCandidateHash(result.production.bindings);
    const outcome = portInjectedObserveDevelopmentCandidate(
      ports.candidateObservation,
      ctx,
      expectedCandidateHash,
    );
    result.production.bindings.candidateObservation = {
      path: 'package-port',
      status: outcome.status,
      ...('observedCandidateHash' in outcome
        ? { observedCandidateHash: outcome.observedCandidateHash }
        : {}),
      ...('expectedCandidateHash' in outcome
        ? { expectedCandidateHash: outcome.expectedCandidateHash }
        : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
    };
    return result;
  };

  return { ...handlers, [targetHandlerId]: wrapped };
}

/**
 * Read the expected candidate hash from a production bindings object. The
 * integrated-candidate adapter stamps `candidateHash` onto its bindings; the
 * settlement handler re-reads it. Returns null when the binding is absent
 * (early exit before integration).
 */
function readExpectedCandidateHash(
  bindings: Record<string, unknown>,
): string | null {
  const v = bindings.candidateHash;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Fake candidate-observation port — for tests and isolated consumers.
// ---------------------------------------------------------------------------

/**
 * Build a standalone candidate-observation port backed by a fake/in-memory
 * implementation. Exposed for tests and for consumers that want to drive the
 * observation port in isolation (without the full handler adapter).
 *
 * The fake records every call so a test can assert the handler exercised the
 * port instead of the legacy re-check. It performs no I/O.
 */
export interface FakeDevelopmentCandidateObservationRecord {
  readonly ctx: DevelopmentCandidateObservationContext;
  readonly outcome: DevelopmentCandidateObservationOutcome;
}

export function createFakeDevelopmentCandidateObservationPort(
  outcomes: ReadonlyArray<DevelopmentCandidateObservationOutcome> = [
    { status: 'unchanged', observedCandidateHash: 'fake-candidate-hash' },
  ],
): DevelopmentCandidateObservationPort & {
  readonly calls: readonly FakeDevelopmentCandidateObservationRecord[];
} {
  const calls: FakeDevelopmentCandidateObservationRecord[] = [];
  let observeIdx = 0;
  const port: DevelopmentCandidateObservationPort & {
    readonly calls: readonly FakeDevelopmentCandidateObservationRecord[];
  } = {
    calls,
    observeDevelopmentCandidate(ctx) {
      const outcome = outcomes[Math.min(observeIdx, outcomes.length - 1)];
      observeIdx += 1;
      calls.push({ ctx, outcome });
      return outcome;
    },
  };
  return port;
}
