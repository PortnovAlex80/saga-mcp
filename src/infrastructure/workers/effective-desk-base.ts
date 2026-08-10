import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';

export interface EffectiveDeskBaseTask {
  readonly id: number;
  readonly workplace_ref?: string | null;
  readonly project_repository_id?: number | null;
  readonly metadata?: unknown;
}

export interface EffectiveDeskBaseRepository {
  readonly id: number;
  readonly integrationBranch: string;
  readonly repositoryRoot: string;
}

export interface EffectiveDeskBaseReceipt {
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly executionRef: string;
  readonly taskId: number;
  readonly workplaceRef: string;
  readonly processRunId: number;
  readonly projectRepositoryId: number;
  readonly integrationBranch: string;
  readonly lineageAnchorCommit: string;
  readonly effectiveBaseCommit: string;
  readonly observedIntegrationHead: string;
  readonly dependencyTaskIds: readonly number[];
  readonly dependencyIntegratedCommits: readonly Readonly<{
    taskId: number;
    projectRepositoryId: number | null;
    commit: string | null;
  }>[];
}

interface DependencyRow {
  readonly id: number;
  readonly status: string;
  readonly execution_mode: string;
  readonly project_repository_id: number | null;
  readonly integration_state: string;
  readonly integrated_commit: string | null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number | null {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

function git(repositoryRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `EFFECTIVE_DESK_BASE_GIT_FAILED: git ${args.join(' ')} failed in `
      + `${repositoryRoot}: ${result.stderr?.trim() ?? ''}`,
    );
  }
  return result.stdout.trim();
}

function assertCommitExists(repositoryRoot: string, commit: string): void {
  const resolved = git(repositoryRoot, ['rev-parse', '--verify', `${commit}^{commit}`]);
  if (resolved !== commit) {
    throw new Error(
      `EFFECTIVE_DESK_BASE_COMMIT_MISMATCH: expected ${commit}, resolved ${resolved}`,
    );
  }
}

function assertAncestor(repositoryRoot: string, ancestor: string, descendant: string): void {
  const result = spawnSync(
    'git',
    ['-C', repositoryRoot, 'merge-base', '--is-ancestor', ancestor, descendant],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `EFFECTIVE_DESK_BASE_DEPENDENCY_NOT_IN_HEAD: dependency ${ancestor} `
      + `is not an ancestor of ${descendant}`,
    );
  }
}

function readLineageAnchor(
  db: Database.Database,
  task: EffectiveDeskBaseTask,
): { processRunId: number; commit: string } {
  const metadata = parseMetadata(task.metadata);
  const processRunId = positiveInteger(metadata.process_run_id);
  if (processRunId === null) {
    throw new Error(`EFFECTIVE_DESK_BASE_PROCESS_RUN_REQUIRED: task ${task.id}`);
  }
  const row = db.prepare(
    'SELECT input_snapshot FROM factory_process_runs WHERE id=?',
  ).get(processRunId) as { input_snapshot: string | null } | undefined;
  if (!row?.input_snapshot) {
    throw new Error(`EFFECTIVE_DESK_BASE_PROCESS_INPUT_REQUIRED: process ${processRunId}`);
  }
  const input = JSON.parse(row.input_snapshot) as {
    repositories?: Array<{
      projectRepositoryId?: unknown;
      expectedBaseCommit?: unknown;
    }>;
  };
  const target = input.repositories?.find(
    candidate => candidate.projectRepositoryId === task.project_repository_id,
  );
  const commit = target?.expectedBaseCommit;
  if (typeof commit !== 'string' || !commit) {
    throw new Error(
      `EFFECTIVE_DESK_BASE_LINEAGE_ANCHOR_REQUIRED: task ${task.id}, `
      + `repository ${String(task.project_repository_id)}`,
    );
  }
  return { processRunId, commit };
}

function readCanonicalDependencies(
  db: Database.Database,
  taskId: number,
  workplaceRef: string,
): DependencyRow[] {
  const graphItem = db.prepare(
    `SELECT graph_ref FROM factory_workplace_graph_items
      WHERE task_id=? AND workplace_ref=?`,
  ).get(taskId, workplaceRef) as { graph_ref: string } | undefined;
  if (!graphItem) {
    throw new Error(
      `EFFECTIVE_DESK_BASE_GRAPH_REQUIRED: task ${taskId} is not in a sealed Workplace graph`,
    );
  }
  return db.prepare(
    `SELECT predecessor.id,
            predecessor.status,
            predecessor.execution_mode,
            predecessor.project_repository_id,
            predecessor.integration_state,
            predecessor.integrated_commit
       FROM factory_workplace_dependencies dependency
       JOIN factory_workplace_graph_items predecessor_item
         ON predecessor_item.graph_ref=dependency.graph_ref
        AND predecessor_item.workplace_ref=dependency.depends_on_workplace_ref
       JOIN tasks predecessor ON predecessor.id=predecessor_item.task_id
      WHERE dependency.graph_ref=?
        AND dependency.workplace_ref=?
      ORDER BY predecessor.id`,
  ).all(graphItem.graph_ref, workplaceRef) as DependencyRow[];
}

