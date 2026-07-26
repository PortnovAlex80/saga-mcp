import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import {
  processModuleKey,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';
import type {
  ClaimExternalEffectCommand,
  ExternalEffectActionRecord,
  ExternalEffectActionState,
  ExternalEffectClaim,
  ExternalEffectClaimKind,
  ExternalEffectExecutionResult,
  ExternalEffectLedger,
  ExternalEffectObservation,
  RecordExternalEffectExecutionResultCommand,
  RecordExternalEffectObservationCommand,
  StartExternalEffectActionCommand,
} from './external-effect-ledger.js';
import { ensureSaga3ProcessRunSchema } from './sqlite-process-run-repository.js';

const ACTION_STATES = [
  'new',
  'executing',
  'succeeded',
  'failed',
  'unknown',
  'retry-authorized',
  'blocked',
] as const;

type AuditEventType =
  | 'action.started'
  | 'execution.claimed'
  | 'execution.succeeded'
  | 'execution.failed'
  | 'execution.unknown'
  | 'observation.claimed'
  | 'observation.matched'
  | 'observation.absent-retry-safe'
  | 'observation.blocked';

export function ensureSaga3ExternalEffectLedgerSchema(db: Database.Database): void {
  ensureSaga3ProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_external_effect_actions (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_namespace        TEXT NOT NULL,
      action_key                TEXT NOT NULL,
      process_run_id            INTEGER NOT NULL
                                    REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      module_name               TEXT NOT NULL,
      module_version            TEXT NOT NULL,
      module_ref_key            TEXT NOT NULL,
      node_id                   TEXT NOT NULL,
      request_snapshot          TEXT NOT NULL,
      request_hash              TEXT NOT NULL,
      state                     TEXT NOT NULL DEFAULT 'new'
                                    CHECK (state IN (
                                      'new','executing','succeeded','failed',
                                      'unknown','retry-authorized','blocked'
                                    )),
      claim_fence               INTEGER NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
      active_claim_kind         TEXT
                                    CHECK (active_claim_kind IN ('execution','observation')
                                           OR active_claim_kind IS NULL),
      active_claim_owner        TEXT,
      active_claim_expires_at   TEXT,
      execution_attempts        INTEGER NOT NULL DEFAULT 0
                                    CHECK (execution_attempts >= 0),
      provider_effect_id        TEXT,
      last_error                TEXT,
      last_execution_fence      INTEGER,
      last_execution_owner      TEXT,
      execution_result_snapshot TEXT,
      execution_result_hash     TEXT,
      last_observation_fence    INTEGER,
      last_observation_owner    TEXT,
      observation_snapshot      TEXT,
      observation_hash          TEXT,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at              TEXT,
      UNIQUE(provider_namespace, action_key),
      CHECK (
        (active_claim_kind IS NULL
          AND active_claim_owner IS NULL
          AND active_claim_expires_at IS NULL)
        OR
        (active_claim_kind IS NOT NULL
          AND active_claim_owner IS NOT NULL
          AND active_claim_expires_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_external_effect_actions_run
      ON saga3_external_effect_actions(process_run_id, node_id, id);
    CREATE INDEX IF NOT EXISTS idx_saga3_external_effect_actions_state
      ON saga3_external_effect_actions(state, updated_at);

    CREATE TABLE IF NOT EXISTS saga3_external_effect_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id          INTEGER NOT NULL
                              REFERENCES saga3_external_effect_actions(id) ON DELETE RESTRICT,
      sequence           INTEGER NOT NULL,
      event_type         TEXT NOT NULL,
      from_state         TEXT,
      to_state           TEXT NOT NULL,
      claim_kind         TEXT,
      claim_fence        INTEGER NOT NULL CHECK (claim_fence >= 0),
      actor              TEXT NOT NULL,
      payload_snapshot   TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(action_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_external_effect_events_action
      ON saga3_external_effect_events(action_id, sequence);

    CREATE TRIGGER IF NOT EXISTS trg_saga3_external_effect_binding_immutable
    BEFORE UPDATE OF
      provider_namespace, action_key, process_run_id, module_name,
      module_version, module_ref_key, node_id, request_snapshot, request_hash
    ON saga3_external_effect_actions
    BEGIN
      SELECT RAISE(ABORT, 'EXTERNAL_EFFECT_ACTION_BINDING_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_external_effect_actions_no_delete
    BEFORE DELETE ON saga3_external_effect_actions
    BEGIN
      SELECT RAISE(ABORT, 'EXTERNAL_EFFECT_ACTION_AUDIT_DELETE_FORBIDDEN');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_external_effect_events_no_update
    BEFORE UPDATE ON saga3_external_effect_events
    BEGIN
      SELECT RAISE(ABORT, 'EXTERNAL_EFFECT_AUDIT_EVENT_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_external_effect_events_no_delete
    BEFORE DELETE ON saga3_external_effect_events
    BEGIN
      SELECT RAISE(ABORT, 'EXTERNAL_EFFECT_AUDIT_EVENT_DELETE_FORBIDDEN');
    END;
  `);
}

interface ExternalEffectActionRow {
  id: number;
  provider_namespace: string;
  action_key: string;
  process_run_id: number;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  node_id: string;
  request_snapshot: string;
  request_hash: string;
  state: ExternalEffectActionState;
  claim_fence: number;
  active_claim_kind: ExternalEffectClaimKind | null;
  active_claim_owner: string | null;
  active_claim_expires_at: string | null;
  execution_attempts: number;
  provider_effect_id: string | null;
  last_error: string | null;
  last_execution_fence: number | null;
  last_execution_owner: string | null;
  execution_result_snapshot: string | null;
  execution_result_hash: string | null;
  last_observation_fence: number | null;
  last_observation_owner: string | null;
  observation_snapshot: string | null;
  observation_hash: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToRecord(row: ExternalEffectActionRow): ExternalEffectActionRecord {
  return {
    id: row.id,
    providerNamespace: row.provider_namespace,
    actionKey: row.action_key,
    processRunId: row.process_run_id,
    moduleRef: {
      name: row.module_name,
      version: row.module_version,
    },
    moduleRefKey: row.module_ref_key,
    nodeId: row.node_id,
    requestSnapshot: row.request_snapshot,
    requestHash: row.request_hash,
    state: row.state,
    claimFence: row.claim_fence,
    activeClaimKind: row.active_claim_kind,
    activeClaimOwner: row.active_claim_owner,
    activeClaimExpiresAt: row.active_claim_expires_at,
    executionAttempts: row.execution_attempts,
    providerEffectId: row.provider_effect_id,
    lastError: row.last_error,
    lastExecutionFence: row.last_execution_fence,
    lastExecutionOwner: row.last_execution_owner,
    executionResultSnapshot: row.execution_result_snapshot,
    executionResultHash: row.execution_result_hash,
    lastObservationFence: row.last_observation_fence,
    lastObservationOwner: row.last_observation_owner,
    observationSnapshot: row.observation_snapshot,
    observationHash: row.observation_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`EXTERNAL_EFFECT_${field.toUpperCase()}_REQUIRED`);
  }
  return value;
}

function validateLease(command: ClaimExternalEffectCommand): void {
  requireNonEmpty(command.owner, 'claim_owner');
  if (
    !Number.isSafeInteger(command.leaseSeconds)
    || command.leaseSeconds < 1
    || command.leaseSeconds > 86_400
  ) {
    throw new Error('EXTERNAL_EFFECT_INVALID_LEASE_SECONDS');
  }
}

function canonicalSnapshot(value: unknown, field: string): string {
  const snapshot = canonicalJson(value);
  if (typeof snapshot !== 'string') {
    throw new Error(`EXTERNAL_EFFECT_${field.toUpperCase()}_NOT_JSON`);
  }
  try {
    JSON.parse(snapshot);
  } catch {
    throw new Error(`EXTERNAL_EFFECT_${field.toUpperCase()}_NOT_JSON`);
  }
  return snapshot;
}

function resultState(
  result: ExternalEffectExecutionResult,
): 'succeeded' | 'failed' | 'unknown' {
  return result.outcome;
}

function observationState(
  observation: ExternalEffectObservation,
): 'succeeded' | 'retry-authorized' | 'blocked' {
  switch (observation.outcome) {
    case 'matched': return 'succeeded';
    case 'absent-retry-safe': return 'retry-authorized';
    case 'blocked': return 'blocked';
  }
}

function isTerminal(state: ExternalEffectActionState): boolean {
  return state === 'succeeded' || state === 'blocked';
}

function sameModule(
  row: { module_name: string; module_version: string },
  moduleRef: ProcessModuleReference,
): boolean {
  return row.module_name === moduleRef.name && row.module_version === moduleRef.version;
}

export class SqliteExternalEffectLedger implements ExternalEffectLedger {
  constructor(private readonly db: Database.Database = getDb()) {
    ensureSaga3ExternalEffectLedgerSchema(db);
  }

  start(command: StartExternalEffectActionCommand): {
    record: ExternalEffectActionRecord;
    replayed: boolean;
  } {
    requireNonEmpty(command.providerNamespace, 'provider_namespace');
    requireNonEmpty(command.actionKey, 'action_key');
    requireNonEmpty(command.moduleRef.name, 'module_name');
    requireNonEmpty(command.moduleRef.version, 'module_version');
    requireNonEmpty(command.nodeId, 'node_id');
    if (!Number.isSafeInteger(command.processRunId) || command.processRunId < 1) {
      throw new Error('EXTERNAL_EFFECT_INVALID_PROCESS_RUN_ID');
    }
    const requestSnapshot = canonicalSnapshot(command.request, 'request');
    const computedHash = sha256Hex(command.request);
    if (computedHash !== command.requestHash) {
      throw new Error('EXTERNAL_EFFECT_REQUEST_HASH_MISMATCH');
    }
    const moduleRefKey = processModuleKey(command.moduleRef);

    return this.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM saga3_external_effect_actions
          WHERE provider_namespace=? AND action_key=?`,
      ).get(
        command.providerNamespace,
        command.actionKey,
      ) as ExternalEffectActionRow | undefined;
      if (existing) {
        if (
          existing.request_hash !== command.requestHash
          || existing.request_snapshot !== requestSnapshot
        ) {
          throw new Error('EXTERNAL_EFFECT_ACTION_KEY_REUSED_WITH_DIFFERENT_REQUEST');
        }
        if (
          existing.process_run_id !== command.processRunId
          || !sameModule(existing, command.moduleRef)
          || existing.node_id !== command.nodeId
        ) {
          throw new Error('EXTERNAL_EFFECT_ACTION_KEY_REUSED_WITH_DIFFERENT_BINDING');
        }
        return { record: rowToRecord(existing), replayed: true };
      }

      const processRun = this.db.prepare(
        `SELECT module_name,module_version,status
           FROM saga3_process_runs WHERE id=?`,
      ).get(command.processRunId) as {
        module_name: string;
        module_version: string;
        status: string;
      } | undefined;
      if (!processRun) {
        throw new Error(`EXTERNAL_EFFECT_PROCESS_RUN_NOT_FOUND: ${command.processRunId}`);
      }
      if (!sameModule(processRun, command.moduleRef)) {
        throw new Error('EXTERNAL_EFFECT_PROCESS_RUN_MODULE_MISMATCH');
      }
      if (isProcessRunTerminal(processRun.status)) {
        throw new Error(
          `EXTERNAL_EFFECT_PROCESS_RUN_NOT_ACTIVE: ${command.processRunId} is ${processRun.status}`,
        );
      }

      const info = this.db.prepare(
        `INSERT INTO saga3_external_effect_actions
          (provider_namespace,action_key,process_run_id,module_name,module_version,
           module_ref_key,node_id,request_snapshot,request_hash,state)
         VALUES (?,?,?,?,?,?,?,?,?,'new')`,
      ).run(
        command.providerNamespace,
        command.actionKey,
        command.processRunId,
        command.moduleRef.name,
        command.moduleRef.version,
        moduleRefKey,
        command.nodeId,
        requestSnapshot,
        command.requestHash,
      );
      const actionId = Number(info.lastInsertRowid);
      this.appendEvent({
        actionId,
        eventType: 'action.started',
        fromState: null,
        toState: 'new',
        claimKind: null,
        claimFence: 0,
        actor: 'kernel',
        payload: {
          providerNamespace: command.providerNamespace,
          actionKey: command.actionKey,
          processRunId: command.processRunId,
          moduleRefKey,
          nodeId: command.nodeId,
          requestHash: command.requestHash,
        },
      });
      return { record: rowToRecord(this.readRow(actionId)), replayed: false };
    });
  }

  read(actionId: number): ExternalEffectActionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_external_effect_actions WHERE id=?',
    ).get(actionId) as ExternalEffectActionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readByKey(
    providerNamespace: string,
    actionKey: string,
  ): ExternalEffectActionRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_external_effect_actions
        WHERE provider_namespace=? AND action_key=?`,
    ).get(providerNamespace, actionKey) as ExternalEffectActionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  claim(command: ClaimExternalEffectCommand): {
    record: ExternalEffectActionRecord;
    claim: ExternalEffectClaim;
  } | null {
    validateLease(command);
    return this.transaction(() => {
      const row = this.readRow(command.actionId);
      const processStatus = this.readProcessRunStatus(row.process_run_id);
      if (isProcessRunTerminal(processStatus)) {
        throw new Error(
          `EXTERNAL_EFFECT_PROCESS_RUN_NOT_ACTIVE: ${row.process_run_id} is ${processStatus}`,
        );
      }
      if (row.state === 'failed' || row.state === 'unknown') {
        throw new Error('EXTERNAL_EFFECT_OBSERVATION_REQUIRED_BEFORE_RETRY');
      }
      if (row.state === 'executing' || isTerminal(row.state)) return null;
      if (row.state !== 'new' && row.state !== 'retry-authorized') {
        throw new Error(`EXTERNAL_EFFECT_EXECUTION_CLAIM_NOT_ALLOWED_FROM_${row.state}`);
      }

      const fence = row.claim_fence + 1;
      const changed = this.db.prepare(
        `UPDATE saga3_external_effect_actions
            SET state='executing', claim_fence=?,
                active_claim_kind='execution', active_claim_owner=?,
                active_claim_expires_at=datetime('now', ?),
                execution_attempts=execution_attempts+1,
                updated_at=datetime('now')
          WHERE id=? AND claim_fence=? AND state=?
            AND EXISTS (
              SELECT 1 FROM saga3_process_runs
               WHERE saga3_process_runs.id=saga3_external_effect_actions.process_run_id
                 AND saga3_process_runs.status NOT IN ('completed','failed','cancelled')
            )`,
      ).run(
        fence,
        command.owner,
        `+${command.leaseSeconds} seconds`,
        command.actionId,
        row.claim_fence,
        row.state,
      );
      if (changed.changes !== 1) return null;

      const claimed = this.readRow(command.actionId);
      this.appendEvent({
        actionId: command.actionId,
        eventType: 'execution.claimed',
        fromState: row.state,
        toState: 'executing',
        claimKind: 'execution',
        claimFence: fence,
        actor: command.owner,
        payload: { attempt: claimed.execution_attempts },
      });
      return {
        record: rowToRecord(claimed),
        claim: this.claimFromRow(claimed, 'execution'),
      };
    });
  }

  recordExecutionResult(
    command: RecordExternalEffectExecutionResultCommand,
  ): ExternalEffectActionRecord {
    if (command.claim.kind !== 'execution') {
      throw new Error('EXTERNAL_EFFECT_EXECUTION_CLAIM_KIND_REQUIRED');
    }
    requireNonEmpty(command.claim.owner, 'claim_owner');
    if (
      command.result.outcome !== 'succeeded'
      && command.result.error.trim().length === 0
    ) {
      throw new Error('EXTERNAL_EFFECT_EXECUTION_ERROR_REQUIRED');
    }
    const snapshot = canonicalSnapshot(command.result, 'execution_result');
    const snapshotHash = sha256Hex(command.result);
    const nextState = resultState(command.result);

    return this.transaction(() => {
      const row = this.readRow(command.claim.actionId);
      if (
        row.claim_fence === command.claim.fence
        && row.last_execution_fence === command.claim.fence
      ) {
        if (
          row.last_execution_owner !== command.claim.owner
          || row.execution_result_hash !== snapshotHash
          || row.execution_result_snapshot !== snapshot
          || row.state !== nextState
        ) {
          throw new Error('EXTERNAL_EFFECT_EXECUTION_RESULT_REPLAY_MISMATCH');
        }
        return rowToRecord(row);
      }
      this.requireLiveClaim(row, command.claim, 'execution');

      const providerEffectId = command.result.providerEffectId ?? null;
      const lastError = command.result.outcome === 'succeeded'
        ? null
        : command.result.error;
      const completedAt = command.result.outcome === 'succeeded'
        ? "datetime('now')"
        : 'NULL';
      const changed = this.db.prepare(
        `UPDATE saga3_external_effect_actions
            SET state=?, active_claim_kind=NULL, active_claim_owner=NULL,
                active_claim_expires_at=NULL, provider_effect_id=COALESCE(?,provider_effect_id),
                last_error=?, last_execution_fence=?, last_execution_owner=?,
                execution_result_snapshot=?, execution_result_hash=?,
                completed_at=${completedAt}, updated_at=datetime('now')
          WHERE id=? AND state='executing'
            AND active_claim_kind='execution' AND active_claim_owner=?
            AND claim_fence=?
            AND julianday(active_claim_expires_at)>julianday('now')`,
      ).run(
        nextState,
        providerEffectId,
        lastError,
        command.claim.fence,
        command.claim.owner,
        snapshot,
        snapshotHash,
        command.claim.actionId,
        command.claim.owner,
        command.claim.fence,
      );
      if (changed.changes !== 1) throw new Error('EXTERNAL_EFFECT_STALE_EXECUTION_FENCE');

      const updated = this.readRow(command.claim.actionId);
      this.appendEvent({
        actionId: command.claim.actionId,
        eventType: `execution.${nextState}` as AuditEventType,
        fromState: 'executing',
        toState: nextState,
        claimKind: 'execution',
        claimFence: command.claim.fence,
        actor: command.claim.owner,
        payload: command.result,
      });
      return rowToRecord(updated);
    });
  }

  claimObservation(command: ClaimExternalEffectCommand): {
    record: ExternalEffectActionRecord;
    claim: ExternalEffectClaim;
  } | null {
    validateLease(command);
    return this.transaction(() => {
      const row = this.readRow(command.actionId);
      if (isTerminal(row.state) || row.state === 'new' || row.state === 'retry-authorized') {
        throw new Error(`EXTERNAL_EFFECT_OBSERVATION_NOT_ALLOWED_FROM_${row.state}`);
      }

      let nextState: 'failed' | 'unknown';
      let recoveredExpiredExecution = false;
      if (row.state === 'executing') {
        if (
          row.active_claim_kind === 'execution'
          && row.active_claim_expires_at !== null
          && this.isFuture(row.active_claim_expires_at)
        ) {
          return null;
        }
        nextState = 'unknown';
        recoveredExpiredExecution = true;
      } else if (row.state === 'failed' || row.state === 'unknown') {
        if (
          row.active_claim_kind === 'observation'
          && row.active_claim_expires_at !== null
          && this.isFuture(row.active_claim_expires_at)
        ) {
          return null;
        }
        nextState = row.state;
      } else {
        throw new Error(`EXTERNAL_EFFECT_OBSERVATION_NOT_ALLOWED_FROM_${row.state}`);
      }

      const fence = row.claim_fence + 1;
      const changed = this.db.prepare(
        `UPDATE saga3_external_effect_actions
            SET state=?, claim_fence=?,
                active_claim_kind='observation', active_claim_owner=?,
                active_claim_expires_at=datetime('now', ?),
                last_error=CASE
                  WHEN state='executing'
                    THEN 'execution claim expired before a durable result'
                  ELSE last_error
                END,
                updated_at=datetime('now')
          WHERE id=? AND claim_fence=? AND state=?`,
      ).run(
        nextState,
        fence,
        command.owner,
        `+${command.leaseSeconds} seconds`,
        command.actionId,
        row.claim_fence,
        row.state,
      );
      if (changed.changes !== 1) return null;

      const claimed = this.readRow(command.actionId);
      this.appendEvent({
        actionId: command.actionId,
        eventType: 'observation.claimed',
        fromState: row.state,
        toState: nextState,
        claimKind: 'observation',
        claimFence: fence,
        actor: command.owner,
        payload: { recoveredExpiredExecution },
      });
      return {
        record: rowToRecord(claimed),
        claim: this.claimFromRow(claimed, 'observation'),
      };
    });
  }

  recordObservation(
    command: RecordExternalEffectObservationCommand,
  ): ExternalEffectActionRecord {
    if (command.claim.kind !== 'observation') {
      throw new Error('EXTERNAL_EFFECT_OBSERVATION_CLAIM_KIND_REQUIRED');
    }
    requireNonEmpty(command.claim.owner, 'claim_owner');
    if (
      command.observation.outcome === 'blocked'
      && command.observation.reason.trim().length === 0
    ) {
      throw new Error('EXTERNAL_EFFECT_BLOCK_REASON_REQUIRED');
    }
    const snapshot = canonicalSnapshot(command.observation, 'observation');
    const snapshotHash = sha256Hex(command.observation);
    const nextState = observationState(command.observation);

    return this.transaction(() => {
      const row = this.readRow(command.claim.actionId);
      if (
        row.claim_fence === command.claim.fence
        && row.last_observation_fence === command.claim.fence
      ) {
        if (
          row.last_observation_owner !== command.claim.owner
          || row.observation_hash !== snapshotHash
          || row.observation_snapshot !== snapshot
          || row.state !== nextState
        ) {
          throw new Error('EXTERNAL_EFFECT_OBSERVATION_REPLAY_MISMATCH');
        }
        return rowToRecord(row);
      }
      this.requireLiveClaim(row, command.claim, 'observation');
      if (row.state !== 'failed' && row.state !== 'unknown') {
        throw new Error(`EXTERNAL_EFFECT_OBSERVATION_NOT_ALLOWED_FROM_${row.state}`);
      }

      const providerEffectId = command.observation.outcome === 'matched'
        ? command.observation.providerEffectId ?? row.provider_effect_id
        : command.observation.outcome === 'absent-retry-safe'
          ? null
          : row.provider_effect_id;
      const lastError = command.observation.outcome === 'blocked'
        ? command.observation.reason
        : null;
      const completedAt = nextState === 'succeeded' || nextState === 'blocked'
        ? "datetime('now')"
        : 'NULL';
      const changed = this.db.prepare(
        `UPDATE saga3_external_effect_actions
            SET state=?, active_claim_kind=NULL, active_claim_owner=NULL,
                active_claim_expires_at=NULL,
                provider_effect_id=?,
                last_error=?, last_observation_fence=?, last_observation_owner=?,
                observation_snapshot=?, observation_hash=?,
                completed_at=${completedAt}, updated_at=datetime('now')
          WHERE id=? AND state IN ('failed','unknown')
            AND active_claim_kind='observation' AND active_claim_owner=?
            AND claim_fence=?
            AND julianday(active_claim_expires_at)>julianday('now')`,
      ).run(
        nextState,
        providerEffectId,
        lastError,
        command.claim.fence,
        command.claim.owner,
        snapshot,
        snapshotHash,
        command.claim.actionId,
        command.claim.owner,
        command.claim.fence,
      );
      if (changed.changes !== 1) throw new Error('EXTERNAL_EFFECT_STALE_OBSERVATION_FENCE');

      const updated = this.readRow(command.claim.actionId);
      this.appendEvent({
        actionId: command.claim.actionId,
        eventType: `observation.${command.observation.outcome}` as AuditEventType,
        fromState: row.state,
        toState: nextState,
        claimKind: 'observation',
        claimFence: command.claim.fence,
        actor: command.claim.owner,
        payload: command.observation,
      });
      return rowToRecord(updated);
    });
  }

  private claimFromRow(
    row: ExternalEffectActionRow,
    kind: ExternalEffectClaimKind,
  ): ExternalEffectClaim {
    if (
      row.active_claim_kind !== kind
      || row.active_claim_owner === null
      || row.active_claim_expires_at === null
    ) {
      throw new Error('EXTERNAL_EFFECT_CLAIM_PROJECTION_INVALID');
    }
    return {
      actionId: row.id,
      kind,
      owner: row.active_claim_owner,
      fence: row.claim_fence,
      expiresAt: row.active_claim_expires_at,
    };
  }

  private requireLiveClaim(
    row: ExternalEffectActionRow,
    claim: ExternalEffectClaim,
    kind: ExternalEffectClaimKind,
  ): void {
    if (
      claim.actionId !== row.id
      || claim.kind !== kind
      || row.active_claim_kind !== kind
      || row.active_claim_owner !== claim.owner
      || row.claim_fence !== claim.fence
      || row.active_claim_expires_at === null
      || !this.isFuture(row.active_claim_expires_at)
    ) {
      const suffix = kind === 'execution' ? 'EXECUTION' : 'OBSERVATION';
      throw new Error(`EXTERNAL_EFFECT_STALE_${suffix}_FENCE`);
    }
  }

  private isFuture(timestamp: string): boolean {
    const row = this.db.prepare(
      `SELECT julianday(?)>julianday('now') AS is_future`,
    ).get(timestamp) as { is_future: number };
    return row.is_future === 1;
  }

  private appendEvent(input: {
    actionId: number;
    eventType: AuditEventType;
    fromState: ExternalEffectActionState | null;
    toState: ExternalEffectActionState;
    claimKind: ExternalEffectClaimKind | null;
    claimFence: number;
    actor: string;
    payload: unknown;
  }): void {
    const payloadSnapshot = canonicalSnapshot(input.payload, 'audit_payload');
    const sequence = this.db.prepare(
      `SELECT COALESCE(MAX(sequence),0)+1 AS sequence
         FROM saga3_external_effect_events WHERE action_id=?`,
    ).get(input.actionId) as { sequence: number };
    this.db.prepare(
      `INSERT INTO saga3_external_effect_events
        (action_id,sequence,event_type,from_state,to_state,claim_kind,
         claim_fence,actor,payload_snapshot,payload_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.actionId,
      sequence.sequence,
      input.eventType,
      input.fromState,
      input.toState,
      input.claimKind,
      input.claimFence,
      input.actor,
      payloadSnapshot,
      sha256Hex(input.payload),
    );
  }

  private readRow(actionId: number): ExternalEffectActionRow {
    const row = this.db.prepare(
      'SELECT * FROM saga3_external_effect_actions WHERE id=?',
    ).get(actionId) as ExternalEffectActionRow | undefined;
    if (!row) throw new Error(`EXTERNAL_EFFECT_ACTION_NOT_FOUND: ${actionId}`);
    if (!(ACTION_STATES as readonly string[]).includes(row.state)) {
      throw new Error(`EXTERNAL_EFFECT_INVALID_PERSISTED_STATE: ${row.state}`);
    }
    return row;
  }

  private readProcessRunStatus(processRunId: number): string {
    const row = this.db.prepare(
      'SELECT status FROM saga3_process_runs WHERE id=?',
    ).get(processRunId) as { status: string } | undefined;
    if (!row) throw new Error(`EXTERNAL_EFFECT_PROCESS_RUN_NOT_FOUND: ${processRunId}`);
    return row.status;
  }

  private transaction<T>(work: () => T): T {
    const ownsTransaction = !this.db.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      }
      throw error;
    }
  }
}

function isProcessRunTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
