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
  outcomeAuthority?:
    | 'worker_proposal'
    | 'normalized_worker_proposal'
    | 'discovery_settlement_policy'
    | 'none';
  proposalId?: number | null;
  proposalHash?: string | null;

  /**
   * D4 provisional outcome section. When settlement ran and issued a
   * certificate, the top-level outcome/outcomeAuthority become AUTHORITATIVE
   * (outcomeAuthority='discovery_settlement_policy') and the worker's original
   * provisional recommendation is preserved here, unchanged. Before settlement
   * (or when settlement is not_run), the top-level fields ARE the provisional
   * outcome and this section mirrors them.
   */
  provisional?: {
    outcome: string;
    authority: 'worker_proposal' | 'normalized_worker_proposal' | 'none';
    proposalId: number | null;
    proposalHash: string | null;
  };

  /**
   * D3 shadow readiness section. ADVISORY ONLY — never feeds back into
   * outcome/outcomeAuthority/scopeCompleted. If discovery succeeded but the
   * readiness assessment failed/paused, the provisional discovery result is
   * preserved unchanged and readiness.status reports the failure separately.
   * D3 must not overload outcomeAuthority with readiness authority (D4 owns
   * settlement).
   */
  readiness?: {
    status: 'completed' | 'not_run' | 'failed' | 'paused';
    authority: 'shadow_advisor' | 'none';
    assessmentId: number | null;
    assessmentHash: string | null;
    overallReadiness: 'ready' | 'conditionally_ready' | 'not_ready' | 'inconclusive' | null;
    recommendedNextAction: string | null;
    error: string | null;
  };

  /**
   * D4 authoritative settlement section. status='issued' means an immutable
   * DiscoveryOutcomeCertificate exists and the top-level outcome is
   * AUTHORITATIVE (outcomeAuthority='discovery_settlement_policy').
   * status='failed' means the settlement infrastructure errored before a
   * certificate could be issued — this is the authoritative boundary, so the
   * run reason is 'failed' and scopeCompleted is false (unlike D3 shadow, a
   * settlement failure means Discovery Edition did NOT complete
   * authoritatively). status='not_run' means settlement was not wired (legacy
   * / test) and the top-level outcome stays provisional.
   */
  settlement?: {
    status: 'issued' | 'failed' | 'not_run';
    settlementId: number | null;
    certificateId: number | null;
    certificateHash: string | null;
    policyVersion: string | null;
    decision: 'go' | 'clarify' | 'reject' | null;
    reasonCodes: string[];
    error: string | null;
  };
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
