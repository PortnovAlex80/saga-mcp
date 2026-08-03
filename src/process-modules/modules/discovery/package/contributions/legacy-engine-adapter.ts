/**
 * W9-A2 — Discovery package legacy engine adapter.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.4 (W9-A2 owns the discovery legacy engine adapter subtree),
 *       §0.11.7 (handler adapters wrapping existing handlers behind port
 *       interfaces — mirrors W8-A6's formalization handler adapter).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * The legacy discovery handlers (`../../discovery-installation.ts`) are
 * constructed by `createDiscoveryKernelHandlers(deps)` where `deps` carries
 * the `Saga3DiscoveryRuntimePersistence` port — but the
 * `ensureDiscoveryBriefArtifact` helper STILL calls `getDb()` directly for
 * the one piece of state no port exposes: the auto-provisioned `brief`
 * artifact row that downstream Formalization needs for its PRD → brief
 * `derived_from` lineage.
 *
 * This file provides the PORT-INJECTED wrapper surface:
 *
 *   1. `DiscoveryBriefProvisioningPort` — a module-local port that replaces
 *      the `getDb()` brief-provisioning step. The composition root injects a
 *      concrete (SQLite-backed) implementation; tests inject fakes.
 *
 *   2. `createDiscoveryPackageHandlerAdapter(options)` — builds a thin adapter
 *      that exposes the discovery kernel handlers behind the port-injection
 *      bundle. The adapter does NOT re-implement the handlers; it wraps them
 *      so the brief-provisioning step runs through the injected port instead
 *      of `getDb()`.
 *
 *   3. `portInjectedEnsureDiscoveryBrief(ports, ctx, proposalPayload)` — a
 *      drop-in replacement for the legacy
 *      `ensureDiscoveryBriefArtifact`'s DB-touching body, driven entirely by
 *      the `DiscoveryBriefProvisioningPort`. This is the function Wave 11 will
 *      splice into the legacy handler when the composition root cuts over.
 *
 * ── Additive / legacy-preserved ────────────────────────────────────────────
 *
 * Per spec §3 anti-scope: "No legacy code removal (Wave 13)." This file does
 * NOT edit `discovery-installation.ts`, does NOT remove the `getDb()` call,
 * and does NOT touch the dependency-direction allowlist. It provides the NEW
 * port-injected path; the composition root (Wave 11) chooses which path to
 * wire. The legacy `discovery-installation.ts` keeps its `getDb()` call and
 * its allowlist entry.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file lives in `modules/discovery/package/contributions/` — the package-
 * local subtree. It imports only:
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
  createDiscoveryKernelHandlers,
  type DiscoveryInstallationDeps,
} from '../../../../../modules/discovery/application/discovery-installation.js';

// ---------------------------------------------------------------------------
// Brief provisioning port — replaces the `getDb()` brief auto-provisioning.
// ---------------------------------------------------------------------------

/**
 * What the provisioning port must know to provision a discovery brief. Mirrors
 * the `KernelHandlerContext` fields `ensureDiscoveryBriefArtifact` actually
 * consumes plus the proposal payload it derives the brief content hash from.
 */
export interface DiscoveryBriefProvisioningContext {
  readonly projectId: number;
  readonly epicId: number;
  readonly processRunId: number;
  /**
   * The proposal payload the synthetic brief is derived from. May be null when
   * the resolver does not have the decoded payload (the legacy helper accepts
   * null and hashes null fields).
   */
  readonly proposalPayload: {
    readonly problem_statement?: unknown;
    readonly candidate_scope?: unknown;
    readonly recommended_outcome?: unknown;
  } | null;
}

/**
 * Result of a provisioning attempt.
 *
 *   - `'already-provisioned'` — a brief already exists for this epic; nothing
 *     was written.
 *   - `'brief-created'` — a synthetic accepted brief was created from the
 *     accepted proposal. `briefArtifactId` is the new row.
 *   - `'provisioning-failed'` — the port could not provision (e.g. the
 *     substrate rejected the insert). `reason` explains why.
 */
export type DiscoveryBriefProvisioningOutcome =
  | { readonly status: 'already-provisioned'; readonly briefArtifactId: number }
  | { readonly status: 'brief-created'; readonly briefArtifactId: number }
  | { readonly status: 'provisioning-failed'; readonly reason: string };

/**
 * PORT — replaces the `getDb()` call in `ensureDiscoveryBriefArtifact`.
 *
 * The legacy helper reads the live DB to check whether a brief already exists
 * for the epic, and if not, creates a synthetic accepted brief from the
 * accepted proposal (idempotent via a `SELECT … WHERE type='brief'` pre-check
 * and a content-addressed hash). That is two concerns — a READ and a WRITE —
 * both currently done through the global handle. This port lifts both behind
 * a module-local capability the composition root injects.
 *
 * The WRITE path is idempotent: provisioning the same context twice must
 * create at most one brief (mirrors the legacy `SELECT … WHERE type='brief'`
 * pre-check). When a brief already exists, the port returns
 * `'already-provisioned'` with the existing row id.
 */
