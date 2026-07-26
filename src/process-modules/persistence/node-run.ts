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
  outputHash: string | null;
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
  outputHash: string | null;
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
