// ---------------------------------------------------------------------------
// Managed-production ledger interfaces (Wave 7 type-leak fix).
//
// This is the CANONICAL source of truth for the managed-production ledger
// contract. These pure interface definitions previously lived inlined in
// each module's `*-kernel-ports.ts` (development + formalization), which
// duplicated the shapes. They are now centralized here (refactoring task A4)
// and each module re-exports them under a module-local alias so its handlers
// can speak in module-local language while remaining byte-for-byte type
// compatible with the shared ledger.
//
// The concrete SQLite implementation in
// `persistence/sqlite-managed-production-ledger.ts` imports these interfaces
// and `implements ManagedProductionLedger` — infrastructure depends inward
// (dependency inversion), which is allowed. No module ever imports the
// concrete persistence file.
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
  // WAVE 6 CUTOVER: listArtifactsForExecution / listTracesForExecution were
  // REMOVED. They were the execution-scoped (intentId/taskId/executionId)
  // product-resolution fallback the exact-ProductRef cutover retires
  // (execution-context-assembler §9.11: no epic-scope / latest-in-run / by-
  // execution fallback). The live product-resolution path is
  // listArtifactsForNodeInProcessRun (durable node-scope, CGAD P18) and the
  // exact-by-ProductRef ProcessProductRepository.getByProductRef. The task-
  // scoped variants remain for the reviewed-task product lineage. Re-introducing
  // an execution-scoped lookup is forbidden by
  // tests/architecture/no-execution-scoped-lookup.test.mjs.
  /**
   * Read the durable product accumulated by one reviewed task across its
   * author/reviewer retry executions. A different recovery task is a new
   * product attempt and must write or carry an explicit product reference.
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
  /** Node-wide audit query. Product resolvers must not use it as fallback. */
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
}
