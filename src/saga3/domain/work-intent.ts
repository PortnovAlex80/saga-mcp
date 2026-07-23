/**
 * WorkIntent — the deterministic kernel's request for product work.
 *
 * Roadmap §7.1. The kernel creates a WorkIntent; a product worker executes
 * against it and returns a typed Proposal (see proposal.ts). The worker never
 * commits the proposal directly — it submits it via proposal_submit, and the
 * kernel records provenance and content hash. The authoritative outcome is
 * produced later by the settlement policy (D4), not by the worker.
 *
 * WorkIntent is a Saga 3 protocol entity — it lives in saga3_work_intents, NOT
 * in the existing artifacts table. It is shared by every Saga 3 stage (discovery
 * today; formalization/planning/development later). The discovery-specific
 * payload shape is described in discovery-proposal.ts.
 */

/** Lifecycle of a WorkIntent. */
export type WorkIntentStatus =
  | 'open'        // created, waiting for a worker to execute it
  | 'executing'   // a task+execution is running against it
  | 'concluded'   // the kernel has produced a provisional/authoritative outcome
  | 'cancelled';

/** Authority and tool surface granted to the worker for this intent. */
export interface AuthorityScope {
  /** Stable ref to the authoritative state snapshot the worker reasoned over. */
  snapshot_ref: string;
  /** Human-readable scope label (e.g. "read-only discovery context"). */
  scope: string;
  /**
   * Tool allowlist the worker is permitted to call. MUST stay in sync with the
   * discovery skill's documented tool list; the WorkIntent is the source of
   * truth and the skill mirrors it.
   */
  allowed_tools: string[];
  /**
   * Whether the runtime actually enforces allowed_tools.
   * - 'advisory' (D1): the allowlist is declared but not yet enforced at the
   *   MCP gateway / spawn layer. The skill instructs the worker to honour it.
   * - 'runtime' (D1.1): an immutable authority snapshot captured at claim time
   *   is checked by the MCP gateway on every tool call; Claude's
   *   --disallowedTools is added only as defense in depth.
   *
   * D1 ships with 'advisory' so the correction commit does not modify the
   * shared Claude spawn path; D1.1 flips discovery intents to 'runtime'.
   */
  enforcement: 'advisory' | 'runtime';
}

/**
 * Envelope common to every WorkIntent, regardless of stage. The `kind` names
 * the product stage (discovery, formalization, …). `objective` is the natural
 * language goal; `output_schema` names the schema version the worker must emit.
 */
export interface WorkIntent {
  id: number;
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: AuthorityScope;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
  /** ID of the board task projected from this intent (set when the task exists). */
  projected_task_id: number | null;
  status: WorkIntentStatus;
  created_at: string;
}

/** Fields the kernel supplies when creating a WorkIntent. */
export interface CreateWorkIntent {
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: AuthorityScope;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
}

/**
 * Schema version for the discovery WorkIntent itself. Bumped when the intent
 * envelope shape changes in an incompatible way.
 */
export const DISCOVERY_WORK_INTENT_SCHEMA = 'saga3.work-intent.discovery.v1';

/** Kind value for discovery product work. */
export const DISCOVERY_INTENT_KIND = 'discovery';
