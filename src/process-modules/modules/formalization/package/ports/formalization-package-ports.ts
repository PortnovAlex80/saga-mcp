/**
 * W8-A6 — Formalization package-local ports.
 *
 * Plan §0.11.7: "W8-A6 owns Formalization ports and handler adapters that
 * remove global database and infrastructure access."
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Frozen input: `5bf74bf` (Wave 7 checkpoint).
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The legacy formalization handlers (in `../../formalization-installation.ts`)
 * reach for the GLOBAL database handle via `getDb()` from `src/db.ts`. That is
 * a Rule 2 dependency-direction violation (plan §3.7: a module never imports
 * db.ts / Runtime persistence adapters / infrastructure). It is currently
 * allowlisted against "Phase 4/5 moves persistence behind module-local ports"
 * (see `tests/architecture/dependency-direction.test.mjs`).
 *
 * Wave 8 DEFINES these module-local ports so the handlers can be driven through
 * INJECTED capabilities instead of global lookups. The exit gate (§0.11.11)
 * requires: "Formalization runs completely through pinned package resources and
 * standard interfaces with no fallback context, global resource lookup, or
 * direct infrastructure dependency." A handler that calls `getDb()` is a direct
 * infrastructure dependency — this file is what removes it.
 *
 * Wave 8 only DEFINES the ports + handler adapter; the legacy path is NOT
 * migrated here (plan §3 anti-scope: "Additive: legacy formalization path
 * preserved alongside"). The legacy `formalization-installation.ts` keeps its
 * `getDb()` call and its allowlist entry. A new, port-injected handler surface
 * (`FormalizationPackageHandlerAdapter`, see `./handler-adapter.ts`) wraps the
 * existing handlers behind these ports. Wave 11 cutover will switch the
 * composition root to the port-injected path and the legacy allowlist entry is
 * removed then.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file lives in `modules/formalization/package/ports/` — the package-local
 * ports subtree recommended by plan §5.4.8 (`modules/<module-name>/ports`). It
 * imports ONLY:
 *   - its own module's schema/contract declarations (`../../formalization-*.ts`)
 *   - the canonical-hash shared util
 *
 * It deliberately does NOT import:
 *   - `src/db.ts` (the global handle it replaces)
 *   - `better-sqlite3` (the persistence substrate)
 *   - `persistence/sqlite-*` adapters
 *   - `infrastructure/`
 *
 * Concrete SQLite-backed implementations live in
 * `./sqlite-formalization-package-adapters.ts` (Rule 2 violation, allowlisted
 * like the existing `sqlite-formalization-kernel.ts` sibling). Tests inject
 * fakes of these ports — no DB needed.
 */

import type { FormalizationCanonicalGraphPort } from '../../formalization-kernel-ports.js';

// ---------------------------------------------------------------------------
// Brief provisioning port — replaces the `getDb()` brief auto-provisioning.
// ---------------------------------------------------------------------------

/**
 * Read-only view of an accepted root ancestor artifact for one PRD. Mirrors
 * exactly what `ensureBriefRootTrace` inspects via raw SQL: the existing
 * `derived_from` targets of the PRD, their canonical rows, and whether one of
 * them is an accepted non-product-type ancestor (brief/decision/discovery-doc).
 *
 * This is the READ the legacy handler does BEFORE deciding to auto-provision.
 */
export interface FormalizationPrdRootRead {
  /** Ids of artifacts the PRD already traces to via `derived_from` (any type). */
  readonly derivedFromTargetIds: readonly number[];
  /**
   * Among `derivedFromTargetIds`, the ones whose canonical row exists, is
   * accepted+clean, and is NOT itself a product type (PRD/FR/NFR/RULE/UC/AC/SRS).
   * When non-empty, the PRD already has a valid root and provisioning is a
   * no-op.
   */
  readonly acceptedRootArtifactIds: readonly number[];
}

/**
 * What the provisioning port must know to provision a root trace. Mirrors the
 * `KernelHandlerContext` fields `ensureBriefRootTrace` actually consumes.
 */