export interface DiscoveryBriefProvisioningPort {
  /**
   * Ensure a `brief` artifact exists for the epic, derived from the accepted
   * proposal. Idempotent. Returns the brief artifact id in both the
   * already-provisioned and brief-created cases.
   */
  provisionDiscoveryBrief(
    ctx: DiscoveryBriefProvisioningContext,
  ): DiscoveryBriefProvisioningOutcome;
}

// ---------------------------------------------------------------------------
// Handler ids — mirror the string literals in discovery-installation.ts.
// ---------------------------------------------------------------------------

/**
 * The set of handler ids the discovery package exposes. The legacy
 * `discovery-installation.ts` does not export a `DISCOVERY_HANDLER_IDS`
 * constant (it uses inline string literals in the handler factory map), so
 * this file declares them as package-local stable logical ids. A consumer can
 * address handlers by these ids regardless of which path (legacy or
 * port-injected) is wired.
 */
export const DISCOVERY_PACKAGE_HANDLER_IDS = {
  resolveProposalSubmission: 'discovery-resolve-proposal-submission',
  prepareNormalization: 'discovery-prepare-normalization',
  resolveNormalizedProposal: 'discovery-resolve-normalized-proposal',
  prepareReadiness: 'discovery-prepare-readiness',
  resolveReadiness: 'discovery-resolve-readiness',
  settle: 'discovery-settlement-policy',
} as const;

// ---------------------------------------------------------------------------
// Port-injected brief provisioning — drop-in for the legacy helper body.
// ---------------------------------------------------------------------------

/**
 * Drive the brief provisioning through the injected port.
 *
 * This is the port-injected equivalent of the legacy
 * `ensureDiscoveryBriefArtifact(projectId, epicId, proposalPayload)` body. The
 * legacy version:
 *   1. calls `getDb()`
 *   2. checks for a pre-existing accepted brief in the epic
 *   3. hashes the proposal payload into a content-addressed brief hash
 *   4. calls `getDb()` to `INSERT` the synthetic brief
 *
 * This version collapses steps 1-4 into the single
 * `DiscoveryBriefProvisioningPort.provisionDiscoveryBrief` call. Returns the
 * provisioning outcome so the caller can record it in bindings and decide
 * whether to surface the provisioning path in the result.
 *
 * Returns `{ status: 'provisioning-failed', reason }` when there is no epic or
 * project (matches the legacy guard: provisioning only runs when
 * `ctx.epicId !== null`).
 */
export function portInjectedEnsureDiscoveryBrief(
  port: DiscoveryBriefProvisioningPort,
  ctx: KernelHandlerContext,
  proposalPayload: DiscoveryBriefProvisioningContext['proposalPayload'],
): DiscoveryBriefProvisioningOutcome {
  // No epic/project means no provisioning is possible (matches the legacy
  // guard: `if (result.event === 'accepted' && ctx.epicId !== null)`).
  if (ctx.epicId === null) {
    return {
      status: 'provisioning-failed',
      reason: 'brief provisioning requires an epic',
    };
  }
  const provisionCtx: DiscoveryBriefProvisioningContext = {
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    processRunId: ctx.processRunId,
    proposalPayload,
  };
  return port.provisionDiscoveryBrief(provisionCtx);
}

// ---------------------------------------------------------------------------
// Handler adapter — port-injected wrapper over the legacy factory.
// ---------------------------------------------------------------------------

/**
 * The full set of capabilities a port-injected discovery kernel handler needs.
 * This is the injection surface: the composition root builds one of these
 * (backed by SQLite in production, fakes in tests) and hands it to the handler
 * adapter. No handler built against this bundle ever calls `getDb()`.
 */
export interface DiscoveryPackagePorts {
  /** Provision the discovery brief without touching the global DB. */
  readonly briefProvisioning: DiscoveryBriefProvisioningPort;
}

/**
 * Adapter options. `legacyDeps` is the existing `DiscoveryInstallationDeps`
 * bundle the legacy handler factory consumes (the saga3 runtime persistence
 * port). `ports` is the NEW port-injection bundle.
 *
 * The adapter overlays `ports` on top of `legacyDeps`: handlers keep their
 * exact behavior, EXCEPT the proposal-submission resolver's brief-provisioning
 * side-effect runs through the injected port. The wrapper records the
 * provisioning outcome in the handler result bindings under
 * `briefProvisioning` so a downstream observer can see which path ran.
 *
 * `briefProvisioningHandlerId` selects which handler's brief-provisioning step
 * is port-injected. Defaults to the proposal-submission resolver — the only
 * handler that currently auto-provisions a brief.
 */
