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
}
