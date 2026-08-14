#!/usr/bin/env node
// tests/factory-e2e/w9-03-adversarial-drive.mjs
//
// Standalone single-drive runner for W9-03. Runs ONE adversarial scenario in
// an isolated process and prints a JSON evidence bundle on stdout. The
// companion test (w9-03-adversarial.test.mjs) invokes this script per scenario,
// twice each, to prove determinism without cross-drive module-level state
// contamination.
//
// Scenario selection: W9_SCENARIO env var = 'cross-execution-durability' |
// 'reviewer-reject-repair' | 'carry-forward-authority'.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SCENARIO = process.env.W9_SCENARIO || '';
const label = process.env.W9_DRIVE_LABEL || SCENARIO;

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const { HARNESS_CONCURRENCY_CEILING } = manifestMod;
const { createScriptedObserver } = await import('./scripted-inference.mjs');
const { buildHarnessComposition } = await import('./harness-composition.mjs');
const {
  buildCrossExecutionDurabilityHandlers,
  buildReviewerRejectRepairHandlers,
  buildCarryForwardAuthorityHandlers,
} = await import('./w9-03-adversarial-handlers.mjs');
const { defaultW9RunManifest, parseRunManifest } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);

const SCENARIO_MAP = {
  'cross-execution-durability': {
    manifestId: 'w9-03-cross-execution-durability',
    handlers: () => buildCrossExecutionDurabilityHandlers(),
    idea: `W9-03 cross-execution durability (${label}): author crash + recovery on same workplace`,
    maxCycles: 120,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
  'reviewer-reject-repair': {
    manifestId: 'w9-03-reviewer-reject-repair',
    handlers: () => buildReviewerRejectRepairHandlers(),
    idea: `W9-03 reviewer reject then repair (${label}): gate rejects first assessment, repaired set accepted`,
    maxCycles: 150,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
  'carry-forward-authority': {
    manifestId: 'w9-03-carry-forward-authority',
    handlers: () => buildCarryForwardAuthorityHandlers(),
    idea: `W9-03 carry-forward authority (${label}): integration task from readAuthorTaskId, not recency`,
    maxCycles: 120,
    maxEmptyDispatchStreak: 10,
    pollMs: 5,
  },
};

const config = SCENARIO_MAP[SCENARIO];
if (!config) {
  throw new Error(`W9_SCENARIO must be one of: ${Object.keys(SCENARIO_MAP).join(', ')}`);
}

// Verify the manifest declares this scenario.
const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: 'de00aa7' }));
const scenario = manifest.scenarios.find(s => s.scenarioId === config.manifestId);
if (!scenario) throw new Error(`${config.manifestId} scenario not declared in manifest`);

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: config.idea,
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  const observer = createScriptedObserver();
  const composition = buildHarnessComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: config.handlers(),
  });

  const result = await driveFreshHarness({
    bootstrap,
    composition,
    scenarioConcurrencyCap: SCENARIO_CAP,
    maxCycles: config.maxCycles,
    pollMs: config.pollMs,
    maxEmptyDispatchStreak: config.maxEmptyDispatchStreak,
    scriptedObserver: observer,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  // Common evidence: development convergence + harness invariants.
  const devRun = db.prepare(
    `SELECT id, module_name, status, local_outcome
       FROM factory_process_runs
      WHERE module_name LIKE '%development%' ORDER BY id DESC LIMIT 1`,
  ).get();

  const lrReceipt = db.prepare(
    `SELECT outcome, subject_candidate_set_ref
       FROM factory_check_receipts
      WHERE provider_id='factory.local-runnability.v1' AND outcome='passed'
      ORDER BY rowid DESC LIMIT 1`,
  ).get();

  const baseEvidence = {
    label,
    scenario: SCENARIO,
    reachedRunnableLocal: devRun?.local_outcome === 'verified' && lrReceipt?.outcome === 'passed',
    devOutcome: devRun?.local_outcome ?? null,
    devStatus: devRun?.status ?? null,
    lrReceiptOutcome: lrReceipt?.outcome ?? null,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    reachedTerminal: result.reachedTerminal,
    scriptedInvocationCount: result.scriptedInvocationCount,
    maxObservedConcurrency: result.maxObservedConcurrency,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    invariantsDeclared: scenario.expectedAuthorityInvariants.map(i => i.id),
  };

  // Scenario-specific evidence.
  let scenarioEvidence;
  if (SCENARIO === 'cross-execution-durability') {
    scenarioEvidence = collectCrossExecutionDurabilityEvidence(db);
  } else if (SCENARIO === 'reviewer-reject-repair') {
    scenarioEvidence = collectReviewerRejectRepairEvidence(db);
  } else {
    scenarioEvidence = collectCarryForwardAuthorityEvidence(db);
  }

  const evidence = { ...baseEvidence, ...scenarioEvidence };

  if (!devRun || devRun.local_outcome !== 'verified') {
    const diagnostic = {
      processRuns: db.prepare(
        `SELECT id,module_name,status,local_outcome
           FROM factory_process_runs ORDER BY id`,
      ).all(),
      openWorkplaces: db.prepare(
        `SELECT process_run_id,workplace_ref,kanban_phase,loop_state,
                next_role,terminal_reason,active_reservation_ref,revision
           FROM factory_workplaces
          WHERE loop_state<>'terminal' OR terminal_reason<>'accepted'
          ORDER BY process_run_id,workplace_ref`,
      ).all(),
      activeTasks: db.prepare(
        `SELECT id,status,assigned_to,current_execution_id,workplace_ref
           FROM tasks
          WHERE status NOT IN ('done','completed','cancelled')
          ORDER BY id`,
      ).all(),
      activeExecutions: db.prepare(
        `SELECT execution_id,task_id,state,phase,last_error
           FROM worker_executions
          WHERE state NOT IN ('exited','lost','spawn_failed','cancelled')
          ORDER BY execution_id`,
      ).all(),
      pendingObligations: db.prepare(
        `SELECT source_kind,source_ref,handoff_kind,state,last_error
           FROM factory_transition_obligations
          WHERE state<>'completed' ORDER BY created_at,obligation_key`,
      ).all(),
      nonAcceptedGates: db.prepare(
        `SELECT workplace_ref,gate_phase,verdict,subject_candidate_set_ref,
                assessment_candidate_set_refs
           FROM factory_gate_decisions
          WHERE verdict<>'accepted' ORDER BY decided_at,decision_key`,
      ).all(),
    };
    process.stderr.write(`[w9-adversarial-diagnostic] ${JSON.stringify(diagnostic)}\n`);
  }

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.ok(result.effectiveConcurrency <= SCENARIO_CAP, `${label}: concurrency ≤ 2`);
  A.equal(devRun?.status, 'completed', `${label}: development status=completed`);
  A.equal(devRun?.local_outcome, 'verified', `${label}: development outcome=verified`);
  A.ok(lrReceipt, `${label}: passed local-readiness receipt exists`);
  A.equal(evidence.reachedRunnableLocal, true, `${label}: reached runnable-local`);

  // Scenario-specific assertions.
  if (SCENARIO === 'cross-execution-durability') {
    A.ok(evidence.lostExecutionCount >= 1, `${label}: at least one lost execution`);
    A.equal(evidence.crashRecoveryConverged, true, `${label}: crash recovery converged`);
    A.equal(evidence.authorCandidateSetCount, 1, `${label}: exactly one author CandidateSet for crashed workplace (partition invariance)`);
  } else if (SCENARIO === 'reviewer-reject-repair') {
    A.ok(evidence.gateRepairDecisionCount >= 1, `${label}: at least one repair_required gate decision`);
    A.ok(evidence.refsAreDistinct, `${label}: rejected and accepted CandidateSets have distinct refs`);
    A.equal(evidence.headPointsToAccepted, true, `${label}: authority head points to accepted (not rejected) CandidateSet`);
  } else {
    A.equal(evidence.allHeadTaskIdsNonNull, true, `${label}: all development head task IDs are non-null`);
    A.equal(evidence.allIntegratedTasksMatchHead, true, `${label}: all integrated tasks match the authority head`);
    A.ok(evidence.multipleGitChangeTasksPresent, `${label}: multiple git_change tasks present (recency trap)`);
  }

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}

// ---------------------------------------------------------------------------
// Scenario-specific evidence collectors
// ---------------------------------------------------------------------------

function collectCrossExecutionDurabilityEvidence(db) {
  // The crash targeted the first formalization define-product-contract author.
  // Find the formalization workplace(s) and check for lost executions +
  // singular CandidateSet (partition invariance).
  const lostExecutions = db.prepare(
    `SELECT COUNT(*) AS n FROM worker_executions
      WHERE state='lost'`,
  ).get();

  const formalizationWorkplaces = db.prepare(
    `SELECT DISTINCT w.workplace_ref
       FROM factory_workplaces w
       JOIN factory_process_runs pr ON pr.id=w.process_run_id
      WHERE pr.module_name LIKE '%formalization%'`,
  ).all();

  // Find the workplace with a lost execution (the crash target).
  let crashWorkplaceRef = null;
  let authorCandidateSetCount = 0;
  for (const wp of formalizationWorkplaces) {
    const lost = db.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions we
        JOIN tasks t ON t.id=we.task_id
        WHERE t.workplace_ref=? AND we.state='lost'`,
    ).get(wp.workplace_ref);
    if (lost.n > 0) {
      crashWorkplaceRef = wp.workplace_ref;
      const cs = db.prepare(
        `SELECT COUNT(*) AS n FROM factory_candidate_sets
          WHERE workplace_ref=? AND role='author'`,
      ).get(wp.workplace_ref);
      authorCandidateSetCount = cs.n;
      break;
    }
  }

  // Total lost executions across the epic (the crash + any natural lost execs).
  // Partition invariance: the crashed workplace has EXACTLY ONE author
  // CandidateSet (from the recovery execution). The crash didn't duplicate
  // or lose the contribution.
  return {
    lostExecutionCount: lostExecutions.n,
    crashWorkplaceRef,
    authorCandidateSetCount,
    crashRecoveryConverged: crashWorkplaceRef !== null && authorCandidateSetCount === 1,
    partitionInvarianceHolds: authorCandidateSetCount === 1,
  };
}

function collectReviewerRejectRepairEvidence(db) {
  // The reject targeted the reconcile-what reviewer cell. Find the workplace
  // with a repair_required gate decision.
  const repairDecisions = db.prepare(
    `SELECT workplace_ref, verdict, subject_candidate_set_ref,
            assessment_candidate_set_refs, decided_at
       FROM factory_gate_decisions
      WHERE verdict='repair_required'`,
  ).all();

  const repairWorkplace = repairDecisions[0]?.workplace_ref ?? null;

  // All gate decisions for the repair workplace (repair_required + accepted).
  const allDecisions = repairWorkplace
    ? db.prepare(
        `SELECT verdict, subject_candidate_set_ref, gate_phase
           FROM factory_gate_decisions
          WHERE workplace_ref=?
          ORDER BY decided_at, decision_key`,
      ).all(repairWorkplace)
    : [];

  // All author CandidateSets for the repair workplace.
  const authorSets = repairWorkplace
    ? db.prepare(
        `SELECT candidate_set_ref, production_revision_ref, sealed_at
           FROM factory_candidate_sets
          WHERE workplace_ref=? AND role='author'
          ORDER BY sealed_at, candidate_set_ref`,
      ).all(repairWorkplace)
    : [];

  // The accepted-authority head for the repair workplace.
  const head = repairWorkplace
    ? db.prepare(
        `SELECT accepted_author_candidate_set_ref, accepted_author_task_id
           FROM factory_accepted_authority_head
          WHERE workplace_ref=?`,
      ).get(repairWorkplace)
    : null;

  const rejectedRef = authorSets[0]?.candidate_set_ref ?? null;
  const acceptedRef = authorSets[authorSets.length - 1]?.candidate_set_ref ?? null;
  const headRef = head?.accepted_author_candidate_set_ref ?? null;

  return {
    repairWorkplaceRef: repairWorkplace,
    gateRepairDecisionCount: repairDecisions.length,
    gateDecisionVerdicts: allDecisions.map(d => ({ verdict: d.verdict, phase: d.gate_phase })),
    authorCandidateSetRefs: authorSets.map(s => s.candidate_set_ref),
    rejectedCandidateSetRef: rejectedRef,
    acceptedCandidateSetRef: acceptedRef,
    headCandidateSetRef: headRef,
    headTaskId: head?.accepted_author_task_id ?? null,
    refsAreDistinct: rejectedRef !== null && acceptedRef !== null && rejectedRef !== acceptedRef,
    headPointsToAccepted: headRef !== null && headRef === acceptedRef && headRef !== rejectedRef,
  };
}

function collectCarryForwardAuthorityEvidence(db) {
  // All development implementation tasks that were integrated (merged).
  const integratedTasks = db.prepare(
    `SELECT t.id, t.workplace_ref, t.integration_state, t.integrated_commit
       FROM tasks t
      WHERE t.execution_mode='git_change'
        AND t.integration_state='merged'`,
  ).all();

  // For each integrated task, verify the authority head's task ID matches.
  const headTaskBindings = integratedTasks.map(task => {
    const head = task.workplace_ref
      ? db.prepare(
          `SELECT accepted_author_task_id
             FROM factory_accepted_authority_head
            WHERE workplace_ref=?`,
        ).get(task.workplace_ref)
      : null;
    return {
      taskId: task.id,
      workplaceRef: task.workplace_ref,
      headTaskId: head?.accepted_author_task_id ?? null,
      matches: head?.accepted_author_task_id === String(task.id),
    };
  });

  // Count all git_change tasks (the recency trap — multiple tasks exist).
  const totalGitChangeTasks = db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE execution_mode='git_change'`,
  ).get();

  // Managed node submissions carry a task_id (the origin process's task).
  // Verify the head binding doesn't rely on submission.task_id by checking
  // the head is the sole authority for task selection.
  const allHeadTaskIdsNonNull = headTaskBindings.every(b => b.headTaskId !== null);
  const allIntegratedTasksMatchHead = headTaskBindings.every(b => b.matches);

  return {
    integratedTaskCount: integratedTasks.length,
    headTaskBindings,
    allHeadTaskIdsNonNull,
    allIntegratedTasksMatchHead,
    totalGitChangeTasks: totalGitChangeTasks.n,
    multipleGitChangeTasksPresent: totalGitChangeTasks.n >= 2,
  };
}
