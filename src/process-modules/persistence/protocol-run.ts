/**
 * W4-A1 — ProtocolRun persistence: port + durable record types.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md §2.
 * Task: docs/refactor-management/05-subagent-tasks/W04-a1.md.
 *
 * A ProtocolRun is the durable execution record of one LM-operated Flow node's
 * inner `NodeProtocolDefinition` (Wave 1 W1-A4). The protocol runtime (Wave 4
 * lanes W4-A2..A6) drives a step state machine (start → in_progress →
 * completed, with repeat/branch/retry/pause/resume/recovery transitions); this
 * module owns ONLY the durable identity + status columns + the step ledger.
 * It does not decide step transitions or evidence validity — those are the
 * runtime's job (W4-A2/A3).
 *
 * This file is the PORT (interface) + types. It imports ONLY from `domain/`
 * (the dependency-direction ratchet Rule 5 keeps `domain/` pure; `persistence/`
 * port files are allowed to import `domain/`). The SQLite adapter lives in
 * `sqlite-protocol-run-repository.ts` (W4-A1, SQL OWNER).
 *
 * Two tables (spec §2, W4-A1 is the single SQL owner):
 *   - `saga3_protocol_runs`       — one row per active protocol per
 *                                   (process_run_id, node_protocol_id). Partial
 *                                   UNIQUE index enforces at most one ACTIVE row
 *                                   per pair; paused/completed/failed/abandoned
 *                                   rows are kept for history.
 *   - `saga3_protocol_step_runs`  — one row per (protocol_run_id, step_id,
 *                                   attempt) triple. The attempt counter lets a
 *                                   repeated/retried step carry fresh evidence
 *                                   without overwriting history.
 *
 * Plan ref: §8.2, §8.4, §0.7.11 (crash-resume at exact last incomplete step).
 */

// ---------------------------------------------------------------------------
// Status unions (mirror the SQL CHECK constraints verbatim, spec §2).
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a ProtocolRun row.
 *
 * Mirrors `saga3_protocol_runs.status` CHECK:
 *   'active'     — protocol is executing (some step is in_progress or pending).
 *   'paused'     — protocol has been explicitly parked (pause-external recovery
 *                  action or human pause); resume re-enters at current_step.
 *   'completed'  — protocol reached its terminal step successfully.
 *   'failed'     — protocol ended in a non-recoverable failure.
 *   'abandoned'  — protocol was abandoned (e.g. process run cancelled).
 */
export const PROTOCOL_RUN_STATUSES = [
  'active',
  'paused',
  'completed',
  'failed',
  'abandoned',
] as const;
export type ProtocolRunStatus = typeof PROTOCOL_RUN_STATUSES[number];

/**
 * Lifecycle status of a single ProtocolStepRun row.
 *
 * Mirrors `saga3_protocol_step_runs.status` CHECK:
 *   'pending'     — step row created but not yet started.
 *   'in_progress' — step is currently executing (advanceStep has fired).
 *   'completed'   — step finished and its required evidence was recorded.
 *   'skipped'     — step was skipped (e.g. branch predicate excluded it).
 *   'failed'      — step ended in failure; the runtime decides retry/recovery.
 */
export const PROTOCOL_STEP_RUN_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'failed',
] as const;
export type ProtocolStepRunStatus = typeof PROTOCOL_STEP_RUN_STATUSES[number];

// ---------------------------------------------------------------------------
// Durable records (one per table row).
// ---------------------------------------------------------------------------

/**
 * One row of `saga3_protocol_runs`.
 *
 * `nodeRunId` is nullable: a protocol may be started before its owning NodeRun
 * row is known (the runtime binds it once the NodeRun starts). `currentStep` is
 * null only transiently between row creation and the first `advanceStep`; once
 * the protocol is executing it always names a step id from the
 * NodeProtocolDefinition.
 */
export interface ProtocolRunRecord {
  id: number;
  processRunId: number;
  /** Owning NodeRun, if known. Null when the protocol predates the NodeRun row. */
  nodeRunId: number | null;
  /** `NodeProtocolDefinition.id` (Wave 1 W1-A4). */
  nodeProtocolId: string;
  /** `NodeProtocolDefinition.version`. */
  nodeProtocolVersion: string;
  /** `NodeProtocolDefinition.entryStep` — the step the protocol started at. */
  entryStep: string;
  /** Step id the protocol is currently at (resume target). Null pre-first-advance. */
  currentStep: string | null;
  status: ProtocolRunStatus;
  /** 1-based attempt counter for the whole protocol (retries bump it). */
  attempt: number;
  createdAt: string;
  updatedAt: string;
  /** Set when status transitions to a terminal state (completed/failed/abandoned). */
  completedAt: string | null;
}

/**
 * One row of `saga3_protocol_step_runs`.
 *
 * The (protocolRunId, stepId, attempt) triple is UNIQUE — a repeated/retried
 * step gets a fresh attempt number and therefore a fresh row, so evidence is
 * append-only and never overwritten.
 */