export interface FormalizationBriefProvisioningContext {
  readonly projectId: number;
  readonly epicId: number;
  readonly processRunId: number;
  /** The PRD artifact id that needs a root ancestor trace. */
  readonly prdArtifactId: number;
}

/**
 * Result of a provisioning attempt.
 *
 *   - `'already-rooted'` — the PRD already has an accepted non-product
 *     ancestor; nothing was written.
 *   - `'root-attached'` — a root trace was created (either to a pre-existing
 *     brief, or to a freshly auto-provisioned one). `briefArtifactId` is the
 *     root ancestor the trace now points at.
 *   - `'root-creation-failed'` — the port could not provision (e.g. the
 *     substrate rejected the insert). `reason` explains why.
 */
export type FormalizationBriefProvisioningOutcome =
  | { readonly status: 'already-rooted'; readonly rootArtifactId: number }
  | {
      readonly status: 'root-attached';
      readonly briefArtifactId: number;
      readonly newlyCreated: boolean;
    }
  | { readonly status: 'root-creation-failed'; readonly reason: string };

/**
 * PORT — replaces the `getDb()` call in `ensureBriefRootTrace`.
 *
 * The legacy handler reads the live DB to (a) check whether the PRD already has
 * a root ancestor trace, and (b) if not, create a synthetic brief artifact +
 * link it. That is two concerns — a READ and a WRITE — both currently done
 * through the global handle. This port lifts both behind a module-local
 * capability the composition root injects.
 *
 * The READ path is split out (`readPrdRoot`) so a handler can decide whether to
 * provision without trusting the port to do the right thing implicitly. The
 * WRITE path (`provisionBriefRoot`) is idempotent: provisioning the same context
 * twice must attach at most one root trace (mirrors the legacy `INSERT OR
 * IGNORE` on the trace and the `SELECT … WHERE type='brief'` pre-check).
 */
export interface FormalizationBriefProvisioningPort {
  /**
   * Read the current root-ancestor state for one PRD. Pure read; no mutation.
   * Returns `{ derivedFromTargetIds: [], acceptedRootArtifactIds: [] }` when the
   * PRD has no `derived_from` traces at all.
   */
  readPrdRoot(prdArtifactId: number): FormalizationPrdRootRead;

  /**
   * Ensure the PRD has a root ancestor trace. Idempotent. When the PRD already
   * has an accepted non-product ancestor (per `readPrdRoot`), this is a no-op
   * returning `'already-rooted'`. Otherwise it provisions a brief (reusing a
   * pre-existing accepted brief in the epic when one exists, else creating a
   * synthetic one) and attaches the `derived_from` trace.
   */
  provisionBriefRoot(
    ctx: FormalizationBriefProvisioningContext,
  ): FormalizationBriefProvisioningOutcome;
}

// ---------------------------------------------------------------------------
// Managed-production port — module-local alias of the shared ledger contract.
// ---------------------------------------------------------------------------

/**
 * The query shape a formalization handler uses to read managed productions for
 * one (process run, module, node, intent, task, execution). This is a
 * module-local re-declaration of the shared `ManagedExecutionProductQuery` so
 * the package ports file does not import `persistence/` directly. The SQLite
 * adapter in `sqlite-formalization-package-adapters.ts` bridges this to the
 * shared ledger type (byte-for-byte compatible).
 */
export interface FormalizationManagedProductionQuery {
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly intentId: number;
  readonly taskId: number;
  readonly executionId: string;
}

/** A managed artifact write recorded by the production ledger. */
export interface FormalizationManagedArtifactWrite {
  readonly ledgerId: number;
  readonly artifactId: number;
  readonly artifactType: string;
  readonly artifactStatus: string;
  readonly contentHash: string;
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly intentId: number;
  readonly taskId: number;
  readonly executionId: string;
}

