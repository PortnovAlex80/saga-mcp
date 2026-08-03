/**
 * ExecutionContextAssembler.
 *
 * Assembles an immutable, driver-neutral ExecutionContextEnvelope from
 * durable state, replacing the former mutable NodeExecutionFrame
 * reconstruction (`restoreFrame`, now RETIRED — the no-fallback contract).
 * The executor hands this assembler the EXACT predecessor `ProductRef`s the
 * next node declared it consumes, and the assembler loads each one by
 * content-address (replacing the former `listArtifactsForNodeInEpic`
 * "latest in run" lookup, now RETIRED). If a declared predecessor product is
 * missing, the assembler throws `UPSTREAM_PRODUCT_NOT_FOUND` — there is NO
 * fallback to epic-scope or "latest in run" search. Crash-resume after a
 * worker completed but before kernel verification therefore resumes from the
 * EXACT receipt + product, not a mutable reconstruction.
 *
 * Driver-neutrality: board/task/epic/WorkIntent IDs are NOT base fields of the
 * returned envelope. They live in `frozenAuthority` only when the durable
 * ProcessRun already carries them as authority snapshot (read-only
 * projection); the executor never switches on them. The forbidden-key guard
 * (`findForbiddenDriverNeutralKeys`) is applied to the assembled envelope so
 * a leak is a hard failure, not a silent drop.
 */

import type { ExecutionContextEnvelope, PackageRef, NodeRef, ProductRef } from '../domain/spi/index.js';
import { findForbiddenDriverNeutralKeys } from '../domain/spi/index.js';
import type { ProcessRunRepository } from '../persistence/process-run-repository.js';
import type { ProcessRunRecord } from '../persistence/process-run.js';
import type { NodeRunRepository } from '../persistence/node-run.js';

// ---------------------------------------------------------------------------
// Port shape consumed from ProcessProductRepository v2.
//
// `getByProductRef(ref)` is the EXACT-by-`(schemaId, ref, digest)` query that
// replaces `listArtifactsForNodeInEpic`. The returned record carries the
// durable payload the executor forwards to the next node — it is NOT
// reinterpreted here.
// ---------------------------------------------------------------------------

/**
 * Durable product record returned by ProcessProductRepository.getByProductRef.
 * Only the fields the assembler reads are named here.
 */
export interface UpstreamProductRecord {
  /** Content-addressed reference — MUST equal the queried ProductRef. */
  readonly productRef: ProductRef;
  /** The durable product body (opaque to the runtime; forwarded verbatim). */
  readonly payload: unknown;
}

/**
 * ProcessProductRepository port. Only `getByProductRef` is consumed by the
 * assembler; the full port also exposes `getByArtifactRef` and
 * `recordProduct` which the assembler does not call.
 */
