/**
 * SagaBoardAdapterDataBuilder — W3-A2 (spec §5).
 *
 * Isolates the saga-board-driver-specific (snake_case) vocabulary stamping
 * that the {@link LmNodeExecutor} historically inlined. The LM executor calls
 * this builder and receives two board-driver artefacts:
 *
 *   1. {@link SagaBoardLineageBag} — the reserved lineage bag stamped onto the
 *      projected task's metadata (`process_run_id`, `process_node_id`, …). This
 *      is the EXACT shape the existing saga3 adapter reads, so the projected
 *      task row is byte-identical to the pre-Wave-3 behaviour (no migration).
 *   2. {@link SagaBoardAdapterData} — the substrate payload carried inside a
 *      {@link DriverNeutralExecutionReceipt}'s `adapterData`. Board/task/
 *      WorkIntent IDs live HERE, never on the driver-neutral base fields (plan
 *      §10.14, §13.16, C061). The runtime persists and forwards `adapterData`
 *      without interpreting its keys.
 *
 * Why a separate file? The snake_case keys (`process_run_id`, `task_id`, …) are
 * driver-vocab. Keeping them behind a named builder lets the LM executor body
 * stay driver-neutral: it talks to a port (`buildLineageBag` / `buildReceipt`)
 * and the board-specific stamping is localised to this one file. Wave 5 will
 * migrate the persistence port fully; Wave 3 only changes what the executor
 * EMITS (driver-neutral receipt) and what it READS (envelope vs frame).
 *
 * This file lives under `application/node-executors/` and imports only from
 * `domain/` (pure types) and `shared/` (frozen primitives) — no new
 * dependency-direction edges (ratchet-safe). It is NOT one of the four Rule-4a
 * core files, so the module-name-literal scan does not apply here; in any case
 * this file contains no module-name literals.
 */

import type {
  DriverNeutralExecutionReceipt,
  DriverRuntimeEvent,
} from '../../domain/spi/index.js';
import type { FlowNodeKind } from '../../domain/process-module.js';
import type { RecoveryFeedback } from '../../domain/recovery.js';
import { sha256Hex } from '../../shared/canonical-json.js';

/**
 * Driver kind this builder targets. Hard-coded `'lm'` because this builder is
 * the LM executor's board adapter — a kernel/external/human executor would
 * have its own builder (or share a generic one in Wave 5). This is a
 * FlowNodeKind enum value, NOT a module-name literal.
 */
const LM_DRIVER_KIND: FlowNodeKind = 'lm';

/**
 * Reserved saga-board lineage keys stamped onto the projected task's metadata.
 * Mirrors the pre-Wave-3 `processBinding` object verbatim (snake_case
 * driver-vocab) so the saga3 persistence adapter and existing workers read the
 * exact same row. Wave 5 migrates these into a driver-neutral shape.
 */
export interface SagaBoardLineageBag {
  process_run_id: number;
  process_node_id: string;
  process_module_ref: string;
  process_input_hash: string;
  process_node_input: unknown;
  process_node_input_hash: string;
  artifact_acceptance_authority: 'worker' | 'kernel-gate';
  /** Present only when this execution is a repair attempt. */
  recovery_case_id?: number;
  recovery_attempt?: number;
  recovery_issue_ref?: string;
  recovery_issue_hash?: string;
  recovery_feedback?: RecoveryFeedback;
  /** Present when the projected task's repository was resolved. */
  project_repository_id?: number;
  /** Generic reviewer-correction budget enforced by the task substrate. */
  managed_review_budget?: number;
  /**
   * Index signature: this bag is stamped onto the projected task's
   * `metadata: Record<string, unknown>` and onto the driver-neutral receipt's
   * `adapterData` blob, both of which are opaque substrate payloads. The
   * runtime persists and forwards them without interpreting keys, so the bag
   * must be assignable to `Record<string, unknown>` (plan §10.14, §13.16).
   */
  [key: string]: unknown;
}

/**
 * Substrate payload carried inside a {@link DriverNeutralExecutionReceipt}'s
 * `adapterData`. The board/task/WorkIntent identifiers the saga3 driver needs
 * to reconcile the driver-neutral receipt with the projected task/intent rows
 * live here. The runtime persists and forwards this blob opaquely.
 */
