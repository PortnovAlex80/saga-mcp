// src/process-modules/application/commit-accepted-candidate.ts
//
// ADR-081 — CommitAcceptedCandidate: the ONE proof-backed acceptance
// mutation service (Saga Core Renewal, K12).
//
// The command carries REFERENCES ONLY (workplace, persisted gate decision
// key, the CLAIMED subject candidate set, optional task provenance, the CAS
// expected revision). The service LOADS the persisted facts and verifies the
// full proof contract BEFORE any mutation:
//
//   1. the decision exists (AUTHORITY_COMMIT_DECISION_MISSING);
//   2. its verdict is accepted (AUTHORITY_COMMIT_DECISION_NOT_ACCEPTED);
//   3. its phase matches the acceptance kind — final-phase for a no-review
//      cell's final acceptance, author-phase for accepted-with-review
//      (AUTHORITY_COMMIT_DECISION_PHASE_MISMATCH);
//   4. its subject IS the claimed CandidateSet
//      (AUTHORITY_COMMIT_SUBJECT_MISMATCH);
//   5. its GateRun is terminal (AUTHORITY_COMMIT_RUN_NOT_TERMINAL);
//   6. at least one CheckReceipt exists for the run
//      (AUTHORITY_COMMIT_RECEIPTS_MISSING);
//   7. the frozen check plan is bound (non-empty checkPlanRef AND
//      checkPlanDigest — AUTHORITY_COMMIT_CHECK_PLAN_UNFROZEN);
//   8. the CAS expected revision is current
//      (AUTHORITY_COMMIT_REVISION_STALE).
//
// Only then does it mutate — in ONE transaction (the coordinator's
// applyVerifiedAcceptance: accepted CAS transition + authority head +
// applied-decision head link). A rejected proof mutates NOTHING.
//
// The coordinator's public applyGateDecision no longer performs the
// accepted-with-head transition (GATE_PROOF_VERIFICATION_REQUIRED): callers
// cannot supply accepted material truth directly.

import type { ProductionCellCoordinator } from './production-cell-coordinator.js';
import type { SqliteGateRepository } from '../../infrastructure/workplace/sqlite-gate-repository.js';
import type { WorkplaceRef } from '../domain/workplace/workplace-ref.js';

export interface AuthorityCommitCommand {
  readonly workplaceRef: WorkplaceRef;
  /** The persisted accepted decision that authorizes this commit. */
  readonly gateDecisionKey: string;
  /** The claimed subject — verified against the decision, never trusted. */
  readonly acceptedCandidateSetRef: string;
  /** Provenance written to the authority head (C5-02), not material truth. */
  readonly acceptedAuthorTaskId?: string | null;
  /** CAS fence: must equal the workplace's current revision. */
  readonly expectedRevision: number;
  /** true → final acceptance (no-review cell); false → accepted-with-review. */
  readonly isFinal: boolean;
  readonly effectRequired?: boolean;
}

export interface CommitAcceptedCandidateDeps {
  readonly gateRepo: SqliteGateRepository;
  readonly coordinator: ProductionCellCoordinator;
}

export class CommitAcceptedCandidate {
  constructor(private readonly deps: CommitAcceptedCandidateDeps) {}

  commit(command: AuthorityCommitCommand) {
    const decision = this.deps.gateRepo.readDecision(command.gateDecisionKey);
    if (!decision) {
      throw new Error(`AUTHORITY_COMMIT_DECISION_MISSING: ${command.gateDecisionKey}`);
    }
    if (decision.verdict !== 'accepted') {
      throw new Error(
        `AUTHORITY_COMMIT_DECISION_NOT_ACCEPTED: ${command.gateDecisionKey} is '${decision.verdict}'`,
      );
    }
    // Phase matches the acceptance kind (production-cell-definition): in a
    // NO-REVIEW cell the author gate IS the final gate (phase 'final');
    // with review, the author acceptance is phase 'author' and the
    // reviewer's final gate flows through applyReviewerVerdict — a different
    // mutation path that carries no caller-supplied material truth.
    const requiredPhase = command.isFinal ? 'final' : 'author';
    if (decision.gatePhase !== requiredPhase) {
      throw new Error(
        `AUTHORITY_COMMIT_DECISION_PHASE_MISMATCH: ${command.gateDecisionKey} is `
        + `'${decision.gatePhase}', acceptance kind requires '${requiredPhase}'`,
      );
    }
    if (decision.subjectCandidateSetRef !== command.acceptedCandidateSetRef) {
      throw new Error(
        `AUTHORITY_COMMIT_SUBJECT_MISMATCH: decision '${command.gateDecisionKey}' is about `
        + `'${decision.subjectCandidateSetRef}', claimed '${command.acceptedCandidateSetRef}'`,
      );
    }
    if (!decision.checkPlanRef.trim() || !decision.checkPlanDigest.trim()) {
      throw new Error(
        `AUTHORITY_COMMIT_CHECK_PLAN_UNFROZEN: ${command.gateDecisionKey}`,
      );
    }
    const run = this.deps.gateRepo.readGateRun(decision.gateRunRef);
    if (!run || run.state !== 'terminal') {
      throw new Error(
        `AUTHORITY_COMMIT_RUN_NOT_TERMINAL: ${decision.gateRunRef}${run ? ` is '${run.state}'` : ' is missing'}`,
      );
    }
    const receipts = this.deps.gateRepo.listReceiptsForRun(decision.gateRunRef);
    if (receipts.length === 0) {
      throw new Error(
        `AUTHORITY_COMMIT_RECEIPTS_MISSING: ${decision.gateRunRef}`,
      );
    }
    return this.deps.coordinator.applyVerifiedAcceptance(
      command.workplaceRef,
      {
        isFinal: command.isFinal,
        effectRequired: command.effectRequired ?? false,
      },
      {
        acceptedAuthorCandidateSetRef: command.acceptedCandidateSetRef,
        acceptedAuthorGateDecisionKey: command.gateDecisionKey,
        acceptedAuthorTaskId: command.acceptedAuthorTaskId ?? null,
      },
      command.expectedRevision,
    );
  }
}
