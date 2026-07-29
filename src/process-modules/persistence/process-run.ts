/**
 * ProcessRun domain — generic envelope around one Process Module execution.
 *
 * ProcessRun is module-agnostic: it captures the lifecycle of ONE invocation
 * of ONE registered module (e.g. product-discovery@3.0.0,
 * solution-formalization@1.0.0) regardless of the executor kind (legacy
 * adapter, generic flow, external, human). Module-specific execution state
 * lives separately (WorkIntent/Proposal/Certificate for discovery,
 * PRD/UC/AC/SRS for formalization); ProcessRun is the common shell.
 *
 * Idempotency: the caller-supplied idempotency_key names the run WITHIN
 * (project_id, module_name, module_version). It is unique per (project,
 * module). The input_hash captured at start time is IMMUTABLE — a second
 * start with the same key must present the SAME input_hash (replay) or the
 * repository throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT. This mirrors
 * the saga3 settlement invariant: the key pins the immutable INPUT target and
 * is INDEPENDENT of any executor_run_ref. A restart reuses the same ProcessRun
 * row; no second run is ever created for the same key.
 *
 * Status transitions:
 *   created → preparing → running → (settling → completed) | (paused → ...)
 *   created | preparing | running | paused | settling → failed | cancelled
 *
 * A ProcessRun only reaches `completed` after the module produced a
 * ProcessModuleRunResult (with optional certificate). `paused` is a recovery
 * checkpoint — the executor must be resumable.
 */

import type { ProcessModuleReference } from '../domain/process-module.js';

export const PROCESS_RUN_STATUSES = [
  'created',
  'preparing',
  'running',
  'paused',
  'settling',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ProcessRunStatus = typeof PROCESS_RUN_STATUSES[number];

export const EXECUTOR_KINDS = [
  'legacy-adapter',
  'generic-flow',
  'external',
  'human',
] as const;
export type ExecutorKind = typeof EXECUTOR_KINDS[number];

/**
 * Generic module input envelope. `payload` is opaque to the persistence layer
 * — the executor decodes it against the module's input contract. `schema` is
 * the contract id (e.g. 'saga3.discovery-case.v1').
 */
export interface ProcessModuleInput {
  schema: string;
  payload: unknown;
  /** SHA-256 over the canonical JSON of payload (machine-filled by caller). */
  contentHash: string;
}

export interface ProcessModuleOutput {
  schema: string;
  artifactRef: string;
  contentHash: string;
}

export interface ProcessModuleCertificateRef {
  schema: string;
  certificateRef: string;
  certificateHash: string;
}

/** Mutable pointer to the durable issue currently suspending/repairing a run. */
export interface ProcessRunActiveIssue {
  recoveryCaseId: number;
  issueRef: string;
  issueHash: string;
}

/**
 * The command that starts one ProcessRun. Carries the immutable input envelope
 * + the invocation context that pins the run to one (project, epic, initiator,
 * idempotency_key). Every field except `epicId` is required.
 */
export interface StartProcessModuleCommand {
  moduleRef: ProcessModuleReference;
  input: ProcessModuleInput;
  executorKind: ExecutorKind;
  /** Where to project legacy episode_workflows.stage (null = no projection). */
  projectedStage: string | null;
  /**
   * Wave 2 installation pin (W3-A3, spec §6). When BOTH are set the run is
   * pinned to an immutable module installation (`saga3_module_installations`).
   * When BOTH are null the run is a legacy pre-Wave-2 run that routes through
   * the legacy nullable adapter (plan §14.3.7). No NOT NULL enforcement until
   * Wave 11. The caller (composition root / Wave 11 cutover) sets these when
   * starting a run via the installation path; legacy call sites omit them and
   * both default to null.
   */
  installationId: number | null;
  packageDigest: string | null;
  invocationContext: {
    projectId: number;
    epicId: number | null;
    initiatedBy: string;
    /**
     * Caller-supplied idempotency key. Unique within (projectId, moduleRef).
     * The same key + same input_hash returns the existing run (replay). The
     * same key + different input_hash throws
     * IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT. A different key creates a
     * brand-new run.
     */
    idempotencyKey: string;
  };
}

/**
 * The persisted ProcessRun record. Read-only projection of the DB row.
 */
export interface ProcessRunRecord {
  id: number;
  moduleRef: ProcessModuleReference;
  moduleRefKey: string;
  projectId: number;
  epicId: number | null;
  /** Immutable idempotency key from the caller. */
  idempotencyKey: string;
  /** Schema id from ProcessModuleInput.schema. */
  inputSchema: string;
  /** Canonical JSON of ProcessModuleInput.payload, persisted for replay/audit. */
  inputSnapshot: string;
  /** SHA-256 over inputSnapshot (matches ProcessModuleInput.contentHash). */
  inputHash: string;
  status: ProcessRunStatus;
  executorKind: ExecutorKind;
  /** Stage to project into episode_workflows when this run completes. */
  projectedStage: string | null;
  /**
   * Wave 2 installation pin (W3-A3, spec §6). Mirrors the two nullable
   * `installation_id` / `package_digest` columns on `saga3_process_runs`.
   * BOTH set → the run is pinned to an immutable module installation; BOTH
   * null → legacy pre-Wave-2 run (routes through the legacy nullable adapter,
   * plan §14.3.7). The Wave 3 `AgentLaunchSpec` resolver reads
   * `installationId` to decide pinned-package resolution vs catalog fallback.
   */
  installationId: number | null;
  packageDigest: string | null;
  /** Local outcome emitted by the module (null until terminal). */
  localOutcome: string | null;
  /**
   * Stable issuer/policy authority for the terminal outcome. Persisted
   * write-once so replay projects the same result as the live execution.
   */
  authority: string | null;
  outputSchema: string | null;
  outputRef: string | null;
  outputHash: string | null;
  certificateSchema: string | null;
  certificateRef: string | null;
  certificateHash: string | null;
  /** Reference to the executor's internal run (e.g. discovery WorkIntent id). */
  executorRunRef: string | null;
  /** Separate from terminal output_*: cleared only after the verifier passes. */
  activeIssue: ProcessRunActiveIssue | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields a caller may update on a non-terminal ProcessRun. Terminal statuses
 * (completed | failed | cancelled) are write-once for outcome/output/
 * certificate — they can only be set once and never overwritten.
 */
export interface UpdateProcessRunInput {
  status?: ProcessRunStatus;
  localOutcome?: string | null;
  authority?: string | null;
  output?: ProcessModuleOutput | null;
  certificate?: ProcessModuleCertificateRef | null;
  executorRunRef?: string | null;
  activeIssue?: ProcessRunActiveIssue | null;
  error?: string | null;
  /** Set to current ISO timestamp when transitioning to a terminal status. */
  completedAt?: string | null;
}
