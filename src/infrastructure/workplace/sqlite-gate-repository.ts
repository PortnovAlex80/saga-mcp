/**
 * SqliteGateRepository — GateRun / CheckReceipt / GateDecision store (step 1.2).
 *
 * Target contracts: REG-15 (GateRun), REG-17 (CheckReceipt), REG-18
 * (GateDecision). The v4_check_receipts and v4_gate_decisions tables are
 * append-only (BEFORE UPDATE/DELETE triggers in schema.ts), so this repository
 * only INSERTs into them — there is no UPDATE path.
 *
 * Idempotency:
 *   - GateDecision: primary key is the deterministic `decision_key`; a replay
 *     returns the stored row, a different digest under the same key throws
 *     (mirrors ExactCandidateAcceptance, which step 3.A.3 generalizes into
 *     this universal contract).
 *   - CheckReceipt: primary key is `check_receipt_ref`; a replay returns the
 *     stored row.
 *
 * Step 1.2 scope: repository EXISTS and is tested; nothing on the runtime
 * path uses it yet. Step 2.2 (ProductionCellCoordinator) becomes the first
 * caller when it starts GateRuns and applies decisions.
 */

import type Database from 'better-sqlite3';
import {
  assertValidGateDecision,
  type AcceptedOutputBinding,
  type CheckOutcome,
  type CheckReceipt,
  type GateDecision,
  type GatePhase,
  type GateRun,
  type GateVerdict,
  type RepairTargetRole,
} from '../../process-modules/domain/workplace/index.js';
import type { ProductRef } from '../../process-modules/domain/spi/index.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export const GATE_DECISION_REPLAY_MISMATCH = 'GATE_DECISION_REPLAY_MISMATCH';

// ---------------------------------------------------------------------------
// GateRun.
// ---------------------------------------------------------------------------

export interface CreateGateRunInput {
  readonly gateRunRef: string;
  readonly workplaceRef: WorkplaceRef;
  readonly gatePhase: GatePhase;
  readonly subjectCandidateSetRef: string;
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly checkPlanRef: string;
  readonly checkPlanDigest: string;
  readonly expectedWorkplaceRevision: number;
  readonly gateLeaseRef: string;
}

