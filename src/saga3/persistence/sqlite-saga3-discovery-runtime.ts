import { getDb } from '../../db.js';
import { prepareSaga3ProjectedTaskForExecution } from '../../lifecycle/legacy-assignment-recovery.js';
import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../domain/work-intent.js';
import type { ProposalRecord } from '../domain/proposal.js';
import { DISCOVERY_NORMALIZATION_INTENT_KIND, DISCOVERY_READINESS_INTENT_KIND } from '../domain/work-intent.js';
import { DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA } from '../domain/discovery-normalization-proposal.js';
import { DISCOVERY_READINESS_ASSESSMENT_SCHEMA } from '../domain/discovery-readiness-assessment.js';
import type { ControlIntentStatus } from '../domain/discovery-normalization-records.js';
import type { ReadinessAssessmentRecord, ReadinessControlExecution, ReadinessControlStatus } from '../domain/discovery-readiness-records.js';
import {
  type EnsureNormalizationControl,
  type EnsureProjectedTask,
  type EnsureReadinessControl,
  type NormalizationControlExecution,
  type PrepareIntentForExecutionResult,
  type Saga3DiscoveryRuntimePersistence,
} from './saga3-discovery-runtime-port.js';
import {
  canonicalJson,
  hashPayload,
} from './saga3-proposal-repository.js';
import { ensureSaga3NormalizationSchema, readLatestRawSubmissionForIntent } from './saga3-normalization-repository.js';
import {
  ensureSaga3ReadinessSchema,
  readLatestReadinessAssessmentForControl,
} from './saga3-readiness-repository.js';

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
      'SELECT id FROM tasks WHERE epic_id=? AND generation_key=?',
    ).get(input.epicId, input.generationKey) as { id: number } | undefined;
    if (existing) return existing.id;

    const repoId = db.prepare(
      'SELECT id FROM project_repositories WHERE project_id=? ORDER BY id LIMIT 1',
    ).get(input.projectId) as { id: number } | undefined;

    const info = db.prepare(
      `INSERT INTO tasks
         (epic_id, title, description, status, priority, task_kind, workflow_stage,
          execution_skill, execution_mode, project_repository_id, generation_key, tags, metadata)
       VALUES (?, ?, ?, 'todo', 'high', ?, 'discovery', ?, 'tracker_only', ?, ?, '[]', ?)`,
    ).run(
      input.epicId,
      `Discovery: ${input.objective.slice(0, 80)}`,
      JSON.stringify({ work_intent_id: input.intentId, objective: input.objective, ...(input.metadata ?? {}) }),
      input.taskKind,
      input.executionSkill,
      repoId?.id ?? null,
      input.generationKey,
      JSON.stringify({ work_intent_id: input.intentId, ...(input.metadata ?? {}) }),
    );
    return Number(info.lastInsertRowid);
  }

  readTaskState(taskId: number): string | null {
    const row = getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
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
          'SELECT state FROM worker_executions WHERE execution_id=?',
        ).get(task.current_execution_id) as { state: string } | undefined;
        if (execution && ['reserved','running','cancel_requested'].includes(execution.state)) {
          db.exec('COMMIT');
          return {
            state: 'active', intentStatus: 'executing', taskStatus: task.status,
            detail: `execution ${task.current_execution_id} is still ${execution.state}`,
          };
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
    if (!task || task.intent_id == null) return null;
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

  readLatestRawSubmission(intentId: number) {
    ensureSaga3NormalizationSchema(getDb());
    return readLatestRawSubmissionForIntent(getDb(), intentId);
  }

  ensureNormalizationControl(input: EnsureNormalizationControl): NormalizationControlExecution {
    const db = getDb();
    ensureSaga3NormalizationSchema(db);
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
    return {
      controlIntentId: control.id,
      sourceSubmissionId: input.sourceSubmissionId,
      controlStatus: control.status,
      authorityIntentId: authority.id,
      authorityIntentStatus: authority.status,
      taskId,
    };
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
    return {
      controlIntentId: control.id,
      proposalId: input.proposalId,
      proposalContentHash: input.proposalContentHash,
      controlStatus: control.status,
      authorityIntentId: authority.id,
      authorityIntentStatus: authority.status,
      taskId,
    };
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
