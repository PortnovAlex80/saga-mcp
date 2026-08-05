/**
 * NodeRun v2 — durable execution primitives for factory_node_runs (Wave 3 §9).
 *
 * W3-A6 owns this file. It is the SQL OWNER for factory_node_runs this wave
 * (C083: single-writer coordination). The v2 record EXTENDS the legacy
 * `NodeRunRecord` (no field removed, none narrowed) with the seven additive
 * nullable columns introduced by Wave 3 §9 of WAVE3-DURABLE-EXECUTION-SPEC.md:
 *
 *   - `inputEnvelopeHash`        — content hash of the ExecutionContextEnvelope
 *                                   the node was dispatched against (Wave 1 §7.7).
 *                                   Present ⇒ the NodeRun is a Wave-3+ row; absent
 *                                   ⇒ legacy row, restored via `restoreFrame`.
 *   - `nodeRef`                  — JSON `NodeRef` (Wave 1 §7.7.1) pinning the
 *                                   exact (nodeId, flowId, flowVersion) triple.
 *   - `packageRef`               — JSON `PackageRef` (Wave 1 §7.7.1) pinning the
 *                                   installed package snapshot the run used.
 *   - `predecessorNodeRunIds`    — JSON array of upstream NodeRun ids whose
 *                                   productions fed this node (exact predecessor
 *                                   refs, replaces the epic-scope fallback §9.11).
 *   - `definitionDigest`         — digest of the NodeProtocolDefinition (Wave 1
 *                                   W1-A4) the node ran under; detects flow drift.
 *   - `transitionCursor`         — opaque cursor the kernel writes to mark the
 *                                   exact transition this node resolved (so a
 *                                   resume can prove which edge fired, not just
 *                                   "the last completed node").
 *   - `productionEnvelope`       — JSON `NodeProductionEnvelope` (Wave 1 §7.6)
 *                                   carrying the durable, content-addressed
 *                                   production + lineage. Dual-written alongside
 *                                   the legacy flat `output_*` columns.
 *   - `completion`               — FU-A Wave 3: explicit terminal
 *                                   `ModuleCompletion` envelope the node emitted.
 *                                   Persisted so crash-resume rebuilds the
 *                                   `NodeExecutionResult.completion` and
 *                                   settlement reads the explicit certificate
 *                                   ref (no magic-bindings fallback).
 *   - `completionHash`           — WAVE 8 HIGH 4: SHA-256 over canonical JSON
 *                                   of `completion`. Verified on read
 *                                   (COMPLETION_CORRUPT / COMPLETION_HASH_MISMATCH
 *                                   throw, not silent null).
 *
 * All seven are OPTIONAL on the record (legacy rows surface them as null/empty).
 * No NOT NULL is enforced at the schema layer (Wave 11 hardens that). No legacy
 * column is removed. The port methods `startV2` / `completeV2` DUAL-WRITE: they
 * populate BOTH the legacy fields (so pre-Wave-3 readers keep working) AND the
 * new v2 columns (so Wave-3 readers can resume by exact cursor). The legacy
 * `start` / `complete` / `fail` methods are unchanged.
 *
 * `readByExactCursor(processRunId, nodeId, attempt)` is the resume query that
 * replaces `readLastCompleted` + mutable frame reconstruction (§9.11): it
 * returns the single NodeRun for an exact (run, node, attempt) triple, which
 * is what the ExecutionContextAssembler (W3-A5) loads to assemble the next
 * node's envelope from exact predecessor products.
 *
 * Plan ref: §7.6, §7.7, §9, §13.7, §13.20.
 * Spec ref: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md §9.
 */

import type { RecoveryIssue } from '../domain/recovery.js';
import type { ModuleCompletion } from '../domain/spi/module-completion.js';
import type {
  NodeProductionEnvelope,
  NodeRef,
  PackageRef,
} from '../domain/spi/index.js';
import type {
  NodeRunRecord,
  NodeRunStatus,
} from './node-run.js';

