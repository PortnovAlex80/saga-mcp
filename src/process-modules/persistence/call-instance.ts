/**
 * W5-A2 — CallInstance persistence: port + durable record types.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md §2.
 * Task: docs/refactor-management/05-subagent-tasks/W05-a2.md.
 *
 * A CallInstance is the durable record of ONE consequential tool/agent call the
 * runtime makes on behalf of a ProtocolStep (Wave 4). The repository owns ONLY
 * the durable identity, the lifecycle status columns, and the per-call attempt
 * counter; it does NOT decide whether a draft is well-formed, whether a call
 * should be retried, or which step comes next — those are the runtime's job
 * (W5-A6 / Wave 4 ProtocolRuntime). It materializes the call BEFORE submission
 * (C028), preserves the same draft across retries so the model can progress
 * over it (C029), and seals a successful instance with its exact receipt
 * (C030).
 *
 * This file is the PORT (interface) + types. It imports nothing (the
 * dependency-direction ratchet Rule 5 keeps `domain/` pure; persistence port
 * files are pure data shapes + a behavioural interface). The SQLite adapter
 * lives in `sqlite-call-instance-repository.ts` (W5-A2, SQL OWNER).
 *
 * One table (spec §2, W5-A2 is the single SQL owner):
 *   - `saga3_call_instances` — one row per (process_run, step, tool_contract,
 *     attempt) call. The attempt counter lets a retried call carry a fresh row
 *     without overwriting the failed draft (C029: same draft preserved for
 *     progressive correction means the runtime re-edits the SAME row when it
 *     re-submits, rather than creating a new one each time — see `retryCall`).
 *
 * State machine (spec §2 exit gate 4; mirrors the SQL CHECK verbatim):
 *
 *     materialized ──updateDraft──▶ edited ──validateCall──▶ validated
 *                                                                   │
 *                                                       submitCall  │
 *                                                                   ▼
 *                                                                 submitted
 *                                                          │              │
 *                                              sealCall    │        failCall
 *                                            (succeeded)   │       (failed)
 *                                                          ▼              │
 *                                                       succeeded         │
 *                                                          │              ▼
 *                                                          └────▶ sealed   │
 *                                                                         │
 *                                          retryCall ◀──── (failed draft  │
 *                                            │            preserved C029) │
 *                                            └──▶ edited (re-edit & resubmit)
 *
 * `abandoned` is a terminal escape used when the runtime gives up on a call
 * (e.g. process run cancelled).
 *
 * Plan ref: §0.8, §0.8.12 (exit gate 4 — full lifecycle reachable + failed
 * drafts preserved), C028/C029/C030.
 */

// ---------------------------------------------------------------------------
// Status union (mirrors the SQL CHECK constraint verbatim, spec §2).
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a CallInstance row.
 *
 * Mirrors `saga3_call_instances.status` CHECK:
 *   'materialized' — row created BEFORE submission (C028). No draft yet, or a
 *                    draft just attached via updateDraft.
 *   'edited'       — a draft (draft_content_hash) has been attached/updated.
 *                    The runtime may re-edit the SAME row on retry (C029).
 *   'validated'    — the runtime has accepted the draft shape (e.g. schema
 *                    check). The repository trusts the caller.
 *   'submitted'    — the call has been dispatched to the tool/agent. A receipt
 *                    is not yet known.
 *   'succeeded'    — a successful receipt was recorded (successful_receipt_ref
 *                    set). Awaiting seal.
 *   'failed'       — the call failed. last_error_json is set. The draft is
 *                    PRESERVED so the runtime can retry from the same draft
 *                    (C029 — progressive correction).
 *   'sealed'       — terminal success. sealed_at stamped; the row is now
 *                    immutable (C030).
 *   'abandoned'    — terminal escape (e.g. run cancelled).
 */
export const CALL_INSTANCE_STATUSES = [
  'materialized',
  'edited',
  'validated',
  'submitted',
  'succeeded',
  'failed',
  'sealed',
  'abandoned',
] as const;
export type CallInstanceStatus = typeof CALL_INSTANCE_STATUSES[number];