export interface SagaBoardAdapterData {
  /** Receipt discriminator (mirrors legacy NodeExecutionReceipt.kind). */
  kind: 'task-execution';
  /** saga3 WorkIntent row id. */
  intentId: number;
  /** saga3 task row id. */
  taskId: number;
  /** Exact worker execution fence when the substrate exposes it. */
  executionId?: string;
  /** True when the receipt was synthesised from an already-concluded run. */
  replayed: boolean;
  /**
   * Reserved saga-board lineage refs (snake_case) forwarded so a
   * driver-neutral receipt can be reconciled with the projected task metadata
   * without a second DB read. These mirror {@link SagaBoardLineageBag} but are
   * namespaced under `lineage` to keep the adapter data self-describing.
   */
  lineage: SagaBoardLineageBag;
  /**
   * Index signature: this is the opaque substrate payload carried inside a
   * {@link DriverNeutralExecutionReceipt}'s `adapterData`
   * (`Readonly<Record<string, unknown>>`). The runtime persists and forwards
   * it without interpreting keys (plan §10.14, §13.16, C061).
   */
  [key: string]: unknown;
}

/** Inputs the LM executor already computes; the builder does not re-derive. */
export interface SagaBoardLineageInputs {
  processRunId: number;
  nodeId: string;
  moduleRef: string;
  runInput: unknown;
  nodeInput: unknown;
  artifactAcceptanceAuthority: 'worker' | 'kernel-gate';
  recoveryFeedback: RecoveryFeedback | null;
  /** Resolved project_repository_id, or null when unknown at build time. */
  projectRepositoryId: number | null;
  /** Null when this execution profile has no separate reviewer. */
  managedReviewBudget: number | null;
}

/**
 * Build the reserved saga-board lineage bag stamped onto the projected task's
 * metadata. Pure: same inputs → same bag (the recovery/project_repository
 * branches are deterministic conditionals).
 *
 * This is the EXTRACTED body of the pre-Wave-3 `processBinding` literal that
 * lived inline in `lm-node-executor.ts` (~:271-292). The shape is unchanged so
 * existing saga3 adapter reads and worker consumers see byte-identical
 * metadata. Wave 5 migrates the persistence port fully (spec §5).
 */
export function buildSagaBoardLineageBag(
  inputs: SagaBoardLineageInputs,
): SagaBoardLineageBag {
  // CGAD P18 — Node-Durable Identity: process_node_input is the STABLE view of
  // the node's input (the workplace context), excluding the transient recovery
  // loop input. Recovery feedback is the LOOP input and travels in its own
  // `recovery_feedback` field; it must NOT perturb `process_node_input_hash`,
  // because a repair round reuses the workplace's existing card and that card's
  // reserved metadata must compare equal across attempts. Without this split,
  // bindProjectedTaskProcessContext throws "cannot be rebound" on every repair
  // round (the recovery chainInput carries recoveryFeedback, so the raw hash
  // differs from the producer's). The stable view is the nodeInput with the
  // recoveryFeedback binding removed.
  const stableNodeInput = stripRecoveryFeedback(inputs.nodeInput);
  const bag: SagaBoardLineageBag = {
    process_run_id: inputs.processRunId,
    process_node_id: inputs.nodeId,
    process_module_ref: inputs.moduleRef,
    process_input_hash: sha256Hex(inputs.runInput),
    process_node_input: stableNodeInput,
    process_node_input_hash: sha256Hex(stableNodeInput),
    artifact_acceptance_authority: inputs.artifactAcceptanceAuthority,
  };
  if (inputs.recoveryFeedback) {
    const fb = inputs.recoveryFeedback;
    bag.recovery_case_id = fb.caseId;
    bag.recovery_attempt = fb.attempt;
    bag.recovery_issue_ref = fb.issueRef;
    bag.recovery_issue_hash = fb.issueHash;
    bag.recovery_feedback = fb;
  }
  if (inputs.projectRepositoryId !== null) {
    bag.project_repository_id = inputs.projectRepositoryId;
  }
  if (inputs.managedReviewBudget !== null) {
    bag.managed_review_budget = inputs.managedReviewBudget;
  }
  return bag;
}

