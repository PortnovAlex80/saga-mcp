import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type Database from 'better-sqlite3';
import type {
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
  WorkerRunSnapshot,
} from '../../../application/ports/worker-executor.js';
import { getDb } from '../../../db.js';
import {
  SqliteProcessProductRepository,
  type ProcessProductRecord,
} from '../../persistence/sqlite-process-product-repository.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  DevelopmentAcceptanceVerificationPort,
  DevelopmentCandidateIntegrationPort,
  DevelopmentExternalActionKind,
  DevelopmentExternalActionReceipt,
  DevelopmentImplementationWorksetPort,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
} from './development-kernel-ports.js';
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
} from './development-schemas.js';
import {
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
} from './development-settlement-policy.js';

const TASK_RESULT_SCHEMA = 'saga3.development-task-result.v1';
const VERIFICATION_EVIDENCE_REF_SCHEMA =
  'saga3.candidate-verification-evidence.v1';
const EXTERNAL_FAILURE_SCHEMA = 'saga3.development-external-failure.v1';

const PRODUCT_KINDS = {
  taskGraph: 'development.task-graph',
  implementationWorkset: 'development.implementation-workset',
  integratedCandidate: 'development.integrated-candidate',
  acceptanceVerification: 'development.acceptance-verification',
} as const;

export interface SqliteDevelopmentRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number;
  }) => WorkerExecutorFactoryContext;
  db?: Database.Database;
  concurrency?: number;
  pollMs?: number;
  maxRunMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

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
 * Production adapter from the Development module ports to the existing Saga
 * task/worker/review/integration/evidence substrate.
 *
 * It does not move task lifecycle columns itself. The existing dispatcher and
 * workers remain the sole owners of claim, review and merge transitions. This
 * adapter only:
 * - projects a kernel-authorized graph idempotently;
 * - runs exact claim scopes through WorkerExecutor;
 * - freezes immutable products from durable task/Git/evidence observations;
 * - supplies settlement with exact, content-addressed products.
 */
