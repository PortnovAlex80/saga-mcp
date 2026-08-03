import { getDb } from '../../db.js';
import { prepareSaga3ProjectedTaskForExecution } from '../../lifecycle/legacy-assignment-recovery.js';
import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../../shared/work-intent.js';
import type { ProposalRecord } from '../domain/proposal.js';
import { DISCOVERY_DIAGNOSIS_INTENT_KIND, DIAGNOSE_DISCOVERY_OUTCOME_KIND, DISCOVERY_DIAGNOSIS_WORK_INTENT_SCHEMA, DISCOVERY_NORMALIZATION_INTENT_KIND, DISCOVERY_READINESS_INTENT_KIND } from '../../shared/work-intent.js';
import { DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA } from '../../modules/discovery/domain/discovery-normalization-proposal.js';
import { DISCOVERY_READINESS_ASSESSMENT_SCHEMA } from '../../modules/discovery/domain/discovery-readiness-assessment.js';
import type { ControlIntentStatus } from '../../modules/discovery/domain/discovery-normalization-records.js';
import type { ReadinessAssessmentRecord, ReadinessControlExecution, ReadinessControlIntentRecord, ReadinessControlStatus } from '../../modules/discovery/domain/discovery-readiness-records.js';
import type { OutcomeCertificateRecord, SettlementRecord } from '../../modules/discovery/domain/discovery-settlement-records.js';
import { diagnosisCaseHash } from '../domain/discovery-diagnosis-case.js';
import type {
  DiagnosisControlExecution,
  DiagnosisControlIntentRecord,
  DiagnosisControlStatus,
  DiagnosisReportRecord,
} from '../domain/discovery-diagnosis-records.js';
import {
  type EnsureDiagnosisControl,
  type EnsureNormalizationControl,
  type EnsureNodeExecutionPlan,
  type EnsureProjectedTask,
  type EnsureReadinessControl,
  type InsertSettlementPort,
  type IssueCertificateAtomicallyInput,
  type NormalizationControlExecution,
  type PrepareIntentForExecutionResult,
  type Saga3DiscoveryRuntimePersistence,
  type SettlementInputKey,
  type SettlementProposalRecord,
  type SubmitDiagnosisReportInput,
} from '../../modules/discovery/infrastructure/saga3-discovery-runtime-port.js';
import {
  canonicalJson,
  hashPayload,
} from './saga3-proposal-repository.js';
import {
  ensureSaga3NormalizationSchema,
  readLatestNormalizationProposalForControl,
  readLatestRawSubmissionForIntent,
  readNormalizationProposalForExecution,
  readRawSubmission,
  readRawSubmissionForExecution,
} from './saga3-normalization-repository.js';
import {
  ensureSaga3ReadinessSchema,
  readLatestReadinessAssessmentForControl,
  readReadinessAssessmentForExecution,
  readReadinessAssessment,
  readReadinessControlForProposal as readReadinessControlForProposalRepo,
} from './saga3-readiness-repository.js';
import {
  ensureSaga3SettlementSchema,
  findSettlementByInputKey as findSettlementByInputKeyRepo,
  insertSettlement as insertSettlementRepo,
  issueCertificateAtomically as issueCertificateAtomicallyRepo,
  markSettlementFailed as markSettlementFailedRepo,
  readCertificateForSettlement as readCertificateForSettlementRepo,
  readOutcomeCertificate as readOutcomeCertificateRepo,
  readSettlement as readSettlementRepo,
  reconcileExistingCertificate as reconcileExistingCertificateRepo,
} from '../../modules/discovery/infrastructure/saga3-settlement-repository.js';
import {
  ensureSaga3DiagnosisSchema,
  findDiagnosisControlByTarget as findDiagnosisControlByTargetRepo,
  submitDiagnosisReportAtomically as submitDiagnosisReportAtomicallyRepo,
  readAcceptedDiagnosisReportForControl as readAcceptedDiagnosisReportForControlRepo,
  readDiagnosisControlById as readDiagnosisControlByIdRepo,
  readLatestDiagnosisReportForControl as readLatestDiagnosisReportForControlRepo,
} from './saga3-diagnosis-repository.js';

/**
 * SQLite implementation of the Saga3DiscoveryRuntimePersistence port.
 *
 * This is the ONLY place the Saga 3 discovery engine's data access touches
 * `getDb()`. The engine itself depends on the interface, so a test can inject
 * a fake. All methods here mirror what the D1 engine previously did inline
 * (readObjective / ensureDiscoveryTask / repoForProject / taskStatus) plus the
 * WorkIntent + proposal reads it delegated to Saga3ProposalRepository.
 */
export class SqliteSaga3DiscoveryRuntime implements Saga3DiscoveryRuntimePersistence {
  constructor() {
    ensurePausedWorkIntentStatus(getDb());
    ensureSaga3NormalizationSchema(getDb());
    ensureSaga3ReadinessSchema(getDb());
    ensureSaga3SettlementSchema(getDb());
    ensureSaga3DiagnosisSchema(getDb());
  }

  readEpicObjective(epicId: number): { name: string; description: string | null } | null {
    const row = getDb().prepare(
      'SELECT name, description FROM epics WHERE id=?',
    ).get(epicId) as { name: string; description: string | null } | undefined;
    return row ?? null;
  }

