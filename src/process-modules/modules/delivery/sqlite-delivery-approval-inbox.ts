import type Database from 'better-sqlite3';
import { getDb } from '../../../db.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  DeliveryApprovalSource,
  DeliveryApprovalSourceResult,
  DeliveryProviderIdentity,
} from './delivery-provider-ports.js';
import type { AuthorizedDeliveryReleaseCase } from './delivery-schemas.js';

export const DELIVERY_APPROVAL_RECORD_SCHEMA =
  'saga3.delivery-approval-record.v1';

export interface DeliveryApprovalRequestRecord {
  requestId: string;
  processRunId: number;
  projectId: number;
  epicId: number | null;
  candidateHash: string;
  preflightHash: string;
  releasePolicyHash: string;
  state: 'open' | 'decided';
  createdAt: string;
  decidedAt: string | null;
}

export interface RecordDeliveryApprovalDecision {
  requestId: string;
  status: 'approved' | 'denied' | 'expired';
  decidedBy: string;
  rationale: string;
  providerId: number;
}

/**
 * Standard human-approval bridge for Delivery.
 *
 * The flow pauses while the request is open. UI/MCP records a decision in the
 * inbox; resuming the same ProcessRun re-enters the human node and receives
 * the immutable, candidate/preflight/policy-bound decision.
 */
