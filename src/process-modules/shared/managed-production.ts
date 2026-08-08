// ---------------------------------------------------------------------------
// Managed-production ledger interfaces (Wave 7 type-leak fix).
//
// This is the CANONICAL provenance-ledger contract. It records physical writes
// by ProcessRun/node/task/execution. Durable product ownership is NOT inferred
// from any one of those columns: the application-level Workplace production
// resolver groups ledger rows by the server-authored tasks.workplace_ref.
// ---------------------------------------------------------------------------

export interface ManagedExecutionProductQuery {
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
}

export interface ManagedArtifactProductionRecord {
  ledgerId: number;
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
  artifactId: number;
  artifactType: string;
  artifactStatus: string;
  contentHash: string | null;
  operation: 'create' | 'upsert' | 'update';
  recordedAt: string;
}

export interface ManagedTraceProductionRecord {
  ledgerId: number;
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
  traceId: number;
  sourceId: number;
  targetType: 'artifact' | 'task';
  targetId: number;
  linkType: string;
  traceHash: string;
  recordedAt: string;
}

export interface ManagedProductionLedger {
  /**
   * Task-scoped provenance read. Useful for audit/review lineage, but not the
   * generic durable product owner: several physical task/execution attempts may
   * contribute to one Workplace desk.
   */
  listArtifactsForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedArtifactProductionRecord[];
  listTracesForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedTraceProductionRecord[];

  /**
   * Node-wide AUDIT query. A node may materialize many sibling Workplaces, so
   * generic Product/Candidate/Replay resolvers MUST NOT use node scope as the
   * durable ownership boundary.
   */
  listArtifactsForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedArtifactProductionRecord[];
  listTracesForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedTraceProductionRecord[];

  /** Legacy cross-run audit/recovery query; not a current-product fallback. */
  listArtifactsForNodeInEpic(
    projectId: number,
    epicId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedArtifactProductionRecord[];
  listTracesForNodeInEpic(
    projectId: number,
    epicId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedTraceProductionRecord[];

  /** Audit helper only; producer execution is provenance, not product identity. */
  readLatestManagedProductionExecutionIdForNode?(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): string | null;
}