  readOpenIntent(epicId: number, kind: string): WorkIntent | null {
    const row = getDb().prepare(
      `SELECT * FROM saga3_work_intents
        WHERE epic_id=? AND kind=? AND status IN ('open','executing','paused')
        ORDER BY id DESC LIMIT 1`,
    ).get(epicId, kind) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  readConcludedIntentWithProposal(epicId: number, kind: string): WorkIntent | null {
    // Find the latest concluded intent that has a submitted proposal.
    // This enables restart recovery: reuse the existing discovery result
    // instead of creating a duplicate intent + worker.
    const row = getDb().prepare(
      `SELECT wi.* FROM saga3_work_intents wi
        WHERE wi.epic_id=? AND wi.kind=? AND wi.status='concluded'
          AND EXISTS (
            SELECT 1 FROM saga3_proposals p
            WHERE p.intent_id = wi.id AND p.status = 'submitted'
          )
        ORDER BY wi.id DESC LIMIT 1`,
    ).get(epicId, kind) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  createIntent(command: CreateWorkIntent): WorkIntent {
    const db = getDb();
    const info = db.prepare(
      `INSERT INTO saga3_work_intents
         (epic_id, kind, objective, authority_scope, output_schema,
          token_budget, retry_budget, status)
       VALUES (?,?,?,?,?,?,?, 'open')`,
    ).run(
      command.epic_id,
      command.kind,
      command.objective,
      JSON.stringify(command.authority_scope),
      command.output_schema,
      command.token_budget,
      command.retry_budget,
    );
    return this.readIntentStrict(Number(info.lastInsertRowid));
  }

  setProjectedTask(intentId: number, taskId: number): void {
    getDb().prepare(
      `UPDATE saga3_work_intents SET projected_task_id=?, updated_at=datetime('now')
        WHERE id=?`,
    ).run(taskId, intentId);
  }

  bindProjectedTaskProcessContext(input: {
    taskId: number;
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    processInputHash: string;
    nodeInput: unknown;
    nodeInputHash: string;
    projectRepositoryId?: number | null;
    managedReviewBudget?: number | null;
    recoveryFeedback?: unknown;
  }): void {
    const db = getDb();
    const row = db.prepare(
      'SELECT metadata FROM tasks WHERE id=?',
    ).get(input.taskId) as { metadata: string } | undefined;
    if (!row) throw new Error(`saga3: projected task ${input.taskId} not found`);
    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      metadata = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`saga3: projected task ${input.taskId} metadata is invalid`);
    }
    const bindings: Record<string, unknown> = {
      process_run_id: input.processRunId,
      process_node_id: input.nodeId,
      process_module_ref: input.moduleRef,
      process_input_hash: input.processInputHash,
      process_node_input: input.nodeInput,
      process_node_input_hash: input.nodeInputHash,
    };
    // CGAD P18 — recovery_feedback is a SEPARATE metadata field, not inside
    // process_node_input (which is stripped for hash stability). The materializer
    // reads metadata.recovery_feedback to write recovery-feedback.json.
    if (input.recoveryFeedback !== undefined) {
      bindings.recovery_feedback = input.recoveryFeedback;
    } else if (metadata.recovery_feedback !== undefined) {
      // Clear stale feedback from a prior recovery when the current execution
      // is NOT a recovery cycle (worker re-entered normally).
      bindings.recovery_feedback = null;
    }
    // project_repository_id is a project-level constant (resolved from
    // tasks.project_repository_id). Stamp it into task.metadata so the worker
    // can pass it to artifact_create / artifact_update, which require it to
    // compute content_hash via artifactDiskHash. Without it artifacts end up
    // with NULL project_repository_id and NULL content_hash, and formalization
    // resolvers fail closed.
    if (input.projectRepositoryId !== undefined && input.projectRepositoryId !== null) {
      bindings.project_repository_id = input.projectRepositoryId;
    }
    if (input.managedReviewBudget !== undefined && input.managedReviewBudget !== null) {
      bindings.managed_review_budget = input.managedReviewBudget;
    }
    for (const [key, value] of Object.entries(bindings)) {
      if (
        metadata[key] !== undefined
        && canonicalJson(metadata[key]) !== canonicalJson(value)
      ) {
        // CGAD P18 — Node-Durable Identity: the task belongs to the workplace
        // (processRun + node). When the same node re-executes (recovery, repair,
        // re-entry from a prior incomplete attempt), the node input may carry
        // updated chain context (e.g. recoveryFeedback). Allow rebind when the
        // task is already owned by the SAME processRun + nodeId — the workplace
        // is updating its own card, not stealing another node's card.
        const sameWorkplace =
          metadata.process_run_id === input.processRunId
          && metadata.process_node_id === input.nodeId;
        if (!sameWorkplace) {
          throw new Error(
            `saga3: projected task ${input.taskId} reserved metadata.${key} cannot be rebound`,
          );
        }
        // Same workplace — allow the rebind (node input evolved between attempts).
      }
      metadata[key] = value;
    }
    db.prepare(
      `UPDATE tasks
          SET metadata=?, updated_at=datetime('now')
        WHERE id=?`,
    ).run(JSON.stringify(metadata), input.taskId);
  }

  setIntentStatus(intentId: number, expected: WorkIntentStatus, next: WorkIntentStatus): boolean {
    const info = getDb().prepare(
      `UPDATE saga3_work_intents
          SET status=?, updated_at=datetime('now')
        WHERE id=? AND status=?`,
    ).run(next, intentId, expected);
    return info.changes === 1;
  }