export class SqliteGateRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a GateRun row. Idempotent on gate_run_ref (INSERT OR IGNORE); a
   * repeat call for the same ref returns the existing row. The runtime claims
   * a gate lease BEFORE creating the run, so the claim is the race chokepoint;
   * this insert is the durable record of the claim.
   */
  createGateRun(input: CreateGateRunInput): GateRun {
    this.db.prepare(
      `INSERT OR IGNORE INTO v4_gate_runs
         (gate_run_ref, workplace_ref, gate_phase, subject_candidate_set_ref,
          assessment_candidate_set_refs, check_plan_ref, check_plan_digest,
          expected_workplace_revision, gate_lease_ref, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`,
    ).run(
      input.gateRunRef,
      serializeWorkplaceRef(input.workplaceRef),
      input.gatePhase,
      input.subjectCandidateSetRef,
      JSON.stringify(input.assessmentCandidateSetRefs),
      input.checkPlanRef,
      input.checkPlanDigest,
      input.expectedWorkplaceRevision,
      input.gateLeaseRef,
    );
    return this.readGateRun(input.gateRunRef)!;
  }

  readGateRun(gateRunRef: string): GateRun | null {
    const row = this.db.prepare(
      `SELECT * FROM v4_gate_runs WHERE gate_run_ref=?`,
    ).get(gateRunRef) as
      | {
          gate_run_ref: string;
          workplace_ref: string;
          gate_phase: GatePhase;
          subject_candidate_set_ref: string;
          assessment_candidate_set_refs: string;
          check_plan_ref: string;
          check_plan_digest: string;
          expected_workplace_revision: number;
          gate_lease_ref: string;
          state: GateRun['state'];
        }
      | undefined;
    if (!row) return null;
    return {
      gateRunRef: row.gate_run_ref,
      workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
      gatePhase: row.gate_phase,
      subjectCandidateSetRef: row.subject_candidate_set_ref,
      assessmentCandidateSetRefs: JSON.parse(row.assessment_candidate_set_refs),
      checkPlanRef: row.check_plan_ref,
      checkPlanDigest: row.check_plan_digest,
      expectedWorkplaceRevision: row.expected_workplace_revision,
      gateLeaseRef: row.gate_lease_ref,
      state: row.state,
    };
  }

  /**
   * Update a GateRun's state (claimed → checking → decided → terminal). This
   * is NOT append-only (only decisions/receipts are); the run row is the
   * audit of the inspection lifecycle, and its state transitions are part of
   * that audit.
   */
  setGateRunState(gateRunRef: string, state: GateRun['state']): void {
    this.db.prepare(
      `UPDATE v4_gate_runs SET state=?, updated_at=datetime('now') WHERE gate_run_ref=?`,
    ).run(state, gateRunRef);
  }

  // -----------------------------------------------------------------------
  // CheckReceipt (REG-17) — append-only.
  // -----------------------------------------------------------------------

  /**
   * Record an immutable CheckReceipt. Idempotent on check_receipt_ref (INSERT
   * OR IGNORE). The schema's BEFORE UPDATE/DELETE triggers enforce immutability
   * at the DB level, so even a bypass of this repository cannot mutate a row.
   */
  recordCheckReceipt(input: {
    readonly checkReceiptRef: string;
    readonly checkRunRef: string;
    readonly subjectCandidateSetRef: string;
    readonly assessmentCandidateSetRefs: readonly string[];
    readonly check: { providerId: string; version: string; providerDigest: string };
    readonly environmentRef: string | null;
    readonly outcome: CheckOutcome;
    readonly evidenceRefs: readonly string[];
    readonly receiptDigest: string;
  }): CheckReceipt {
    this.db.prepare(
      `INSERT OR IGNORE INTO v4_check_receipts
         (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
          assessment_candidate_set_refs, provider_id, provider_version,
          provider_digest, environment_ref, outcome, evidence_refs, receipt_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.checkReceiptRef,
      input.checkRunRef,
      input.subjectCandidateSetRef,
      JSON.stringify(input.assessmentCandidateSetRefs),
      input.check.providerId,
      input.check.version,
      input.check.providerDigest,
      input.environmentRef,
      input.outcome,
      JSON.stringify(input.evidenceRefs),
      input.receiptDigest,
    );
    return this.readCheckReceipt(input.checkReceiptRef)!;
  }

  readCheckReceipt(checkReceiptRef: string): CheckReceipt | null {
    const row = this.db.prepare(
      `SELECT * FROM v4_check_receipts WHERE check_receipt_ref=?`,
    ).get(checkReceiptRef) as
      | {
          check_receipt_ref: string;
          check_run_ref: string;
          subject_candidate_set_ref: string;
          assessment_candidate_set_refs: string;
          provider_id: string;
          provider_version: string;
          provider_digest: string;
          environment_ref: string | null;
          outcome: CheckOutcome;
          evidence_refs: string;
          receipt_digest: string;
        }
      | undefined;
    if (!row) return null;
    return {
      checkReceiptRef: row.check_receipt_ref,
      checkRunRef: row.check_run_ref,
      subjectCandidateSetRef: row.subject_candidate_set_ref,
      assessmentCandidateSetRefs: JSON.parse(row.assessment_candidate_set_refs),
      check: {
        providerId: row.provider_id,
        version: row.provider_version,
        providerDigest: row.provider_digest,
      },
      environmentRef: row.environment_ref,
      outcome: row.outcome,
      evidenceRefs: JSON.parse(row.evidence_refs),
      receiptDigest: row.receipt_digest,
    };
  }

  /**
   * List all CheckReceipts produced by one GateRun, in insertion order. The
   * decision policy reduces over this list.
   */
  listReceiptsForRun(gateRunRef: string): CheckReceipt[] {
    const rows = this.db.prepare(
      `SELECT * FROM v4_check_receipts WHERE check_run_ref=? ORDER BY rowid`,
    ).all(gateRunRef) as CheckReceiptRow[];
    return rows.map(readCheckReceiptRow);
  }

  // -----------------------------------------------------------------------
  // GateDecision (REG-18) — append-only.
  // -----------------------------------------------------------------------

  /**
   * Record an immutable GateDecision. Idempotent on decision_key (REG-18-AC-05
   * outbox replay): a replay returns the stored decision; a different digest
   * under the same key throws GATE_DECISION_REPLAY_MISMATCH.
   */
  recordDecision(decision: GateDecision): { decision: GateDecision; replayed: boolean } {
    // Validate cross-field rules BEFORE any DB write (REG-18).
    assertValidGateDecision(decision);
    const existing = this.db.prepare(
      'SELECT decision_digest FROM v4_gate_decisions WHERE decision_key=?',
    ).get(decision.decisionKey) as { decision_digest: string } | undefined;
    if (existing) {
      if (existing.decision_digest !== decision.decisionDigest) {
        throw new Error(
          `${GATE_DECISION_REPLAY_MISMATCH}: key '${decision.decisionKey}' exists `
            + `with digest '${existing.decision_digest}' (submitted '${decision.decisionDigest}')`,
        );
      }
      return { decision, replayed: true };
    }
    this.db.prepare(
      `INSERT INTO v4_gate_decisions
         (decision_key, workplace_ref, gate_ref, gate_run_ref, gate_phase,
          transition_ref, subject_candidate_set_ref, assessment_candidate_set_refs,
          verdict, repair_target_role, check_plan_ref, check_plan_digest,
          decision_policy_ref, decision_policy_digest, check_receipt_refs,
          installation_digest, accepted_output_bindings, recovery_issue_ref,
          decision_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decision.decisionKey,
      serializeWorkplaceRef(decision.workplaceRef),
      decision.gateRef,
      decision.gateRunRef,
      decision.gatePhase,
      decision.transitionRef,
      decision.subjectCandidateSetRef,
      JSON.stringify(decision.assessmentCandidateSetRefs),
      decision.verdict,
      decision.repairTargetRole,
      decision.checkPlanRef,
      decision.checkPlanDigest,
      decision.decisionPolicyRef,
      decision.decisionPolicyDigest,
      JSON.stringify(decision.checkReceiptRefs),
      decision.installationDigest,
      JSON.stringify(decision.acceptedOutputBindings),
      decision.recoveryIssueRef,
      decision.decisionDigest,
    );
    return { decision, replayed: false };
  }

  readDecision(decisionKey: string): GateDecision | null {
    const row = this.db.prepare(
      `SELECT * FROM v4_gate_decisions WHERE decision_key=?`,
    ).get(decisionKey) as GateDecisionRow | undefined;
    if (!row) return null;
    return hydrateDecision(row);
  }

  /**
   * List decisions for a workplace, newest first. Used by diagnostics and by
   * the recovery-policy reader (it finds the most recent decision to build a
   * RecoveryIssue from).
   */
  listDecisionsForWorkplace(workplaceRef: WorkplaceRef): GateDecision[] {
    const rows = this.db.prepare(
      `SELECT * FROM v4_gate_decisions
        WHERE workplace_ref=?
        ORDER BY decided_at DESC, rowid DESC`,
    ).all(serializeWorkplaceRef(workplaceRef)) as GateDecisionRow[];
    return rows.map(hydrateDecision);
  }
}

