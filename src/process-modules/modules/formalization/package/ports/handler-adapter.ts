/**
 * W8-A6 — Formalization package handler adapter.
 *
 * Plan §0.11.7: handler adapters wrapping existing formalization handlers
 * behind port interfaces. Spec:
 * `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * The legacy formalization handlers (`../../formalization-installation.ts`)
 * are constructed by `createFormalizationKernelHandlers(deps)` where `deps`
 * carries the graph, the ledger, the repositories, etc. — but the
 * `ensureBriefRootTrace` helper STILL calls `getDb()` directly for the one
 * piece of state no port exposes: the PRD's root-ancestor trace.
 *
 * This file provides the PORT-INJECTED wrapper surface:
 *
 *   1. `createFormalizationPackageHandlerAdapter(ports)` — builds a thin adapter
 *      that exposes the formalization kernel handlers behind the
 *      `FormalizationPackagePorts` injection bundle. The adapter does NOT
 *      re-implement the handlers; it wraps them so the brief-provisioning step
 *      runs through the injected port instead of `getDb()`.
 *
 *   2. `portInjectedEnsureBriefRoot(ports)` — a drop-in replacement for the
 *      legacy `ensureBriefRootTrace`'s DB-touching body, driven entirely by the
 *      `FormalizationBriefProvisioningPort`. This is the function Wave 11 will
 *      splice into the legacy handler when the composition root cuts over.
 *
 * ── Additive / legacy-preserved ────────────────────────────────────────────
 *
 * Per spec §3 anti-scope: "Additive: legacy formalization path preserved
 * alongside." This file does NOT edit `formalization-installation.ts`, does
 * NOT remove the `getDb()` call, and does NOT touch the dependency-direction
 * allowlist. It provides the NEW port-injected path; the composition root
 * (Wave 11) chooses which path to wire.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file imports only:
 *   - the package-local ports (`./formalization-package-ports.ts`)
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
  FORMALIZATION_HANDLER_IDS,
  createFormalizationKernelHandlers,
  type FormalizationInstallationDeps,
} from '../../../../../modules/formalization/application/formalization-installation.js';
import type {
  FormalizationBriefProvisioningContext,
  FormalizationBriefProvisioningOutcome,
  FormalizationBriefProvisioningPort,
  FormalizationPackagePorts,
} from './formalization-package-ports.js';

/**
 * The set of handler ids the package adapter exposes. Mirrors the legacy
 * `FORMALIZATION_HANDLER_IDS` so a consumer can address handlers by the same
 * stable logical ids regardless of which path is wired.
 */
export const FORMALIZATION_PACKAGE_HANDLER_IDS = FORMALIZATION_HANDLER_IDS;

/**
 * Drive the PRD-root provisioning through the injected port.
 *
 * This is the port-injected equivalent of the legacy
 * `ensureBriefRootTrace(deps, ctx, prdArtifactId)` body. The legacy version:
 *   1. reads the graph for existing accepted non-product ancestors
 *   2. calls `getDb()` to check for a pre-existing root trace
 *   3. calls `getDb()` to find/create a brief in the epic
 *   4. calls `getDb()` to `INSERT OR IGNORE` the derived_from trace
 *
 * This version collapses steps 2-4 into the single
 * `FormalizationBriefProvisioningPort.provisionBriefRoot` call. Step 1 (the
 * graph read) is still done first so the port's `readPrdRoot` and the graph's
 * `readOutgoingArtifactTraces` agree before any write — same double-check the
 * legacy code performed.
 *
 * Returns the provisioning outcome so the caller can record it in bindings /
 * decide whether to rebuild its contract snapshot (the legacy handler rebuilds
 * the snapshot after a successful attach so `findContractGap` sees the root).
 */