export class SqliteDeliveryApprovalInbox implements DeliveryApprovalSource {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureDeliveryApprovalInboxSchema(db);
  }

  decide(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    preflightHash: string;
    heartbeat: () => void;
  }): DeliveryApprovalSourceResult {
    input.heartbeat();
    const request = this.ensureRequest(input);
    const decision = this.db.prepare(
      `SELECT status,decision_ref,decision_hash,provider_id
         FROM saga3_delivery_approval_decisions
        WHERE request_id=?`,
    ).get(request.requestId) as {
      status: 'approved' | 'denied' | 'expired';
      decision_ref: string;
      decision_hash: string;
      provider_id: number;
    } | undefined;
    if (!decision) {
      return {
        status: 'pending',
        decision: null,
        provider: null,
      };
    }
    const provider = this.readProvider(
      input.deliveryCase.projectId,
      decision.provider_id,
    );
    return {
      status: decision.status,
      decision: {
        schema: DELIVERY_APPROVAL_RECORD_SCHEMA,
        ref: decision.decision_ref,
        hash: decision.decision_hash,
      },
      provider,
    };
  }

  recordDecision(
    input: RecordDeliveryApprovalDecision,
  ): {
    request: DeliveryApprovalRequestRecord;
    replayed: boolean;
    decisionRef: string;
    decisionHash: string;
  } {
    if (!input.requestId.trim()) {
      throw new Error('DELIVERY_APPROVAL_REQUEST_ID_REQUIRED');
    }
    if (!input.decidedBy.trim()) {
      throw new Error('DELIVERY_APPROVAL_DECIDED_BY_REQUIRED');
    }
    if (!input.rationale.trim()) {
      throw new Error('DELIVERY_APPROVAL_RATIONALE_REQUIRED');
    }
    const request = this.readRequest(input.requestId);
    if (!request) {
      throw new Error(
        `DELIVERY_APPROVAL_REQUEST_NOT_FOUND: ${input.requestId}`,
      );
    }
    const provider = this.readProvider(
      request.projectId,
      input.providerId,
    );
    const body = {
      schemaVersion: DELIVERY_APPROVAL_RECORD_SCHEMA,
      requestId: request.requestId,
      processRunId: request.processRunId,
      projectId: request.projectId,
      epicId: request.epicId,
      candidateHash: request.candidateHash,
      preflightHash: request.preflightHash,
      releasePolicyHash: request.releasePolicyHash,
      status: input.status,
      decidedBy: input.decidedBy,
      rationale: input.rationale,
      provider,
    };
    const decisionHash = sha256Hex(body);
    const decisionRef =
      `delivery-approval:${request.requestId}:${decisionHash}`;

    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT status,decision_ref,decision_hash,payload_snapshot
           FROM saga3_delivery_approval_decisions
          WHERE request_id=?`,
      ).get(request.requestId) as {
        status: string;
        decision_ref: string;
        decision_hash: string;
        payload_snapshot: string;
      } | undefined;
      const payloadSnapshot = canonicalJson(body);
      if (existing) {
        if (
          existing.status !== input.status
          || existing.decision_ref !== decisionRef
          || existing.decision_hash !== decisionHash
          || existing.payload_snapshot !== payloadSnapshot
        ) {
          throw new Error(
            `DELIVERY_APPROVAL_DECISION_IMMUTABLE: ${request.requestId}`,
          );
        }
        return {
          request: this.readRequest(request.requestId)!,
          replayed: true,
          decisionRef,
          decisionHash,
        };
      }
      if (request.state !== 'open') {
        throw new Error(
          `DELIVERY_APPROVAL_REQUEST_NOT_OPEN: ${request.requestId}`,
        );
      }
      this.db.prepare(
        `INSERT INTO saga3_delivery_approval_decisions
          (request_id,status,decided_by,rationale,provider_id,decision_ref,
           decision_hash,payload_snapshot)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        request.requestId,
        input.status,
        input.decidedBy,
        input.rationale,
        input.providerId,
        decisionRef,
        decisionHash,
        payloadSnapshot,
      );
      this.db.prepare(
        `UPDATE saga3_delivery_approval_requests
            SET state='decided',decided_at=datetime('now'),
                updated_at=datetime('now')
          WHERE request_id=? AND state='open'`,
      ).run(request.requestId);
      return {
        request: this.readRequest(request.requestId)!,
        replayed: false,
        decisionRef,
        decisionHash,
      };
    });
  }

  readRequest(requestId: string): DeliveryApprovalRequestRecord | null {
    const row = this.db.prepare(
      `SELECT request_id,process_run_id,project_id,epic_id,candidate_hash,
              preflight_hash,release_policy_hash,state,created_at,decided_at
         FROM saga3_delivery_approval_requests
        WHERE request_id=?`,
    ).get(requestId) as ApprovalRequestRow | undefined;
    return row ? requestRowToRecord(row) : null;
  }

  listOpen(projectId?: number): DeliveryApprovalRequestRecord[] {
    const rows = projectId === undefined
      ? this.db.prepare(
          `SELECT request_id,process_run_id,project_id,epic_id,candidate_hash,
                  preflight_hash,release_policy_hash,state,created_at,decided_at
             FROM saga3_delivery_approval_requests
            WHERE state='open'
            ORDER BY created_at,request_id`,
        ).all()
      : this.db.prepare(
          `SELECT request_id,process_run_id,project_id,epic_id,candidate_hash,
                  preflight_hash,release_policy_hash,state,created_at,decided_at
             FROM saga3_delivery_approval_requests
            WHERE state='open' AND project_id=?
            ORDER BY created_at,request_id`,
        ).all(projectId);
    return (rows as ApprovalRequestRow[]).map(requestRowToRecord);
  }

  private ensureRequest(input: {
    processRunId: number;
    deliveryCase: AuthorizedDeliveryReleaseCase;
    preflightHash: string;
  }): DeliveryApprovalRequestRecord {
    const requestId = `delivery-approval-request:${input.processRunId}`;
    const existing = this.readRequest(requestId);
    if (existing) {
      if (
        existing.processRunId !== input.processRunId
        || existing.projectId !== input.deliveryCase.projectId
        || existing.epicId !== input.deliveryCase.epicId
        || existing.candidateHash
          !== input.deliveryCase.integratedCandidate.hash
        || existing.preflightHash !== input.preflightHash
        || existing.releasePolicyHash
          !== input.deliveryCase.policy.contentHash
      ) {
        throw new Error(
          `DELIVERY_APPROVAL_REQUEST_REPLAY_MISMATCH: ${requestId}`,
        );
      }
      return existing;
    }
    this.db.prepare(
      `INSERT INTO saga3_delivery_approval_requests
        (request_id,process_run_id,project_id,epic_id,candidate_hash,
         preflight_hash,release_policy_hash,requested_by)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      requestId,
      input.processRunId,
      input.deliveryCase.projectId,
      input.deliveryCase.epicId,
      input.deliveryCase.integratedCandidate.hash,
      input.preflightHash,
      input.deliveryCase.policy.contentHash,
      input.deliveryCase.initiatedBy,
    );
    return this.readRequest(requestId)!;
  }

  private readProvider(
    projectId: number,
    providerId: number,
  ): DeliveryProviderIdentity {
    const row = this.db.prepare(
      `SELECT id,name,version,category,project_id
         FROM trusted_providers
        WHERE id=? AND category='authorized_decision' AND status='active'
          AND (project_id=? OR project_id IS NULL)`,
    ).get(providerId, projectId) as {
      id: number;
      name: string;
      version: string | null;
      category: 'authorized_decision';
      project_id: number | null;
    } | undefined;
    if (!row) {
      throw new Error(
        `DELIVERY_APPROVAL_PROVIDER_NOT_TRUSTED: ${providerId}`,
      );
    }
    return {
      providerId: row.id,
      name: row.name,
      version: row.version,
      category: 'authorized_decision',
    };
  }

  private transaction<T>(work: () => T): T {
    const owns = !this.db.inTransaction;
    if (owns) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (owns) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (owns) {
        try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
      }
      throw error;
    }
  }
}

export function ensureDeliveryApprovalInboxSchema(
  db: Database.Database,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_delivery_approval_requests (
      request_id         TEXT PRIMARY KEY,
      process_run_id     INTEGER NOT NULL UNIQUE
                           REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      project_id         INTEGER NOT NULL
                           REFERENCES projects(id) ON DELETE RESTRICT,
      epic_id            INTEGER REFERENCES epics(id) ON DELETE RESTRICT,
      candidate_hash     TEXT NOT NULL,
      preflight_hash     TEXT NOT NULL,
      release_policy_hash TEXT NOT NULL,
      requested_by       TEXT NOT NULL,
      state              TEXT NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open','decided')),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_delivery_approval_open
      ON saga3_delivery_approval_requests(state,project_id,created_at);

    CREATE TABLE IF NOT EXISTS saga3_delivery_approval_decisions (
      request_id       TEXT PRIMARY KEY
                         REFERENCES saga3_delivery_approval_requests(request_id)
                         ON DELETE RESTRICT,
      status           TEXT NOT NULL
                         CHECK (status IN ('approved','denied','expired')),
      decided_by       TEXT NOT NULL,
      rationale        TEXT NOT NULL,
      provider_id      INTEGER NOT NULL
                         REFERENCES trusted_providers(id) ON DELETE RESTRICT,
      decision_ref     TEXT NOT NULL UNIQUE,
      decision_hash    TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

interface ApprovalRequestRow {
  request_id: string;
  process_run_id: number;
  project_id: number;
  epic_id: number | null;
  candidate_hash: string;
  preflight_hash: string;
  release_policy_hash: string;
  state: 'open' | 'decided';
  created_at: string;
  decided_at: string | null;
}

function requestRowToRecord(
  row: ApprovalRequestRow,
): DeliveryApprovalRequestRecord {
  return {
    requestId: row.request_id,
    processRunId: row.process_run_id,
    projectId: row.project_id,
    epicId: row.epic_id,
    candidateHash: row.candidate_hash,
    preflightHash: row.preflight_hash,
    releasePolicyHash: row.release_policy_hash,
    state: row.state,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