function storedReceipt(db: Database.Database, executionRef: string): EffectiveDeskBaseReceipt | null {
  const row = db.prepare(
    `SELECT receipt_ref,receipt_digest,execution_ref,task_id,workplace_ref,
            process_run_id,project_repository_id,integration_branch,
            lineage_anchor_commit,effective_base_commit,observed_integration_head,
            dependency_task_ids,dependency_integrated_commits
       FROM factory_effective_desk_base_receipts WHERE execution_ref=?`,
  ).get(executionRef) as {
    receipt_ref: string;
    receipt_digest: string;
    execution_ref: string;
    task_id: number;
    workplace_ref: string;
    process_run_id: number;
    project_repository_id: number;
    integration_branch: string;
    lineage_anchor_commit: string;
    effective_base_commit: string;
    observed_integration_head: string;
    dependency_task_ids: string;
    dependency_integrated_commits: string;
  } | undefined;
  if (!row) return null;
  return {
    receiptRef: row.receipt_ref,
    receiptDigest: row.receipt_digest,
    executionRef: row.execution_ref,
    taskId: row.task_id,
    workplaceRef: row.workplace_ref,
    processRunId: row.process_run_id,
    projectRepositoryId: row.project_repository_id,
    integrationBranch: row.integration_branch,
    lineageAnchorCommit: row.lineage_anchor_commit,
    effectiveBaseCommit: row.effective_base_commit,
    observedIntegrationHead: row.observed_integration_head,
    dependencyTaskIds: JSON.parse(row.dependency_task_ids) as number[],
    dependencyIntegratedCommits: JSON.parse(row.dependency_integrated_commits) as Array<{
      taskId: number;
      projectRepositoryId: number | null;
      commit: string | null;
    }>,
  };
}

/**
 * Resolve and freeze the exact repository base for one author execution.
 * This is deliberately fail-closed: no sealed graph, missing predecessor
 * acceptance/integration, or Git lineage drift means no worker spawn.
 */
export function resolveEffectiveDeskBase(
  db: Database.Database,
  input: {
    readonly executionRef: string;
    readonly task: EffectiveDeskBaseTask;
    readonly repository: EffectiveDeskBaseRepository;
  },
): EffectiveDeskBaseReceipt {
  const existing = storedReceipt(db, input.executionRef);
  if (existing) return existing;

  const taskRepositoryId = input.task.project_repository_id;
  if (taskRepositoryId !== input.repository.id) {
    throw new Error(`EFFECTIVE_DESK_BASE_REPOSITORY_MISMATCH: task ${input.task.id}`);
  }
  const workplaceRef = input.task.workplace_ref;
  if (typeof workplaceRef !== 'string' || !workplaceRef) {
    throw new Error(`EFFECTIVE_DESK_BASE_WORKPLACE_REQUIRED: task ${input.task.id}`);
  }

  const lineage = readLineageAnchor(db, input.task);
  assertCommitExists(input.repository.repositoryRoot, lineage.commit);
  const dependencies = readCanonicalDependencies(db, input.task.id, workplaceRef);
  for (const dependency of dependencies) {
    if (dependency.status !== 'done') {
      throw new Error(
        `EFFECTIVE_DESK_BASE_DEPENDENCY_NOT_ACCEPTED: task ${dependency.id} `
        + `is ${dependency.status}`,
      );
    }
    if (
      dependency.execution_mode === 'git_change'
      && dependency.project_repository_id === input.repository.id
      && (dependency.integration_state !== 'merged' || !dependency.integrated_commit)
    ) {
      throw new Error(
        `EFFECTIVE_DESK_BASE_DEPENDENCY_NOT_INTEGRATED: task ${dependency.id}`,
      );
    }
  }

  const observedIntegrationHead = git(input.repository.repositoryRoot, [
    'rev-parse',
    `refs/heads/${input.repository.integrationBranch}`,
  ]);
  const sameRepositoryCommits = dependencies
    .filter(dependency => dependency.project_repository_id === input.repository.id)
    .map(dependency => dependency.integrated_commit)
    .filter((commit): commit is string => typeof commit === 'string' && commit.length > 0);
  for (const commit of sameRepositoryCommits) {
    assertAncestor(input.repository.repositoryRoot, commit, observedIntegrationHead);
  }

  const dependencyTaskIds = dependencies.map(dependency => dependency.id);
  const dependencyIntegratedCommits = dependencies.map(dependency => ({
    taskId: dependency.id,
    projectRepositoryId: dependency.project_repository_id,
    commit: dependency.integrated_commit,
  }));
  const effectiveBaseCommit = dependencies.length > 0
    ? observedIntegrationHead
    : lineage.commit;
  const digestInput = {
    schema: 'factory.effective-desk-base-receipt.v1',
    executionRef: input.executionRef,
    taskId: input.task.id,
    workplaceRef,
    processRunId: lineage.processRunId,
    projectRepositoryId: input.repository.id,
    integrationBranch: input.repository.integrationBranch,
    lineageAnchorCommit: lineage.commit,
    effectiveBaseCommit,
    observedIntegrationHead,
    dependencyTaskIds,
    dependencyIntegratedCommits,
  } as const;
  const receiptDigest = sha256Hex(digestInput);
  const receiptRef = `effective-desk-base:${receiptDigest}`;

  db.prepare(
    `INSERT INTO factory_effective_desk_base_receipts
      (receipt_ref,execution_ref,task_id,workplace_ref,process_run_id,
       project_repository_id,integration_branch,lineage_anchor_commit,
       effective_base_commit,observed_integration_head,dependency_task_ids,
       dependency_integrated_commits,receipt_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    receiptRef,
    input.executionRef,
    input.task.id,
    workplaceRef,
    lineage.processRunId,
    input.repository.id,
    input.repository.integrationBranch,
    lineage.commit,
    effectiveBaseCommit,
    observedIntegrationHead,
    JSON.stringify(dependencyTaskIds),
    JSON.stringify(dependencyIntegratedCommits),
    receiptDigest,
  );

  return {
    receiptRef,
    receiptDigest,
    ...digestInput,
  };
}
