/**
 * SQLite implementation of the Development module's DECLARATIVE persistence
 * ports:
 *
 *   DevelopmentTaskGraphPort   — persist a validated task graph and atomically
 *                                find-or-create its projected kanban tasks.
 *   DevelopmentSettlementStatePort — re-read exact tracker state (validated
 *                                task graph, projected tasks + integration
 *                                state, recorded verification evidence) and
 *                                reconstruct the DevelopmentSettlementInput.
 *
 * This file replaced the deleted `sqlite-development-runtime.ts`. The runtime
 * mixed these declarative ports with THREE executive ports (worker hiring,
 * merge integration, verification driving). Under the Formalization mechanical
 * pattern those executive concerns belong to the INFRASTRUCTURE (workers claim
 * projected tasks through the shared worker_next queue, merge via
 * worker_merge_release, record evidence via verification_record); the module
 * only reads/decides/persists. Hence this store implements exactly two ports
 * and no execution.
 *
 * Reconstruction rule (Q1=A): the implementation workset, integrated release
 * candidate and acceptance-verification workset are INNER data of the
 * DevelopmentSettlementInput, built here from tracker state. They are NOT
 * produced by dedicated Flow nodes and are NOT persisted to the process-product
 * store; settlement consumes them in memory.
 */

import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';
import type {
  DevelopmentArtifactSnapshot,
  DevelopmentCanonicalGraphPort,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
  DevelopmentTraceSnapshot,
  GitPort,
  MachinePort,
  ProcessProductRepositoryPort,
} from '../domain/development-kernel-ports.js';
import {
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  type AcceptanceVerificationWorkset,
  type CandidateRepositorySnapshot,
  type CandidateVerificationEvidence,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentImplementationWorkset,
  type DevelopmentSettlementInput,
  type DevelopmentTaskGraphItem,
  type DevelopmentTaskGraphSnapshot,
  type ImplementationWorkItemResult,
  type IntegratedReleaseCandidate,
  type VerificationProviderBinding,
} from '../domain/development-schemas.js';
import {
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
} from '../domain/development-settlement-policy.js';

const PROCESS_PRODUCT_KIND_TASK_GRAPH = 'development.task-graph';

const TASK_RESULT_SCHEMA = 'factory.development-task-result.v1';
const VERIFICATION_EVIDENCE_REF_SCHEMA =
  'factory.candidate-verification-evidence.v1';
const MODULE_REF = 'solution-development@1.0.0';
const RESOLVE_NODE_ID = 'resolve-task-graph';

interface ProjectedTaskRow {
  task_id: number;
  work_item_key: string;
  item_kind: 'implementation' | 'verification';
}

interface RuntimeTaskRow {
  id: number;
  status: string;
  integration_state: string;
  integrated_commit: string | null;
  project_repository_id: number | null;
  metadata: string;
}

/**
 * SQLite-backed Development module store. Implements the declarative ports over
 * the shared tracker tables (tasks, task_dependencies, worker_executions,
 * integration_intents, verification_evidence, artifacts, artifact_traces) and
 * the module-owned projection tables installed by
 * {@link ensureDevelopmentStoreSchema}.
 *
 *   DevelopmentTaskGraphPort        — persist + project
 *   DevelopmentSettlementStatePort  — re-read + reconstruct settlement input
 *   DevelopmentCanonicalGraphPort   — re-read exact artifacts/traces by id
 */