  ensureProjectedTask(input: EnsureProjectedTask): number {
    const db = getDb();
    const existing = db.prepare(
      'SELECT id, review_skill FROM tasks WHERE epic_id=? AND generation_key=?',
    ).get(input.epicId, input.generationKey) as
      | { id: number; review_skill: string | null }
      | undefined;
    if (existing) {
      if (input.reviewSkill && existing.review_skill === null) {
        db.prepare(
          `UPDATE tasks
              SET review_skill=?, updated_at=datetime('now')
            WHERE id=?`,
        ).run(input.reviewSkill, existing.id);
      } else if (
        input.reviewSkill
        && existing.review_skill !== null
        && existing.review_skill !== input.reviewSkill
      ) {
        throw new Error(
          `saga3: projected task ${existing.id} review_skill cannot be rebound `
          + `from '${existing.review_skill}' to '${input.reviewSkill}'`,
        );
      }
      return existing.id;
    }

    const repoId = db.prepare(
      'SELECT id FROM project_repositories WHERE project_id=? ORDER BY id LIMIT 1',
    ).get(input.projectId) as { id: number } | undefined;

    // Generic-runtime parameters (P6c): the generic flow executor passes these
    // from the module's ExecutionProfileDefinition. Discovery historically
    // hardcoded these literals; defaults preserve that for existing callers.
    const workflowStage = input.workflowStage ?? 'discovery';
    const executionMode = input.executionMode ?? 'tracker_only';
    const titlePrefix = input.titlePrefix ?? 'Discovery: ';
    const priority = input.priority ?? 'high';

    const info = db.prepare(
      `INSERT INTO tasks
         (epic_id, title, description, status, priority, task_kind, workflow_stage,
          execution_skill, review_skill, execution_mode, project_repository_id,
          generation_key, tags, metadata)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    ).run(
      input.epicId,
      `${titlePrefix}${input.objective.slice(0, 80)}`,
      // Description is the human/worker-facing context the worker reads to
      // understand WHAT to do. It must NOT carry machine lineage (process_run_id,
      // process_node_id, process_input_hash, ...) — that lives in the `metadata`
      // column below, where the managed-production ledger reads it. Mixing them
      // produced a description like {"objective":...,"process_run_id":6,
      // "process_node_input":{"objective":...}} where objective was duplicated
      // and the worker waded through opaque JSON. Keep the legacy shape:
      // { objective, work_intent_id } only.
      JSON.stringify({ objective: input.objective, work_intent_id: input.intentId }),
      priority,
      input.taskKind,
      workflowStage,
      input.executionSkill,
      input.reviewSkill ?? null,
      executionMode,
      repoId?.id ?? null,
      input.generationKey,
      JSON.stringify({ ...(input.metadata ?? {}), work_intent_id: input.intentId }),
    );
    return Number(info.lastInsertRowid);
  }

  readTaskState(taskId: number): string | null {
    const row = getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  readCurrentExecutionId(taskId: number): string | null {
    const row = getDb().prepare(
      'SELECT current_execution_id FROM tasks WHERE id=?',
    ).get(taskId) as { current_execution_id: string | null } | undefined;
    return row?.current_execution_id ?? null;
  }

  ensureNodeExecutionPlan(input: EnsureNodeExecutionPlan): {
    intentId: number;
    taskId: number;
    replayed: boolean;
  } {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(
        `SELECT id, json_extract(metadata, '$.work_intent_id') AS intent_id
           FROM tasks
          WHERE epic_id=? AND generation_key=?`,
      ).get(input.task.epicId, input.task.generationKey) as
        | { id: number; intent_id: number | null }
        | undefined;
      if (existing) {
        if (!existing.intent_id) {
          throw new Error(`saga3: projected task ${existing.id} has no work_intent_id binding`);
        }
        const intent = this.readIntentStrict(existing.intent_id);
        if (
          intent.epic_id !== input.intent.epic_id
          || intent.kind !== input.intent.kind
          || intent.output_schema !== input.intent.output_schema
        ) {
          throw new Error(`saga3: execution plan ${input.task.generationKey} binding mismatch`);
        }
        if (
          intent.projected_task_id !== null
          && intent.projected_task_id !== existing.id
        ) {
          throw new Error(
            `saga3: execution plan ${input.task.generationKey} intent ${intent.id} `
            + `is already projected to task ${intent.projected_task_id}, not ${existing.id}`,
          );
        }
        if (intent.projected_task_id === null) {
          this.setProjectedTask(intent.id, existing.id);
        }
        const reboundTaskId = this.ensureProjectedTask({
          ...input.task,
          intentId: intent.id,
        });
        if (reboundTaskId !== existing.id) {
          throw new Error(
            `saga3: execution plan ${input.task.generationKey} resolved to `
            + `task ${reboundTaskId}, expected ${existing.id}`,
          );
        }
        db.exec('COMMIT');
        return { intentId: intent.id, taskId: existing.id, replayed: true };
      }

      const intent = this.createIntent(input.intent);
      const taskId = this.ensureProjectedTask({
        ...input.task,
        intentId: intent.id,
      });
      this.setProjectedTask(intent.id, taskId);
      db.exec('COMMIT');
      return { intentId: intent.id, taskId, replayed: false };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }

  readLatestExecutionId(taskId: number): string | null {
    const row = getDb().prepare(
      `SELECT execution_id
         FROM worker_executions
        WHERE task_id=?
        ORDER BY reserved_at DESC, execution_id DESC
        LIMIT 1`,
    ).get(taskId) as { execution_id: string } | undefined;
    return row?.execution_id ?? null;
  }

  readLatestManagedProductionExecutionId(
    taskId: number,
    processRunId: number,
    nodeId: string,
  ): string | null {
    try {
      const db = getDb();
      // A completed artifact-producing task normally has a producer
      // worker_done receipt that moved it to review, followed by a separate
      // reviewer receipt. Bind replay to that exact producer execution instead
      // of comparing ids from two independent ledger sequences.
      const completedProducer = db.prepare(
        `WITH managed_execution_ids AS (
           SELECT execution_id
             FROM saga3_managed_artifact_productions
            WHERE task_id=? AND process_run_id=? AND node_id=?
           UNION
           SELECT execution_id
             FROM saga3_managed_trace_productions
            WHERE task_id=? AND process_run_id=? AND node_id=?
         )
         SELECT cr.execution_id
           FROM command_receipts cr
           JOIN managed_execution_ids managed
             ON managed.execution_id=cr.execution_id
          WHERE cr.task_id=?
            AND cr.command_kind='worker_done'
            AND cr.accepted=1
            AND json_valid(cr.result_json)
            AND json_extract(
              cr.result_json,
              '$.completed_new_status'
            )='review'
          ORDER BY cr.accepted_at DESC, cr.rowid DESC
          LIMIT 1`,
      ).get(
        taskId,
        processRunId,
        nodeId,
        taskId,
        processRunId,
        nodeId,
        taskId,
      ) as { execution_id: string } | undefined;
      if (completedProducer) return completedProducer.execution_id;

      // Active/legacy fallback: rank executions by their own reservation
      // chronology, then by their latest product timestamp. Never compare a
      // ledger id from the artifact table with one from the trace table.
      const row = db.prepare(
        `WITH managed_products AS (
             SELECT execution_id, recorded_at
               FROM saga3_managed_artifact_productions
              WHERE task_id=? AND process_run_id=? AND node_id=?
             UNION ALL
             SELECT execution_id, recorded_at
               FROM saga3_managed_trace_productions
              WHERE task_id=? AND process_run_id=? AND node_id=?
           )
         SELECT products.execution_id
           FROM managed_products products
           LEFT JOIN worker_executions execution
             ON execution.execution_id=products.execution_id
          GROUP BY products.execution_id
          ORDER BY MAX(COALESCE(execution.started_at, execution.reserved_at)) DESC,
                   MAX(products.recorded_at) DESC,
                   products.execution_id DESC
          LIMIT 1`,
      ).get(
        taskId,
        processRunId,
        nodeId,
        taskId,
        processRunId,
        nodeId,
      ) as { execution_id: string } | undefined;
      return row?.execution_id ?? null;
    } catch (error) {
      // Managed-production tables are additive and may be absent in a legacy
      // discovery-only database. The caller retains its physical fallback.
      if (error instanceof Error && error.message.includes('no such table')) return null;
      throw error;
    }
  }

  readTaskProjectRepositoryId(taskId: number): number | null {
    const row = getDb().prepare(
      'SELECT project_repository_id FROM tasks WHERE id=?',
    ).get(taskId) as { project_repository_id: number | null } | undefined;
    return row?.project_repository_id ?? null;
  }

  prepareIntentForExecution(intentId: number, taskId: number): PrepareIntentForExecutionResult {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const intent = db.prepare(
        'SELECT status, projected_task_id FROM saga3_work_intents WHERE id=?',
      ).get(intentId) as { status: WorkIntentStatus; projected_task_id: number | null } | undefined;
      if (!intent) throw new Error(`saga3: WorkIntent ${intentId} not found during resume`);
      if (intent.projected_task_id !== taskId) {
        throw new Error(`saga3: WorkIntent ${intentId} is not projected to task ${taskId}`);
      }
      const task = db.prepare(
        `SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?`,
      ).get(taskId) as { status: string; assigned_to: string | null; current_execution_id: string | null } | undefined;
      if (!task) throw new Error(`saga3: projected task ${taskId} not found during resume`);
      if (task.status === 'done') {
        db.exec('COMMIT');
        return { state: 'done', intentStatus: intent.status, taskStatus: 'done' };
      }
      if (task.status === 'blocked') {
        if (intent.status === 'executing') {
          db.prepare(`UPDATE saga3_work_intents SET status='paused', updated_at=datetime('now') WHERE id=? AND status='executing'`).run(intentId);
        }
        db.exec('COMMIT');
        return { state: 'blocked', intentStatus: 'paused', taskStatus: 'blocked', detail: 'blocked tasks require controller/operator policy' };
      }
      if (task.current_execution_id) {
        const execution = db.prepare(
          'SELECT state, pid, started_at FROM worker_executions WHERE execution_id=?',
        ).get(task.current_execution_id) as { state: string; pid: number | null; started_at: string | null } | undefined;
        if (execution && ['reserved','running','cancel_requested'].includes(execution.state)) {
          // A 'reserved' execution without a PID is a zombie — the spawn
          // failed (or the process crashed before recording its PID). Treat
          // it as gone, not active, so prepareIntentForExecution falls
          // through to the reset path below. Without this, a zombie reserved
          // execution deadlocks resume forever: LM-executor sees state='active'
          // and returns paused without spawning a new worker.
          const isZombie = execution.state === 'reserved'
            && (execution.pid === null || execution.pid === undefined)
            && (execution.started_at === null || execution.started_at === undefined);
          if (!isZombie) {
            db.exec('COMMIT');
            return {
              state: 'active', intentStatus: 'executing', taskStatus: task.status,
              detail: `execution ${task.current_execution_id} is still ${execution.state}`,
            };
          }
          // Zombie reserved: mark it lost so it doesn't confuse future queries.
          db.prepare(
            `UPDATE worker_executions SET state='lost', finished_at=datetime('now'),
                    last_error='zombie reserved (no PID/started_at) cleaned by prepareIntentForExecution'
             WHERE execution_id=? AND state='reserved'`,
          ).run(task.current_execution_id);
        }
      }
      const restoredStatus = prepareSaga3ProjectedTaskForExecution(db, {
        taskId,
        currentStatus: task.status,
        assignedTo: task.assigned_to,
        currentExecutionId: task.current_execution_id,
      });
      let intentStatus = intent.status;
      if (intentStatus === 'executing') {
        db.prepare(`UPDATE saga3_work_intents SET status='paused', updated_at=datetime('now') WHERE id=? AND status='executing'`).run(intentId);
        intentStatus = 'paused';
      }
      if (intentStatus !== 'open' && intentStatus !== 'paused') {
        throw new Error(`saga3: WorkIntent ${intentId} status '${intentStatus}' is not resumable`);
      }
      db.exec('COMMIT');
      return { state: 'ready', intentStatus, taskStatus: restoredStatus };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
  }

  readWorkIntentForTask(taskId: number): WorkIntent | null {
    const db = getDb();
    const task = db.prepare(
      `SELECT json_extract(metadata, '$.work_intent_id') AS intent_id
         FROM tasks WHERE id=?`,
    ).get(taskId) as { intent_id: number | null } | undefined;
    if (!task || task.intent_id === null) return null;
    const row = db.prepare(
      'SELECT * FROM saga3_work_intents WHERE id=?',
    ).get(task.intent_id) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  readLatestProposal(intentId: number): ProposalRecord | null {
    const row = getDb().prepare(
      `SELECT * FROM saga3_proposals
        WHERE intent_id=? AND status='submitted'
        ORDER BY id DESC LIMIT 1`,
    ).get(intentId) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readProposalForExecution(
    intentId: number,
    taskId: number,
    executionId: string,
  ): ProposalRecord | null {
    const row = getDb().prepare(
      `SELECT * FROM saga3_proposals
        WHERE intent_id=? AND task_id=? AND execution_id=? AND status='submitted'
        ORDER BY id DESC LIMIT 1`,
    ).get(intentId, taskId, executionId) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readLatestProposalByEpic(epicId: number): ProposalRecord | null {
    const row = getDb().prepare(
      `SELECT p.* FROM saga3_proposals p
        JOIN saga3_work_intents i ON i.id = p.intent_id
        WHERE i.epic_id=? AND p.status='submitted'
        ORDER BY p.id DESC LIMIT 1`,
    ).get(epicId) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readLatestAcceptedReadinessForEpic(epicId: number): {
    assessment_id: number;
    content_hash: string;
    payload: unknown;
  } | null {
    ensureSaga3ReadinessSchema(getDb());
    const row = getDb().prepare(
      `SELECT a.id AS assessment_id, a.content_hash, a.payload
         FROM saga3_readiness_assessments a
         JOIN saga3_control_intents c ON c.id = a.control_intent_id
        WHERE c.epic_id=? AND a.status='accepted_by_kernel'
        ORDER BY a.id DESC LIMIT 1`,
    ).get(epicId) as
      | { assessment_id: number; content_hash: string; payload: unknown }
      | undefined;
    return row ?? null;
  }

  readLatestRawSubmission(intentId: number) {
    ensureSaga3NormalizationSchema(getDb());
    return readLatestRawSubmissionForIntent(getDb(), intentId);
  }

  readRawSubmission(submissionId: number) {
    ensureSaga3NormalizationSchema(getDb());
    return readRawSubmission(getDb(), submissionId);
  }

  readRawSubmissionForExecution(intentId: number, taskId: number, executionId: string) {
    ensureSaga3NormalizationSchema(getDb());
    return readRawSubmissionForExecution(getDb(), intentId, taskId, executionId);
  }

  ensureNormalizationControl(input: EnsureNormalizationControl): NormalizationControlExecution {
    const db = getDb();
    ensureSaga3NormalizationSchema(db);
    const ownsTransaction = !db.inTransaction;
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try {
    let control = db.prepare(
      `SELECT id, authority_intent_id, projected_task_id, status FROM saga3_control_intents WHERE source_submission_id=?`,
    ).get(input.sourceSubmissionId) as {
      id: number;
      authority_intent_id: number;
      projected_task_id: number | null;
      status: ControlIntentStatus;
    } | undefined;

    let authority: WorkIntent;
    if (!control) {
      authority = this.createIntent({
        epic_id: input.epicId,
        kind: DISCOVERY_NORMALIZATION_INTENT_KIND,
        objective: `Normalize raw discovery submission ${input.sourceSubmissionId}: ${input.objective}`,
        authority_scope: {
          snapshot_ref: `raw-submission:${input.sourceSubmissionId}`,
          scope: 'read-only normalization control',
          allowed_tools: ['task_get', 'normalization_get', 'normalization_submit', 'worker_done'],
          enforcement: 'runtime',
        },
        output_schema: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
        token_budget: 0,
        retry_budget: 0,
      });
      const info = db.prepare(
        `INSERT INTO saga3_control_intents
           (epic_id, kind, question, source_submission_id, authority_intent_id, status)
         VALUES (?, 'NormalizeDiscoveryProposal', ?, ?, ?, 'open')`,
      ).run(
        input.epicId,
        `Transform source ${input.sourceSubmissionId} into the discovery proposal schema without inventing evidence.`,
        input.sourceSubmissionId,
        authority.id,
      );
      control = {
        id: Number(info.lastInsertRowid),
        authority_intent_id: authority.id,
        projected_task_id: null,
        status: 'open',
      };
    } else {
      authority = this.readIntentStrict(control.authority_intent_id);
    }

    const taskId = this.ensureProjectedTask({
      epicId: input.epicId,
      projectId: input.projectId,
      intentId: authority.id,
      objective: authority.objective,
      taskKind: 'discovery.normalize',
      executionSkill: 'saga-discovery-normalizer',
      generationKey: `saga3:normalize:${input.sourceSubmissionId}`,
      metadata: { control_intent_id: control.id, source_submission_id: input.sourceSubmissionId },
    });
    if (!authority.projected_task_id) {
      this.setProjectedTask(authority.id, taskId);
      authority = this.readIntentStrict(authority.id);
    }
    if (control.projected_task_id !== taskId) {
      db.prepare(`UPDATE saga3_control_intents SET projected_task_id=?, updated_at=datetime('now') WHERE id=?`).run(taskId, control.id);
    }
    const result = {
      controlIntentId: control.id,
      sourceSubmissionId: input.sourceSubmissionId,
      controlStatus: control.status,
      authorityIntentId: authority.id,
      authorityIntentStatus: authority.status,
      taskId,
    };
    if (ownsTransaction) db.exec('COMMIT');
    return result;
    } catch (error) {
      if (ownsTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      }
      throw error;
    }
  }

  readLatestNormalizationProposal(controlIntentId: number) {
    ensureSaga3NormalizationSchema(getDb());
    return readLatestNormalizationProposalForControl(getDb(), controlIntentId);
  }

  readNormalizationProposalForExecution(
    controlIntentId: number,
    taskId: number,
    executionId: string,
  ) {
    ensureSaga3NormalizationSchema(getDb());
    return readNormalizationProposalForExecution(getDb(), controlIntentId, taskId, executionId);
  }

  setControlIntentStatus(controlIntentId: number, expected: ControlIntentStatus, next: ControlIntentStatus): boolean {
    const info = getDb().prepare(
      `UPDATE saga3_control_intents SET status=?, updated_at=datetime('now') WHERE id=? AND status=?`,
    ).run(next, controlIntentId, expected);
    return info.changes === 1;
  }

  ensureReadinessControl(input: EnsureReadinessControl): ReadinessControlExecution {
    const db = getDb();
    ensureSaga3ReadinessSchema(db);
    const ownsTransaction = !db.inTransaction;
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try {
    // Idempotent on the immutable Proposal version (proposal_id + content_hash).
    let control = db.prepare(
      `SELECT id, authority_intent_id, projected_task_id, status
         FROM saga3_readiness_control_intents
        WHERE proposal_id=? AND proposal_content_hash=?`,
    ).get(input.proposalId, input.proposalContentHash) as {
      id: number;
      authority_intent_id: number;
      projected_task_id: number | null;
      status: ReadinessControlStatus;
    } | undefined;

    let authority: WorkIntent;
    if (!control) {
      authority = this.createIntent({
        epic_id: input.epicId,
        kind: DISCOVERY_READINESS_INTENT_KIND,
        objective: `Assess readiness of discovery proposal ${input.proposalId}: ${input.objective}`,
        authority_scope: {
          snapshot_ref: `proposal:${input.proposalId}:${input.proposalContentHash.slice(0, 12)}`,
          scope: 'read-only shadow readiness assessment',
          // Minimal authority: exactly the tools the advisor needs, nothing more.
          allowed_tools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done'],
          enforcement: 'runtime',
        },
        output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
        token_budget: 0,
        retry_budget: 0,
      });
      const info = db.prepare(
        `INSERT INTO saga3_readiness_control_intents
           (epic_id, kind, proposal_id, proposal_content_hash, source_intent_id,
            authority_intent_id, status)
         VALUES (?, 'AssessDiscoveryReadiness', ?, ?, ?, ?, 'open')`,
      ).run(
        input.epicId,
        input.proposalId,
        input.proposalContentHash,
        input.sourceIntentId,
        authority.id,
      );
      control = {
        id: Number(info.lastInsertRowid),
        authority_intent_id: authority.id,
        projected_task_id: null,
        status: 'open',
      };
    } else {
      authority = this.readIntentStrict(control.authority_intent_id);
    }

    const taskId = this.ensureProjectedTask({
      epicId: input.epicId,
      projectId: input.projectId,
      intentId: authority.id,
      objective: authority.objective,
      taskKind: 'discovery.assess',
      executionSkill: 'saga-discovery-readiness-advisor',
      // generation_key ties the advisor task to the immutable Proposal version.
      generationKey: `saga3:assess:${input.proposalId}:${input.proposalContentHash.slice(0, 12)}`,
      metadata: {
        control_intent_id: control.id,
        proposal_id: input.proposalId,
        proposal_content_hash: input.proposalContentHash,
      },
    });
    if (!authority.projected_task_id) {
      this.setProjectedTask(authority.id, taskId);
      authority = this.readIntentStrict(authority.id);
    }
    if (control.projected_task_id !== taskId) {
      db.prepare(
        `UPDATE saga3_readiness_control_intents SET projected_task_id=?, updated_at=datetime('now') WHERE id=?`,
      ).run(taskId, control.id);
    }
    const result = {
      controlIntentId: control.id,
      proposalId: input.proposalId,
      proposalContentHash: input.proposalContentHash,
      controlStatus: control.status,
      authorityIntentId: authority.id,
      authorityIntentStatus: authority.status,
      taskId,
    };
    if (ownsTransaction) db.exec('COMMIT');
    return result;
    } catch (error) {
      if (ownsTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      }
      throw error;
    }
  }

  setReadinessControlStatus(controlIntentId: number, expected: ReadinessControlStatus, next: ReadinessControlStatus): boolean {
    const info = getDb().prepare(
      `UPDATE saga3_readiness_control_intents SET status=?, updated_at=datetime('now') WHERE id=? AND status=?`,
    ).run(next, controlIntentId, expected);
    return info.changes === 1;
  }

  readLatestReadinessAssessment(controlIntentId: number): ReadinessAssessmentRecord | null {
    ensureSaga3ReadinessSchema(getDb());
    return readLatestReadinessAssessmentForControl(getDb(), controlIntentId);
  }

  readReadinessAssessmentForExecution(
    controlIntentId: number,
    taskId: number,
    executionId: string,
  ): ReadinessAssessmentRecord | null {
    ensureSaga3ReadinessSchema(getDb());
    return readReadinessAssessmentForExecution(getDb(), controlIntentId, taskId, executionId);
  }

  readReadinessControlForProposal(proposalId: number, proposalContentHash: string): ReadinessControlIntentRecord | null {
    // D4: read-only lookup of the readiness ControlIntent for an exact immutable
    // Proposal version. Used by engine recovery (reconstruct the D3 readiness
    // shadow) and by the settlement service (full exact binding through the
    // ControlIntent + authority WorkIntent).
    ensureSaga3ReadinessSchema(getDb());
    return readReadinessControlForProposalRepo(getDb(), proposalId, proposalContentHash);
  }

  readWorkIntent(intentId: number): WorkIntent | null {
    // D4: read-only lookup of any WorkIntent by id (authority lineage binding).
    const row = getDb().prepare('SELECT * FROM saga3_work_intents WHERE id=?')
      .get(intentId) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  readProposalForSettlement(proposalId: number): SettlementProposalRecord | null {
    // D4: read the canonical proposal plus the lineage columns the snapshot
    // needs. epic_id is on the WorkIntent, project_id is on the epic, so join
    // both. kind/schema_version/status are surfaced so the service can do
    // EXACT target binding (it rejects a proposal of the wrong kind/schema/
    // status, or bound to a different epic/project than the request).
    ensureSaga3NormalizationSchema(getDb());
    const row = getDb().prepare(
      `SELECT p.id, p.intent_id, p.task_id, p.execution_id,
              p.kind, p.schema_version, p.status,
              p.content_hash, p.payload,
              p.source_submission_id, p.normalization_proposal_id,
              wi.epic_id AS epic_id, e.project_id AS project_id
         FROM saga3_proposals p
         JOIN saga3_work_intents wi ON wi.id = p.intent_id
         JOIN epics e ON e.id = wi.epic_id
        WHERE p.id=?`,
    ).get(proposalId) as
      | {
          id: number; intent_id: number; task_id: number; execution_id: string;
          kind: string; schema_version: string;
          status: string; content_hash: string; payload: string;
          source_submission_id: number | null; normalization_proposal_id: number | null;
          epic_id: number; project_id: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      epic_id: row.epic_id,
      project_id: row.project_id,
      intent_id: row.intent_id,
      task_id: row.task_id,
      execution_id: row.execution_id,
      kind: row.kind,
      schema_version: row.schema_version,
      status: row.status,
      content_hash: row.content_hash,
      // payload is stored as canonical JSON text; parse for the service to
      // re-validate and re-hash. The service recomputes the hash from the
      // canonical form and compares to content_hash, so a parse->canonicalize
      // round-trip must match (it does, by canonicalJson construction).
      payload: JSON.parse(row.payload),
      source_submission_id: row.source_submission_id,
      normalization_proposal_id: row.normalization_proposal_id,
    };
  }

  readReadinessAssessment(assessmentId: number): ReadinessAssessmentRecord | null {
    // D4: EXACT target binding — read the specific assessment by id (NOT the
    // latest accepted for a proposal). The engine supplies the exact
    // assessmentId/assessmentHash it observed via D3; the settlement must
    // build its snapshot from THAT assessment, never silently substitute a
    // newer accepted row that appeared afterwards.
    ensureSaga3ReadinessSchema(getDb());
    return readReadinessAssessment(getDb(), assessmentId);
  }

  findSettlementByInputKey(key: SettlementInputKey): SettlementRecord | null {
    ensureSaga3SettlementSchema(getDb());
    return findSettlementByInputKeyRepo(getDb(), key);
  }

  insertSettlement(input: InsertSettlementPort): { record: SettlementRecord; replayed: boolean } {
    ensureSaga3SettlementSchema(getDb());
    return insertSettlementRepo(getDb(), input);
  }

  markSettlementFailed(settlementId: number): void {
    ensureSaga3SettlementSchema(getDb());
    markSettlementFailedRepo(getDb(), settlementId);
  }

  readCertificateForSettlement(settlementId: number): OutcomeCertificateRecord | null {
    ensureSaga3SettlementSchema(getDb());
    return readCertificateForSettlementRepo(getDb(), settlementId);
  }

  readOutcomeCertificate(certificateId: number): OutcomeCertificateRecord | null {
    // D5: load the immutable diagnosis target by exact certificate id. Read-only.
    ensureSaga3SettlementSchema(getDb());
    return readOutcomeCertificateRepo(getDb(), certificateId);
  }

  readSettlement(settlementId: number): SettlementRecord | null {
    // D5: load the settlement by exact id (settlement/certificate relation
    // verification before building the diagnosis case). Read-only.
    ensureSaga3SettlementSchema(getDb());
    return readSettlementRepo(getDb(), settlementId);
  }

  issueCertificateAtomically(input: IssueCertificateAtomicallyInput): {
    record: OutcomeCertificateRecord;
    inserted: boolean;
  } {
    ensureSaga3SettlementSchema(getDb());
    return issueCertificateAtomicallyRepo(getDb(), input);
  }

  reconcileExistingCertificate(input: IssueCertificateAtomicallyInput): OutcomeCertificateRecord {
    ensureSaga3SettlementSchema(getDb());
    return reconcileExistingCertificateRepo(getDb(), input);
  }

  // -------------------------------------------------------------------------
  // D5: advisory diagnosis. Read-only against D4 artifacts; the ONLY writes are
  // the two diagnosis tables. Diagnosis never mutates the D4
  // settlement/certificate, the product Proposal, or the readiness assessment.
  // -------------------------------------------------------------------------

  ensureDiagnosisControl(input: EnsureDiagnosisControl): DiagnosisControlExecution {
    const db = getDb();
    ensureSaga3DiagnosisSchema(db);
    // Idempotent on the immutable certificate target (certificate_id +
    // certificate_hash + diagnosis_contract_version).
    let control = db.prepare(
      `SELECT id, epic_id, kind, certificate_id, certificate_hash, settlement_input_hash,
              diagnosis_case, diagnosis_case_hash, diagnosis_contract_version,
              authority_intent_id, projected_task_id, status
         FROM saga3_discovery_diagnosis_control_intents
        WHERE certificate_id=? AND certificate_hash=? AND diagnosis_contract_version=?`,
    ).get(
      input.certificateId,
      input.certificateHash,
      input.diagnosisContractVersion,
    ) as {
      id: number;
      epic_id: number;
      kind: string;
      certificate_id: number;
      certificate_hash: string;
      settlement_input_hash: string;
      diagnosis_case: string;
      diagnosis_case_hash: string;
      diagnosis_contract_version: string;
      authority_intent_id: number;
      projected_task_id: number | null;
      status: DiagnosisControlStatus;
    } | undefined;

    let authority: WorkIntent;
    if (!control) {
      authority = this.createIntent({
        epic_id: input.epicId,
        kind: DISCOVERY_DIAGNOSIS_INTENT_KIND,
        objective: `Diagnose discovery outcome certificate ${input.certificateId}: ${input.objective}`,
        authority_scope: {
          snapshot_ref: `certificate:${input.certificateId}:${input.certificateHash.slice(0, 12)}`,
          scope: 'read-only advisory diagnosis',
          // Minimal authority: exactly the tools the advisor needs, nothing more.
          // No proposal_submit / readiness_submit / settlement_submit /
          // certificate_submit / stage_transition / task_create (architecture F8).
          allowed_tools: ['task_get', 'diagnosis_get', 'diagnosis_submit', 'worker_done'],
          enforcement: 'runtime',
        },
        output_schema: DISCOVERY_DIAGNOSIS_WORK_INTENT_SCHEMA,
        token_budget: 0,
        retry_budget: 0,
      });
      const info = db.prepare(
        `INSERT INTO saga3_discovery_diagnosis_control_intents
           (epic_id, kind, certificate_id, certificate_hash, settlement_input_hash,
            diagnosis_case, diagnosis_case_hash, diagnosis_contract_version,
            authority_intent_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      ).run(
        input.epicId,
        DIAGNOSE_DISCOVERY_OUTCOME_KIND,
        input.certificateId,
        input.certificateHash,
        input.settlementInputHash,
        input.diagnosisCase,
        input.diagnosisCaseHash,
        input.diagnosisContractVersion,
        authority.id,
      );
      control = {
        id: Number(info.lastInsertRowid),
        epic_id: input.epicId,
        kind: DIAGNOSE_DISCOVERY_OUTCOME_KIND,
        certificate_id: input.certificateId,
        certificate_hash: input.certificateHash,
        settlement_input_hash: input.settlementInputHash,
        diagnosis_case: input.diagnosisCase,
        diagnosis_case_hash: input.diagnosisCaseHash,
        diagnosis_contract_version: input.diagnosisContractVersion,
        authority_intent_id: authority.id,
        projected_task_id: null,
        status: 'open',
      };
    } else {
      let storedCase: unknown;
      try { storedCase = JSON.parse(control.diagnosis_case); } catch {
        throw new Error(`saga3: diagnosis control ${control.id} diagnosis_case is not valid JSON`);
      }
      const storedRecomputedHash = diagnosisCaseHash(
        storedCase as Parameters<typeof diagnosisCaseHash>[0],
      );
      const reuseChecks: Array<[string, unknown, unknown]> = [
        ['epic_id', control.epic_id, input.epicId],
        ['kind', control.kind, DIAGNOSE_DISCOVERY_OUTCOME_KIND],
        ['certificate_id', control.certificate_id, input.certificateId],
        ['certificate_hash', control.certificate_hash, input.certificateHash],
        ['settlement_input_hash', control.settlement_input_hash, input.settlementInputHash],
        ['diagnosis_case_hash', control.diagnosis_case_hash, input.diagnosisCaseHash],
        ['recomputed diagnosis_case_hash', storedRecomputedHash, control.diagnosis_case_hash],
        ['diagnosis_contract_version', control.diagnosis_contract_version, input.diagnosisContractVersion],
      ];
      for (const [field, actual, expected] of reuseChecks) {
        if (actual !== expected) {
          throw new Error(
            `saga3: diagnosis control ${control.id} ${field} '${String(actual)}' != expected '${String(expected)}'`,
          );
        }
      }
      authority = this.readIntentStrict(control.authority_intent_id);
    }

    const taskId = this.ensureProjectedTask({
      epicId: input.epicId,
      projectId: input.projectId,
      intentId: authority.id,
      objective: authority.objective,
      taskKind: 'discovery.diagnose',
      executionSkill: 'saga-discovery-diagnosis-advisor',
      // generation_key ties the advisor task to the immutable certificate target.
      generationKey: `saga3:diagnose:${input.certificateId}:${input.certificateHash.slice(0, 12)}`,
      metadata: {
        control_intent_id: control.id,
        certificate_id: input.certificateId,
        certificate_hash: input.certificateHash,
        settlement_input_hash: input.settlementInputHash,
        diagnosis_case_hash: input.diagnosisCaseHash,
        diagnosis_contract_version: input.diagnosisContractVersion,
      },
    });
    if (!authority.projected_task_id) {
      this.setProjectedTask(authority.id, taskId);
      authority = this.readIntentStrict(authority.id);
    }
    if (control.projected_task_id !== taskId) {
      db.prepare(
        `UPDATE saga3_discovery_diagnosis_control_intents
           SET projected_task_id=?, updated_at=datetime('now') WHERE id=?`,
      ).run(taskId, control.id);
    }
    return {
      controlIntentId: control.id,
      certificateId: input.certificateId,
      certificateHash: input.certificateHash,
      settlementInputHash: input.settlementInputHash,
      controlStatus: control.status,
      authorityIntentId: authority.id,
      authorityIntentStatus: authority.status,
      taskId,
      diagnosisCase: input.diagnosisCase,
      diagnosisCaseHash: input.diagnosisCaseHash,
    };
  }