export class SqliteDevelopmentRuntime implements
  DevelopmentTaskGraphPort,
  DevelopmentImplementationWorksetPort,
  DevelopmentCandidateIntegrationPort,
  DevelopmentAcceptanceVerificationPort,
  DevelopmentSettlementStatePort {
  private readonly db: Database.Database;
  private readonly products: SqliteProcessProductRepository;
  private readonly workerExecutorFactory: WorkerExecutorFactory;
  private readonly resolveWorkerContext: SqliteDevelopmentRuntimeOptions[
    'resolveWorkerContext'
  ];
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly maxRunMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: SqliteDevelopmentRuntimeOptions) {
    this.db = options.db ?? getDb();
    this.products = new SqliteProcessProductRepository(this.db);
    this.workerExecutorFactory = options.workerExecutorFactory;
    this.resolveWorkerContext = options.resolveWorkerContext;
    this.concurrency = boundedConcurrency(options.concurrency ?? 2);
    this.pollMs = positiveInteger(options.pollMs ?? 2_000, 'pollMs');
    this.maxRunMs = positiveInteger(
      options.maxRunMs ?? 4 * 60 * 60 * 1_000,
      'maxRunMs',
    );
    this.sleep = options.sleep
      ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    ensureDevelopmentRuntimeSchema(this.db);
  }

  materializeValidatedTaskGraph(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    graph: DevelopmentTaskGraphSnapshot;
  }): {
    graph: DevelopmentTaskGraphSnapshot;
    reference: ContentAddressedReference;
  } {
    const existing =
      this.products.read<DevelopmentTaskGraphSnapshot>(
        input.processRunId,
        PRODUCT_KINDS.taskGraph,
      );
    if (existing) {
      assertStoredGraph(existing, input.graph);
      this.assertTaskProjection(input.processRunId, input.graph);
      return {
        graph: existing.payload,
        reference: existing.reference,
      };
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
        productKind: PRODUCT_KINDS.taskGraph,
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

  async execute(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    workset: DevelopmentImplementationWorkset | null;
  }> {
    const replay = this.products.read<DevelopmentImplementationWorkset>(
      input.processRunId,
      PRODUCT_KINDS.implementationWorkset,
    );
    if (replay) {
      return {
        receipt: receiptFromProduct(
          'implementation-workset',
          input.actionKey,
          input.payloadHash,
          replay,
          worksetReceiptStatus(replay.payload),
          true,
        ),
        workset: replay.payload,
      };
    }

    const projections = this.readProjectedTasks(
      input.processRunId,
      'implementation',
    );
    assertProjectionKeys(
      projections,
      input.taskGraph.implementationItems.map(item => item.key),
      'implementation',
    );

    let runnerFailure: string | null = null;
    try {
      await this.runScopedTasks({
        projectId: input.developmentCase.projectId,
        epicId: input.developmentCase.epicId,
        taskIds: projections.map(row => row.task_id),
        heartbeat: input.heartbeat,
      });
    } catch (error) {
      runnerFailure = errorMessage(error);
    }

    const projectionByKey = new Map(
      projections.map(row => [row.work_item_key, row]),
    );
    const results = input.taskGraph.implementationItems.map(item =>
      this.buildImplementationResult(
        item,
        requireMapValue(projectionByKey, item.key).task_id,
        runnerFailure,
      ));
    const requiredKeys = new Set(
      input.taskGraph.implementationItems
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
      taskGraphHash: input.taskGraph.graphHash,
      results,
      complete: blockingItemKeys.length === 0,
      blockingItemKeys,
    } as const;
    const workset: DevelopmentImplementationWorkset = {
      ...body,
      worksetHash: hashImplementationWorkset({
        ...body,
        worksetHash: '',
      }),
    };
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind: PRODUCT_KINDS.implementationWorkset,
      schema: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      productHash: workset.worksetHash,
      payload: workset,
      artifactRefPrefix: 'development-implementation-workset',
    });
    return {
      receipt: receiptFromProduct(
        'implementation-workset',
        input.actionKey,
        input.payloadHash,
        stored.record,
        worksetReceiptStatus(workset),
        stored.replayed,
      ),
      workset,
    };
  }

  async integrateAndFreeze(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    implementationWorkset: DevelopmentImplementationWorkset;
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    candidate: IntegratedReleaseCandidate | null;
  }> {
    const replay = this.products.read<IntegratedReleaseCandidate>(
      input.processRunId,
      PRODUCT_KINDS.integratedCandidate,
    );
    if (replay) {
      const observed = this.observeCandidate(replay.payload);
      const status = observed === replay.payload.candidateHash
        ? 'succeeded'
        : 'blocked';
      return {
        receipt: receiptFromProduct(
          'candidate-integration',
          input.actionKey,
          input.payloadHash,
          replay,
          status,
          true,
        ),
        candidate: replay.payload,
      };
    }

    input.heartbeat();
    try {
      const repositories = input.developmentCase.repositories
        .map(binding => this.observeRepository(
          input.developmentCase.projectId,
          binding.projectRepositoryId,
          binding.integrationBranch,
          binding.expectedBaseCommit,
        ))
        .sort((left, right) =>
          left.projectRepositoryId - right.projectRepositoryId);
      const integrationIntentRefs =
        this.persistIntegrationObservations(
          input.processRunId,
          input.taskGraph,
          input.implementationWorkset,
        );
      const buildProducts = repositories.map(repository => ({
        kind: 'source-tree',
        ref:
          `project-repository:${repository.projectRepositoryId}`
          + `:branch:${repository.branch}:commit:${repository.commitSha}`,
        digest: repository.treeHash,
      }));
      const body: Omit<IntegratedReleaseCandidate, 'candidateHash'> = {
        schemaVersion: INTEGRATED_CANDIDATE_SCHEMA,
        taskGraphHash: input.taskGraph.graphHash,
        implementationWorksetHash:
          input.implementationWorkset.worksetHash,
        repositories,
        buildProducts,
        integrationIntentRefs,
        frozen: true as const,
      };
      const candidate: IntegratedReleaseCandidate = {
        ...body,
        candidateHash: hashIntegratedCandidate({
          ...body,
          candidateHash: '',
        }),
      };
      const stored = this.products.persist({
        processRunId: input.processRunId,
        productKind: PRODUCT_KINDS.integratedCandidate,
        schema: INTEGRATED_CANDIDATE_SCHEMA,
        productHash: candidate.candidateHash,
        payload: candidate,
        artifactRefPrefix: 'development-integrated-candidate',
      });
      return {
        receipt: receiptFromProduct(
          'candidate-integration',
          input.actionKey,
          input.payloadHash,
          stored.record,
          'succeeded',
          stored.replayed,
        ),
        candidate,
      };
    } catch (error) {
      const failed = this.persistFailure(
        input.processRunId,
        'candidate-integration',
        input.actionKey,
        input.payloadHash,
        error,
      );
      return {
        receipt: failed,
        candidate: null,
      };
    }
  }

  async verify(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    candidate: IntegratedReleaseCandidate;
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    verification: AcceptanceVerificationWorkset | null;
  }> {
    const replay = this.products.read<AcceptanceVerificationWorkset>(
      input.processRunId,
      PRODUCT_KINDS.acceptanceVerification,
    );
    if (replay) {
      return {
        receipt: receiptFromProduct(
          'acceptance-verification',
          input.actionKey,
          input.payloadHash,
          replay,
          replay.payload.complete ? 'succeeded' : 'blocked',
          true,
        ),
        verification: replay.payload,
      };
    }

    const projections = this.readProjectedTasks(
      input.processRunId,
      'verification',
    );
    assertProjectionKeys(
      projections,
      input.taskGraph.verificationItems.map(item => item.key),
      'verification',
    );
    this.bindVerificationCandidate(
      projections.map(row => row.task_id),
      input.candidate.candidateHash,
    );

    let runnerFailure: string | null = null;
    try {
      await this.runScopedTasks({
        projectId: input.developmentCase.projectId,
        epicId: input.developmentCase.epicId,
        taskIds: projections.map(row => row.task_id),
        heartbeat: input.heartbeat,
      });
    } catch (error) {
      runnerFailure = errorMessage(error);
    }

    const projectionByKey = new Map(
      projections.map(row => [row.work_item_key, row]),
    );
    const criterionById = new Map(
      input.developmentCase.acceptanceCriteria.map(criterion => [
        criterion.artifactId,
        criterion,
      ]),
    );
    const evidence: CandidateVerificationEvidence[] = [];
    for (const item of input.taskGraph.verificationItems) {
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
        candidateHash: input.candidate.candidateHash,
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
          input.developmentCase.projectId,
          row.provider,
        ),
      });
    }

    const requiredCount = input.taskGraph.verificationItems
      .filter(item => item.required).length;
    const complete = runnerFailure === null
      && evidence.length === requiredCount;
    const body: Omit<AcceptanceVerificationWorkset, 'verificationHash'> = {
      schemaVersion: ACCEPTANCE_VERIFICATION_SCHEMA,
      acceptanceBaselineHash: input.developmentCase.acceptanceBaselineHash,
      candidateHash: input.candidate.candidateHash,
      evidence: evidence.sort((left, right) =>
        left.verificationItemKey.localeCompare(right.verificationItemKey)),
      complete,
    };
    const verification: AcceptanceVerificationWorkset = {
      ...body,
      verificationHash: hashAcceptanceVerification({
        ...body,
        verificationHash: '',
      }),
    };
    const stored = this.products.persist({
      processRunId: input.processRunId,
      productKind: PRODUCT_KINDS.acceptanceVerification,
      schema: ACCEPTANCE_VERIFICATION_SCHEMA,
      productHash: verification.verificationHash,
      payload: verification,
      artifactRefPrefix: 'development-acceptance-verification',
    });
    return {
      receipt: receiptFromProduct(
        'acceptance-verification',
        input.actionKey,
        input.payloadHash,
        stored.record,
        complete ? 'succeeded' : 'blocked',
        stored.replayed,
      ),
      verification,
    };
  }

  buildSettlementInput(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): DevelopmentSettlementInput {
    const taskGraph = this.readProduct<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PRODUCT_KINDS.taskGraph,
    );
    const implementation =
      this.readProduct<DevelopmentImplementationWorkset>(
        input.processRunId,
        PRODUCT_KINDS.implementationWorkset,
      );
    const candidate = this.readProduct<IntegratedReleaseCandidate>(
      input.processRunId,
      PRODUCT_KINDS.integratedCandidate,
    );
    const verification =
      this.readProduct<AcceptanceVerificationWorkset>(
        input.processRunId,
        PRODUCT_KINDS.acceptanceVerification,
      );
    const projectedIds = this.readProjectedTasks(input.processRunId)
      .map(row => row.task_id);
    return {
      schemaVersion: DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
      developmentCase: input.developmentCase,
      taskGraph: taskGraph?.payload ?? null,
      implementationWorkset: implementation?.payload ?? null,
      integratedCandidate: candidate?.payload ?? null,
      observedCandidateHash: candidate
        ? this.observeCandidate(candidate.payload)
        : null,
      acceptanceVerification: verification?.payload ?? null,
      productReferences: {
        taskGraph: taskGraph?.reference ?? null,
        implementationWorkset: implementation?.reference ?? null,
        integratedCandidate: candidate?.reference ?? null,
        acceptanceVerification: verification?.reference ?? null,
      },
      openHumanGateIds: projectedIds.length === 0
        ? []
        : this.readOpenHumanGateIds(projectedIds),
    };
  }

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
    // Read the ProcessRun input hash and the planner's WorkIntent so we can
    // stamp full managed-production provenance onto each projected task.
    // Without process_input_hash + work_intent_id, workers that call any
    // managed-production tool (artifact_create, process_node_submit, etc.)
    // under SAGA_MANAGED_EXECUTION=1 hit MANAGED_PRODUCTION_CONTEXT_INVALID:
    // "process provenance binding is incomplete" (3 of 4 keys present).
    // Both values are shared across all tasks of the same ProcessRun — the
    // planner LM node already established them when it created its WorkIntent.
    const processRun = this.db.prepare(
      'SELECT input_hash FROM saga3_process_runs WHERE id=?',
    ).get(input.processRunId) as { input_hash: string } | undefined;
    const plannerIntent = this.db.prepare(
      `SELECT wi.id AS work_intent_id
         FROM saga3_work_intents wi
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
      process_node_id: 'resolve-task-graph',
      process_module_ref: 'solution-development@1.0.0',
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
      `INSERT INTO saga3_development_task_projections
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
         FROM saga3_development_task_projections
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
         FROM saga3_development_task_projections
        WHERE process_run_id=?${whereKind}
        ORDER BY work_item_key`,
    ).all(...params) as ProjectedTaskRow[];
  }

  private async runScopedTasks(input: {
    projectId: number;
    epicId: number;
    taskIds: number[];
    heartbeat: () => void;
  }): Promise<WorkerRunSnapshot | null> {
    if (input.taskIds.length === 0) return null;
    if (this.tasksAreTerminal(input.taskIds)) return null;

    const workerContext = this.resolveWorkerContext({
      projectId: input.projectId,
      epicId: input.epicId,
    });
    const executor = this.workerExecutorFactory(workerContext);
    let terminal: WorkerRunSnapshot | null = null;
    try {
      input.heartbeat();
      executor.start({
        projectId: input.projectId,
        epicId: input.epicId,
        concurrency: Math.min(this.concurrency, input.taskIds.length),
        claimScope: { taskIds: input.taskIds },
      });
      const startedAt = this.now().getTime();
      while (true) {
        input.heartbeat();
        terminal = executor.status(input.projectId);
        if (terminal === null) {
          throw new Error('DEVELOPMENT_WORKER_EXECUTOR_DISAPPEARED');
        }
        if (terminal.status === 'completed') break;
        if (terminal.status === 'failed' || terminal.status === 'stopped') {
          throw new Error(
            `DEVELOPMENT_WORKER_RUN_${terminal.status.toUpperCase()}: `
            + (terminal.last_error ?? 'no error detail'),
          );
        }
        if (this.now().getTime() - startedAt > this.maxRunMs) {
          throw new Error('DEVELOPMENT_WORKER_RUN_TIMEOUT');
        }
        await this.sleep(this.pollMs);
      }
      return terminal;
    } finally {
      if (terminal?.status !== 'completed') {
        try { executor.stop(input.projectId); } catch { /* best effort */ }
      }
      try { executor.dispose(); } catch { /* best effort */ }
    }
  }

  private tasksAreTerminal(taskIds: number[]): boolean {
    const rows = this.readRuntimeTasks(taskIds);
    return rows.length === taskIds.length && rows.every(row =>
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

  private buildImplementationResult(
    item: DevelopmentTaskGraphItem,
    taskId: number,
    runnerFailure: string | null,
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
    if (
      task.status === 'blocked'
      || task.integration_state === 'conflict'
    ) {
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
      if (runnerFailure) reasonCodes.push('worker-substrate-unavailable');
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
    return gitText(repository.localPath, [
      'rev-parse',
      `refs/heads/task/${task.id}`,
    ]);
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
    const commitSha = gitText(repository.localPath, [
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
      !gitOk(repository.localPath, [
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
    const treeHash = gitText(repository.localPath, [
      'rev-parse',
      `${commitSha}^{tree}`,
    ]);
    if (!treeHash) {
      throw new Error(
        `DEVELOPMENT_REPOSITORY_TREE_MISSING: ${projectRepositoryId}`,
      );
    }
    return {
      projectRepositoryId,
      branch,
      commitSha,
      treeHash,
    };
  }

  private observeCandidate(
    candidate: IntegratedReleaseCandidate,
  ): string | null {
    try {
      const repositories = candidate.repositories.map(repository => {
        const binding = this.readRepositoryPath(
          repository.projectRepositoryId,
        );
        if (!binding) throw new Error('checkout missing');
        const commitSha = gitText(binding.localPath, [
          'rev-parse',
          `refs/heads/${repository.branch}`,
        ]);
        if (!commitSha) throw new Error('branch missing');
        const treeHash = gitText(binding.localPath, [
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

  private persistIntegrationObservations(
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
          throw new Error(
            `DEVELOPMENT_INTEGRATION_PROOF_MISSING: ${key}`,
          );
        }
        const task = this.readRuntimeTask(projection.task_id);
        if (
          task.integration_state !== 'merged'
          || !task.integrated_commit
        ) {
          throw new Error(
            `DEVELOPMENT_INTEGRATION_NOT_MERGED: ${key}`,
          );
        }
        const ref =
          `development-integration:${processRunId}:${projection.task_id}:`
          + sha256Hex({
            projectRepositoryId: target.projectRepositoryId,
            taskId: projection.task_id,
            workItemKey: key,
            reviewedSourceCommit: result.reviewedSourceCommit,
            targetBranch: target.targetBranch,
            integratedCommit: task.integrated_commit,
          });
        this.db.prepare(
          `INSERT INTO saga3_development_integration_observations
            (observation_ref,process_run_id,task_id,work_item_key,
             project_repository_id,reviewed_source_commit,target_branch,
             integrated_commit)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(observation_ref) DO NOTHING`,
        ).run(
          ref,
          processRunId,
          projection.task_id,
          key,
          target.projectRepositoryId,
          result.reviewedSourceCommit,
          target.targetBranch,
          task.integrated_commit,
        );
        references.push(ref);
      }
    }
    return [...new Set(references)].sort();
  }

  private bindVerificationCandidate(
    taskIds: number[],
    candidateHash: string,
  ): void {
    const update = this.db.prepare(
      `UPDATE tasks
          SET metadata=json_set(
                COALESCE(metadata,'{}'),
                '$.candidate_hash',
                ?
              ),
              updated_at=datetime('now')
        WHERE id=?
          AND (
            json_extract(metadata,'$.candidate_hash') IS NULL
            OR json_extract(metadata,'$.candidate_hash')=?
          )`,
    );
    for (const taskId of taskIds) {
      const changed = update.run(candidateHash, taskId, candidateHash);
      if (changed.changes !== 1) {
        throw new Error(
          `DEVELOPMENT_VERIFICATION_CANDIDATE_REBIND_REJECTED: ${taskId}`,
        );
      }
    }
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

  private readProduct<T>(
    processRunId: number,
    productKind: string,
  ): ProcessProductRecord<T> | null {
    return this.products.read<T>(processRunId, productKind);
  }

  private readRuntimeTask(taskId: number): RuntimeTaskRow {
    const row = this.db.prepare(
      `SELECT id,status,integration_state,integrated_commit,
              project_repository_id,metadata
         FROM tasks WHERE id=?`,
    ).get(taskId) as RuntimeTaskRow | undefined;
    if (!row) throw new Error(`DEVELOPMENT_TASK_NOT_FOUND: ${taskId}`);
    return row;
  }

  private readRuntimeTasks(taskIds: number[]): RuntimeTaskRow[] {
    if (taskIds.length === 0) return [];
    return this.db.prepare(
      `SELECT id,status,integration_state,integrated_commit,
              project_repository_id,metadata
         FROM tasks
        WHERE id IN (${taskIds.map(() => '?').join(',')})`,
    ).all(...taskIds) as RuntimeTaskRow[];
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
    ).get(os.hostname(), projectRepositoryId) as {
      project_id: number;
      local_path: string | null;
    } | undefined;
    return row?.local_path
      ? { projectId: row.project_id, localPath: row.local_path }
      : null;
  }

  private persistFailure(
    processRunId: number,
    actionKind: DevelopmentExternalActionKind,
    actionKey: string,
    payloadHash: string,
    error: unknown,
  ): DevelopmentExternalActionReceipt {
    const payload = {
      schemaVersion: EXTERNAL_FAILURE_SCHEMA,
      actionKind,
      actionKey,
      payloadHash,
      error: errorMessage(error),
    };
    const resultHash = sha256Hex(payload);
    const stored = this.products.persist({
      processRunId,
      productKind: `development.failure.${actionKind}`,
      schema: EXTERNAL_FAILURE_SCHEMA,
      productHash: resultHash,
      payload,
      artifactRefPrefix: 'development-external-failure',
    });
    return {
      actionKey,
      actionKind,
      payloadHash,
      status: 'failed',
      resultRef: stored.record.reference.ref,
      resultHash,
      replayed: stored.replayed,
    };
  }
}

export function ensureDevelopmentRuntimeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_development_task_projections (
      process_run_id INTEGER NOT NULL
                       REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
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

    CREATE INDEX IF NOT EXISTS idx_saga3_development_projection_task
      ON saga3_development_task_projections(task_id);

    CREATE TABLE IF NOT EXISTS saga3_development_integration_observations (
      observation_ref        TEXT PRIMARY KEY,
      process_run_id         INTEGER NOT NULL
                               REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      task_id                INTEGER NOT NULL
                               REFERENCES tasks(id) ON DELETE RESTRICT,
      work_item_key          TEXT NOT NULL,
      project_repository_id  INTEGER NOT NULL
                               REFERENCES project_repositories(id) ON DELETE RESTRICT,
      reviewed_source_commit TEXT NOT NULL,
      target_branch          TEXT NOT NULL,
      integrated_commit      TEXT NOT NULL,
      observed_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(process_run_id,work_item_key)
    );
  `);
}