export class SqliteDevelopmentModuleStore implements
  DevelopmentTaskGraphPort,
  DevelopmentSettlementStatePort,
  DevelopmentCanonicalGraphPort {
  private readonly db: Database.Database;
  private readonly products: ProcessProductRepositoryPort;
  private readonly git: GitPort;
  private readonly machine: MachinePort;

  constructor(
    db: Database.Database,
    products: ProcessProductRepositoryPort,
    git: GitPort,
    machine: MachinePort,
  ) {
    this.db = db;
    this.products = products;
    // Wave 7 hex extraction: git shell-outs and machine identity are injected
    // as ports — the module has no child_process / node:os imports.
    this.git = git;
    this.machine = machine;
    ensureDevelopmentStoreSchema(db);
  }

  // ----- DevelopmentTaskGraphPort --------------------------------------

  materializeValidatedTaskGraph(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    graph: DevelopmentTaskGraphSnapshot;
  }): {
    graph: DevelopmentTaskGraphSnapshot;
    reference: ContentAddressedReference;
  } {
    const existing = this.products.read<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_TASK_GRAPH,
    );
    if (existing) {
      assertStoredGraph(existing, input.graph);
      this.assertTaskProjection(input.processRunId, input.graph);
      return { graph: existing.payload, reference: existing.reference };
    }

    const materialize = this.db.transaction(() => {
      this.assertDevelopmentScope(input.developmentCase);
      const allItems = [
        ...input.graph.implementationItems,
        ...input.graph.verificationItems,
      ];
      const taskIdByKey = new Map<string, number>();
      allItems.forEach((item, ordinal) => {
        const taskId = this.findOrCreateProjectedTask({
          processRunId: input.processRunId,
          developmentCase: input.developmentCase,
          graph: input.graph,
          item,
          ordinal,
        });
        taskIdByKey.set(item.key, taskId);
      });
      for (const item of allItems) {
        const taskId = requireMapValue(taskIdByKey, item.key);
        const dependencyIds = item.dependsOnKeys.map(key =>
          requireMapValue(taskIdByKey, key));
        this.replaceDependencies(taskId, dependencyIds);
      }
      const stored = this.products.persist({
        processRunId: input.processRunId,
        productKind: PROCESS_PRODUCT_KIND_TASK_GRAPH,
        schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
        productHash: input.graph.graphHash,
        payload: input.graph,
        artifactRefPrefix: 'development-task-graph',
      });
      return stored.record;
    })();

    return {
      graph: materialize.payload,
      reference: materialize.reference,
    };
  }

  // ----- DevelopmentSettlementStatePort --------------------------------

  buildSettlementInput(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): DevelopmentSettlementInput {
    const taskGraphProduct = this.products.read<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_TASK_GRAPH,
    );
    const taskGraph = taskGraphProduct?.payload ?? null;
    const taskGraphRef = taskGraphProduct?.reference ?? null;

    // Reconstruct the three inner worksets directly from tracker state. They
    // are not persisted to the process-product store; settlement consumes them
    // in memory.
    const implementation = taskGraph
      ? this.buildImplementationWorkset(
        input.processRunId,
        taskGraph,
      )
      : null;
    const candidate = implementation && taskGraph
      ? this.buildIntegratedCandidate(
        input.processRunId,
        input.developmentCase,
        taskGraph,
        implementation,
      )
      : null;
    const verification = candidate && taskGraph
      ? this.buildAcceptanceVerification(
        input.processRunId,
        input.developmentCase,
        taskGraph,
        candidate,
      )
      : null;

    const observedCandidateHash = candidate
      ? this.observeCandidate(candidate)
      : null;
    const projectedIds = this.readProjectedTasks(input.processRunId)
      .map(row => row.task_id);
    const openHumanGateIds = projectedIds.length === 0
      ? []
      : this.readOpenHumanGateIds(projectedIds);

    return {
      schemaVersion: DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
      developmentCase: input.developmentCase,
      taskGraph,
      implementationWorkset: implementation,
      integratedCandidate: candidate,
      observedCandidateHash,
      acceptanceVerification: verification,
      productReferences: {
        taskGraph: taskGraphRef,
        implementationWorkset: implementation
          ? refOfWorkset(input.processRunId, implementation)
          : null,
        integratedCandidate: candidate
          ? refOfCandidate(input.processRunId, candidate)
          : null,
        acceptanceVerification: verification
          ? refOfVerification(input.processRunId, verification)
          : null,
      },
      openHumanGateIds,
    };
  }

  areProjectedTasksTerminal(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): boolean {
    const projectedIds = this.readProjectedTasks(input.processRunId)
      .map(row => row.task_id);
    if (projectedIds.length === 0) return true;
    const rows = this.readRuntimeTasks(projectedIds);
    // A projected task is terminal when it is blocked, or done with a settled
    // integration_state (merged / conflict / not_required). While any task is
    // still todo/in_progress/review, settle-development must pause so the
    // conveyor can drain the shared worker_next queue.
    return rows.length === projectedIds.length && rows.every(row =>
      row.status === 'blocked'
      || (
        row.status === 'done'
        && (
          row.integration_state === 'not_required'
          || row.integration_state === 'merged'
          || row.integration_state === 'conflict'
        )
      ));
  }

  // ----- inner workset reconstruction ---------------------------------

  private buildImplementationWorkset(
    processRunId: number,
    taskGraph: DevelopmentTaskGraphSnapshot,
  ): DevelopmentImplementationWorkset | null {
    if (taskGraph.implementationItems.length === 0) return null;
    const projections = this.readProjectedTasks(processRunId, 'implementation');
    assertProjectionKeys(
      projections,
      taskGraph.implementationItems.map(item => item.key),
      'implementation',
    );
    const projectionByKey = new Map(
      projections.map(row => [row.work_item_key, row]),
    );
    const results = taskGraph.implementationItems.map(item =>
      this.buildImplementationResult(
        item,
        requireMapValue(projectionByKey, item.key).task_id,
      ));
    const requiredKeys = new Set(
      taskGraph.implementationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const blockingItemKeys = results
      .filter(result =>
        requiredKeys.has(result.key) && result.status !== 'succeeded')
      .map(result => result.key)
      .sort();
    const body = {
      schemaVersion: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      taskGraphHash: taskGraph.graphHash,
      results,
      complete: blockingItemKeys.length === 0,
      blockingItemKeys,
    } as const;
    return {
      ...body,
      worksetHash: hashImplementationWorkset({ ...body, worksetHash: '' }),
    };
  }

  private buildImplementationResult(
    item: DevelopmentTaskGraphItem,
    taskId: number,
  ): ImplementationWorkItemResult {
    const task = this.readRuntimeTask(taskId);
    const executions = this.db.prepare(
      `SELECT execution_id,state,last_error,reserved_at
         FROM worker_executions
        WHERE task_id=?
        ORDER BY reserved_at,execution_id`,
    ).all(taskId) as Array<{
      execution_id: string;
      state: string;
      last_error: string | null;
      reserved_at: string;
    }>;
    const implementationExecutionId = executions[0]?.execution_id ?? null;
    const reviewExecutionId = executions.length >= 2
      ? executions[executions.length - 1]!.execution_id
      : null;
    const reviewedSourceCommit = this.readReviewedSourceCommit(task);
    const terminalReady = task.status === 'done'
      && (
        item.executionMode === 'git_change'
          ? task.integration_state === 'merged'
          : task.integration_state === 'not_required'
      );
    const proofComplete = implementationExecutionId !== null
      && reviewExecutionId !== null
      && reviewedSourceCommit !== null;

    const reasonCodes: string[] = [];
    let status: ImplementationWorkItemResult['status'];
    if (task.status === 'blocked' || task.integration_state === 'conflict') {
      status = 'blocked';
      reasonCodes.push(
        task.integration_state === 'conflict'
          ? 'integration-conflict'
          : 'task-blocked',
      );
    } else if (terminalReady && proofComplete) {
      status = 'succeeded';
    } else if (
      executions.some(execution =>
        execution.state === 'spawn_failed'
        || (
          execution.state === 'exited'
          && execution.last_error !== null
        ))
    ) {
      status = 'failed';
      reasonCodes.push('worker-execution-failed');
    } else {
      status = 'blocked';
      if (!terminalReady) reasonCodes.push('task-not-terminal');
      if (!proofComplete) reasonCodes.push('review-proof-incomplete');
    }

    const resultBody = status === 'succeeded'
      ? {
        taskId,
        workItemKey: item.key,
        implementationExecutionId,
        reviewExecutionId,
        reviewedSourceCommit,
        integratedCommit: task.integrated_commit,
        comments: this.db.prepare(
          `SELECT author,content,created_at
             FROM comments WHERE task_id=? ORDER BY id`,
        ).all(taskId),
      }
      : null;
    return {
      key: item.key,
      status,
      taskId,
      implementationExecutionId,
      reviewExecutionId,
      reviewedSourceCommit,
      result: resultBody === null
        ? null
        : {
          schema: TASK_RESULT_SCHEMA,
          ref: `development-task-result:${taskId}`,
          hash: sha256Hex(resultBody),
        },
      reasonCodes,
    };
  }

  private buildIntegratedCandidate(
    processRunId: number,
    developmentCase: DevelopmentCase,
    taskGraph: DevelopmentTaskGraphSnapshot,
    workset: DevelopmentImplementationWorkset,
  ): IntegratedReleaseCandidate | null {
    // Only freeze a candidate once required implementation is complete; a
    // partial workset means integration has not happened yet.
    const requiredKeys = new Set(
      taskGraph.implementationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const requiredSucceeded = workset.results.every(result =>
      !requiredKeys.has(result.key) || result.status === 'succeeded');
    if (!workset.complete || !requiredSucceeded) return null;

    try {
      const repositories = developmentCase.repositories
        .map(binding => this.observeRepository(
          developmentCase.projectId,
          binding.projectRepositoryId,
          binding.integrationBranch,
          binding.expectedBaseCommit,
        ))
        .sort((left, right) =>
          left.projectRepositoryId - right.projectRepositoryId);
      const integrationIntentRefs =
        this.collectIntegrationIntentRefs(processRunId, taskGraph, workset);
      const buildProducts = repositories.map(repository => ({
        kind: 'source-tree',
        ref:
          `project-repository:${repository.projectRepositoryId}`
          + `:branch:${repository.branch}:commit:${repository.commitSha}`,
        digest: repository.treeHash,
      }));
      const body: Omit<IntegratedReleaseCandidate, 'candidateHash'> = {
        schemaVersion: INTEGRATED_CANDIDATE_SCHEMA,
        taskGraphHash: taskGraph.graphHash,
        implementationWorksetHash: workset.worksetHash,
        repositories,
        buildProducts,
        integrationIntentRefs,
        frozen: true as const,
      };
      return {
        ...body,
        candidateHash: hashIntegratedCandidate({
          ...body,
          candidateHash: '',
        }),
      };
    } catch {
      return null;
    }
  }

  private buildAcceptanceVerification(
    processRunId: number,
    developmentCase: DevelopmentCase,
    taskGraph: DevelopmentTaskGraphSnapshot,
    candidate: IntegratedReleaseCandidate,
  ): AcceptanceVerificationWorkset | null {
    if (taskGraph.verificationItems.length === 0) return null;
    const projections = this.readProjectedTasks(processRunId, 'verification');
    assertProjectionKeys(
      projections,
      taskGraph.verificationItems.map(item => item.key),
      'verification',
    );
    const projectionByKey = new Map(
      projections.map(row => [row.work_item_key, row]),
    );
    const criterionById = new Map(
      developmentCase.acceptanceCriteria.map(criterion => [
        criterion.artifactId,
        criterion,
      ]),
    );
    const evidence: CandidateVerificationEvidence[] = [];
    for (const item of taskGraph.verificationItems) {
      const taskId = requireMapValue(projectionByKey, item.key).task_id;
      const criterionId = item.acceptanceCriterionIds[0];
      if (criterionId === undefined) continue;
      const criterion = criterionById.get(criterionId);
      if (!criterion) continue;
      const row = this.readVerificationEvidence(
        taskId,
        criterionId,
        criterion.acceptedHash,
      );
      if (!row) continue;
      evidence.push({
        verificationItemKey: item.key,
        taskId,
        executionId: row.execution_id,
        acceptanceCriterionId: criterionId,
        acceptedCriterionHash: criterion.acceptedHash,
        candidateHash: candidate.candidateHash,
        outcome: row.outcome,
        evidence: {
          schema: VERIFICATION_EVIDENCE_REF_SCHEMA,
          ref: `verification-evidence:${row.id}`,
          hash: sha256Hex({
            id: row.id,
            taskId,
            artifactId: criterionId,
            outcome: row.outcome,
            evidence: row.evidence,
            contentHash: row.content_hash,
            executionId: row.execution_id,
          }),
        },
        provider: this.resolveVerificationProvider(
          developmentCase.projectId,
          row.provider,
        ),
      });
    }

    const requiredCount = taskGraph.verificationItems
      .filter(item => item.required).length;
    const complete = evidence.length === requiredCount;
    const body: Omit<AcceptanceVerificationWorkset, 'verificationHash'> = {
      schemaVersion: ACCEPTANCE_VERIFICATION_SCHEMA,
      acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
      candidateHash: candidate.candidateHash,
      evidence: evidence.sort((left, right) =>
        left.verificationItemKey.localeCompare(right.verificationItemKey)),
      complete,
    };
    return {
      ...body,
      verificationHash: hashAcceptanceVerification({
        ...body,
        verificationHash: '',
      }),
    };
  }

  // ----- DevelopmentCanonicalGraphPort --------------------------------

  readArtifactsByIds(ids: readonly number[]): readonly DevelopmentArtifactSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, project_id, epic_id, type, code, status, content_hash,
              accepted_hash, drift_state, tags, metadata
         FROM artifacts
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      project_id: number;
      epic_id: number;
      type: string;
      code: string | null;
      status: string;
      content_hash: string | null;
      accepted_hash: string | null;
      drift_state: string;
      tags: string;
      metadata: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      type: row.type,
      code: row.code,
      status: row.status,
      contentHash: row.content_hash,
      acceptedHash: row.accepted_hash,
      driftState: row.drift_state,
      tags: parseTags(row.tags),
      metadata: parseMetadata(row.metadata),
    }));
  }

  readTracesByIds(ids: readonly number[]): readonly DevelopmentTraceSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      sourceArtifactId: row.source_id,
      targetType: row.target_type,
      targetId: row.target_id,
      linkType: row.link_type,
    }));
  }

  readOutgoingArtifactTraces(
    sourceArtifactIds: readonly number[],
  ): readonly DevelopmentTraceSnapshot[] {
    const unique = [...new Set(sourceArtifactIds.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE source_id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      sourceArtifactId: row.source_id,
      targetType: row.target_type,
      targetId: row.target_id,
      linkType: row.link_type,
    }));
  }

  // ----- tracker readers ----------------------------------------------

  private readProjectedTasks(
    processRunId: number,
    kind?: 'implementation' | 'verification',
  ): ProjectedTaskRow[] {
    const whereKind = kind ? ' AND item_kind=?' : '';
    const params: unknown[] = kind
      ? [processRunId, kind]
      : [processRunId];
    return this.db.prepare(
      `SELECT task_id,work_item_key,item_kind
         FROM factory_development_task_projections
        WHERE process_run_id=?${whereKind}
        ORDER BY work_item_key`,
    ).all(...params) as ProjectedTaskRow[];
  }

  private readRuntimeTask(taskId: number): RuntimeTaskRow {
    // Conveyor v4 step 3.C.4 read-switch: in cutover mode the task's status is
    // the AUTHORITATIVE factory_workplaces kanban_phase (reverse-projected to the
    // legacy status vocabulary). integration_state / integrated_commit /
    // project_repository_id / metadata are DATA columns and stay on tasks.
    const cutover = true;
    const row = (cutover
      ? this.db.prepare(
          `SELECT t.id,
                  COALESCE(
                    CASE w.kanban_phase
                      WHEN 'todo' THEN 'todo'
                      WHEN 'in_progress' THEN 'in_progress'
                      WHEN 'review' THEN 'review'
                      WHEN 'review_in_progress' THEN 'review_in_progress'
                      WHEN 'blocked' THEN 'blocked'
                      WHEN 'done' THEN 'done'
                      WHEN 'failed' THEN 'done'
                      WHEN 'cancelled' THEN 'done'
                      ELSE NULL
                    END, t.status) AS status,
                  t.integration_state, t.integrated_commit,
                  t.project_repository_id, t.metadata
             FROM tasks t
             LEFT JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
            WHERE t.id=?`,
        ).get(taskId)
      : this.db.prepare(
          `SELECT id,status,integration_state,integrated_commit,
                  project_repository_id,metadata
             FROM tasks WHERE id=?`,
        ).get(taskId)
    ) as RuntimeTaskRow | undefined;
    if (!row) throw new Error(`DEVELOPMENT_TASK_NOT_FOUND: ${taskId}`);
    return row;
  }

  private readRuntimeTasks(taskIds: readonly number[]): RuntimeTaskRow[] {
    if (taskIds.length === 0) return [];
    // Conveyor v4 step 3.C.4 read-switch (see readRuntimeTask).
    const cutover = true;
    return (cutover
      ? this.db.prepare(
          `SELECT t.id,
                  COALESCE(
                    CASE w.kanban_phase
                      WHEN 'todo' THEN 'todo'
                      WHEN 'in_progress' THEN 'in_progress'
                      WHEN 'review' THEN 'review'
                      WHEN 'review_in_progress' THEN 'review_in_progress'
                      WHEN 'blocked' THEN 'blocked'
                      WHEN 'done' THEN 'done'
                      WHEN 'failed' THEN 'done'
                      WHEN 'cancelled' THEN 'done'
                      ELSE NULL
                    END, t.status) AS status,
                  t.integration_state, t.integrated_commit,
                  t.project_repository_id, t.metadata
             FROM tasks t
             LEFT JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
            WHERE t.id IN (${taskIds.map(() => '?').join(',')})`,
        ).all(...taskIds)
      : this.db.prepare(
          `SELECT id,status,integration_state,integrated_commit,
                  project_repository_id,metadata
             FROM tasks
            WHERE id IN (${taskIds.map(() => '?').join(',')})`,
        ).all(...taskIds)
    ) as RuntimeTaskRow[];
  }

  private readReviewedSourceCommit(task: RuntimeTaskRow): string | null {
    const intent = this.db.prepare(
      `SELECT reviewed_source_sha
         FROM integration_intents
        WHERE task_id=?
          AND state='merged'
        ORDER BY updated_at DESC
        LIMIT 1`,
    ).get(task.id) as { reviewed_source_sha: string } | undefined;
    if (intent?.reviewed_source_sha) return intent.reviewed_source_sha;
    if (task.project_repository_id === null) {
      return task.integrated_commit;
    }
    const repository = this.readRepositoryPath(task.project_repository_id);
    if (!repository) return null;
    return this.git.read(repository.localPath, [
      'rev-parse',
      `refs/heads/task/${task.id}`,
    ]);
  }

  private readRepositoryPath(
    projectRepositoryId: number,
  ): {
    projectId: number;
    localPath: string;
  } | null {
    const row = this.db.prepare(
      `SELECT pr.project_id,
              COALESCE(rc.local_path,pr.local_path) AS local_path
         FROM project_repositories pr
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id
          AND rc.machine_id=?
          AND rc.status='active'
        WHERE pr.id=? AND pr.status='active'`,
    ).get(this.machine.hostname(), projectRepositoryId) as {
      project_id: number;
      local_path: string | null;
    } | undefined;
    return row?.local_path
      ? { projectId: row.project_id, localPath: row.local_path }
      : null;
  }

  private observeRepository(
    projectId: number,
    projectRepositoryId: number,
    branch: string,
    expectedBaseCommit: string,
  ): CandidateRepositorySnapshot {
    const repository = this.readRepositoryPath(projectRepositoryId);
    if (!repository || repository.projectId !== projectId) {
      throw new Error(
        `DEVELOPMENT_REPOSITORY_CHECKOUT_MISSING: ${projectRepositoryId}`,
      );
    }
    const commitSha = this.git.read(repository.localPath, [
      'rev-parse',
      `refs/heads/${branch}`,
    ]);
    if (!commitSha) {
      throw new Error(
        `DEVELOPMENT_REPOSITORY_BRANCH_MISSING: `
        + `${projectRepositoryId}/${branch}`,
      );
    }
    if (
      !this.git.ok(repository.localPath, [
        'merge-base',
        '--is-ancestor',
        expectedBaseCommit,
        commitSha,
      ])
    ) {
      throw new Error(
        `DEVELOPMENT_REPOSITORY_BASE_MISMATCH: ${projectRepositoryId}`,
      );
    }
    const treeHash = this.git.read(repository.localPath, [
      'rev-parse',
      `${commitSha}^{tree}`,
    ]);
    if (!treeHash) {
      throw new Error(
        `DEVELOPMENT_REPOSITORY_TREE_MISSING: ${projectRepositoryId}`,
      );
    }
    return { projectRepositoryId, branch, commitSha, treeHash };
  }

  private observeCandidate(
    candidate: IntegratedReleaseCandidate,
  ): string | null {
    try {
      const repositories = candidate.repositories.map(repository => {
        const binding = this.readRepositoryPath(repository.projectRepositoryId);
        if (!binding) throw new Error('checkout missing');
        const commitSha = this.git.read(binding.localPath, [
          'rev-parse',
          `refs/heads/${repository.branch}`,
        ]);
        if (!commitSha) throw new Error('branch missing');
        const treeHash = this.git.read(binding.localPath, [
          'rev-parse',
          `${commitSha}^{tree}`,
        ]);
        if (!treeHash) throw new Error('tree missing');
        return {
          projectRepositoryId: repository.projectRepositoryId,
          branch: repository.branch,
          commitSha,
          treeHash,
        };
      });
      const buildProducts = candidate.buildProducts.map(product => {
        if (product.kind !== 'source-tree') return product;
        const repository = repositories.find(item =>
          product.ref.includes(
            `project-repository:${item.projectRepositoryId}:`,
          ));
        return repository
          ? { ...product, digest: repository.treeHash }
          : product;
      });
      return hashIntegratedCandidate({
        ...candidate,
        repositories,
        buildProducts,
      });
    } catch {
      return null;
    }
  }

  private collectIntegrationIntentRefs(
    processRunId: number,
    graph: DevelopmentTaskGraphSnapshot,
    workset: DevelopmentImplementationWorkset,
  ): string[] {
    const resultByKey = new Map(
      workset.results.map(result => [result.key, result]),
    );
    const projectionByKey = new Map(
      this.readProjectedTasks(processRunId, 'implementation')
        .map(row => [row.work_item_key, row]),
    );
    const references: string[] = [];
    for (const target of graph.integrationTargets) {
      for (const key of target.sourceWorkItemKeys) {
        const result = resultByKey.get(key);
        const projection = projectionByKey.get(key);
        if (
          !result
          || result.status !== 'succeeded'
          || !result.reviewedSourceCommit
          || !projection
        ) {
          throw new Error(`DEVELOPMENT_INTEGRATION_PROOF_MISSING: ${key}`);
        }
        const task = this.readRuntimeTask(projection.task_id);
        if (
          task.integration_state !== 'merged'
          || !task.integrated_commit
        ) {
          throw new Error(`DEVELOPMENT_INTEGRATION_NOT_MERGED: ${key}`);
        }
        references.push(
          `development-integration:${processRunId}:${projection.task_id}:`
          + sha256Hex({
            projectRepositoryId: target.projectRepositoryId,
            taskId: projection.task_id,
            workItemKey: key,
            reviewedSourceCommit: result.reviewedSourceCommit,
            targetBranch: target.targetBranch,
            integratedCommit: task.integrated_commit,
          }),
        );
      }
    }
    return [...new Set(references)].sort();
  }

  private readVerificationEvidence(
    taskId: number,
    artifactId: number,
    acceptedHash: string,
  ): {
    id: number;
    outcome: CandidateVerificationEvidence['outcome'];
    evidence: string;
    content_hash: string | null;
    provider: string | null;
    execution_id: string | null;
  } | null {
    const row = this.db.prepare(
      `SELECT id,outcome,evidence,content_hash,provider,execution_id
         FROM verification_evidence
        WHERE task_id=? AND artifact_id=? AND content_hash=?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(taskId, artifactId, acceptedHash) as {
      id: number;
      outcome: CandidateVerificationEvidence['outcome'];
      evidence: string;
      content_hash: string | null;
      provider: string | null;
      execution_id: string | null;
    } | undefined;
    return row ?? null;
  }

  private resolveVerificationProvider(
    projectId: number,
    providerName: string | null,
  ): VerificationProviderBinding {
    const normalized = providerName?.trim() ?? '';
    const row = normalized
      ? this.db.prepare(
        `SELECT id,name,version,category,status
           FROM trusted_providers
          WHERE name=?
            AND category='deterministic_evidence'
            AND status='active'
            AND (project_id=? OR project_id IS NULL)
          ORDER BY project_id IS NOT NULL DESC,id
          LIMIT 1`,
      ).get(normalized, projectId) as {
        id: number;
        name: string;
        version: string | null;
        category: 'deterministic_evidence';
        status: string;
      } | undefined
      : undefined;
    return row
      ? {
        providerId: row.id,
        name: row.name,
        version: row.version,
        category: 'deterministic_evidence',
        trusted: true,
      }
      : {
        providerId: 0,
        name: normalized || 'unregistered',
        version: null,
        category: 'deterministic_evidence',
        trusted: false,
      };
  }

  private readOpenHumanGateIds(taskIds: number[]): string[] {
    return (this.db.prepare(
      `SELECT request_id
         FROM human_requests
        WHERE state='open'
          AND task_id IN (${taskIds.map(() => '?').join(',')})
        ORDER BY request_id`,
    ).all(...taskIds) as Array<{ request_id: string }>)
      .map(row => row.request_id);
  }

  // ----- graph projection (materializeValidatedTaskGraph) -------------

  private findOrCreateProjectedTask(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    graph: DevelopmentTaskGraphSnapshot;
    item: DevelopmentTaskGraphItem;
    ordinal: number;
  }): number {
    const generationKey = taskGenerationKey(
      input.processRunId,
      input.graph.graphHash,
      input.item.key,
    );
    const existing = this.db.prepare(
      `SELECT id,epic_id,task_kind,workflow_stage,execution_skill,
              execution_mode,project_repository_id,
              verification_target_artifact_id,generation_key,metadata
         FROM tasks
        WHERE epic_id=? AND generation_key=?`,
    ).get(
      input.developmentCase.epicId,
      generationKey,
    ) as {
      id: number;
      epic_id: number;
      task_kind: string | null;
      workflow_stage: string | null;
      execution_skill: string | null;
      execution_mode: string;
      project_repository_id: number | null;
      verification_target_artifact_id: number | null;
      generation_key: string;
      metadata: string;
    } | undefined;
    const verificationTarget = input.item.kind === 'verification'
      ? input.item.acceptanceCriterionIds[0] ?? null
      : null;
    const workflowStage = input.item.kind === 'verification'
      ? 'verification'
      : 'development';
    // Stamp each projected task with the ProcessRun input hash + the planner's
    // WorkIntent so managed-production provenance is complete for the workers
    // that later claim these tasks through worker_next.
    const processRun = this.db.prepare(
      'SELECT input_hash FROM factory_process_runs WHERE id=?',
    ).get(input.processRunId) as { input_hash: string } | undefined;
    const plannerIntent = this.db.prepare(
      `SELECT wi.id AS work_intent_id
         FROM factory_work_intents wi
         JOIN tasks t ON t.id = wi.projected_task_id
        WHERE t.metadata LIKE ?
          AND t.epic_id = ?
        ORDER BY wi.id DESC LIMIT 1`,
    ).get(
      `%"process_run_id":${input.processRunId}%`,
      input.developmentCase.epicId,
    ) as { work_intent_id: number } | undefined;
    const metadata = {
      process_run_id: input.processRunId,
      process_node_id: RESOLVE_NODE_ID,
      process_module_ref: MODULE_REF,
      process_input_hash: processRun?.input_hash ?? null,
      work_intent_id: plannerIntent?.work_intent_id ?? null,
      task_graph_hash: input.graph.graphHash,
      work_item_key: input.item.key,
      work_item_kind: input.item.kind,
      acceptance_criterion_ids: [...input.item.acceptanceCriterionIds],
      candidate_hash: null,
    };

    let taskId: number;
    if (existing) {
      if (
        existing.epic_id !== input.developmentCase.epicId
        || existing.task_kind !== input.item.taskKind
        || existing.workflow_stage !== workflowStage
        || existing.execution_skill !== input.item.executionSkill
        || existing.execution_mode !== input.item.executionMode
        || existing.project_repository_id !== input.item.projectRepositoryId
        || existing.verification_target_artifact_id !== verificationTarget
        || existing.generation_key !== generationKey
        || !metadataProjectionMatches(existing.metadata, metadata)
      ) {
        throw new Error(
          `DEVELOPMENT_TASK_PROJECTION_MISMATCH: ${input.item.key}`,
        );
      }
      taskId = existing.id;
    } else {
      const info = this.db.prepare(
        `INSERT INTO tasks
          (epic_id,title,description,status,priority,sort_order,task_kind,
           workflow_stage,execution_skill,review_skill,execution_mode,
           project_repository_id,verification_target_artifact_id,
           generation_key,tags,metadata)
         VALUES (?,?,?,'todo','medium',?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.developmentCase.epicId,
        `${input.item.kind === 'verification' ? 'Verify' : 'Implement'}: `
          + input.item.key,
        `ProcessRun ${input.processRunId}; graph ${input.graph.graphHash}; `
          + `accepted criteria: ${input.item.acceptanceCriterionIds.join(', ')}`,
        input.ordinal,
        input.item.taskKind,
        workflowStage,
        input.item.executionSkill,
        input.item.kind === 'verification'
          ? 'saga-reviewer'
          : 'saga-reviewer',
        input.item.executionMode,
        input.item.projectRepositoryId,
        verificationTarget,
        generationKey,
        canonicalJson([
          'process-module:solution-development',
          `development-work-item:${input.item.key}`,
        ]),
        canonicalJson(metadata),
      );
      taskId = Number(info.lastInsertRowid);
    }

    this.db.prepare(
      `INSERT INTO factory_development_task_projections
        (process_run_id,graph_hash,work_item_key,item_kind,task_id)
       VALUES (?,?,?,?,?)
       ON CONFLICT(process_run_id,work_item_key) DO NOTHING`,
    ).run(
      input.processRunId,
      input.graph.graphHash,
      input.item.key,
      input.item.kind,
      taskId,
    );
    const projection = this.db.prepare(
      `SELECT graph_hash,item_kind,task_id
         FROM factory_development_task_projections
        WHERE process_run_id=? AND work_item_key=?`,
    ).get(input.processRunId, input.item.key) as {
      graph_hash: string;
      item_kind: string;
      task_id: number;
    };
    if (
      projection.graph_hash !== input.graph.graphHash
      || projection.item_kind !== input.item.kind
      || projection.task_id !== taskId
    ) {
      throw new Error(
        `DEVELOPMENT_TASK_PROJECTION_REPLAY_MISMATCH: ${input.item.key}`,
      );
    }

    const linkType = input.item.kind === 'implementation'
      ? 'implements'
      : 'depends_on';
    for (const artifactId of input.item.acceptanceCriterionIds) {
      this.db.prepare(
        `INSERT OR IGNORE INTO artifact_traces
          (source_id,target_type,target_id,link_type)
         VALUES (?,'task',?,?)`,
      ).run(artifactId, taskId, linkType);
    }
    return taskId;
  }

  private replaceDependencies(taskId: number, dependencyIds: number[]): void {
    const existing = this.db.prepare(
      `SELECT depends_on_task_id
         FROM task_dependencies
        WHERE task_id=?
        ORDER BY depends_on_task_id`,
    ).all(taskId) as Array<{ depends_on_task_id: number }>;
    const expected = [...new Set(dependencyIds)].sort((a, b) => a - b);
    if (existing.length > 0) {
      const actual = existing.map(row => row.depends_on_task_id);
      if (
        actual.length !== expected.length
        || actual.some((value, index) => value !== expected[index])
      ) {
        throw new Error(
          `DEVELOPMENT_TASK_DEPENDENCY_REPLAY_MISMATCH: task ${taskId}`,
        );
      }
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO task_dependencies (task_id,depends_on_task_id)
       VALUES (?,?)`,
    );
    for (const dependencyId of expected) insert.run(taskId, dependencyId);
  }

  private assertTaskProjection(
    processRunId: number,
    graph: DevelopmentTaskGraphSnapshot,
  ): void {
    const rows = this.readProjectedTasks(processRunId);
    assertProjectionKeys(
      rows,
      [
        ...graph.implementationItems.map(item => item.key),
        ...graph.verificationItems.map(item => item.key),
      ],
      'task graph',
    );
    if (rows.some(row => row.item_kind === 'implementation'
      ? !graph.implementationItems.some(item => item.key === row.work_item_key)
      : !graph.verificationItems.some(item => item.key === row.work_item_key))) {
      throw new Error('DEVELOPMENT_TASK_PROJECTION_KIND_MISMATCH');
    }
  }

  private assertDevelopmentScope(developmentCase: DevelopmentCase): void {
    const epic = this.db.prepare(
      'SELECT project_id FROM epics WHERE id=?',
    ).get(developmentCase.epicId) as { project_id: number } | undefined;
    if (!epic || epic.project_id !== developmentCase.projectId) {
      throw new Error('DEVELOPMENT_EPIC_PROJECT_SCOPE_MISMATCH');
    }
    for (const repository of developmentCase.repositories) {
      const row = this.db.prepare(
        `SELECT project_id,integration_branch
           FROM project_repositories WHERE id=? AND status='active'`,
      ).get(repository.projectRepositoryId) as {
        project_id: number;
        integration_branch: string;
      } | undefined;
      if (
        !row
        || row.project_id !== developmentCase.projectId
        || row.integration_branch !== repository.integrationBranch
      ) {
        throw new Error(
          `DEVELOPMENT_REPOSITORY_SCOPE_MISMATCH: `
          + repository.projectRepositoryId,
        );
      }
    }
    for (const criterion of developmentCase.acceptanceCriteria) {
      const row = this.db.prepare(
        `SELECT epic_id,type,status,accepted_hash,content_hash,drift_state
           FROM artifacts WHERE id=?`,
      ).get(criterion.artifactId) as {
        epic_id: number;
        type: string;
        status: string;
        accepted_hash: string | null;
        content_hash: string | null;
        drift_state: string;
      } | undefined;
      if (
        !row
        || row.epic_id !== developmentCase.epicId
        || row.type !== 'AC'
        || row.status !== 'accepted'
        || row.accepted_hash !== criterion.acceptedHash
        || row.content_hash !== criterion.acceptedHash
        || row.drift_state !== 'clean'
      ) {
        throw new Error(
          `DEVELOPMENT_ACCEPTANCE_BASELINE_MISMATCH: `
          + criterion.artifactId,
        );
      }
    }
  }
}

/**
 * Build a synthetic durable reference for the in-memory implementation
 * workset. The workset is not persisted to the process-product store; this
 * reference lets the settlement policy's referenceMatches check pass while
 * binding the exact workset hash into the verified bundle.
 */
function refOfWorkset(
  processRunId: number,
  workset: DevelopmentImplementationWorkset,
): ContentAddressedReference {
  return {
    schema: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    ref: `development-implementation-workset:${processRunId}:${workset.worksetHash}`,
    hash: workset.worksetHash,
  };
}

function refOfCandidate(
  processRunId: number,
  candidate: IntegratedReleaseCandidate,
): ContentAddressedReference {
  return {
    schema: INTEGRATED_CANDIDATE_SCHEMA,
    ref: `development-integrated-candidate:${processRunId}:${candidate.candidateHash}`,
    hash: candidate.candidateHash,
  };
}

function refOfVerification(
  processRunId: number,
  verification: AcceptanceVerificationWorkset,
): ContentAddressedReference {
  return {
    schema: ACCEPTANCE_VERIFICATION_SCHEMA,
    ref: `development-acceptance-verification:${processRunId}:${verification.verificationHash}`,
    hash: verification.verificationHash,
  };
}

function assertStoredGraph(
  existing: { payload: DevelopmentTaskGraphSnapshot; reference: ContentAddressedReference },
  expected: DevelopmentTaskGraphSnapshot,
): void {
  if (
    existing.payload.graphHash !== expected.graphHash
    || existing.reference.hash !== expected.graphHash
    || sha256Hex(existing.payload) !== sha256Hex(expected)
  ) {
    throw new Error(
      'DEVELOPMENT_TASK_GRAPH_REPLAY_MISMATCH: stored graph differs from authorized graph',
    );
  }
}

function taskGenerationKey(
  processRunId: number,
  graphHash: string,
  itemKey: string,
): string {
  return `process-run:${processRunId}:development:${graphHash}:${sha256Hex(itemKey)}`;
}

function assertProjectionKeys(
  rows: readonly ProjectedTaskRow[],
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = rows.map(row => row.work_item_key).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `DEVELOPMENT_${label.toUpperCase().replaceAll(' ', '_')}_PROJECTION_MISMATCH`,
    );
  }
}

function metadataProjectionMatches(
  raw: string,
  expected: Record<string, unknown>,
): boolean {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(expected).every(([key, expectedValue]) =>
      sha256Hex(value[key]) === sha256Hex(expectedValue));
  } catch {
    return false;
  }
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`DEVELOPMENT_MAP_VALUE_MISSING: ${String(key)}`);
  }
  return value;
}

function parseTags(raw: string): readonly string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function ensureDevelopmentStoreSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_development_task_projections (
      process_run_id INTEGER NOT NULL
                       REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      graph_hash     TEXT NOT NULL,
      work_item_key  TEXT NOT NULL,
      item_kind      TEXT NOT NULL
                       CHECK (item_kind IN ('implementation','verification')),
      task_id        INTEGER NOT NULL
                       REFERENCES tasks(id) ON DELETE RESTRICT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(process_run_id,work_item_key),
      UNIQUE(process_run_id,task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_development_projection_task
      ON factory_development_task_projections(task_id);
  `);
}