  setDiagnosisControlStatus(controlIntentId: number, expected: DiagnosisControlStatus, next: DiagnosisControlStatus): boolean {
    const info = getDb().prepare(
      `UPDATE saga3_discovery_diagnosis_control_intents
          SET status=?, updated_at=datetime('now') WHERE id=? AND status=?`,
    ).run(next, controlIntentId, expected);
    return info.changes === 1;
  }

  readDiagnosisControlForTarget(certificateId: number, certificateHash: string): DiagnosisControlIntentRecord | null {
    ensureSaga3DiagnosisSchema(getDb());
    return findDiagnosisControlByTargetRepo(getDb(), certificateId, certificateHash);
  }

  readDiagnosisControl(controlIntentId: number): DiagnosisControlIntentRecord | null {
    ensureSaga3DiagnosisSchema(getDb());
    return readDiagnosisControlByIdRepo(getDb(), controlIntentId);
  }

  readAcceptedDiagnosisReport(controlIntentId: number): DiagnosisReportRecord | null {
    ensureSaga3DiagnosisSchema(getDb());
    return readAcceptedDiagnosisReportForControlRepo(getDb(), controlIntentId);
  }

  readLatestDiagnosisReport(controlIntentId: number): DiagnosisReportRecord | null {
    ensureSaga3DiagnosisSchema(getDb());
    return readLatestDiagnosisReportForControlRepo(getDb(), controlIntentId);
  }

