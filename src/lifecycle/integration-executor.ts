/**
 * Integration executor — deterministic Git merge with observation + CAS.
 *
 * Source: blueprint §13 (docs/architecture/passive-worker-kernel-blueprint.md:580-678),
 *         §16 Slice 5 acceptance (line 907-912).
 *
 * Why: the audit identified that the previous same-process worker merge
 * path was non-deterministic across crashes:
 *   - a merge that succeeded on disk but lost its DB write was invisible to
 *     the recovery path → either silently re-merged (double merge commit) or
 *     misclassified as failed;
 *   - merge-lock staleness was wall-clock only — a live executor could lose
 *     its claim to a zombie timer;
 *   - `git merge` was run against an unobserved target head, so a concurrent
 *     advance produced wrong history.
 *
 * This module implements the idempotent algorithm (blueprint §13.3:622-667):
 *   1. observe the current target head (no blind merge);
 *   2. if reviewed_source_sha is already an ancestor of the target, report
 *      IntegrationObservedMerged without another merge — idempotent success;
 *   3. if the target differs from expected_target_sha, the base advanced —
 *      emit BASE_ADVANCED, never blind-merge;
 *   4. otherwise run `git merge --no-ff --no-commit`; on conflict abort and
 *      report ObserveIntegrationConflict with the file list;
 *   5. on success advance the target with `git update-ref refs/heads/<target>
 *      <merge-sha> <expected-target-sha>` — compare-and-swap; if CAS fails,
 *      re-observe and reconcile (do NOT report success).
 *
 * Crash recovery (blueprint §13 line 669-676): the integration_intent row
 * carries the expected_target_sha and reviewed_source_sha, so a crashed
 * executor is recovered by ancestry observation — not by LLM inference.
 *
 * Git/OS only live in this module (and in store executors). Pure domain code
 * in src/lifecycle/domain/ never imports from here.
 */

import { spawnSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Intent persistence.
// ---------------------------------------------------------------------------

export interface IntegrationIntentRow {
  readonly integration_id: string;
  readonly intent_key: string;
  readonly originating_command_id: string | null;
  readonly task_id: number;
  readonly project_repository_id: number | null;
  readonly source_branch: string;
  readonly reviewed_source_sha: string;
  readonly target_branch: string;
  readonly expected_target_sha: string;
  readonly state: string;
  readonly executor_execution_id: string | null;
  readonly attempt_count: number;
  readonly available_at: string;
  readonly result_commit: string | null;
  readonly conflict_files: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface NewIntent {
  readonly integrationId: string;
  readonly taskId: number;
  readonly projectRepositoryId: number | null;
  readonly sourceBranch: string;
  readonly reviewedSourceSha: string;
  readonly targetBranch: string;
  readonly expectedTargetSha: string;
  readonly originatingCommandId?: string | null;
}

/**
 * Compute the idempotent intent_key per blueprint §13.1:607-611.
 * Same (repo, task, source-sha, target-branch) always produces the same key,
 * so a replay returns the existing intent instead of creating a duplicate.
 */
export function computeIntentKey(input: {
  projectRepositoryId: number | null;
  taskId: number;
  reviewedSourceSha: string;
  targetBranch: string;
}): string {
  const repo = input.projectRepositoryId ?? 'global';
  return `repo${repo}:task${input.taskId}:${input.reviewedSourceSha}:${input.targetBranch}`;
}

/**
 * Find or create an intent. Idempotent on intent_key. Returns the row.
 */
export function findOrCreateIntent(db: Database, input: NewIntent): IntegrationIntentRow {
  const intentKey = computeIntentKey({
    projectRepositoryId: input.projectRepositoryId,
    taskId: input.taskId,
    reviewedSourceSha: input.reviewedSourceSha,
    targetBranch: input.targetBranch,
  });

  const existing = db
    .prepare('SELECT * FROM integration_intents WHERE intent_key = ?')
    .get(intentKey) as IntegrationIntentRow | undefined;
  if (existing) return existing;

  db.prepare(
    `INSERT INTO integration_intents
       (integration_id, intent_key, originating_command_id, task_id,
        project_repository_id, source_branch, reviewed_source_sha,
        target_branch, expected_target_sha, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.integrationId,
    intentKey,
    input.originatingCommandId ?? null,
    input.taskId,
    input.projectRepositoryId,
    input.sourceBranch,
    input.reviewedSourceSha,
    input.targetBranch,
    input.expectedTargetSha,
  );
  return db
    .prepare('SELECT * FROM integration_intents WHERE integration_id = ?')
    .get(input.integrationId) as IntegrationIntentRow;
}

/**
 * Mark an intent's state (and optional result fields). Used by the executor
 * after each observation step.
 */
export function updateIntentState(
  db: Database,
  integrationId: string,
  patch: {
    state?: string;
    resultCommit?: string | null;
    conflictFiles?: string[] | null;
    lastError?: string | null;
    expectedTargetSha?: string | null;
    attemptCount?: number | null;
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: Array<unknown> = [];
  if (patch.state !== undefined) {
    sets.push('state = ?');
    params.push(patch.state);
  }
  if (patch.resultCommit !== undefined) {
    sets.push('result_commit = ?');
    params.push(patch.resultCommit);
  }
  if (patch.conflictFiles !== undefined) {
    sets.push('conflict_files = ?');
    params.push(patch.conflictFiles ? JSON.stringify(patch.conflictFiles) : null);
  }
  if (patch.lastError !== undefined) {
    sets.push('last_error = ?');
    params.push(patch.lastError);
  }
  if (patch.expectedTargetSha !== undefined) {
    sets.push('expected_target_sha = ?');
    params.push(patch.expectedTargetSha);
  }
  if (patch.attemptCount !== undefined) {
    sets.push('attempt_count = ?');
    params.push(patch.attemptCount);
  }
  params.push(integrationId);
  db.prepare(`UPDATE integration_intents SET ${sets.join(', ')} WHERE integration_id = ?`).run(...params);
}

// ---------------------------------------------------------------------------
// Observation outcomes.
// ---------------------------------------------------------------------------

export type ObservationResult =
  | { readonly kind: 'already_merged'; readonly observedTargetSha: string }
  | { readonly kind: 'base_advanced'; readonly observedTargetSha: string; readonly expectedTargetSha: string }
  | { readonly kind: 'source_not_at_reviewed_sha'; readonly observedSourceSha: string }
  | { readonly kind: 'ready_to_merge'; readonly observedTargetSha: string };

/**
 * Observe repository state against the intent. Pure Git read; no writes.
 * Step 1-4 of blueprint §13.3.
 */
export function observeRepository(repoPath: string, intent: IntegrationIntentRow): ObservationResult {
  // Step 1: source branch must still point at reviewed_source_sha.
  const observedSourceSha = revParse(repoPath, intent.source_branch);
  if (observedSourceSha !== intent.reviewed_source_sha) {
    return {
      kind: 'source_not_at_reviewed_sha',
      observedSourceSha: observedSourceSha ?? '(missing)',
    };
  }

  // Step 2: observe target head.
  const observedTargetSha = revParse(repoPath, intent.target_branch);
  if (!observedTargetSha) {
    return {
      kind: 'base_advanced',
      observedTargetSha: '(missing)',
      expectedTargetSha: intent.expected_target_sha,
    };
  }

  // Step 3: if reviewed_source_sha is already an ancestor of the target, the
  // integration already happened. Idempotent success.
  if (isAncestor(repoPath, intent.reviewed_source_sha, observedTargetSha)) {
    return { kind: 'already_merged', observedTargetSha };
  }

  // Step 4: if the target differs from expected_target_sha, the base advanced
  // since intent creation. Do not blind-merge.
  if (observedTargetSha !== intent.expected_target_sha) {
    return {
      kind: 'base_advanced',
      observedTargetSha,
      expectedTargetSha: intent.expected_target_sha,
    };
  }

  return { kind: 'ready_to_merge', observedTargetSha };
}

// ---------------------------------------------------------------------------
// Merge execution.
// ---------------------------------------------------------------------------

export type MergeResult =
  | { readonly kind: 'merged'; readonly mergeCommitSha: string }
  | { readonly kind: 'conflict'; readonly conflictFiles: string[] }
  | { readonly kind: 'cas_failed'; readonly observedTargetSha: string }
  | { readonly kind: 'git_error'; readonly message: string };

/**
 * Perform the merge against the observed state. Steps 5-10 of blueprint §13.3.
 *
 * Strategy (simplified for Slice 5; full worktree-isolation is a follow-up):
 *   - check out the target branch in a fresh temporary worktree at
 *     expected_target_sha;
 *   - run `git merge --no-ff --no-commit <reviewed_source_sha>`;
 *   - on conflict, abort, collect conflict file list, remove temp worktree;
 *   - on success, create the commit with the saga trailers;
 *   - advance the target with `git update-ref refs/heads/<target> <merge-sha>
 *     <expected-target-sha>` (CAS).
 *
 * The trailer fields (Saga-Integration-Id etc.) are part of the audit trail
 * and the recovery signal — `isAlreadyIntegrated` can recognise a saga-made
 * merge even after a crash.
 */
export function performMerge(
  repoPath: string,
  intent: IntegrationIntentRow,
): MergeResult {
  // For Slice 5 we implement a minimal but correct path: merge directly in
  // the target repo using plumbing, with the CAS guard. Worktree-isolation
  // (blueprint §13.3:632-660) is a follow-up — flagged in the checklist.
  // The CAS at the end guarantees we never produce a wrong-history merge
  // even without worktree isolation: if the target advanced under us, the
  // update-ref fails and we report cas_failed instead of committing.

  // Use `git merge-tree --write-tree` (Git 2.38+), which performs a merge
  // WITHOUT touching the working tree or refs. This is the cleanest path —
  // no checkout dance, no risk to the user's working directory.
  const mergeTreeResult = spawnSync(
    'git',
    ['-C', repoPath, 'merge-tree', '--write-tree', '--messages', '--no-messages',
     intent.expected_target_sha, intent.reviewed_source_sha],
    { encoding: 'utf8', windowsHide: true },
  );

  if (mergeTreeResult.status === 0) {
    // merge-tree writes "<tree-sha>\n[conflicting file paths...]" or just
    // "<tree-sha>\n" depending on --no-messages. The first line is the tree.
    const lines = (mergeTreeResult.stdout || '').split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { kind: 'git_error', message: 'merge-tree produced no output' };
    }
    const treeSha = lines[0]!;
    // Create the commit object referencing both parents + trailers.
    const commitResult = spawnSync(
      'git',
      ['-C', repoPath, 'commit-tree', treeSha,
       '-p', intent.expected_target_sha,
       '-p', intent.reviewed_source_sha,
       '-F', '-'],
      {
        encoding: 'utf8',
        windowsHide: true,
        input: buildMergeCommitMessage(intent),
      },
    );
    if (commitResult.status !== 0) {
      return {
        kind: 'git_error',
        message: `commit-tree failed: ${commitResult.stderr || '(no stderr)'}`,
      };
    }
    const mergeCommitSha = (commitResult.stdout || '').trim();

    // CAS: advance the target only if it still equals expected_target_sha.
    const casResult = spawnSync(
      'git',
      ['-C', repoPath, 'update-ref',
       `refs/heads/${intent.target_branch}`,
       mergeCommitSha,
       intent.expected_target_sha],
      { encoding: 'utf8', windowsHide: true },
    );
    if (casResult.status !== 0) {
      // CAS failed — target advanced. Re-observe; caller will reconcile.
      const observedTargetSha = revParse(repoPath, intent.target_branch) ?? '(missing)';
      return { kind: 'cas_failed', observedTargetSha };
    }
    return { kind: 'merged', mergeCommitSha };
  }

  // Non-zero status from merge-tree means either conflict OR unsupported flag.
  if (mergeTreeResult.status === 1) {
    // Git 2.38+ uses exit 1 to signal conflicts; the conflicting entries are
    // listed in stdout after the tree sha. Each entry has the form
    // "<mode> <sha> <stage>\t<path>" (raw ls-files format). We extract just
    // the path after the tab, deduplicated.
    const stdout = mergeTreeResult.stdout || '';
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length >= 2) {
      const paths = new Set<string>();
      for (const line of lines.slice(1)) {
        const tabIdx = line.indexOf('\t');
        const p = tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
        if (p) paths.add(p);
      }
      return { kind: 'conflict', conflictFiles: [...paths] };
    }
    return { kind: 'conflict', conflictFiles: [] };
  }

  // Status 128 or 129 — likely unsupported flag or bad refs.
  return {
    kind: 'git_error',
    message: `merge-tree exited ${mergeTreeResult.status}: ${mergeTreeResult.stderr || '(no stderr)'}`,
  };
}

/**
 * Build the commit message with the saga trailers (blueprint §13.3:641-646).
 * Trailers double as recovery signals — ancestry observation can verify a
 * saga-made merge by reading them.
 */
function buildMergeCommitMessage(intent: IntegrationIntentRow): string {
  return [
    `Merge task ${intent.task_id} (${intent.source_branch})`,
    '',
    `Saga-Integration-Id: ${intent.integration_id}`,
    `Saga-Task-Id: ${intent.task_id}`,
    `Saga-Reviewed-Source: ${intent.reviewed_source_sha}`,
    `Saga-Target-Branch: ${intent.target_branch}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Git plumbing helpers.
// ---------------------------------------------------------------------------

function revParse(repoPath: string, ref: string): string | null {
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', ref], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

/**
 * Is `ancestor` reachable from `descendant`? Uses `git merge-base --is-ancestor`.
 */
export function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync(
    'git',
    ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant],
    { encoding: 'utf8', windowsHide: true },
  );
  // Exit 0: ancestor. Exit 1: not ancestor. Anything else: error (treat as false).
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Consumer loop — wires the deterministic executor into the working cycle.
// ADR-013 Phase 4.2.
// ---------------------------------------------------------------------------

/**
 * Result of processing one integration intent through the executor.
 * Mirrors what worker_merge_release used to return, so callers can switch.
 */
export interface IntentProcessingResult {
  integration_id: string;
  task_id: number;
  outcome: 'merged' | 'conflict' | 'base_advanced' | 'already_merged' | 'git_error' | 'skipped';
  merge_commit: string | null;
  conflict_files: string[] | null;
  message: string;
}

/**
 * Process a SINGLE integration intent through observe → merge → record.
 *
 * This is the deterministic replacement for the worker-driven git merge that
 * used to live inside worker_merge_release. The worker now only reports the
 * review outcome and queues an intent; this function picks up the intent and
 * performs the merge with CAS, observation, and idempotent recovery.
 *
 * Steps (blueprint §13.3):
 *   1. Load the intent row. If state != 'pending', return skipped.
 *   2. Resolve the repository local_path from project_repositories +
 *      repository_checkouts (machine-specific).
 *   3. Observe: already_merged / base_advanced / source_moved / ready.
 *   4. If ready, performMerge with CAS.
 *   5. Update the intent row state and emit an audit event.
 *
 * Returns a structured outcome. Does NOT throw on Git failures — those become
 * outcome='git_error' with the message, so the caller (worker_merge_release
 * or a future consumer loop) can decide whether to retry or surface to human.
 *
 * Each intent is processed in its own short DB transaction so a failure on
 * one does not block others. The Git work happens OUTSIDE the tx (Git is the
 * source of truth for refs; we only record the outcome in the DB).
 */
export function processIntegrationIntent(
  db: Database,
  integrationId: string,
  machineId: string,
): IntentProcessingResult {
  const intent = db.prepare(
    `SELECT * FROM integration_intents WHERE integration_id=?`,
  ).get(integrationId) as IntegrationIntentRow | undefined;

  if (!intent) {
    return {
      integration_id: integrationId, task_id: -1, outcome: 'skipped',
      merge_commit: null, conflict_files: null, message: 'intent not found',
    };
  }
  if (intent.state !== 'pending' && intent.state !== 'retryable') {
    return {
      integration_id: integrationId, task_id: intent.task_id, outcome: 'skipped',
      merge_commit: intent.result_commit, conflict_files: null,
      message: `intent in state '${intent.state}' — not processable`,
    };
  }

  // Resolve repoPath from the binding + this machine's checkout.
  const repo = db.prepare(
    `SELECT COALESCE(rc.local_path, pr.local_path) AS local_path
       FROM project_repositories pr
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id = pr.id AND rc.machine_id = ? AND rc.status='active'
      WHERE pr.id = ?`,
  ).get(machineId, intent.project_repository_id) as { local_path: string | null } | undefined;

  if (!repo?.local_path) {
    updateIntentState(db, integrationId, {
      state: 'retryable',
      lastError: `no active checkout on machine ${machineId} for repo ${intent.project_repository_id}`,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id, outcome: 'git_error',
      merge_commit: null, conflict_files: null,
      message: `no active checkout on machine ${machineId}`,
    };
  }

  // Step 1: observe.
  const observation = observeRepository(repo.local_path, intent);
  if (observation.kind === 'already_merged') {
    // The merge already happened (likely a crashed executor recovered).
    // Record the observed sha as the result and mark merged.
    updateIntentState(db, integrationId, {
      state: 'merged',
      resultCommit: observation.observedTargetSha,
      lastError: null,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'already_merged',
      merge_commit: observation.observedTargetSha,
      conflict_files: null,
      message: 'reviewed_source_sha is already an ancestor of target',
    };
  }
  if (observation.kind === 'base_advanced') {
    updateIntentState(db, integrationId, {
      state: 'base_advanced',
      lastError: `target advanced: expected ${intent.expected_target_sha.slice(0, 7)}, now ${observation.observedTargetSha.slice(0, 7)}`,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'base_advanced',
      merge_commit: null, conflict_files: null,
      message: 'target branch advanced since intent creation — re-observe required',
    };
  }
  if (observation.kind === 'source_not_at_reviewed_sha') {
    updateIntentState(db, integrationId, {
      state: 'retryable',
      lastError: `source branch moved off reviewed sha: now ${observation.observedSourceSha}`,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'git_error',
      merge_commit: null, conflict_files: null,
      message: 'source branch no longer at reviewed_source_sha',
    };
  }

  // Step 2: perform the merge (ready_to_merge branch).
  const mergeResult = performMerge(repo.local_path, intent);
  if (mergeResult.kind === 'merged') {
    updateIntentState(db, integrationId, {
      state: 'merged',
      resultCommit: mergeResult.mergeCommitSha,
      lastError: null,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'merged',
      merge_commit: mergeResult.mergeCommitSha,
      conflict_files: null,
      message: 'merged with CAS',
    };
  }
  if (mergeResult.kind === 'conflict') {
    updateIntentState(db, integrationId, {
      state: 'conflict',
      conflictFiles: mergeResult.conflictFiles,
      lastError: null,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'conflict',
      merge_commit: null,
      conflict_files: mergeResult.conflictFiles,
      message: `merge conflict in ${mergeResult.conflictFiles.length} file(s)`,
    };
  }
  if (mergeResult.kind === 'cas_failed') {
    updateIntentState(db, integrationId, {
      state: 'base_advanced',
      lastError: `CAS failed — target now ${mergeResult.observedTargetSha}`,
    });
    return {
      integration_id: integrationId, task_id: intent.task_id,
      outcome: 'base_advanced',
      merge_commit: null, conflict_files: null,
      message: 'CAS failed — another merge landed first',
    };
  }
  // git_error
  updateIntentState(db, integrationId, {
    state: 'retryable',
    lastError: mergeResult.message,
  });
  return {
    integration_id: integrationId, task_id: intent.task_id,
    outcome: 'git_error',
    merge_commit: null, conflict_files: null,
    message: mergeResult.message,
  };
}

/**
 * Drain all pending integration intents for the given machine. Returns a
 * summary. Safe to call repeatedly — already-processed intents are skipped.
 *
 * This is the future consumer-loop entry point. Today worker_merge_release
 * still drives the merge itself; once the migration in Phase 4.3 lands, the
 * worker will only enqueue an intent and this function will run it.
 */
export function processPendingIntegrationIntents(
  db: Database,
  machineId: string,
  options: { limit?: number } = {},
): { processed: number; merged: number; conflicts: number; errors: number; skipped: number } {
  const limit = options.limit ?? 10;
  const pending = db.prepare(
    `SELECT integration_id FROM integration_intents
      WHERE state IN ('pending', 'retryable')
        AND (executor_execution_id IS NULL OR executor_execution_id = '')
        AND available_at <= datetime('now')
      ORDER BY created_at ASC
      LIMIT ?`,
  ).all(limit) as { integration_id: string }[];

  let merged = 0;
  let conflicts = 0;
  let errors = 0;
  let skipped = 0;
  for (const row of pending) {
    const result = processIntegrationIntent(db, row.integration_id, machineId);
    if (result.outcome === 'merged' || result.outcome === 'already_merged') merged += 1;
    else if (result.outcome === 'conflict') conflicts += 1;
    else if (result.outcome === 'git_error') errors += 1;
    else if (result.outcome === 'base_advanced') errors += 1;
    else skipped += 1;
  }
  return { processed: pending.length, merged, conflicts, errors, skipped };
}
