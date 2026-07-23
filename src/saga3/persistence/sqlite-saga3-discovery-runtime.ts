import { getDb } from '../../db.js';
import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../domain/work-intent.js';
import type { ProposalRecord } from '../domain/proposal.js';
import {
  type EnsureProjectedTask,
  type Saga3DiscoveryRuntimePersistence,
} from './saga3-discovery-runtime-port.js';
import {
  canonicalJson,
  hashPayload,
} from './saga3-proposal-repository.js';

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
  readEpicObjective(epicId: number): { name: string; description: string | null } | null {
    const row = getDb().prepare(
      'SELECT name, description FROM epics WHERE id=?',
    ).get(epicId) as { name: string; description: string | null } | undefined;
    return row ?? null;
  }

  readOpenIntent(epicId: number, kind: string): WorkIntent | null {
    const row = getDb().prepare(
      `SELECT * FROM saga3_work_intents
        WHERE epic_id=? AND kind=? AND status IN ('open','executing')
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
      JSON.stringify({ work_intent_id: input.intentId, objective: input.objective }),
      input.taskKind,
      input.executionSkill,
      repoId?.id ?? null,
      input.generationKey,
      JSON.stringify({ work_intent_id: input.intentId }),
    );
    return Number(info.lastInsertRowid);
  }

  readTaskState(taskId: number): string | null {
    const row = getDb().prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  readLatestProposal(intentId: number): ProposalRecord | null {
    const row = getDb().prepare(
      `SELECT * FROM saga3_proposals
        WHERE intent_id=? AND status='submitted'
        ORDER BY id DESC LIMIT 1`,
    ).get(intentId) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
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

// Re-export the canonical-JSON helpers so the proposal handler keeps a single
// hashing implementation (recordProposal below mirrors the repository's path).
export { canonicalJson, hashPayload };
