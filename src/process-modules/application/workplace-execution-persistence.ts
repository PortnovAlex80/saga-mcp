export interface WorkplaceExecutionPersistence {
  ensureExecutionPlan(input: {
    intent: { epicId: number; kind: string; objective: string; authorityScope: WorkIntentAuthorityScope; outputSchema: string; tokenBudget: number; retryBudget: number };
    task: { epicId: number; projectId: number; objective: string; taskKind: string; executionSkill: string; reviewSkill?: string | null; generationKey: string; workflowStage?: string; executionMode?: string; titlePrefix?: string; metadata?: Record<string, unknown>; sourceArtifactIds?: readonly number[]; verificationTargetArtifactId?: number | null };
  }): { intentId: number; taskId: number; replayed: boolean };
  createIntent(input: { epicId: number; kind: string; objective: string; authorityScope: WorkIntentAuthorityScope; outputSchema: string; tokenBudget: number; retryBudget: number }): { id: number };
  ensureProjectedTask(input: { epicId: number; projectId: number; intentId: number; objective: string; taskKind: string; executionSkill: string; reviewSkill?: string | null; generationKey: string; workflowStage?: string; executionMode?: string; titlePrefix?: string; metadata?: Record<string, unknown>; sourceArtifactIds?: readonly number[]; verificationTargetArtifactId?: number | null }): number;
  setProjectedTask(intentId: number, taskId: number): void;
  bindProjectedTaskProcessContext?(input: { taskId: number; processRunId: number; nodeId: string; moduleRef: string; processInputHash: string; nodeInput: unknown; nodeInputHash: string; semanticInputDigest: string; projectRepositoryId?: number | null; managedReviewBudget?: number | null; recoveryFeedback?: unknown }): void;
  setIntentStatus(intentId: number, expected: string, next: string): boolean;
  prepareIntentForExecution(intentId: number, taskId: number): { status: 'ready' | 'active' | 'blocked' | 'done'; intentStatus: string };
  transitionToInRepair(taskId: number): boolean;
  readTaskState(taskId: number): string | null;
  readCurrentExecutionId(taskId: number): string | null;
  readLatestExecutionId(taskId: number): string | null;
  readProducerExecutionId?(taskId: number): string | null;
  readLatestManagedProductionExecutionId?(taskId: number, processRunId: number, nodeId: string): string | null;
  readTaskProjectRepositoryId(taskId: number): number | null;
  readExecutionLiveness?(executionId: string): { pid: number | null; state: string } | null;
}

export interface WorkIntentAuthorityScope {
  snapshot_ref: string;
  scope: string;
  allowed_tools: string[];
  enforcement: 'advisory' | 'runtime';
  payload_contract?: {
    contractId: string;
    version: string;
    contractDigest: string;
  };
  /** Exact, kernel-owned values that a submitted JSON product must echo. */
  payload_bindings?: readonly {
    field: string;
    equals: string;
  }[];
}