  submitDiagnosisReportAtomically(input: SubmitDiagnosisReportInput): {
    record: DiagnosisReportRecord;
    inserted: boolean;
    replayed: boolean;
  } {
    ensureSaga3DiagnosisSchema(getDb());
    return submitDiagnosisReportAtomicallyRepo(getDb(), input);
  }

  private readIntentStrict(id: number): WorkIntent {
    const row = getDb().prepare(
      'SELECT * FROM saga3_work_intents WHERE id=?',
    ).get(id) as WorkIntentRow | undefined;
    if (!row) throw new Error(`saga3: WorkIntent ${id} vanished after insert`);
    return rowToIntent(row);
  }
}

interface WorkIntentRow {
  id: number;
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: string;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
  projected_task_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToIntent(row: WorkIntentRow): WorkIntent {
  return {
    id: row.id,
    epic_id: row.epic_id,
    kind: row.kind,
    objective: row.objective,
    authority_scope: JSON.parse(row.authority_scope),
    output_schema: row.output_schema,
    token_budget: row.token_budget,
    retry_budget: row.retry_budget,
    projected_task_id: row.projected_task_id,
    status: row.status as WorkIntentStatus,
    created_at: row.created_at,
  };
}

interface ProposalRow {
  id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  payload: string;
  content_hash: string;
  status: string;
  provenance: string;
  created_at: string;
}

function rowToRecord(row: ProposalRow): ProposalRecord {
  const provenance = row.provenance && row.provenance !== '{}'
    ? (JSON.parse(row.provenance) as ProposalRecord['provenance'])
    : null;
  return {
    id: row.id,
    intent_id: row.intent_id,
    task_id: row.task_id,
    execution_id: row.execution_id,
    kind: row.kind,
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload),
    content_hash: row.content_hash,
    status: row.status as ProposalRecord['status'],
    provenance: provenance as NonNullable<typeof provenance>,
    created_at: row.created_at,
  };
}