function receiptFromProduct(
  actionKind: DevelopmentExternalActionKind,
  actionKey: string,
  payloadHash: string,
  product: ProcessProductRecord,
  status: DevelopmentExternalActionReceipt['status'],
  replayed: boolean,
): DevelopmentExternalActionReceipt {
  return {
    actionKey,
    actionKind,
    payloadHash,
    status,
    resultRef: product.reference.ref,
    resultHash: product.reference.hash,
    replayed,
  };
}

function worksetReceiptStatus(
  workset: DevelopmentImplementationWorkset,
): DevelopmentExternalActionReceipt['status'] {
  if (workset.complete && workset.blockingItemKeys.length === 0) {
    return 'succeeded';
  }
  return workset.results.some(result => result.status === 'failed')
    ? 'failed'
    : 'blocked';
}

function assertStoredGraph(
  record: ProcessProductRecord<DevelopmentTaskGraphSnapshot>,
  expected: DevelopmentTaskGraphSnapshot,
): void {
  if (
    record.reference.schema !== DEVELOPMENT_TASK_GRAPH_SCHEMA
    || record.reference.hash !== expected.graphHash
    || sha256Hex(record.payload) !== sha256Hex(expected)
  ) {
    throw new Error('DEVELOPMENT_TASK_GRAPH_REPLAY_MISMATCH');
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

function gitText(repoPath: string, args: string[]): string | null {
  const result = spawnSync(
    'git',
    ['-C', repoPath, ...args],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

function gitOk(repoPath: string, args: string[]): boolean {
  return spawnSync(
    'git',
    ['-C', repoPath, ...args],
    { encoding: 'utf8', windowsHide: true },
  ).status === 0;
}

function boundedConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('development concurrency must be an integer from 1 to 10');
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`development ${label} must be a positive integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
