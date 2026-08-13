// tests/factory-e2e/w9-03-adversarial-handlers.mjs
//
// W9-03 per-scenario SCRIPTED ADVERSARIAL HANDLERS. Each of the three
// adversarial scenarios declared in run-manifest.ts gets a handler map that
// extends the W9-02 happy handlers with ONE targeted adversarial override,
// leaving every other cell on the happy path.
//
// Design rules (ADR-053 alignment):
//   - Crash points are NAMED + DETERMINISTIC (per-workplace invocation counter),
//     never random fault injection. A handler self-crashes at the same logical
//     point every run — the manifest's deterministicCrashPoints declaration
//     documents WHERE; the handler implements HOW.
//   - The reviewer handler reads the EXACT accepted-author CandidateSet from
//     the authority head (readAuthorCandidateSetRef), NOT candidate_read's
//     hash-order sets[0]. In a repair cycle there are multiple author sets;
//     only the head is authoritative (ADR-053 C1).
//   - No authority HACKS: the handlers never WRITE to authority tables. The
//     head read is a READ of the authoritative state — the same read the
//     production-cell-node-executor's acceptedAuthorCandidate() makes.

import { W9_HAPPY_HANDLERS } from './w9-happy-handlers.mjs';

const FRM = 'solution-formalization@1.0.0';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Read the EXACT accepted-author CandidateSet ref for a workplace from the
 * durable authority head (ADR-053 C1). This is the authoritative read — NOT
 * candidate_read's hash-order sets[0] which is wrong in repair cycles. Used by
 * adversarial reviewer handlers to bind verdicts to the correct subject.
 *
 * This is a READ of the authoritative state (the same read the production
 * production-cell-node-executor's acceptedAuthorCandidate() makes), NOT a write
 * or a hack.
 */
function readAcceptedAuthorCandidateSetRef(db, workplaceRef) {
  const row = db.prepare(
    `SELECT accepted_author_candidate_set_ref
       FROM factory_accepted_authority_head
      WHERE workplace_ref = ?`,
  ).get(workplaceRef);
  return row?.accepted_author_candidate_set_ref ?? null;
}

function done(handlers, assignment, result) {
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: CROSS-EXECUTION DURABILITY
//
// The adversarial define-product-contract author self-crashes (exit-without-
// done) on its FIRST invocation for a workplace. The production finalizer
// classifies it as a lost execution and enters crash repair. A SECOND execution
// is leased for the SAME workplace/task; the handler completes normally.
//
// Named deterministic crash point: 'author-lost-after-first-contribution'
// (manifest: trigger=invocation-count, atInvocation=1, effect=exit-without-done).
// Implemented via a per-workplace Set so the crash fires exactly once per
// workplace, regardless of global invocation ordering.
// ---------------------------------------------------------------------------

const crossExecCrashFired = new Set();

function crossExecDurabilityProductContractAuthor(ctx) {
  const { meta } = ctx;
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (workplaceRef && !crossExecCrashFired.has(workplaceRef)) {
    crossExecCrashFired.add(workplaceRef);
    // DETERMINISTIC CRASH — exit without worker_done. The production finalizer
    // (finalizeManagedWorkerProcess) detects no accepted worker_done receipt,
    // classifies the execution as 'lost', and calls requestWorkplaceCrashRepair
    // → releaseExecution(outcome='crashed') → workplace enters repair_wait.
    // The next runEpisode re-queues the task; a second execution completes it.
    return {
      kind: 'exit-without-done',
      crashPoint: 'author-lost-after-first-contribution',
    };
  }
  // Recovery invocation (or a non-target workplace): complete normally.
  return W9_HAPPY_HANDLERS[`${FRM}/define-product-contract/author/singleton`](ctx);
}

/**
 * Build the handler map for scenario 1 (cross-execution durability).
 * All happy handlers, with define-product-contract/author replaced by the
 * self-crashing adversarial wrapper.
 */
export function buildCrossExecutionDurabilityHandlers() {
  crossExecCrashFired.clear();
  return {
    ...W9_HAPPY_HANDLERS,
    [`${FRM}/define-product-contract/author/singleton`]:
      crossExecDurabilityProductContractAuthor,
  };
}

// ---------------------------------------------------------------------------
// Scenario 2: REVIEWER REJECT → REPAIR
//
// The adversarial reconcile-what reviewer emits a structured 'changes_requested'
// verdict on its FIRST assessment for a workplace, then 'approved' on the second.
// The final gate maps changes_requested → repair_required (repairTargetRole=
// author). The author re-produces a SECOND immutable CandidateSet (different
// production revision → different candidate_set_ref). The second assessment
// approves. The accepted-authority head must end up pointing to the SECOND
// (accepted) CandidateSet, never the first (rejected) one.
//
// The reviewer handler reads the accepted-author head to bind its verdict to
// the EXACT current subject (ADR-053 C1). candidate_read's hash-order sets[0]
// would be wrong when two author CandidateSets exist.
// ---------------------------------------------------------------------------

const reviewRejectFired = new Set();

function reviewerRejectThenApprove(ctx) {
  const { handlers, assignment, meta, db } = ctx;
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (!workplaceRef) throw new Error('reviewer task has no workplace_ref');

  // ADR-053 C1 — bind the verdict to the EXACT accepted-author CandidateSet
  // from the durable authority head, NOT candidate_read's hash-order sets[0].
  const authorCsRef = readAcceptedAuthorCandidateSetRef(db, workplaceRef);
  if (!authorCsRef) {
    throw new Error(
      'W9-03 reject-repair: no accepted-author CandidateSet on the authority head',
    );
  }

  if (!reviewRejectFired.has(workplaceRef)) {
    reviewRejectFired.add(workplaceRef);
    // First assessment: structured reject (changes_requested). The review-
    // verdict check provider maps this to 'failed' → final gate returns
    // repair_required with repairTargetRole='author'.
    handlers.product_submit({
      schema: 'factory.review-verdict.v1',
      content: {
        verdict: 'changes_requested',
        findings: [{
          message: 'W9-03 adversarial: reconciliation rationale requires repair',
          severity: 'major',
        }],
        subject_candidate_set_ref: authorCsRef,
      },
    });
    done(handlers, assignment, 'W9-03 reject-repair: changes_requested (first assessment)');
    return { kind: 'worker-done-accepted' };
  }

  // Second assessment: approve the repaired CandidateSet.
  handlers.product_submit({
    schema: 'factory.review-verdict.v1',
    content: {
      verdict: 'approved',
      findings: [],
      subject_candidate_set_ref: authorCsRef,
    },
  });
  done(handlers, assignment, 'W9-03 reject-repair: approved (second assessment)');
  return { kind: 'worker-done-accepted' };
}

/**
 * Build the handler map for scenario 2 (reviewer reject → repair).
 * All happy handlers, with reconcile-what/reviewer replaced by the
 * reject-then-approve adversarial wrapper.
 */
export function buildReviewerRejectRepairHandlers() {
  reviewRejectFired.clear();
  return {
    ...W9_HAPPY_HANDLERS,
    [`${FRM}/reconcile-what/reviewer/singleton`]: reviewerRejectThenApprove,
  };
}

// ---------------------------------------------------------------------------
// Scenario 3: CARRY-FORWARD AUTHORITY
//
// This scenario drives the UNMODIFIED happy path (same handlers as W9-02). The
// adversarial aspect is the ASSERTION: after the cohort converges to runnable-
// local, the development integration tasks were selected from the accepted-
// authority head (readAuthorTaskId), NOT from submission.task_id or recency.
// Multiple git_change tasks exist (the recency trap is structurally present),
// yet each integrated task matches its workplace's head binding.
//
// No adversarial handler overrides are needed — the happy handlers already
// exercise the carry-forward path (formalization accepted material → development
// integration). The proof is in the post-drive DB assertions.
// ---------------------------------------------------------------------------

export function buildCarryForwardAuthorityHandlers() {
  return { ...W9_HAPPY_HANDLERS };
}