function ensurePausedWorkIntentStatus(db: ReturnType<typeof getDb>): void {
  const ddl = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='saga3_work_intents'",
  ).get() as { sql: string } | undefined;
  if (!ddl?.sql || ddl.sql.includes("'paused'")) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE saga3_work_intents_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        objective TEXT NOT NULL,
        authority_scope TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        token_budget INTEGER NOT NULL DEFAULT 0,
        retry_budget INTEGER NOT NULL DEFAULT 0,
        projected_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','executing','paused','concluded','cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO saga3_work_intents_new
        (id, epic_id, kind, objective, authority_scope, output_schema,
         token_budget, retry_budget, projected_task_id, status, created_at, updated_at)
      SELECT id, epic_id, kind, objective, authority_scope, output_schema,
             token_budget, retry_budget, projected_task_id, status, created_at, updated_at
        FROM saga3_work_intents;
      DROP TABLE saga3_work_intents;
      ALTER TABLE saga3_work_intents_new RENAME TO saga3_work_intents;
      CREATE INDEX IF NOT EXISTS idx_saga3_work_intents_epic ON saga3_work_intents(epic_id);
      CREATE INDEX IF NOT EXISTS idx_saga3_work_intents_kind_status ON saga3_work_intents(kind, status);
    `);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw new Error(`Migration 'saga3 WorkIntent paused' failed: ${(error as Error).message}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violation = db.prepare('PRAGMA foreign_key_check').get();
  if (violation) throw new Error("Migration 'saga3 WorkIntent paused' produced foreign key violations");
}

// Re-export the canonical-JSON helpers so the proposal handler keeps a single
// hashing implementation (recordProposal below mirrors the repository's path).
export { canonicalJson, hashPayload };