/**
 * NodeRun v2 record — extends the legacy NodeRunRecord with the seven Wave 3
 * additive fields. Every new field is optional so legacy rows (and any caller
 * that still constructs the legacy shape) compile and round-trip unchanged.
 *
 * The `inputEnvelopeHash` field is the canonical "is this a Wave-3 row?"
 * discriminant (WAVE3-DURABLE-EXECUTION-SPEC §3): a non-null value means the
 * row was written by `startV2`/`completeV2` and may be resumed by exact cursor;
 * null means a legacy row that must be restored via the mutable `restoreFrame`
 * fallback (kept until Wave 5/9 migrate consumers).
 */
export interface NodeRunRecordV2 extends NodeRunRecord {
  /**
   * SHA-256 over the canonical JSON of the ExecutionContextEnvelope the node
   * was dispatched against. Wave-3 marker: non-null ⇒ v2 row.
   */
  inputEnvelopeHash: string | null;
  /** JSON-pinned NodeRef (nodeId + flowId + flowVersion). Null on legacy rows. */
  nodeRef: NodeRef | null;
  /** JSON-pinned PackageRef (name + version + digest). Null on legacy rows. */
  packageRef: PackageRef | null;
  /**
   * Exact predecessor NodeRun ids whose productions fed this node. Empty array
   * on v2 rows with no upstream; null on legacy rows (unknown predecessor set).
   */
  predecessorNodeRunIds: number[] | null;
  /** Digest of the NodeProtocolDefinition the node ran under. Null on legacy rows. */
  definitionDigest: string | null;
  /** Opaque transition cursor the kernel stamps on resolve. Null on legacy rows. */
  transitionCursor: string | null;
  /** Durable NodeProductionEnvelope with lineage. Null on legacy rows. */
  productionEnvelope: NodeProductionEnvelope | null;
  /**
   * FU-A Wave 3 (W3-A1 spec §3/§4): explicit terminal envelope the node
   * emitted. Persisted so crash-resume can rebuild NodeExecutionResult.
   * completion and settlement can read the explicit certificate ref instead
   * of falling back to magic bindings (which would silently lose the
   * certificate on restart). Null on legacy rows / non-terminal nodes.
   */
  completion: ModuleCompletion | null;
  /**
   * WAVE 8 HIGH 4 — SHA-256 over the canonical JSON of `completion`. Persisted
   * alongside the JSON so reads can VERIFY integrity: a malformed
   * `completion` throws COMPLETION_CORRUPT; a hash mismatch throws
   * COMPLETION_HASH_MISMATCH. Null when `completion` is null (legacy row or
   * non-terminal node). Pre-Wave-8 rows that carry `completion` without this
   * column are trusted by the migration contract (the read surfaces the parsed
   * value without verifying).
   */
  completionHash: string | null;
}

/**
 * Input for `startV2`: legacy start fields + the Wave-3 envelope metadata.
 *
 * The legacy fields (`processRunId`, `nodeId`, `nodeKind`) are required; the v2
 * fields are optional (callers that have not yet wired envelope assembly may
 * omit them and the row will be written with the v2 columns NULL — still a
 * "v2" row by virtue of being inserted through `startV2`, but without the
 * envelope hash marker). The recommended path (post W3-A1/A5) always supplies
 * `inputEnvelopeHash`, `nodeRef`, `packageRef`, `predecessorNodeRunIds`, and
 * `definitionDigest`.
 */
export interface StartNodeRunV2Input {
  processRunId: number;
  nodeId: string;
  nodeKind: string;
  /** Wave-3 envelope hash. Strongly recommended; omitted ⇒ v2 row without marker. */
  inputEnvelopeHash?: string | null;
  nodeRef?: NodeRef | null;
  packageRef?: PackageRef | null;
  predecessorNodeRunIds?: number[] | null;
  definitionDigest?: string | null;
  transitionCursor?: string | null;
}

/**
 * Input for `completeV2`: legacy complete fields + the Wave-3 production envelope.
 *
 * Dual-write contract: the legacy `outputRef`/`outputSchema`/`outputHash`/
 * `outputBindings` fields are populated FROM the envelope when the caller does
 * not pass them explicitly (the envelope is the canonical source post-Wave-3),
 * but the caller MAY override them (e.g. during migration when the envelope is
 * not yet populated). The kernel's settlement (W3-A1) is the only caller that
 * should pass `productionEnvelope`; everyone else continues to call `complete`.
 */