export interface ProcessProductRepository {
  /**
   * EXACT query by `(schemaId, ref, digest)`. Returns null when no product
   * matches all three. There is no epic-scope / latest-in-run fallback.
   */
  getByProductRef(ref: ProductRef): UpstreamProductRecord | null;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Raised when a declared predecessor ProductRef cannot be resolved by exact
 * content-address query. A missing predecessor product is a hard stop that
 * surfaces a recovery issue, never a silent reconstruction — there is no
 * fallback to epic-scope or "latest in run" search.
 */
export const UPSTREAM_PRODUCT_NOT_FOUND = 'UPSTREAM_PRODUCT_NOT_FOUND' as const;

export class UpstreamProductNotFoundError extends Error {
  readonly code = UPSTREAM_PRODUCT_NOT_FOUND;
  constructor(
    readonly processRunId: number,
    readonly nodeId: string,
    readonly missingRef: ProductRef,
  ) {
    super(
      `${UPSTREAM_PRODUCT_NOT_FOUND}: upstream product not found for `
        + `processRun=${processRunId} node='${nodeId}' `
        + `(schemaId='${missingRef.schemaId}' ref='${missingRef.ref}' `
        + `digest='${missingRef.digest}') — no epic-scope fallback`,
    );
    this.name = 'UpstreamProductNotFoundError';
  }
}

/**
 * Raised when the ProcessRun row is missing (deleted / never started). The
 * assembler cannot construct a frozen-authority snapshot without it.
 */
export class ProcessRunNotFoundError extends Error {
  constructor(readonly processRunId: number) {
    super(`ExecutionContextAssembler: ProcessRun ${processRunId} not found`);
    this.name = 'ProcessRunNotFoundError';
  }
}

/**
 * Raised when the durable ProcessRun authority snapshot leaks a forbidden
 * driver-neutral key (board/task/epic/WorkIntent/board id) onto the envelope
 * base. Those IDs are adapter data, never contract base fields; a leak is a
 * hard failure, not a silent canonical-JSON drop.
 */
export class ForbiddenDriverNeutralKeyError extends Error {
  constructor(
    readonly processRunId: number,
    readonly nodeId: string,
    readonly forbiddenKeys: readonly string[],
  ) {
    super(
      `ExecutionContextAssembler: forbidden driver-neutral keys leaked onto `
        + `envelope for processRun=${processRunId} node='${nodeId}': `
        + `${forbiddenKeys.join(', ')}`,
    );
    this.name = 'ForbiddenDriverNeutralKeyError';
  }
}

// ---------------------------------------------------------------------------
// Dependencies bundle.
// ---------------------------------------------------------------------------

/**
 * Repositories the assembler reads. `productRepo` is the exact-by-ProductRef
 * port; the others are existing ports. `nodeRunRepo` is used to pin the
 * `nodeRunId` identity onto the envelope (the exact NodeRun row this attempt
 * targets).
 */
export interface ExecutionContextAssemblerDeps {
  productRepo: ProcessProductRepository;
  processRunRepo: ProcessRunRepository;
  nodeRunRepo: NodeRunRepository;
}

// ---------------------------------------------------------------------------
// Pin resolvers — packageRef / nodeRef from the run's installation + flow.
//
// The run may or may not carry an installation pin (`installationId`/
// `packageDigest`); the assembler reads them defensively (present → pin,
// absent → legacy placeholder) so it builds green against both shapes.
// ---------------------------------------------------------------------------

/**
 * Resolve the installed-package identity for this run. The Flow's owning
 * package name/version come from the module manifest (passed by the caller
 * via `packageIdentity`). The digest pins the exact immutable content.
 *
 * Legacy runs (no installation pin yet) get a placeholder digest of
 * `'legacy:unpinned'` so the envelope is still well-typed; the executor's
 * catalog fallback path treats that sentinel as "use catalog".
 */
export function resolvePackageRef(
  run: ProcessRunRecord,
  packageIdentity: { name: string; version: string } | null,
  installedDigest: string | null,
): PackageRef {
  const name = packageIdentity?.name ?? run.moduleRef.name;
  const version = packageIdentity?.version ?? run.moduleRef.version;
  const digest = installedDigest ?? 'legacy:unpinned';
  return { name, version, digest };
}

/**
 * Resolve the Flow-node identity this envelope targets. `nodeId` is the
 * declared Flow node id; `flowId`/`flowVersion` come from the module
 * manifest (passed by the caller) so a node id is never ambiguous across
 * module versions.
 *
 * Legacy callers without a Flow manifest may pass null; the assembler falls
 * back to the module name as the flow id and the module version as the flow
 * version.
 */
export function resolveNodeRef(
  nodeId: string,
  flowIdentity: { flowId: string; flowVersion: string } | null,
  run: ProcessRunRecord,
): NodeRef {
  return {
    nodeId,
    flowId: flowIdentity?.flowId ?? run.moduleRef.name,
    flowVersion: flowIdentity?.flowVersion ?? run.moduleRef.version,
  };
}

// ---------------------------------------------------------------------------
// frozenAuthority — durable authority snapshot from the ProcessRun.
//
// The envelope's `frozenAuthority` is the read-only authority snapshot the
// next node operates under. It is sourced from the durable ProcessRun, never
// mutated mid-run. Board/task/epic IDs may legitimately appear here AS
// PROJECTION DATA (the run was started on their behalf) — the forbidden-key
// guard below catches a leak onto the ENVELOPE BASE, not onto
// `frozenAuthority` (the guard scans both, but board ids in frozenAuthority
// are flagged with the `frozenAuthority.` prefix so the caller can tell them
// apart from a true base-key leak).
//
// Implementation: ProcessRunRecord carries `authority` (the terminal outcome
// issuer/policy string, write-once). We seed `frozenAuthority` from
// `authority` plus the run's durable identities (projectId/epicId/initiatedBy
// from the start command — projected here as authority-scope, NOT base
// fields).
// ---------------------------------------------------------------------------

function buildFrozenAuthority(run: ProcessRunRecord): Readonly<Record<string, unknown>> {
  const authority: Record<string, unknown> = {};
  if (run.authority !== null) {
    authority.outcomeAuthority = run.authority;
  }
  // projectId/epicId/initiatedBy are durable invocation context — they live
  // in frozenAuthority as adapter-scope projection data, never on the
  // envelope base. A driver-neutral settlement kernel reads them from here,
  // not from envelope top-level fields.
  authority.projectId = run.projectId;
  if (run.epicId !== null) {
    authority.epicId = run.epicId;
  }
  authority.moduleRefKey = run.moduleRefKey;
  return Object.freeze(authority);
}

// ---------------------------------------------------------------------------
// immutableRunInput — the original ProcessRun input payload.
//
// The envelope carries the ORIGINAL input the run was started with, not a
// re-derived one. The durable ProcessRunRecord persists the canonical JSON
// snapshot in `inputSnapshot`; we parse it once and forward the parsed
// value. If the snapshot is missing/corrupt we forward null (the executor's
// input contract decoder is responsible for rejecting an unknown input; the
// assembler does not interpret payload content).
// ---------------------------------------------------------------------------

function parseImmutableRunInput(run: ProcessRunRecord): unknown {
  if (typeof run.inputSnapshot !== 'string' || run.inputSnapshot.length === 0) {
    return null;
  }
  try {
    return JSON.parse(run.inputSnapshot);
  } catch {
    // Corrupt snapshot — surface as null so the contract decoder fails
    // loudly downstream rather than silently re-deriving input.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry: assembleExecutionContext.
// ---------------------------------------------------------------------------

export interface AssembleExecutionContextOptions {
  /**
   * The module's owning-package identity, used to pin `packageRef.name`/
   * `version` and `nodeRef.flowId`/`flowVersion`. May be null; the assembler
   * falls back to `run.moduleRef`.
   */
  packageIdentity?: { name: string; version: string } | null;
  /**
   * The Flow identity owning `nodeId`. May be null for legacy callers; the
   * assembler falls back to the module name/version as the flow id/version.
   */
  flowIdentity?: { flowId: string; flowVersion: string } | null;
  /**
   * The installed-package content digest. Null for legacy catalog-resolved
   * runs; the assembler emits the `'legacy:unpinned'` sentinel (the
   * executor's catalog fallback treats that as "resolve via catalog").
   */
  installedDigest?: string | null;
  /**
   * Optional recovery feedback to attach when this attempt is a repair.
   * Forwarded verbatim; not interpreted.
   */
  recoveryFeedback?: ExecutionContextEnvelope['recoveryFeedback'];
  /** Optional Lifecycle Scenario scope. */
  scenarioId?: string;
  /** Optional Lifecycle Stage scope. */
  stageId?: string;
}

/**
 * Assemble an immutable, driver-neutral ExecutionContextEnvelope from
 * durable state for the next node execution.
 *
 * Contract:
 *   1. Read the ProcessRun (frozen authority + immutable input source).
 *   2. For EACH declared `upstreamProductRefs` entry, load the product via
 *      `productRepo.getByProductRef(ref)` (EXACT by `(schemaId, ref,
 *      digest)`). If any returns null → throw UpstreamProductNotFoundError.
 *      NO epic-scope / latest-in-run fallback.
 *   3. Pin the NodeRun row for this (processRun, node, attempt) to surface
 *      `nodeRunId` on the envelope.
 *   4. Resolve packageRef / nodeRef from the run's installation + flow.
 *   5. Construct the ExecutionContextEnvelope and run the forbidden-key
 *      guard; a leak onto the base is a hard failure.
 *
 * The returned `upstreamProducts` is the caller-declared predecessor ref
 * list verbatim — the products themselves are loaded for validation +
 * forwarding but the envelope carries the refs (the durable content-address
 * pointers), not the bodies, matching the type
 * (`upstreamProducts: readonly ProductRef[]`). The loaded bodies are
 * available on the returned {@link AssembledExecutionContext} for the
 * executor to hand to the node.
 */
export async function assembleExecutionContext(
  processRunId: number,
  nodeId: string,
  attempt: number,
  upstreamProductRefs: readonly ProductRef[],
  deps: ExecutionContextAssemblerDeps,
  options: AssembleExecutionContextOptions = {},
): Promise<AssembledExecutionContext> {
  // 1. ProcessRun — the frozen-authority + immutable-input source.
  const run = deps.processRunRepo.read(processRunId);
  if (!run) {
    throw new ProcessRunNotFoundError(processRunId);
  }

  // 2. Load each declared upstream product by EXACT content-address.
  //    A missing predecessor product is a hard stop; there is no epic-scope
  //    or latest-in-run fallback. The loaded bodies are returned alongside
  //    the envelope for the executor to forward.
  const loadedProducts: UpstreamProductRecord[] = [];
  for (const ref of upstreamProductRefs) {
    const product = deps.productRepo.getByProductRef(ref);
    if (!product) {
      throw new UpstreamProductNotFoundError(processRunId, nodeId, ref);
    }
    // Defense in depth: the port contract guarantees the returned record's
    // productRef equals the queried ref. We do not re-hash here (the product
    // store already content-addressed it on write); we trust the port's
    // exact-match guarantee.
    loadedProducts.push(product);
  }

  // 3. Pin the NodeRun row to surface nodeRunId on the envelope. The exact
  //    (processRun, node, attempt) row is what crash-resume resumes from.
  //    If the row is not started yet (the executor is assembling the envelope
  //    BEFORE starting the NodeRun), nodeRunId is null on the envelope — the
  //    caller passes 0 and the executor fills it after startV2(). We surface
  //    the latest row if present so the envelope is well-formed for the
  //    common resume path.
  const latestNodeRun = deps.nodeRunRepo.readLatest(processRunId, nodeId);
  const nodeRunId = latestNodeRun && latestNodeRun.attempt === attempt
    ? latestNodeRun.id
    : 0;

  // 4. Resolve packageRef + nodeRef.
  const packageRef = resolvePackageRef(
    run,
    options.packageIdentity ?? null,
    options.installedDigest ?? null,
  );
  const nodeRef = resolveNodeRef(
    nodeId,
    options.flowIdentity ?? null,
    run,
  );

  // 5. Construct the envelope.
  const envelope: ExecutionContextEnvelope = {
    processRunId,
    nodeRunId,
    attempt,
    // executionId is the executor's fencing token; the assembler mints a
    // fresh one per assembly so two assemblies of the same (run,node,attempt)
    // are distinguishable (the executor may re-assemble after a transient
    // lease loss). The executor may override this by post-processing the
    // envelope; the assembler stays self-contained.
    executionId: mintExecutionId(processRunId, nodeId, attempt),
    packageRef,
    nodeRef,
    frozenAuthority: buildFrozenAuthority(run),
    immutableRunInput: parseImmutableRunInput(run),
    upstreamProducts: Object.freeze([...upstreamProductRefs]),
    ...(options.recoveryFeedback !== undefined
      ? { recoveryFeedback: options.recoveryFeedback }
      : {}),
    ...(options.scenarioId !== undefined ? { scenarioId: options.scenarioId } : {}),
    ...(options.stageId !== undefined ? { stageId: options.stageId } : {}),
  };

  // Forbidden-key guard. A leak onto the envelope base (or onto
  // frozenAuthority) is a hard failure — canonical JSON would silently drop
  // unknown keys, masking a contract violation.
  const forbidden = findForbiddenDriverNeutralKeys(envelope);
  // frozenAuthority is ALLOWED to carry board/task/epic ids as projection
  // data (they are durable invocation context, not contract base fields).
  // Filter those out of the failure set; only TRUE base-key leaks fail.
  const baseLeaks = forbidden.filter((k) => !k.startsWith('frozenAuthority.'));
  if (baseLeaks.length > 0) {
    throw new ForbiddenDriverNeutralKeyError(processRunId, nodeId, baseLeaks);
  }

  return { envelope, upstreamProductBodies: loadedProducts };
}

/**
 * Result of {@link assembleExecutionContext}: the immutable envelope plus the
 * loaded upstream product bodies (the executor forwards these to the node's
 * input contract decoder). The envelope itself carries only the
 * content-address ProductRefs (the durable pointers); the bodies live here
 * so the envelope stays a small, hashable, replayable value.
 */
export interface AssembledExecutionContext {
  readonly envelope: ExecutionContextEnvelope;
  /**
   * Upstream product bodies, one per declared ProductRef, in declared order.
   * Each entry's `productRef` equals the corresponding queried ref (port
   * contract). The executor forwards these to the node; the assembler does
   * not interpret their content.
   */
  readonly upstreamProductBodies: readonly UpstreamProductRecord[];
}

// ---------------------------------------------------------------------------
// executionId minting — deterministic-ish fencing token.
//
// The envelope's `executionId` is the fencing token the settlement kernel
// uses to detect stale lease holders. It must be unique per assembly
// attempt. We compose it from (processRunId, nodeId, attempt) plus a
// high-resolution timestamp so two assemblies in the same tick still differ.
// The executor owns the canonical executionId once it starts the NodeRun;
// this is the assembler's best-effort pre-start token.
// ---------------------------------------------------------------------------

// Module-level monotonic counter guarantees two assemblies in the same
// millisecond still produce distinct executionIds. A fencing token that
// collides within one tick would let a stale lease holder masquerade as the
// current one; the counter closes that window.
let _executionIdCounter = 0;

function mintExecutionId(
  processRunId: number,
  nodeId: string,
  attempt: number,
): string {
  _executionIdCounter += 1;
  return `ecx-${processRunId}-${nodeId}-${attempt}-${Date.now().toString(36)}-${_executionIdCounter.toString(36)}`;
}