/**
 * The statuses a CallInstance may legally transition FROM for each mutator.
 * Kept here (next to the port) so the adapter and any test share one truth.
 * The adapter enforces these transitions in SQL via guarded UPDATE ... WHERE
 * status IN (...) so a concurrent/racy write is a clean no-op (changes==0)
 * rather than corrupting the state machine.
 */
export const CALL_INSTANCE_TRANSITIONS: Record<string, readonly CallInstanceStatus[]> = {
  // updateDraft: caller attaches/refreshes a draft hash.
  updateDraft: ['materialized', 'edited', 'failed'],
  // validateCall: caller accepts the draft shape (schema/contract check).
  validateCall: ['edited'],
  // submitCall: the call is dispatched.
  submitCall: ['validated'],
  // sealCall: terminal success on a succeeded row.
  sealCall: ['succeeded'],
  // failCall: a submitted call (or one being prepared) ended in failure.
  failCall: ['edited', 'validated', 'submitted', 'succeeded'],
  // retryCall: re-open a failed draft for progressive correction (C029).
  retryCall: ['failed'],
  // abandonCall: terminal escape from any non-terminal status.
  abandonCall: ['materialized', 'edited', 'validated', 'submitted', 'failed'],
};

// ---------------------------------------------------------------------------
// Durable record (one per table row).
// ---------------------------------------------------------------------------

/**
 * One row of `saga3_call_instances`.
 *
 * `protocolRunId`, `stepId`, and `workspacePath` are nullable because a call
 * may be materialized before the owning protocol/step/workspace is known (the
 * runtime binds them lazily, mirroring the ProtocolRun→NodeRun pattern).
 * `draftContentHash` pins the exact draft blob the call was last prepared with.
 * `successfulReceiptRef` is set on transition to 'succeeded' (C030); the row
 * becomes immutable on 'sealed'.
 */
export interface CallInstanceRecord {
  id: number;
  processRunId: number;
  /** Owning ProtocolRun (Wave 4), if known. */
  protocolRunId: number | null;
  /** Step within the protocol that owns this call, if known. */
  stepId: string | null;
  /** Stable reference to the ToolContract / AgentLaunchSpec this call honours. */
  toolContractRef: string;
  /** 1-based attempt counter for this (process_run, step, tool_contract). */
  attempt: number;
  /** Workspace path the call executes in (W5-A1 WorkspaceProjection), if any. */
  workspacePath: string | null;
  /** Hash of the draft payload the call is currently prepared against. */
  draftContentHash: string | null;
  status: CallInstanceStatus;
  /** Structured error blob recorded on transition to 'failed'. */
  lastErrorJson: string | null;
  /** Receipt reference stamped on transition to 'succeeded' (C030). */
  successfulReceiptRef: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set when status transitions to 'sealed' (terminal success). */
  sealedAt: string | null;
}

// ---------------------------------------------------------------------------
// Method inputs.
// ---------------------------------------------------------------------------

/**
 * Input for `createCallInstance`. Materializes a new row BEFORE the call is
 * submitted (C028). The row starts at status 'materialized' and attempt 1.
 *
 * `toolContractRef` pins the exact ToolContract / AgentLaunchSpec this call
 * honours; `processRunId` is the parent ProcessRun. `protocolRunId` + `stepId`
 * are optional because a call may be created before the owning protocol/step
 * is bound.
 */
export interface CreateCallInstanceInput {
  processRunId: number;
  protocolRunId?: number | null;
  stepId?: string | null;
  toolContractRef: string;
  /** Initial attempt. Defaults to 1. */
  attempt?: number;
  workspacePath?: string | null;
  /** Optional initial draft hash (else draft_content_hash starts NULL). */
  draftContentHash?: string | null;
}

/**
 * Input for `updateDraft`. Attaches (or refreshes) the draft content hash on a
 * call and moves it to 'edited' (or leaves it 'edited' on a re-edit, or
 * 'failed' on progressive correction of a failed call before retry).
 *
 * C029 — the SAME row is re-edited on retry, so the model can correct over the
 * prior draft rather than starting from scratch each attempt.
 */