export interface CompleteNodeRunV2Input {
  id: number;
  event: string;
  outputRef: string | null;
  outputSchema?: string | null;
  outputHash: string | null;
  outputBindings?: Record<string, unknown> | null;
  executionReceipt?: Record<string, unknown> | null;
  acceptanceReceipt?: Record<string, unknown> | null;
  recoveryIssue?: RecoveryIssue | null;
  /** Wave-3 production envelope (canonical). When present, dual-written. */
  productionEnvelope?: NodeProductionEnvelope | null;
  /** Wave-3 transition cursor stamped on resolve. */
  transitionCursor?: string | null;
  /**
   * FU-A Wave 3: explicit terminal envelope. When present, persisted to the
   * `completion` column so crash-resume rebuilds NodeExecutionResult.completion
   * and settlement reads the explicit certificate ref (no magic bindings).
   */
  completion?: ModuleCompletion | null;
}

/**
 * NodeRun v2 repository port — ADDITIVE over `NodeRunRepository`.
 *
 * Implementations MUST also implement the legacy `NodeRunRepository` interface
 * (the v2 methods are additional, not a replacement). The legacy `start` /
 * `complete` / `fail` / `readLatest` / `readLastCompleted` / `list` methods
 * remain the primary surface for pre-Wave-3 callers; `startV2` / `completeV2` /
 * `readByExactCursor` are the Wave-3 surface.
 *
 * `readByExactCursor(processRunId, nodeId, attempt)` is the resume primitive
 * (§9.11): it returns the single NodeRun for an exact (run, node, attempt)
 * triple, or null if no such row exists. This replaces the
 * `readLastCompleted(processRunId)` + mutable-frame reconstruction pattern,
 * which could silently pick up the wrong attempt or the wrong node.
 */
export interface NodeRunRepositoryV2 {
  /**
   * Insert a running NodeRun v2 row. Writes the legacy columns AND the v2
   * columns (input_envelope_hash, node_ref, package_ref,
   * predecessor_node_run_ids, definition_digest, transition_cursor).
   */
  startV2(input: StartNodeRunV2Input): NodeRunRecordV2;

  /**
   * Mark a NodeRun v2 row completed. Dual-writes the legacy output_* columns
   * AND the v2 production_envelope + transition_cursor.
   */
  completeV2(input: CompleteNodeRunV2Input): NodeRunRecordV2;

  /**
   * Read the single NodeRun (v2 shape) for an exact (processRunId, nodeId,
   * attempt) triple. Returns null if no such row exists. The resume primitive
   * that replaces `readLastCompleted` + frame reconstruction (§9.11).
   */
  readByExactCursor(
    processRunId: number,
    nodeId: string,
    attempt: number,
  ): NodeRunRecordV2 | null;

  /**
   * Read the most recent NodeRun (v2 shape) for a (processRunId, nodeId) pair,
   * regardless of status. v2-shaped analogue of the legacy `readLatest`.
   */
  readLatestV2(processRunId: number, nodeId: string): NodeRunRecordV2 | null;

  /**
   * Read the most recent COMPLETED NodeRun (v2 shape) anywhere in the run.
   * v2-shaped analogue of the legacy `readLastCompleted`. Used as a fallback
   * resume point when the caller does not yet know the exact cursor (the
   * exact-cursor path via `readByExactCursor` is preferred).
   */
  readLastCompletedV2(processRunId: number): NodeRunRecordV2 | null;

  /**
   * List all NodeRuns (v2 shape) for a process run, ordered by id ASC.
   */
  listV2(processRunId: number): readonly NodeRunRecordV2[];
}

/**
 * Status type re-export for implementers that import from this module.
 * Identical to `NodeRunStatus` in node-run.ts; re-exported to keep
 * v2-only consumers from needing a second import.
 */
export type { NodeRunStatus };