/**
 * Return a shallow copy of `nodeInput` with any `bindings.recoveryFeedback`
 * removed, so the workplace's stable node-input hash excludes the transient
 * recovery loop input. Pure; non-object inputs are returned as-is.
 */
function stripRecoveryFeedback(nodeInput: unknown): unknown {
  if (!nodeInput || typeof nodeInput !== 'object' || Array.isArray(nodeInput)) {
    return nodeInput;
  }
  const input = nodeInput as { bindings?: Record<string, unknown> };
  if (!input.bindings || typeof input.bindings !== 'object') {
    return nodeInput;
  }
  if (!('recoveryFeedback' in input.bindings)) {
    return nodeInput;
  }
  const strippedBindings = { ...input.bindings };
  delete strippedBindings.recoveryFeedback;
  return { ...input, bindings: strippedBindings };
}

/** Inputs for the adapter-data receipt builder. */
export interface SagaBoardReceiptInputs {
  intentId: number;
  taskId: number;
  /** Worker execution fence, or null when the substrate did not expose one. */
  executionId: string | null;
  runtimeStatus: DriverRuntimeEvent;
  replayed: boolean;
  /** The lineage bag built by {@link buildSagaBoardLineageBag}. */
  lineage: SagaBoardLineageBag;
}

/**
 * Build the `adapterData` payload for a saga-board driver-neutral receipt.
 * Pure: same inputs → same adapter data.
 *
 * Board/task/WorkIntent IDs (intentId/taskId/executionId) live HERE, not on the
 * {@link DriverNeutralExecutionReceipt} base fields (plan §10.14, §13.16,
 * C061). The lineage bag is forwarded under a `lineage` key so the receipt is
 * self-contained: a downstream reconciler can map the driver-neutral receipt
 * back to the projected task row without a second read.
 */
export function buildSagaBoardAdapterData(
  inputs: SagaBoardReceiptInputs,
): SagaBoardAdapterData {
  const data: SagaBoardAdapterData = {
    kind: 'task-execution',
    intentId: inputs.intentId,
    taskId: inputs.taskId,
    replayed: inputs.replayed,
    lineage: inputs.lineage,
  };
  if (inputs.executionId !== null) {
    data.executionId = inputs.executionId;
  }
  return data;
}

/** Inputs for the full driver-neutral receipt builder. */
export interface SagaBoardDriverNeutralReceiptInputs extends SagaBoardReceiptInputs {
  /**
   * Durable NodeRun id. Wave 3 LM executor does NOT own the NodeRun row (the
   * GenericFlowExecutor opens/completes it), so this builder accepts a 0
   * placeholder and lets the caller — or the GenericFlowExecutor's v2
   * dual-write path — stamp the real id. This mirrors `toV2Result` in
 * `node-executor.ts`, which also emits `nodeRunId: 0` for the same reason.
   */
  nodeRunId: number;
  /** Attempt number within the node run (1-based). */
  attempt: number;
}

/**
 * Build a complete {@link DriverNeutralExecutionReceipt} for the saga-board LM
 * driver. The base fields are the physical ones the runtime switches on
 * (`schemaVersion`, `nodeRunId`, `attempt`, `runtimeEvent`, `driverKind`); all
 * board/task/WorkIntent substrate detail is in `adapterData` via
 * {@link buildSagaBoardAdapterData}.
 *
 * Pure: same inputs → same receipt.
 */
export function buildSagaBoardDriverNeutralReceipt(
  inputs: SagaBoardDriverNeutralReceiptInputs,
): DriverNeutralExecutionReceipt {
  return {
    schemaVersion: 'saga3.driver-neutral-receipt.v1',
    nodeRunId: inputs.nodeRunId,
    attempt: inputs.attempt,
    runtimeEvent: inputs.runtimeStatus,
    driverKind: LM_DRIVER_KIND,
    adapterData: buildSagaBoardAdapterData(inputs),
  };
}
