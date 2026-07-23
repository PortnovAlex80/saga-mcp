import { createHash } from 'node:crypto';
import { getDb } from '../../db.js';
import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../domain/work-intent.js';
import type {
  ProposalProvenance,
  ProposalRecord,
  ProposalStatus,
  SubmitProposal,
  SubmittedProposalResult,
} from '../domain/proposal.js';

/**
 * Canonical JSON stringify for content hashing. Keys are sorted so the same
 * semantic payload always hashes identically regardless of object key order.
 * Roadmap §4.6 (D4): certificates must be reproducible from the same stored
 * inputs — deterministic hashing is what makes that true.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** SHA-256 of the canonical JSON encoding of a proposal payload. */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
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
    ? (JSON.parse(row.provenance) as ProposalProvenance)
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
    status: row.status as ProposalStatus,
    provenance,
    created_at: row.created_at,
  };
}

/**
 * SQLite repository for saga3_work_intents + saga3_proposals.
 *
 * Owns the create / read / status transitions for both tables. The
 * proposal_submit handler (src/tools/saga3-proposals.ts) performs the fence +
 * schema validation then delegates the INSERT here; this module never trusts
 * worker-supplied provenance (it is supplied explicitly by the handler).
 */
export class Saga3ProposalRepository {
  createWorkIntent(command: CreateWorkIntent): WorkIntent {
    const db = getDb();
    const authorityScope = JSON.stringify(command.authority_scope);
    const info = db.prepare(
      `INSERT INTO saga3_work_intents
         (epic_id, kind, objective, authority_scope, output_schema,
          token_budget, retry_budget, status)
       VALUES (?,?,?,?,?,?,?, 'open')`,
    ).run(
      command.epic_id,
      command.kind,
      command.objective,
      authorityScope,
      command.output_schema,
      command.token_budget,
      command.retry_budget,
    );
    return this.readWorkIntent(Number(info.lastInsertRowid))!;
  }

  readWorkIntent(id: number): WorkIntent | null {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM saga3_work_intents WHERE id=?',
    ).get(id) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  /** Open WorkIntent of a given kind for an episode, if any (engine lookup). */
  readOpenIntentByEpic(epicId: number, kind: string): WorkIntent | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM saga3_work_intents
        WHERE epic_id=? AND kind=? AND status IN ('open','executing')
        ORDER BY id DESC LIMIT 1`,
    ).get(epicId, kind) as WorkIntentRow | undefined;
    return row ? rowToIntent(row) : null;
  }

  /** Link the projected board task to the intent (idempotent). */
  setProjectedTask(intentId: number, taskId: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE saga3_work_intents SET projected_task_id=?, updated_at=datetime('now')
        WHERE id=?`,
    ).run(taskId, intentId);
  }

  setIntentStatus(intentId: number, status: WorkIntentStatus): void {
    const db = getDb();
    db.prepare(
      `UPDATE saga3_work_intents SET status=?, updated_at=datetime('now') WHERE id=?`,
    ).run(status, intentId);
  }

  /**
   * Persist a worker-submitted proposal. Provenance is supplied by the caller
   * (the proposal_submit handler captures it from the execution fence + model
   * route) — never trusted from the worker payload. Returns the new id + hash.
   */
  recordProposal(
    submission: SubmitProposal,
    provenance: ProposalProvenance,
  ): SubmittedProposalResult {
    const db = getDb();
    const payloadJson = canonicalJson(submission.payload);
    const contentHash = createHash('sha256').update(payloadJson).digest('hex');
    const info = db.prepare(
      `INSERT INTO saga3_proposals
         (intent_id, task_id, execution_id, kind, schema_version,
          payload, content_hash, status, provenance)
       VALUES (?,?,?,?,?,?,?, 'submitted', ?)`,
    ).run(
      submission.intent_id,
      submission.task_id,
      submission.execution_id,
      submission.kind,
      submission.schema_version,
      payloadJson,
      contentHash,
      JSON.stringify(provenance),
    );
    return { proposal_id: Number(info.lastInsertRowid), content_hash: contentHash, status: 'submitted' };
  }

  /** Latest submitted proposal for an intent (engine reads it after the task). */
  readLatestProposalForIntent(intentId: number): ProposalRecord | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM saga3_proposals
        WHERE intent_id=? AND status='submitted'
        ORDER BY id DESC LIMIT 1`,
    ).get(intentId) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
