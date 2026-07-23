export interface RunEpisodeCommand {
  projectId: number;
  epicId: number;
  concurrency?: number;
}

/**
 * Reason the engine run terminated.
 *
 * The four original Saga 2 reasons ('completed' | 'failed' | 'paused_timeout'
 * | 'stopped') describe a full-pipeline run. Saga 3 discovery-only runs add
 * 'discovery_not_implemented' (D0) so that a partial-pipeline engine cannot
 * masquerade as a completed product. New reasons are appended as Discovery
 * Edition grows (D1+); the optional pipelineScope/outcome fields below make the
 * authoritative business outcome explicit.
 */
export type OrchestrationRunReason =
  | 'completed'
  | 'failed'
  | 'paused_timeout'
  | 'stopped'
  | 'discovery_not_implemented';

export interface OrchestrationRunResult {
  projectId: number;
  epicId: number;
  finalStage: string;
  endedAt: string;
  reason: OrchestrationRunReason;
  cycles: number;
  lastError: string | null;

  /**
   * Saga 3 partial-pipeline fields (optional for Saga 2 backward compatibility).
   *
   * pipelineScope names which slice of the product pipeline the engine ran
   * ('discovery_only' for the Discovery Edition). scopeCompleted=true means
   * that the configured slice completed — NOT that the full product is
   * delivered. outcome is the typed business verdict the slice produced.
   *
   * scopeCompleted is decoupled from the business outcome: a valid proposal
   * followed by a terminal worker execution means the discovery slice ran to
   * completion, even when the business verdict is 'clarify'/'reject'/'failed'.
   * outcomeAuthority records whether the outcome came from a worker proposal
   * ('worker_proposal', PROVISIONAL — D4 settlement makes it authoritative) or
   * from the engine itself ('none', e.g. timeout / no proposal).
   * proposalId / proposalHash carry the provenance link to the submitted
   * proposal (null when none).
   */
  pipelineScope?: string;
  scopeCompleted?: boolean;
  outcome?: string;
  outcomeAuthority?: 'worker_proposal' | 'none';
  proposalId?: number | null;
  proposalHash?: string | null;
}

/**
 * Stable application-facing boundary for any orchestration engine.
 *
 * The host, CLI, frontend controls, worker process infrastructure, SQLite
 * schema, and artifact subsystem must not depend on a concrete engine class.
 */
export interface OrchestrationEngine {
  run(command: RunEpisodeCommand): Promise<OrchestrationRunResult>;
}
