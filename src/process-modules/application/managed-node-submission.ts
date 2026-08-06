/**
 * Generic typed product submitted by one managed LM node.
 *
 * The worker supplies only a schema id and JSON payload. The runtime derives
 * every identity field from the live execution fence and server-authored task
 * metadata. Module kernels then read one exact submission by the receipt
 * carried in the durable NodeExecutionFrame.
 */

export interface ManagedNodeSubmissionQuery {
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
}

export interface ManagedNodeSubmissionRecord<T = unknown>
extends ManagedNodeSubmissionQuery {
  submissionId: number;
  schema: string;
  payload: T;
  contentHash: string;
  artifactRef: string;
  submittedAt: string;
}

export interface ManagedNodeSubmissionReader {
  /**
   * Read the sole immutable submission made by this exact execution.
   * Implementations must never fall back to a module/epic "latest" row.
   */
  readExact(
    query: ManagedNodeSubmissionQuery,
  ): ManagedNodeSubmissionRecord | null;

  /**
   * Read the latest immutable submission produced inside one reviewed task.
   *
   * Author and reviewer executions share the same task but have different
   * execution fences. A resolver which runs after review therefore resolves
   * the reviewed task product through this explicit task-level operation and
   * receives the exact producer execution in the returned record.
   *
   * CGAD P18 — Node-Durable Identity: the card belongs to the workplace (node),
   * mints a per-attempt task). So `readLatestForTask` for the receipt's task
   * naturally returns the workplace's prior submission. The narrower-than-node
   * scope is still correct: there is exactly one card per workplace now, so
   * task-scope and node-scope agree.
   */
  readLatestForTask(
    query: Omit<ManagedNodeSubmissionQuery, 'intentId' | 'executionId'>,
  ): ManagedNodeSubmissionRecord | null;

  /**
   * Read the latest immutable submission produced by the WORKPLACE (node),
   * independent of which worker (task) produced it. This is the canonical
   * CGAD P18 read: a kernel gate resolves the workplace's product by durable
   * node-scope (processRunId + moduleRef + nodeId), so it can never be blinded
   * to a prior worker's product even if task identity changes across recovery
   * or review-loop rounds. Returns the most recent submission by submissionId.
   */
  readLatestForNode(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): ManagedNodeSubmissionRecord | null;
}