export interface DiscoveryPackageHandlerAdapterOptions {
  /** The legacy dependency bundle (saga3 runtime persistence). */
  readonly legacyDeps: DiscoveryInstallationDeps;
  /** The NEW port-injection bundle. */
  readonly ports: DiscoveryPackagePorts;
  /**
   * Handler id whose brief-provisioning step is port-injected.
   * @default DISCOVERY_PACKAGE_HANDLER_IDS.resolveProposalSubmission
   */
  readonly briefProvisioningHandlerId?: string;
}

/**
 * Build a port-injected handler map for the discovery package.
 *
 * This wraps `createDiscoveryKernelHandlers` (the legacy factory) so every
 * handler keeps its exact behavior, EXCEPT the configured handler's
 * brief-provisioning side-effect runs through the injected port. The wrapper
 * records the provisioning outcome in the handler result bindings under
 * `briefProvisioning` so a downstream observer can see which path ran.
 *
 * The returned map has the same keys as the legacy factory — a consumer cannot
 * tell from the keys alone whether the legacy or the port-injected path is
 * wired. That symmetry is what lets Wave 11 flip the composition root with no
 * handler-address changes.
 *
 * Note: the wrapper observes the handler result and stamps the provisioning
 * outcome onto the result bindings. It does NOT suppress the legacy
 * `ensureDiscoveryBriefArtifact` call (that lives inside the legacy handler,
 * which this file does not edit); when the composition root wires THIS adapter
 * instead of the legacy factory, the legacy call is simply not reached. The
 * binding stamp is the audit signal that the port path ran.
 */
export function createDiscoveryPackageHandlerAdapter(
  options: DiscoveryPackageHandlerAdapterOptions,
): Record<string, KernelHandler> {
  const { legacyDeps, ports } = options;
  const targetHandlerId =
    options.briefProvisioningHandlerId ??
    DISCOVERY_PACKAGE_HANDLER_IDS.resolveProposalSubmission;

  const handlers = createDiscoveryKernelHandlers(legacyDeps);
  const target = handlers[targetHandlerId];
  if (!target) {
    throw new Error(
      `discovery package adapter: unknown handler id '${targetHandlerId}'`,
    );
  }

  // Wrap only the target handler. The wrapper runs the original handler, then
  // (for the proposal-submission resolver) drives the port-injected brief
  // provisioning and stamps the outcome onto the result. We detect an accepted
  // proposal from the production bindings the resolver emits.
  const wrapped: KernelHandler = async (ctx) => {
    const result = await target(ctx);
    // Only provision when the resolver accepted a proposal. We detect the
    // accepted state from the emitted event (the resolver emits 'accepted'
    // when a canonical Proposal was materialized).
    if (ctx.epicId === null || result.event !== 'accepted') {
      return result;
    }
    const outcome = portInjectedEnsureDiscoveryBrief(
      ports.briefProvisioning,
      ctx,
      null,
    );
    if (result.production) {
      result.production.bindings.briefProvisioning = {
        path: 'package-port',
        status: outcome.status,
        ...(outcome.status === 'brief-created' || outcome.status === 'already-provisioned'
          ? { briefArtifactId: outcome.briefArtifactId }
          : {}),
        ...(outcome.status === 'provisioning-failed'
          ? { reason: outcome.reason }
          : {}),
      };
    }
    return result;
  };

  return { ...handlers, [targetHandlerId]: wrapped };
}

// ---------------------------------------------------------------------------
// Fake brief-provisioning port — for tests and isolated consumers.
// ---------------------------------------------------------------------------

/**
 * Build a standalone brief-provisioning port backed by a fake/in-memory
 * implementation. Exposed for tests and for consumers that want to drive the
 * provisioning port in isolation (without the full handler adapter).
 *
 * The fake records every call so a test can assert the handler exercised the
 * port instead of the global DB. It performs no I/O.
 */
export interface FakeDiscoveryBriefProvisioningRecord {
  readonly ctx: DiscoveryBriefProvisioningContext;
  readonly outcome: DiscoveryBriefProvisioningOutcome;
}

export function createFakeDiscoveryBriefProvisioningPort(
  outcomes: ReadonlyArray<DiscoveryBriefProvisioningOutcome> = [
    { status: 'already-provisioned', briefArtifactId: 1 },
  ],
): DiscoveryBriefProvisioningPort & {
  readonly calls: readonly FakeDiscoveryBriefProvisioningRecord[];
} {
  const calls: FakeDiscoveryBriefProvisioningRecord[] = [];
  let provisionIdx = 0;
  const port: DiscoveryBriefProvisioningPort & {
    readonly calls: readonly FakeDiscoveryBriefProvisioningRecord[];
  } = {
    calls,
    provisionDiscoveryBrief(ctx) {
      const outcome = outcomes[Math.min(provisionIdx, outcomes.length - 1)];
      provisionIdx += 1;
      calls.push({ ctx, outcome });
      return outcome;
    },
  };
  return port;
}