/** A managed trace write recorded by the production ledger. */
export interface FormalizationManagedTraceWrite {
  readonly ledgerId: number;
  readonly traceId: number;
  readonly sourceId: number;
  readonly targetType: 'artifact' | 'task';
  readonly targetId: number;
  readonly linkType: string;
  readonly traceHash: string;
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly intentId: number;
  readonly taskId: number;
  readonly executionId: string;
}

/**
 * PORT — module-local view of the managed-production ledger.
 *
 * The formalization handlers read the managed-production ledger to recover the
 * exact artifacts/traces a worker execution produced (the what-really-happened
 * truth axis). The shared `ManagedProductionLedger` port lives in
 * `persistence/sqlite-managed-production-ledger.ts` and is imported today by
 * `formalization-kernel-ports.ts` (a Rule 2 violation, allowlisted). This
 * module-local port lets a handler depend on a formalization-owned capability
 * instead, with the SQLite adapter bridging to the shared ledger.
 *
 * The method set mirrors what `formalization-installation.ts`
 * `readExecutionWrites` calls on the ledger. Per CGAD P18, product resolvers
 * read by DURABLE node-scope (listArtifactsForNodeInProcessRun /
 * listTracesForNodeInProcessRun); the execution- and task-scoped variants are
 * retained for diagnostics and explicit single-fence views, but are NOT the
 * authoritative channel — filtering by transient task/execution would blind a
 * gate to artifacts produced in an earlier fence of the same node.
 */
export interface FormalizationManagedProductionPort {
  listArtifactsForExecution(
    query: FormalizationManagedProductionQuery,
  ): readonly FormalizationManagedArtifactWrite[];

  listTracesForExecution(
    query: FormalizationManagedProductionQuery,
  ): readonly FormalizationManagedTraceWrite[];

  listArtifactsForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly FormalizationManagedArtifactWrite[];

  listTracesForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly FormalizationManagedTraceWrite[];

  /**
   * Durable node-scope read — the AUTHORITATIVE channel for product resolvers.
   * Per CGAD P18 (Artifact Durability Invariant), a managed artifact/trace is a
   * durable aggregate whose identity survives recovery cycles; gates read by
   * processRunId + moduleRef + nodeId, never by transient task/execution. The
   * task-scoped reads above remain available only where a caller explicitly
   * needs a single task's view (e.g. diagnostics); product resolvers use these.
   */
  listArtifactsForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly FormalizationManagedArtifactWrite[];

  listTracesForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly FormalizationManagedTraceWrite[];
}

// ---------------------------------------------------------------------------
// Aggregate port bundle — what a port-injected handler depends on.
// ---------------------------------------------------------------------------

/**
 * The full set of capabilities a port-injected formalization kernel handler
 * needs. This is the injection surface: the composition root builds one of
 * these (backed by SQLite in production, fakes in tests) and hands it to the
 * handler adapter. No handler built against this bundle ever calls `getDb()`.
 *
 * `graph` is the existing read-only artifact-graph port (already dependency-
 * clean — it reads artifacts/traces by id through a port, not the global DB).
 * Re-exported here so the package ports file is the single import a new
 * handler needs.
 */
export interface FormalizationPackagePorts {
  /** Read accepted artifacts + baseline + traces for one episode. */
  readonly graph: FormalizationCanonicalGraphPort;
  /** Read managed productions (the worker-execution truth axis). */
  readonly managedProduction: FormalizationManagedProductionPort;
  /** Provision PRD root-ancestor traces without touching the global DB. */
  readonly briefProvisioning: FormalizationBriefProvisioningPort;
}

/**
 * Re-export the canonical snapshot types so a handler that imports only this
 * package-ports file has everything it needs. These are type-only re-exports —
 * no runtime coupling to the legacy module's implementation, only to its
 * (already dependency-clean) port interfaces.
 */
export type {
  FormalizationArtifactSnapshot,
  FormalizationCanonicalGraphPort,
  FormalizationTraceSnapshot,
} from '../../formalization-kernel-ports.js';
