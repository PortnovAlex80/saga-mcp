import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';

import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { DEVELOPMENT_REVIEW_VERDICT_SCHEMA } from '../../modules/development/domain/development-schemas.js';
import { SqliteAcceptedAuthorityHeadRepository } from './sqlite-accepted-authority-head-repository.js';
import { SqliteSealedProductMaterialRepository } from './sqlite-sealed-product-material-repository.js';
import { assertPersistedAcceptedCandidateAuthority } from './sqlite-accepted-candidate-authority.js';
import type { AcceptedCandidateAuthority } from '../../process-modules/application/post-acceptance-effects.js';

/**
 * Runtime-owned integration effect for an accepted git-changing Workplace.
 * The LM produces and reviews a source commit; this adapter alone mutates the
 * integration branch and records the observed result.
 */
export interface SqliteProductionCellIntegrationInput {
  readonly workplaceRef: import('../../process-modules/domain/workplace/workplace-ref.js').WorkplaceRef;
  readonly processRunId: number;
  readonly candidateSetRef: string;
  readonly gateDecisionKey: string;
  readonly expectedProductSchema: string;
}

export type ProductionCellIntegrationResult =
  | {
      readonly outcome: 'succeeded';
      readonly taskId: number;
      readonly sourceCommit: string;
      readonly sourceTree: string;
      readonly beforeHead: string;
      readonly afterHead: string;
      readonly alreadyApplied: boolean;
    }
  | {
      readonly outcome: 'repair_required';
      readonly taskId: number;
      readonly sourceCommit: string;
      readonly sourceTree: string;
      readonly beforeHead: string;
      readonly reason: string;
    };

export type ProductionCellIntegrationObservation =
  | { readonly outcome: 'matched'; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'absent-retry-safe'; readonly evidence: Readonly<Record<string, unknown>> }
  | { readonly outcome: 'blocked'; readonly reason: string; readonly evidence: Readonly<Record<string, unknown>> };

export class SqliteProductionCellIntegration {
  private readonly sealedProducts: SqliteSealedProductMaterialRepository;

  constructor(
    private readonly db: Database.Database,
    /**
     * ADR-053 C5-03 — the accepted-authority head is the SOLE source of the
     * task identity for git integration. The integration reads the carry-
     * forward-safe `acceptedAuthorTaskId` from it (see readAuthorTaskId) and
     * fails closed when the head has no task identity, rather than guessing by
     * submission.task_id (origin process's task) or recency.
     */
    private readonly authorityHeadRepo: SqliteAcceptedAuthorityHeadRepository,
  ) {
    this.sealedProducts = new SqliteSealedProductMaterialRepository(db);
  }

  assertAuthority(authority: AcceptedCandidateAuthority): void {
    assertPersistedAcceptedCandidateAuthority(this.db, authority);
  }

  observeAcceptedWorkplace(
    input: SqliteProductionCellIntegrationInput,
  ): ProductionCellIntegrationObservation {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    // ADR-053 C5-03 — task identity comes ONLY from the accepted-authority head
    // (the carry-forward-safe binding), never from the origin submission's
    // task_id and never by recency. Fail closed (block) when the head has no
    // task identity; do NOT guess by latest/origin task.
    const authorTaskId = this.authorityHeadRepo.readAuthorTaskId(workplace);
    if (authorTaskId === null) {
      return {
        outcome: 'blocked',
        reason: `PRODUCTION_CELL_INTEGRATION_TASK_MISSING: authority head has no accepted author task for ${workplace}`,
        evidence: { workplace },
      };
    }
    const task = this.db.prepare(
      `SELECT t.id,t.integration_state,t.project_repository_id,
              COALESCE(rc.local_path, pr.local_path) AS local_path,
              pr.integration_branch
         FROM tasks t
         JOIN project_repositories pr ON pr.id=t.project_repository_id
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE t.id=?
          AND t.workplace_ref=?
          AND t.execution_mode IN ('git_change','artifact_change')
        LIMIT 1`,
    ).get(
      authorTaskId,
      workplace,
    ) as {
      id: number;
      integration_state: string;
      project_repository_id: number;
      local_path: string;
      integration_branch: string;
    } | undefined;
    if (!task) {
      return { outcome: 'blocked', reason: 'integration task missing', evidence: { workplace } };
    }
    const payload = this.readAcceptedProduct(input) as {
      source?: { commitSha?: unknown };
      snapshot?: { treeSha?: unknown };
    };
    const sourceCommit = payload.source?.commitSha;
    if (typeof sourceCommit !== 'string' || !sourceCommit) {
      return {
        outcome: 'blocked',
        reason: 'integration source commit missing',
        evidence: { taskId: task.id },
      };
    }
    const targetHead = git(task.local_path, [
      'rev-parse', `refs/heads/${task.integration_branch}`,
    ]);
    if (!targetHead) {
      return {
        outcome: 'blocked',
        reason: 'integration target missing',
        evidence: { taskId: task.id, integrationBranch: task.integration_branch },
      };
    }
    if (isAncestor(task.local_path, sourceCommit, targetHead)) {
      this.db.prepare(
        `UPDATE tasks
            SET integration_state='merged',integrated_at=COALESCE(integrated_at,datetime('now')),
                integrated_commit=?,updated_at=datetime('now') WHERE id=?`,
      ).run(targetHead, task.id);
      return {
        outcome: 'matched',
        evidence: { taskId: task.id, sourceCommit, targetHead },
      };
    }
    if (task.integration_state === 'conflict') {
      return {
        outcome: 'blocked',
        reason: `PRODUCTION_CELL_INTEGRATION_CONFLICT: task ${task.id}`,
        evidence: { taskId: task.id, sourceCommit, targetHead },
      };
    }
    return {
      outcome: 'absent-retry-safe',
      evidence: { taskId: task.id, sourceCommit, targetHead },
    };
  }

