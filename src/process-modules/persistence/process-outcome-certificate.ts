/**
 * Generic ProcessOutcomeCertificate<TPayload>.
 *
 * This is the MODULE-AGNOSTIC authoritative result record. It lives in
 * saga3_process_outcome_certificates alongside (NOT inside) each module's
 * domain-specific state. Discovery's D4 certificate (saga3_discovery_outcome_
 * certificates) is preserved as-is; in P3b a projection adapter exposes those
 * rows THROUGH the generic shape WITHOUT copying — discovery reads stay on the
 * discovery table, generic reads go through the adapter. Formalization (P4)
 * is the FIRST module that writes directly to this generic table.
 *
 * Invariants (mirror the saga3 settlement write-once pattern):
 *   - One certificate per (process_run_id, module_ref_key, decision).
 *   - certificate_hash is write-once UNIQUE — re-inserting the same hash is a
 *     no-op; inserting a different hash for the same process_run_id is a
 *     domain violation (PROCESS_RUN_ALREADY_CERTIFIED).
 *   - decision MUST be one of the module's declared terminal outcome codes.
 *   - input_hash pins the immutable input the certificate was computed from.
 */

import type { ProcessModuleReference } from '../domain/process-module.js';

/**
 * The generic payload envelope. The payload's shape is module-specific
 * (Discovery: { proposal, readiness, policy, decision, reason_codes };
 * Formalization: { prd, srs, baseline, decision, reason_codes }); the
 * generic layer only carries the envelope. schema_version names the payload
 * shape so consumers can dispatch.
 */
export interface ProcessOutcomeCertificatePayload<TPayload = unknown> {
  schemaVersion: string;
  decision: string;
  reasonCodes: readonly string[];
  rationale: string;
  inputHash: string;
  /** The module-specific payload — opaque to the generic layer. */
  payload: TPayload;
}

export interface ProcessOutcomeCertificate<TPayload = unknown> {
  id: number;
  processRunId: number;
  moduleRef: ProcessModuleReference;
  moduleRefKey: string;
  projectId: number;
  epicId: number | null;
  schemaVersion: string;
  decision: string;
  reasonCodes: readonly string[];
  rationale: string;
  inputHash: string;
  certificatePayload: ProcessOutcomeCertificatePayload<TPayload>;
  certificateHash: string;
  authority: string;
  issuedAt: string;
}

export interface IssueProcessOutcomeCertificateCommand<TPayload = unknown> {
  processRunId: number;
  moduleRef: ProcessModuleReference;
  projectId: number;
  epicId: number | null;
  payload: ProcessOutcomeCertificatePayload<TPayload>;
  /**
   * SHA-256 over the canonical JSON of `payload`. The caller computes it; the
   * persistence layer trusts the caller (same convention as ProcessRun).
   */
  certificateHash: string;
  /** Who/what issued the certificate (policy handler id, human id…). */
  authority: string;
}