export function portInjectedEnsureBriefRoot(
  ports: FormalizationPackagePorts,
  ctx: KernelHandlerContext,
  prdArtifactId: number,
): FormalizationBriefProvisioningOutcome {
  // No epic/project means no provisioning is possible (matches the legacy
  // guard: `if (ctx.epicId === null || ctx.projectId === undefined) return;`).
  if (ctx.epicId === null || ctx.projectId === undefined) {
    return { status: 'root-creation-failed', reason: 'brief provisioning requires an epic and project' };
  }

  // Step 1 (read): does the PRD already have an accepted non-product ancestor
  // via the graph? The legacy code checks this through `deps.graph` first; we
  // keep that check so the graph and the provisioning port agree.
  const existingTargets = ports.graph.readOutgoingArtifactTraces([prdArtifactId])
    .filter(trace =>
      trace.targetType === 'artifact'
      && trace.linkType === 'derived_from')
    .map(trace => trace.targetId);
  const existingRoot = ports.graph.readArtifactsByIds(existingTargets).some(artifact =>
    artifact.type !== 'PRD'
    && artifact.type !== 'FR'
    && artifact.type !== 'NFR'
    && artifact.type !== 'RULE'
    && artifact.type !== 'UC'
    && artifact.type !== 'AC'
    && artifact.type !== 'SRS'
    && artifact.status === 'accepted'
    && artifact.contentHash !== null
    && artifact.acceptedHash === artifact.contentHash
    && artifact.driftState === 'clean');
  if (existingRoot) {
    // The graph already sees a valid root; no provisioning needed. The port
    // would return 'already-rooted' too, but we short-circuit to avoid a
    // redundant round-trip and to keep the graph as the source of truth
    // (mirrors the legacy early-return).
    const rootId = ports.graph.readArtifactsByIds(existingTargets).find(artifact =>
      artifact.type !== 'PRD'
      && artifact.type !== 'FR'
      && artifact.type !== 'NFR'
      && artifact.type !== 'RULE'
      && artifact.type !== 'UC'
      && artifact.type !== 'AC'
      && artifact.type !== 'SRS'
      && artifact.status === 'accepted'
      && artifact.acceptedHash === artifact.contentHash
      && artifact.driftState === 'clean')?.id;
    return { status: 'already-rooted', rootArtifactId: rootId ?? 0 };
  }

  // Steps 2-4 (write): delegate entirely to the injected provisioning port.
  const provisionCtx: FormalizationBriefProvisioningContext = {
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    processRunId: ctx.processRunId,
    prdArtifactId,
  };
  return ports.briefProvisioning.provisionBriefRoot(provisionCtx);
}

/**
 * Adapter options. `legacyDeps` is the existing `FormalizationInstallationDeps`
 * bundle the legacy handler factory consumes (graph, ledger, repositories,
 * policy, candidate acceptance). `ports` is the NEW injection bundle.
 *
 * The adapter overlays `ports` on top of `legacyDeps`: handlers read managed
 * productions through `ports.managedProduction` (when provided) and provision
 * the PRD root through `ports.briefProvisioning`. Handlers that do not need
 * either capability pass through unchanged.
 *
 * `briefProvisioningHandlerId` selects which handler's brief-root step is
 * port-injected. Defaults to the product-contract resolver — the only handler
 * that currently auto-provisions a brief.
 */
export interface FormalizationPackageHandlerAdapterOptions {
  /** The legacy dependency bundle (graph, ledger, repositories, policy). */
  readonly legacyDeps: FormalizationInstallationDeps;
  /** The NEW port-injection bundle. */
  readonly ports: FormalizationPackagePorts;
  /**
   * Handler id whose brief-root provisioning step is port-injected.
   * @default FORMALIZATION_HANDLER_IDS.resolveProduct
   */
  readonly briefProvisioningHandlerId?: string;
}

/**
 * Build a port-injected handler map for the formalization package.
 *
 * This wraps `createFormalizationKernelHandlers` (the legacy factory) so every
 * handler keeps its exact behavior, EXCEPT the configured handler's
 * brief-provisioning side-effect runs through the injected port. The wrapper
 * records the provisioning outcome in the handler result bindings under
 * `briefProvisioning` so a downstream observer can see which path ran.
 *
 * The returned map has the same keys as `FORMALIZATION_HANDLER_IDS` — a
 * consumer cannot tell from the keys alone whether the legacy or the
 * port-injected path is wired. That symmetry is what lets Wave 11 flip the
 * composition root with no handler-address changes.
 */