  integrateAcceptedWorkplace(input: SqliteProductionCellIntegrationInput): ProductionCellIntegrationResult {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    // ADR-053 C5-03 — task identity comes ONLY from the accepted-authority head
    // (the carry-forward-safe binding recorded at author acceptance by C5-02),
    // NEVER from the origin submission's task_id (s.task_id — the origin
    // process's task, wrong after carry-forward) and NEVER by recency
    // (ORDER BY ... DESC — wrong in repair cycles). The head is the sole
    // authority. Fail closed when it has no task identity: do NOT fall back to
    // the latest task or the origin submission.
    const authorTaskId = this.authorityHeadRepo.readAuthorTaskId(workplace);
    if (authorTaskId === null) {
      throw new Error(
        `PRODUCTION_CELL_INTEGRATION_TASK_MISSING: accepted-authority head has no accepted author task for ${workplace}`,
      );
    }
    // Repository Desk consistency fix: use COALESCE(rc.local_path, pr.local_path)
    // so the integration operates on the SAME machine-specific checkout that the
    // worker used (and that the dispatcher/freeze use). The previous raw
    // pr.local_path could point at a stale directory when a per-machine
    // repository_checkouts override was active.
    const task = this.db.prepare(
      `SELECT t.id,t.integration_state,t.project_repository_id,t.metadata,
              COALESCE(rc.local_path, pr.local_path) AS local_path,
              pr.integration_branch
         FROM tasks t
         JOIN project_repositories pr ON pr.id=t.project_repository_id
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE t.id=?
          AND t.workplace_ref=?
          AND t.execution_mode IN ('git_change','artifact_change')
        LIMIT 1`,
    ).get(
      authorTaskId,
      workplace,
    ) as {
      id: number;
      integration_state: string;
      project_repository_id: number;
      local_path: string;
      integration_branch: string;
      metadata: string;
    } | undefined;
    if (!task) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_TASK_MISSING: ${workplace}`);
    }
    const payload = this.readAcceptedProduct(input) as {
      workItemKey?: unknown;
      terminalStatus?: unknown;
      source?: { branch?: unknown; commitSha?: unknown; workItemKey?: unknown };
      snapshot?: { commitSha?: unknown; treeSha?: unknown };
      repository?: { projectRepositoryId?: unknown; integrationBranch?: unknown };
    };
    const sourceCommit = payload.source?.commitSha;
    const sourceBranch = payload.source?.branch;
    // source.workItemKey is redundant with the top-level workItemKey (they
    // identify the same work item). Accept both the strict match (worker
    // included source.workItemKey) and the omitted case (worker skill documents
    // only the top-level field) — as long as the top-level workItemKey is valid
    // and any present source.workItemKey does not contradict it.
    const sourceWorkItemOk = payload.source?.workItemKey === undefined
      || payload.source?.workItemKey === payload.workItemKey;
    if (
      payload.terminalStatus !== 'complete'
      || typeof payload.workItemKey !== 'string'
      || typeof sourceCommit !== 'string' || !sourceCommit
      || typeof sourceBranch !== 'string' || !sourceBranch
      || !sourceWorkItemOk
      || payload.snapshot?.commitSha !== sourceCommit
      || typeof payload.snapshot?.treeSha !== 'string'
      || payload.repository?.projectRepositoryId !== task.project_repository_id
      || payload.repository?.integrationBranch !== task.integration_branch
    ) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING: task ${task.id}`);
    }
    const source = git(task.local_path, [
      'rev-parse', `${sourceCommit}^{commit}`,
    ]);
    const sourceRef = sourceBranch.startsWith('refs/')
      ? sourceBranch
      : `refs/heads/${sourceBranch}`;
    const branchHead = git(task.local_path, ['rev-parse', sourceRef]);
    const sourceTree = git(task.local_path, ['rev-parse', `${sourceCommit}^{tree}`]);
    if (
      source !== sourceCommit
      || branchHead !== sourceCommit
      || sourceTree !== payload.snapshot.treeSha
    ) {
      throw new Error(
        `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task ${task.id} submitted `
        + `${sourceCommit} but branch is ${branchHead ?? 'missing'}`,
      );
    }
    const targetHead = git(task.local_path, [
      'rev-parse', `refs/heads/${task.integration_branch}`,
    ]);
    if (!targetHead) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_TARGET_MISSING: ${task.integration_branch}`);
    }
    if (task.integration_state === 'merged' || isAncestor(task.local_path, sourceCommit, targetHead)) {
      this.db.prepare(
        `UPDATE tasks
            SET integration_state='merged',integrated_at=COALESCE(integrated_at,datetime('now')),
                integrated_commit=?,updated_at=datetime('now')
          WHERE id=?`,
      ).run(targetHead, task.id);
      return {
        outcome: 'succeeded',
        taskId: task.id,
        sourceCommit,
        sourceTree: sourceTree!,
        beforeHead: targetHead,
        afterHead: targetHead,
        alreadyApplied: true,
      };
    }
    const review = this.db.prepare(
      `SELECT material.payload_snapshot,rcs.subject_candidate_set_ref
         FROM factory_gate_decisions gd
         JOIN json_each(gd.assessment_candidate_set_refs) assessment
         JOIN factory_candidate_sets rcs
           ON rcs.candidate_set_ref=assessment.value
          AND rcs.role='reviewer'
         JOIN factory_candidate_set_members m
           ON m.candidate_set_ref=rcs.candidate_set_ref
          AND m.product_schema='${DEVELOPMENT_REVIEW_VERDICT_SCHEMA}'
         JOIN factory_sealed_product_aliases alias
           ON alias.product_ref=m.product_ref
          AND alias.schema_id=m.product_schema
          AND alias.content_digest=m.product_digest
         JOIN factory_sealed_product_materials material
           ON material.schema_id=alias.schema_id
          AND material.content_digest=alias.content_digest
        WHERE gd.decision_key=?
          AND gd.workplace_ref=?
          AND gd.gate_phase='final'
          AND gd.verdict='accepted'
          AND gd.subject_candidate_set_ref=?`,
        // ADR-053 C4/C5 — the filter (workplace, subject, gate_phase='final',
        // verdict='accepted') is unique per subject (one final accepted decision
        // per subject), so no decided_at recency / LIMIT 1 tiebreaker is needed.
    ).get(input.gateDecisionKey, workplace, input.candidateSetRef) as {
      payload_snapshot: string;
      subject_candidate_set_ref: string;
    } | undefined;
    const reviewPayload = review
      ? JSON.parse(review.payload_snapshot) as {
          verdict?: unknown;
          subject_candidate_set_ref?: unknown;
          findings?: unknown;
        }
      : null;
    if (
      reviewPayload?.verdict !== 'approved'
      || review?.subject_candidate_set_ref !== input.candidateSetRef
      || reviewPayload.subject_candidate_set_ref !== input.candidateSetRef
      || !Array.isArray(reviewPayload.findings)
    ) {
      throw new Error(`PRODUCTION_CELL_REVIEW_BINDING_INVALID: task ${task.id}`);
    }
    const beforeHead = git(task.local_path, [
      'rev-parse', `refs/heads/${task.integration_branch}`,
    ]);
    if (!beforeHead) throw new Error(`PRODUCTION_CELL_INTEGRATION_TARGET_MISSING: ${task.integration_branch}`);
    // Integrate through Git's object database, never through the shared
    // checkout's working tree or index. Under the per-task worktree model each
    // author worker runs in its OWN desk (RepositoryDeskProvisioner provisions
    // a `task/<id>` worktree); the shared `local_path` checkout is NOT a worker
    // boundary. `git merge-tree --write-tree <beforeHead> <sourceCommit>`
    // operates purely on commits in the object DB — stray bytes in the shared
    // checkout's working tree or index can NEVER enter this merge, so a
    // DESK_DIRTY pre-check only blocks on benign leftover state (and loops
    // forever when multiple work items share one integration branch). The ref
    // advance below (update-ref CAS) is the authoritative integration; the
    // shared checkout is synced best-effort afterwards for operator convenience.
    const mergeTree = spawnSync('git', [
      '-C', task.local_path, 'merge-tree', '--write-tree', beforeHead, sourceCommit,
    ], { encoding: 'utf8', windowsHide: true });
    const integratedTree = mergeTree.status === 0
      ? mergeTree.stdout.trim().split(/\r?\n/, 1)[0]
      : null;
    if (!integratedTree) {
      this.db.prepare(
        `UPDATE tasks SET integration_state='conflict',updated_at=datetime('now') WHERE id=?`,
      ).run(task.id);
      return {
        outcome: 'repair_required',
        taskId: task.id,
        sourceCommit,
        sourceTree: sourceTree!,
        beforeHead: beforeHead!,
        reason: `PRODUCTION_CELL_INTEGRATION_CONFLICT: task ${task.id}`,
      };
    }
    const commit = spawnSync('git', [
      '-C', task.local_path, 'commit-tree', integratedTree,
      '-p', beforeHead, '-p', sourceCommit,
      '-m', `factory: integrate task #${task.id}`,
    ], { encoding: 'utf8', windowsHide: true });
    const afterHead = commit.status === 0 ? commit.stdout.trim() : null;
    if (!afterHead || afterHead === beforeHead) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_RESULT_INVALID: task ${task.id}`);
    }
    const update = spawnSync('git', [
      '-C', task.local_path, 'update-ref',
      `refs/heads/${task.integration_branch}`, afterHead, beforeHead,
    ], { encoding: 'utf8', windowsHide: true });
    if (update.status !== 0) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_TARGET_ADVANCED: task ${task.id}`);
    }
    // Best-effort: keep the shared checkout coherent with the ref we just
    // advanced, for operator convenience. The update-ref CAS above is the
    // authoritative integration; a failed sync here (e.g. the shared checkout
    // holds unrelated bytes) MUST NOT fail the integration or loop the effect —
    // the ref + object DB are the source of truth, and workers use per-task
    // worktrees, not this shared checkout.
    const synchronizeCheckout = spawnSync('git', [
      '-C', task.local_path, 'reset', '--hard', afterHead,
    ], { encoding: 'utf8', windowsHide: true });
    // Intentionally swallowed: the ref is already advanced. A dirty/locked
    // shared checkout does not invalidate the object-level integration.
    void synchronizeCheckout;
    this.db.prepare(
      `UPDATE tasks
          SET integration_state='merged',integrated_at=datetime('now'),
              integrated_commit=?,updated_at=datetime('now')
        WHERE id=?`,
    ).run(afterHead, task.id);
    return {
      outcome: 'succeeded',
      taskId: task.id,
      sourceCommit,
      sourceTree: sourceTree!,
      beforeHead: beforeHead!,
      afterHead: afterHead!,
      alreadyApplied: false,
    };
  }

  private readAcceptedProduct(input: SqliteProductionCellIntegrationInput): unknown {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    const rows = this.db.prepare(
      `SELECT m.product_schema AS schema_id,m.product_ref,m.product_digest
         FROM factory_candidate_sets cs
         JOIN factory_candidate_set_members m
           ON m.candidate_set_ref=cs.candidate_set_ref
        WHERE cs.candidate_set_ref=? AND cs.workplace_ref=?
          AND m.product_schema=?`,
    ).all(input.candidateSetRef, workplace, input.expectedProductSchema) as Array<{
      schema_id: string;
      product_ref: string;
      product_digest: string;
    }>;
    if (rows.length !== 1) {
      throw new Error(`PRODUCTION_CELL_INTEGRATION_PRODUCT_AMBIGUOUS: ${input.candidateSetRef}`);
    }
    const row = rows[0]!;
    return this.sealedProducts.readExact({
      schemaId: row.schema_id,
      ref: row.product_ref,
      digest: row.product_digest,
    });
  }
}

function git(repositoryPath: string, args: readonly string[]): string | null {
  const result = spawnSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isAncestor(repositoryPath: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', [
    '-C', repositoryPath, 'merge-base', '--is-ancestor', ancestor, descendant,
  ], { encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}
