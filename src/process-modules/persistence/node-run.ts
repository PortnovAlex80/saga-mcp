/**
 * NodeRun — persistence for one flow-node execution within a ProcessRun.
 *
 * GenericFlowExecutor writes a NodeRun row each time it dispatches a flow
 * node. This is the restart/recovery checkpoint: if the runtime crashes
 * mid-flow, the next start can read the last completed node and resume from
 * the next transition (instead of re-running the whole flow).
 *
 * Schema is module-agnostic: it carries node id, kind, status, emitted event,
 * output ref/hash (opaque — the runtime does not interpret node output
 * content), and attempt counter. Node output BODIES live in module-specific
 * stores (discovery proposals, formalization artifacts, …) — NodeRun only
 * records where to find them.
 */

import type { RecoveryIssue } from '../domain/recovery.js';

export type NodeRunStatus = 'running' | 'completed' | 'failed';

export interface NodeRunRecord {
  id: number;
  processRunId: number;
  /** The flow node id from ProcessModuleDefinition.flow.nodes[].id. */
  nodeId: string;
  /** The node kind: 'lm' | 'kernel' | 'human' | 'external' | 'composite'. */
  nodeKind: string;
  /** 1-based attempt counter for this (process_run, node) pair. */
  attempt: number;
  status: NodeRunStatus;
  /** Event emitted by the node — drives transition selection. */
  event: string | null;
  /** Reference to the node's output artifact (opaque to the runtime). */
  outputRef: string | null;
  outputSchema: string | null;
  outputHash: string | null;
  /**
   * Д8: durable NodeProduction bindings (JSON). On restart the walker restores
   * chainInput = { bindings: <output_bindings> } from the last completed
   * NodeRun so the next node sees the exact lineage the previous run produced
   * (proposalId, controlIntentId, preProjectedTaskId, certificatePayload, …).
   * Without this, restart re-initialises chainInput from the module input and
   * the next node loses all upstream context.
   */
  outputBindings: Record<string, unknown> | null;
  /**
   * Physical execution evidence, separate from the module's domain production.
   * A resolver can resume after a crash between worker completion and product
   * materialization without pretending the task itself is the product.
   */
  executionReceipt: Record<string, unknown> | null;
  /** Immutable issue emitted by this completed node, if it entered recovery. */
  recoveryIssue: RecoveryIssue | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StartNodeRunInput {
  processRunId: number;
  nodeId: string;
  nodeKind: string;
}

export interface CompleteNodeRunInput {
  id: number;
  event: string;
  outputRef: string | null;
  outputSchema?: string | null;
  outputHash: string | null;
  /** Д8: durable bindings to persist for restart recovery. */
  outputBindings?: Record<string, unknown> | null;
  executionReceipt?: Record<string, unknown> | null;
  recoveryIssue?: RecoveryIssue | null;
}

export interface FailNodeRunInput {
  id: number;
  errorMessage: string;
}

export interface NodeRunRepository {
  /**
   * Insert a running NodeRun row with attempt = (count of existing rows for
   * this (process_run, node) + 1). Returns the new record.
   */
  start(input: StartNodeRunInput): NodeRunRecord;

  /** Mark a NodeRun completed with its emitted event + output. */
  complete(input: CompleteNodeRunInput): NodeRunRecord;

  /** Mark a NodeRun failed with an error message. */
  fail(input: FailNodeRunInput): NodeRunRecord;

  /** The most recent NodeRun for a (process_run, node), regardless of status. */
  readLatest(processRunId: number, nodeId: string): NodeRunRecord | null;

  /** The most recent COMPLETED NodeRun anywhere in the run (resume point). */
  readLastCompleted(processRunId: number): NodeRunRecord | null;

  /** All NodeRuns for a process run, ordered by id ASC (execution order). */
  list(processRunId: number): readonly NodeRunRecord[];
}
