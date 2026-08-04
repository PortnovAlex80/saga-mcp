/**
 * Target RecoveryIssue — the defect sheet OTK places on the desk when a gate
 * returns `repair_required`.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-19 (Брак-лист) +
 * Conveyor Mental Model v4 §«The repair mechanic (recovery)».
 *
 * # Relationship to the existing `domain/recovery.ts` RecoveryIssue
 *
 * saga already has a `RecoveryIssue` (`domain/recovery.ts`) used by the current
 * verifier/gate path. It is module-agnostic and opaque (policyId, reasonCode,
 * findings, subjectRefs, acceptanceCriteria, allowedChanges, requiredTools).
 * The target v4 contract ADDS four exact-reference fields that close the
 * "issue detached from its decision" hole:
 *
 *   - `rejectedGateDecisionRef` — the GateDecision that produced this issue.
 *   - `subjectCandidateSetRef` — the rejected CandidateSet (immutable input).
 *   - `failingCheckReceiptRefs` — the exact CheckReceipts whose outcomes
 *     triggered the rejection (REG-19 cites failing receipts explicitly).
 *   - `repairTargetRole` — author | reviewer. MUST match the decision's
 *     repairTargetRole (REG-19-AC-03: findings do NOT give the right to change
 *     the role, scope or capabilities).
 *
 * This file defines the target shape WITHOUT touching the legacy
 * `RecoveryIssue` (which stays in use until step 3.A.3 generalises the gate).
 * Step 3 reconciles the two: the legacy opaque fields become the `findings`
 * carrier, and the four exact-reference fields become required. Until then
 * both coexist — this target type is what the new gate/coordinator produces.
 *
 * # Why exact references (the bug this replaces)
 *
 * Earlier recovery hid the defect sheet in mutable task metadata and
 * regenerated it from a prompt each round. A new worker saw a paraphrase, not
 * the exact rejected decision and its evidence. v4 makes the RecoveryIssue an
 * immutable, exactly-referenced product ON THE DESK (REG-19-AC-02): the
 * replacement worker reads it as an exact desk input, not as regenerated
 * prompt text. The issue CANNOT be applied to a different or newer candidate
 * set without an explicit new decision (REG-19-AC-01).
 *
 * # Pure domain
 *
 * Imports only sibling pure types. No SQLite, MCP, db.ts, clock, or
 * application/behavioral code.
 */

import type { RepairTargetRole } from './gate.js';

/**
 * The target RecoveryIssue — an immutable, exactly-referenced defect sheet.
 *
 * REG-19. Combines the legacy opaque-finding carrier with the four
 * exact-reference fields the v4 contract requires. The repair worker reads
 * this alongside the rejected CandidateSet and understands WHAT to fix and
 * WHY, with byte-exact provenance back to the decision and its evidence.
 */
export interface TargetRecoveryIssue {
  /** Stable recovery-issue ref + digest (content-addressed). */
  readonly recoveryIssueRef: string;
  readonly recoveryIssueDigest: string;
  /** The GateDecision that produced this issue (REG-19). */
  readonly rejectedGateDecisionRef: string;
  /** The rejected CandidateSet (immutable input the repair worker reads). */
  readonly subjectCandidateSetRef: string;
  /** The exact CheckReceipts whose outcomes triggered the rejection. */
  readonly failingCheckReceiptRefs: readonly string[];
  /** author | reviewer — MUST match the decision's repairTargetRole. */
  readonly repairTargetRole: RepairTargetRole;
  /** Module-owned, opaque reason code (the runtime never switches on it). */
  readonly reasonCode: string;
  /** Human-readable summary of what is wrong. */
  readonly summary: string;
  /** Actionable verifier findings (opaque to the runtime). */
  readonly findings: readonly RecoveryFindingEntry[];
  /** What the repair must achieve for the next gate to accept. */
  readonly requiredAcceptance: readonly string[];
  /**
   * Allowed changes scope. The repair worker's authority is the producer
   * profile's preset UNION these; it cannot exceed either (REG-19-AC-03).
   */
  readonly allowedChanges: readonly string[];
}

/**
 * One actionable verifier finding (mirrors the legacy `RecoveryFinding` shape
 * so step 3 can lift it without churn). Opaque to the runtime — the runtime
 * persists and forwards it verbatim.
 */
export interface RecoveryFindingEntry {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly message: string;
  readonly subjectRef?: string | null;
  readonly path?: string | null;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly evidenceRefs?: readonly string[];
}

/**
 * Validate a target RecoveryIssue (REG-19).
 *
 * Pure. Throws on any violation. Rules:
 *   - REG-19-AC-01: the issue cites its rejected decision and subject set
 *     (both non-empty) — it cannot float free of the decision that made it.
 *   - REG-19-AC-02: the issue is structured for exact desk read (ref + digest
 *     are content-addressed SHA-256).
 *   - `failingCheckReceiptRefs` is non-empty (a repair must cite at least one
 *     failing receipt — otherwise the rejection has no evidence).
 *   - `findings` is non-empty (an issue with no findings is meaningless).
 *   - `recoveryIssueDigest` is a 64-char lowercase hex SHA-256.
 *
 * REG-19-AC-03 (findings cannot change repairTargetRole) is enforced at the
 * boundary where the issue is BUILT — the coordinator sets the role from the
 * decision and never reads it back from findings. This validator only checks
 * that the role field is present and well-formed.
 */
export function assertValidTargetRecoveryIssue(
  issue: TargetRecoveryIssue,
): void {
  requireNonEmpty(issue.recoveryIssueRef, 'recoveryIssueRef');
  requireNonEmpty(issue.rejectedGateDecisionRef, 'rejectedGateDecisionRef');
  requireNonEmpty(issue.subjectCandidateSetRef, 'subjectCandidateSetRef');
  requireNonEmpty(issue.reasonCode, 'reasonCode');
  requireNonEmpty(issue.summary, 'summary');
  if (issue.failingCheckReceiptRefs.length === 0) {
    throw new Error(
      'TargetRecoveryIssue.failingCheckReceiptRefs must be non-empty — a '
        + 'repair must cite at least one failing CheckReceipt (REG-19)',
    );
  }
  if (issue.findings.length === 0) {
    throw new Error(
      'TargetRecoveryIssue.findings must be non-empty — an issue with no '
        + 'findings is meaningless',
    );
  }
  if (issue.repairTargetRole !== 'author' && issue.repairTargetRole !== 'reviewer') {
    throw new Error(
      `TargetRecoveryIssue.repairTargetRole must be 'author' or 'reviewer', `
        + `got '${issue.repairTargetRole}'`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(issue.recoveryIssueDigest)) {
    throw new Error(
      'TargetRecoveryIssue.recoveryIssueDigest must be a 64-char lowercase '
        + 'hex SHA-256',
    );
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`TargetRecoveryIssue.${label} must be a non-empty string`);
  }
}