export interface UpdateDraftInput {
  callInstanceId: number;
  draftContentHash: string;
}

/**
 * Input for `failCall`. Marks a submitted (or being-prepared) call failed and
 * records the structured error blob. The draft is PRESERVED (C029) so the
 * runtime can retry from the same draft.
 */
export interface FailCallInput {
  callInstanceId: number;
  lastErrorJson: string;
}

// ---------------------------------------------------------------------------
// Repository port.
// ---------------------------------------------------------------------------

/**
 * Persistence port for CallInstance.
 *
 * The repository owns only durable identity, status transitions (each guarded
 * to its legal FROM-set), the attempt counter, and the failed-draft
 * preservation invariant (C029 — failed rows keep their draft_content_hash).
 * It does NOT validate draft content (the runtime does, then calls
 * `validateCall`), decide retries (the runtime does, then calls `retryCall`),
 * or attach receipts arbitrarily (only `sealCall` records one).
 *
 * Crash-resume contract (spec §0.8 exit gate 4): `readCallInstance` returns a
 * row by id; `listForStep` returns the call ledger for a step so the runtime
 * can find the exact in-flight call to resume. Failed drafts are NEVER
 * overwritten — the runtime calls `retryCall` to re-open them.
 */
export interface CallInstanceRepository {
  /**
   * Materialize a new call row BEFORE submission (C028). Returns the row at
   * status 'materialized', attempt as given or 1.
   */
  createCallInstance(input: CreateCallInstanceInput): CallInstanceRecord;

  /**
   * Attach/refresh a draft hash and move the row to 'edited'. Legal FROM
   * statuses: materialized, edited, failed (progressive correction, C029).
   * Throws if the row is missing or in a status that cannot accept a draft
   * (validated/submitted/succeeded/sealed/abandoned).
   */
  updateDraft(input: UpdateDraftInput): CallInstanceRecord;

  /**
   * Accept the draft shape and move the row edited → validated. Throws if the
   * row is not 'edited'.
   */
  validateCall(callInstanceId: number): CallInstanceRecord;

  /**
   * Mark the call dispatched: validated → submitted. Throws if the row is not
   * 'validated'.
   */
  submitCall(callInstanceId: number): CallInstanceRecord;

  /**
   * Record a successful receipt and move the row to 'succeeded' (pre-seal).
   * Throws if the row is not 'submitted'. A non-empty `successfulReceiptRef`
   * is REQUIRED (C030 — seal attaches the EXACT receipt; no empty ref).
   */
  sealCall(callInstanceId: number, successfulReceiptRef: string): CallInstanceRecord;

  /**
   * Mark a call failed and record the structured error blob. Legal FROM
   * statuses: edited, validated, submitted, succeeded. The draft is PRESERVED
   * (C029). Throws if the row is missing or in a status that cannot fail
   * (materialized/sealed/abandoned).
   */
  failCall(input: FailCallInput): CallInstanceRecord;

  /**
   * Re-open a FAILED draft for progressive correction: failed → edited (C029).
   * The draft_content_hash is preserved so the runtime can correct over it.
   * Throws if the row is not 'failed'.
   */
  retryCall(callInstanceId: number): CallInstanceRecord;

  /**
   * Terminal escape: move a non-terminal row to 'abandoned'. Legal FROM
   * statuses: materialized, edited, validated, submitted, failed. Throws if
   * the row is already terminal (sealed/abandoned).
   */
  abandonCall(callInstanceId: number): CallInstanceRecord;

  /**
   * Read one call instance by id, or null. The crash-resume entry point.
   */
  readCallInstance(callInstanceId: number): CallInstanceRecord | null;

  /**
   * List the call ledger for a (processRunId, stepId, toolContractRef) triple.
   * Ordered by (attempt ASC, id ASC) so the chronological order within an
   * attempt is preserved and earlier attempts come first. Lets the runtime
   * find the exact in-flight call for a step to resume.
   */
  listForStep(
    processRunId: number,
    stepId: string,
    toolContractRef: string,
  ): readonly CallInstanceRecord[];
}