// ---------------------------------------------------------------------------
// Row types + hydration.
// ---------------------------------------------------------------------------

interface GateDecisionRow {
  decision_key: string;
  workplace_ref: string;
  gate_ref: string;
  gate_run_ref: string;
  gate_phase: GatePhase;
  transition_ref: string;
  subject_candidate_set_ref: string;
  assessment_candidate_set_refs: string;
  verdict: GateVerdict;
  repair_target_role: RepairTargetRole | null;
  check_plan_ref: string;
  check_plan_digest: string;
  decision_policy_ref: string;
  decision_policy_digest: string;
  check_receipt_refs: string;
  installation_digest: string;
  accepted_output_bindings: string;
  recovery_issue_ref: string | null;
  decision_digest: string;
  decided_at: string;
}

function hydrateDecision(row: GateDecisionRow): GateDecision {
  return {
    workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
    gateRef: row.gate_ref,
    gateRunRef: row.gate_run_ref,
    gatePhase: row.gate_phase,
    transitionRef: row.transition_ref,
    subjectCandidateSetRef: row.subject_candidate_set_ref,
    assessmentCandidateSetRefs: JSON.parse(row.assessment_candidate_set_refs),
    verdict: row.verdict,
    repairTargetRole: row.repair_target_role,
    checkPlanRef: row.check_plan_ref,
    checkPlanDigest: row.check_plan_digest,
    decisionPolicyRef: row.decision_policy_ref,
    decisionPolicyDigest: row.decision_policy_digest,
    checkReceiptRefs: JSON.parse(row.check_receipt_refs),
    installationDigest: row.installation_digest,
    decisionKey: row.decision_key,
    acceptedOutputBindings: JSON.parse(row.accepted_output_bindings) as AcceptedOutputBinding[],
    recoveryIssueRef: row.recovery_issue_ref,
    decisionDigest: row.decision_digest,
  };
}

interface CheckReceiptRow {
  check_receipt_ref: string;
  check_run_ref: string;
  subject_candidate_set_ref: string;
  assessment_candidate_set_refs: string;
  provider_id: string;
  provider_version: string;
  provider_digest: string;
  environment_ref: string | null;
  outcome: CheckOutcome;
  evidence_refs: string;
  receipt_digest: string;
}

function readCheckReceiptRow(row: CheckReceiptRow): CheckReceipt {
  return {
    checkReceiptRef: row.check_receipt_ref,
    checkRunRef: row.check_run_ref,
    subjectCandidateSetRef: row.subject_candidate_set_ref,
    assessmentCandidateSetRefs: JSON.parse(row.assessment_candidate_set_refs),
    check: {
      providerId: row.provider_id,
      version: row.provider_version,
      providerDigest: row.provider_digest,
    },
    environmentRef: row.environment_ref,
    outcome: row.outcome,
    evidenceRefs: JSON.parse(row.evidence_refs),
    receiptDigest: row.receipt_digest,
  };
}

// Re-export the type so callers can `import type { ProductRef }` from here too.
export type { ProductRef };
export type { GateRun };

// ---------------------------------------------------------------------------
// WorkplaceRef deserialization (shared with candidate-set-repository; kept
// inline here to avoid a cross-repository dependency. The serialization format
// is owned by domain/workplace/workplace-ref.ts and is stable).
// ---------------------------------------------------------------------------

function deserializeWorkplaceRef(serialized: string): WorkplaceRef {
  const parts = serialized.split('/');
  if (parts.length < 5 || parts[0] !== 'workplace') {
    throw new Error(`GATE_REPOSITORY_CORRUPT: invalid workplace_ref '${serialized}'`);
  }
  return {
    processRunId: Number(parts[1]),
    moduleRef: parts[2]!,
    productionCellId: parts[3]!,
    workKey: parts.slice(4).join('/'),
  } as WorkplaceRef;
}