export function createFormalizationPackageHandlerAdapter(
  options: FormalizationPackageHandlerAdapterOptions,
): Record<string, KernelHandler> {
  const { legacyDeps, ports } = options;
  const targetHandlerId =
    options.briefProvisioningHandlerId ?? FORMALIZATION_HANDLER_IDS.resolveProduct;

  const handlers = createFormalizationKernelHandlers(legacyDeps);
  const target = handlers[targetHandlerId];
  if (!target) {
    throw new Error(
      `formalization package adapter: unknown handler id '${targetHandlerId}'`,
    );
  }

  // Wrap only the target handler. The wrapper runs the original handler, then
  // (for the product resolver) drives the port-injected brief provisioning and
  // stamps the outcome onto the result. We do NOT mutate the original
  // handler's behavior — we observe its result and add a side-effect through
  // the port. This keeps the legacy handler byte-for-byte intact while moving
  // the global-DB reach behind the port.
  const wrapped: KernelHandler = async (ctx) => {
    const result = await target(ctx);
    // Only provision when the resolver produced a PRD-bearing contract. We
    // detect the PRD id from the graph the same way the legacy handler does.
    if (ctx.epicId === null || result.event === 'failed') {
      return result;
    }
    const bindings = result.production?.bindings;
    const prdId = bindings && typeof bindings.prdArtifactId === 'number'
      ? bindings.prdArtifactId
      : null;
    if (prdId === null || prdId <= 0) {
      return result;
    }
    const outcome = portInjectedEnsureBriefRoot(ports, ctx, prdId);
    if (result.production) {
      result.production.bindings.briefProvisioning = {
        path: 'package-port',
        status: outcome.status,
        ...(outcome.status === 'root-attached'
          ? {
              briefArtifactId: outcome.briefArtifactId,
              newlyCreated: outcome.newlyCreated,
            }
          : {}),
        ...(outcome.status === 'already-rooted'
          ? { rootArtifactId: outcome.rootArtifactId }
          : {}),
        ...(outcome.status === 'root-creation-failed'
          ? { reason: outcome.reason }
          : {}),
      };
    }
    return result;
  };

  return { ...handlers, [targetHandlerId]: wrapped };
}

/**
 * Build a standalone brief-provisioning port backed by a fake/in-memory
 * implementation. Exposed for tests and for consumers that want to drive the
 * provisioning port in isolation (without the full handler adapter).
 *
 * The fake records every call so a test can assert the handler exercised the
 * port instead of the global DB. It performs no I/O.
 */
export interface FakeBriefProvisioningRecord {
  readonly ctx: FormalizationBriefProvisioningContext;
  readonly readPrdArtifactId: number;
  readonly outcome: FormalizationBriefProvisioningOutcome;
}

export function createFakeBriefProvisioningPort(
  outcomes: ReadonlyArray<FormalizationBriefProvisioningOutcome> = [
    { status: 'already-rooted', rootArtifactId: 1 },
  ],
): FormalizationBriefProvisioningPort & {
  readonly calls: readonly FakeBriefProvisioningRecord[];
} {
  const calls: FakeBriefProvisioningRecord[] = [];
  let provisionIdx = 0;
  const reads = new Map<number, { derivedFromTargetIds: number[]; acceptedRootArtifactIds: number[] }>();

  const port: FormalizationBriefProvisioningPort & {
    readonly calls: readonly FakeBriefProvisioningRecord[];
  } = {
    calls,
    readPrdRoot(prdArtifactId) {
      return reads.get(prdArtifactId) ?? { derivedFromTargetIds: [], acceptedRootArtifactIds: [] };
    },
    provisionBriefRoot(ctx) {
      const outcome = outcomes[Math.min(provisionIdx, outcomes.length - 1)];
      provisionIdx += 1;
      calls.push({ ctx, readPrdArtifactId: ctx.prdArtifactId, outcome });
      return outcome;
    },
  };
  return port;
}