export interface ProtocolStepRunRecord {
  id: number;
  protocolRunId: number;
  stepId: string;
  /** 1-based attempt within this (protocol_run, step_id). */
  attempt: number;
  status: ProtocolStepRunStatus;
  /**
   * Verified evidence bundle the runtime recorded before allowing the step to
   * complete (spec §8.4 / C026 — required evidence cannot be skipped). JSON
   * blob; opaque to the repository. Null while the step is pending/in_progress.
   */
  evidenceJson: string | null;
  /** Set when status transitions to 'completed'. */
  completedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Method inputs.
// ---------------------------------------------------------------------------

/**
 * Input for `startProtocol`. Creates a new ACTIVE protocol run row (or resumes
 * an idempotent one if the exact same triple already exists and is active).
 *
 * `nodeProtocolId` + `nodeProtocolVersion` pin the exact NodeProtocolDefinition
 * the runtime is executing; `entryStep` is where execution begins.
 */
export interface StartProtocolInput {
  processRunId: number;
  /** Owning NodeRun id. Optional — may be bound later. */
  nodeRunId?: number | null;
  nodeProtocolId: string;
  nodeProtocolVersion: string;
  entryStep: string;
  /** Initial current_step. Defaults to entryStep when omitted. */
  currentStep?: string;
  /** Initial attempt. Defaults to 1. */
  attempt?: number;
}

/**
 * Input for `advanceStep`. Marks the current step row in_progress (creating it
 * if needed) and moves the protocol's currentStep cursor to `stepId`.
 *
 * `attempt` lets the runtime start a fresh attempt of a repeated/retried step;
 * omitted ⇒ attempt 1 (or the next attempt for an already-seen step).
 */
export interface AdvanceStepInput {
  protocolRunId: number;
  stepId: string;
  attempt?: number;
}

/**
 * Input for `completeStep`. Records verified evidence and marks the step row
 * completed. The runtime MUST have verified required evidence before calling
 * this (spec §8.4 / C026); the repository trusts the caller and persists the
 * `evidenceJson` blob verbatim.
 */
export interface CompleteStepInput {
  protocolRunId: number;
  stepId: string;
  attempt?: number;
  /** Verified evidence bundle (JSON string). Required to complete a step. */
  evidenceJson: string;
}

// ---------------------------------------------------------------------------
// Repository port.
// ---------------------------------------------------------------------------

/**
 * Persistence port for ProtocolRun + ProtocolStepRun.
 *
 * The repository owns only durable identity, status transitions, the
 * (process_run, protocol) active-uniqueness invariant, and the append-only
 * step ledger. It does NOT decide whether a step's evidence is sufficient
 * (that is W4-A3 `verifyStepEvidence`) or which step comes next (W4-A2
 * ProtocolRuntime). Transitions that violate the SQL CHECK constraints throw.
 *
 * Crash-resume contract (spec §0.7.11): `readActiveProtocol` returns the row
 * to resume, and its `currentStep` is the exact step to re-enter;
 * `readByExactStep` returns the step ledger row for an exact
 * (protocolRunId, stepId, attempt) triple so the runtime can prove which step
 * attempt was last in-progress.
 */
export interface ProtocolRunRepository {
  /**
   * Start a new ACTIVE protocol run. Enforces the partial UNIQUE index
   * (at most one active row per (processRunId, nodeProtocolId)) — a second
   * start for the same pair while one is active throws. Returns the new row
   * with currentStep set.
   */
  startProtocol(input: StartProtocolInput): ProtocolRunRecord;

  /**
   * Advance the protocol cursor to `stepId` and mark that step row
   * in_progress (creating a pending→in_progress transition, or a fresh attempt
   * row). Updates protocol.currentStep and protocol.updatedAt. Returns the
   * updated protocol row.
   */
  advanceStep(input: AdvanceStepInput): ProtocolRunRecord;

  /**
   * Record verified evidence and mark the (protocolRunId, stepId, attempt)
   * step row completed. Sets completed_at. Does NOT advance the protocol
   * cursor — the runtime calls `advanceStep` for the next step. Returns the
   * completed step row.
   */
  completeStep(input: CompleteStepInput): ProtocolStepRunRecord;

  /**
   * Read the ACTIVE protocol row for a (processRunId, nodeProtocolId) pair, or
   * null if none is active. The crash-resume entry point (spec §0.7.11).
   */
  readActiveProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null;

  /**
   * Read the step ledger row for an exact (protocolRunId, stepId, attempt)
   * triple, or null if no such row exists. Lets the runtime prove which step
   * attempt was last in-progress / completed (§0.7.11 exact resume).
   */
  readByExactStep(
    protocolRunId: number,
    stepId: string,
    attempt: number,
  ): ProtocolStepRunRecord | null;

  /**
   * Pause an ACTIVE protocol (status active → paused). Returns the updated
   * row, or null if there was no active protocol for the pair.
   */
  pauseProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null;

  /**
   * Resume a PAUSED protocol (status paused → active). Returns the updated
   * row, or null if there was no paused protocol for the pair.
   */
  resumeProtocol(
    processRunId: number,
    nodeProtocolId: string,
  ): ProtocolRunRecord | null;

  /**
   * List all step ledger rows for a protocol run, ordered by (attempt, id) so
   * the chronological order within an attempt is preserved and earlier
   * attempts come first.
   */
  listSteps(protocolRunId: number): readonly ProtocolStepRunRecord[];
}
