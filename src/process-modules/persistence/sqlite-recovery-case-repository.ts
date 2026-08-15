/**
 * SQLite implementation of the generic recovery-case repository.
 *
 * Invariants enforced both in SQL and in code:
 * - at most one active case per (process_run, policy);
 * - one immutable issue per source NodeRun (idempotent replay);
 * - monotonically increasing attempt numbers within a case;
 * - maxAttempts counts repair rounds; exhaustion is the next failed verifier
 *   issue after all configured repair rounds have been consumed;
 * - exhausted budgets are sticky across resume: a verifier recheck may resolve
 *   the exhausted case, but another rejection never mints a fresh budget;
 * - terminal cases are never reopened or mutated.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import {
  RECOVERY_FEEDBACK_SCHEMA,
  RECOVERY_ISSUE_SCHEMA,
  type RecoveryFeedback,
  type RecoveryIssue,
} from '../domain/recovery.js';
import {
  processModuleKey,
} from '../domain/process-module.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  RecordRecoveryIssueInput,
  RecordRecoveryIssueResult,
  RecoveryAttemptRecord,
  RecoveryCaseRecord,
  RecoveryCaseStatus,
} from './recovery-case.js';
import type { RecoveryCaseRepository } from './recovery-case-repository.js';

export function ensureFactoryRecoveryCaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_recovery_cases (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id           INTEGER NOT NULL
                                 REFERENCES factory_process_runs(id) ON DELETE CASCADE,
      module_name              TEXT NOT NULL,
      module_version           TEXT NOT NULL,
      module_ref_key           TEXT NOT NULL,
      policy_id                TEXT NOT NULL,
      verify_node_id           TEXT NOT NULL,
      repair_node_id           TEXT,
      max_attempts             INTEGER NOT NULL CHECK (max_attempts > 0),
      status                   TEXT NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','resolved','exhausted')),
      attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      opened_by_node_run_id    INTEGER NOT NULL
                                 REFERENCES factory_node_runs(id) ON DELETE CASCADE,
      last_source_node_run_id  INTEGER NOT NULL
                                 REFERENCES factory_node_runs(id) ON DELETE CASCADE,
      last_issue_ref           TEXT NOT NULL,
      last_issue_hash          TEXT NOT NULL,
      last_reason_code         TEXT NOT NULL,
      resolved_by_node_run_id  INTEGER
                                 REFERENCES factory_node_runs(id) ON DELETE SET NULL,
      opened_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at              TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_recovery_cases_active_policy
      ON factory_recovery_cases(process_run_id, policy_id)
      WHERE status='active';

    CREATE INDEX IF NOT EXISTS idx_factory_recovery_cases_verifier
      ON factory_recovery_cases(process_run_id, verify_node_id, status, id);

    CREATE TABLE IF NOT EXISTS factory_recovery_attempts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      recovery_case_id    INTEGER NOT NULL
                            REFERENCES factory_recovery_cases(id) ON DELETE CASCADE,
      source_node_run_id  INTEGER NOT NULL
                            REFERENCES factory_node_runs(id) ON DELETE CASCADE,
      attempt             INTEGER NOT NULL CHECK (attempt > 0),
      issue_ref           TEXT NOT NULL,
      issue_schema        TEXT NOT NULL,
      issue_hash          TEXT NOT NULL,
      issue_snapshot      TEXT NOT NULL,
      feedback_schema     TEXT NOT NULL,
      feedback_hash       TEXT NOT NULL,
      feedback_snapshot   TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_node_run_id),
      UNIQUE (recovery_case_id, attempt)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_recovery_attempts_case
      ON factory_recovery_attempts(recovery_case_id, attempt);
  `);
}

interface RecoveryCaseRow {
  id: number;
  process_run_id: number;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  policy_id: string;
  verify_node_id: string;
  repair_node_id: string | null;
  max_attempts: number;
  status: RecoveryCaseStatus;
  attempt_count: number;
  opened_by_node_run_id: number;
  last_source_node_run_id: number;
  last_issue_ref: string;
  last_issue_hash: string;
  last_reason_code: string;
  resolved_by_node_run_id: number | null;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface RecoveryAttemptRow {
  id: number;
  recovery_case_id: number;
  source_node_run_id: number;
  attempt: number;
  issue_ref: string;
  issue_schema: string;
  issue_hash: string;
  issue_snapshot: string;
  feedback_schema: string;
  feedback_hash: string;
  feedback_snapshot: string;
  created_at: string;
}

function rowToCase(row: RecoveryCaseRow): RecoveryCaseRecord {
  return {
    id: row.id,
    processRunId: row.process_run_id,
    moduleRef: {
      name: row.module_name,
      version: row.module_version,
    },
    moduleRefKey: row.module_ref_key,
    policyId: row.policy_id,
    verifyNodeId: row.verify_node_id,
    repairNodeId: row.repair_node_id,
    maxAttempts: row.max_attempts,
    status: row.status,
    attemptCount: row.attempt_count,
    openedByNodeRunId: row.opened_by_node_run_id,
    lastSourceNodeRunId: row.last_source_node_run_id,
    lastIssueRef: row.last_issue_ref,
    lastIssueHash: row.last_issue_hash,
    lastReasonCode: row.last_reason_code,
    resolvedByNodeRunId: row.resolved_by_node_run_id,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function parseIssue(row: RecoveryAttemptRow): RecoveryIssue {
  if (row.issue_schema !== RECOVERY_ISSUE_SCHEMA) {
    throw new Error(
      `RECOVERY_ISSUE_SCHEMA_UNSUPPORTED: attempt ${row.id} uses '${row.issue_schema}'`,
    );
  }
  return JSON.parse(row.issue_snapshot) as RecoveryIssue;
}

function parseFeedback(row: RecoveryAttemptRow): RecoveryFeedback {
  if (row.feedback_schema !== RECOVERY_FEEDBACK_SCHEMA) {
    throw new Error(
      `RECOVERY_FEEDBACK_SCHEMA_UNSUPPORTED: attempt ${row.id} uses '${row.feedback_schema}'`,
    );
  }
  return JSON.parse(row.feedback_snapshot) as RecoveryFeedback;
}

function rowToAttempt(row: RecoveryAttemptRow): RecoveryAttemptRecord {
  return {
    id: row.id,
    caseId: row.recovery_case_id,
    sourceNodeRunId: row.source_node_run_id,
    attempt: row.attempt,
    issueRef: row.issue_ref,
    issueHash: row.issue_hash,
    issue: parseIssue(row),
    feedbackHash: row.feedback_hash,
    feedback: parseFeedback(row),
    createdAt: row.created_at,
  };
}

function readCaseRow(
  db: Database.Database,
  id: number,
): RecoveryCaseRow | null {
  const row = db.prepare(
    'SELECT * FROM factory_recovery_cases WHERE id=?',
  ).get(id) as RecoveryCaseRow | undefined;
  return row ?? null;
}

function readAttemptBySourceNodeRun(
  db: Database.Database,
  sourceNodeRunId: number,
): RecoveryAttemptRow | null {
  const row = db.prepare(
    'SELECT * FROM factory_recovery_attempts WHERE source_node_run_id=?',
  ).get(sourceNodeRunId) as RecoveryAttemptRow | undefined;
  return row ?? null;
}

function readLastAttemptForCase(
  db: Database.Database,
  caseId: number,
): RecoveryAttemptRow | null {
  const row = db.prepare(
    `SELECT * FROM factory_recovery_attempts
      WHERE recovery_case_id=?
      ORDER BY attempt DESC LIMIT 1`,
  ).get(caseId) as RecoveryAttemptRow | undefined;
  return row ?? null;
}

function assertIssueInput(input: RecordRecoveryIssueInput): void {
  if (input.issue.schemaVersion !== RECOVERY_ISSUE_SCHEMA) {
    throw new Error(
      `RECOVERY_ISSUE_SCHEMA_UNSUPPORTED: expected '${RECOVERY_ISSUE_SCHEMA}', `
      + `received '${String(input.issue.schemaVersion)}'`,
    );
  }
  if (!input.issue.policyId || input.issue.policyId.trim() !== input.issue.policyId) {
    throw new Error('RECOVERY_POLICY_ID_INVALID: policyId must be a non-empty trimmed string');
  }
  if (!input.issue.reasonCode || input.issue.reasonCode.trim() !== input.issue.reasonCode) {
    throw new Error('RECOVERY_REASON_CODE_INVALID: reasonCode must be a non-empty trimmed string');
  }
  if (!input.verifyNodeId || input.verifyNodeId.trim() !== input.verifyNodeId) {
    throw new Error('RECOVERY_VERIFY_NODE_INVALID: verifyNodeId must be a non-empty trimmed string');
  }
  if (input.repairNodeId !== null
    && (!input.repairNodeId || input.repairNodeId.trim() !== input.repairNodeId)) {
    throw new Error('RECOVERY_REPAIR_NODE_INVALID: repairNodeId must be null or a non-empty trimmed string');
  }
  if (!Number.isInteger(input.processRunId) || input.processRunId <= 0) {
    throw new Error('RECOVERY_PROCESS_RUN_INVALID: processRunId must be a positive integer');
  }
  if (!Number.isInteger(input.sourceNodeRunId) || input.sourceNodeRunId <= 0) {
    throw new Error('RECOVERY_SOURCE_NODE_RUN_INVALID: sourceNodeRunId must be a positive integer');
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    throw new Error('RECOVERY_ATTEMPT_BUDGET_INVALID: maxAttempts must be a positive integer');
  }
}

function assertActiveCaseMatches(
  row: RecoveryCaseRow,
  input: RecordRecoveryIssueInput,
  moduleRefKey: string,
): void {
  const samePolicyEnvelope = row.module_ref_key === moduleRefKey
    && row.verify_node_id === input.verifyNodeId
    && row.repair_node_id === input.repairNodeId
    && row.max_attempts === input.maxAttempts;
  if (!samePolicyEnvelope) {
    throw new Error(
      `RECOVERY_ACTIVE_POLICY_CHANGED: active case ${row.id} for policy `
      + `'${input.issue.policyId}' was created with a different module, route or attempt budget`,
    );
  }
}

function assertReplayMatches(
  db: Database.Database,
  row: RecoveryAttemptRow,
  input: RecordRecoveryIssueInput,
  issueHash: string,
  moduleRefKey: string,
): RecoveryCaseRow {
  const caseRow = readCaseRow(db, row.recovery_case_id);
  if (!caseRow) {
    throw new Error(
      `RECOVERY_CASE_MISSING: attempt ${row.id} references case ${row.recovery_case_id}`,
    );
  }
  const sameImmutableInput = caseRow.process_run_id === input.processRunId
    && caseRow.module_ref_key === moduleRefKey
    && caseRow.policy_id === input.issue.policyId
    && caseRow.verify_node_id === input.verifyNodeId
    && caseRow.repair_node_id === input.repairNodeId
    && caseRow.max_attempts === input.maxAttempts
    && row.issue_hash === issueHash
    && row.feedback_hash === sha256Hex({
      ...parseFeedback(row),
      sourceProduction: input.sourceProduction,
    });
  if (!sameImmutableInput) {
    throw new Error(
      `RECOVERY_SOURCE_NODE_RUN_REUSED_WITH_DIFFERENT_ISSUE: NodeRun `
      + `${input.sourceNodeRunId} is already bound to a different recovery issue`,
    );
  }
  return caseRow;
}

export class SqliteRecoveryCaseRepository implements RecoveryCaseRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryRecoveryCaseSchema(this.db);
  }

  recordIssue(input: RecordRecoveryIssueInput): RecordRecoveryIssueResult {
    assertIssueInput(input);
    if (this.db.inTransaction) {
      return this.recordIssueReserved(input);
    }
    return this.db.transaction(
      () => this.recordIssueReserved(input),
    ).immediate();
  }

  private recordIssueReserved(
    input: RecordRecoveryIssueInput,
  ): RecordRecoveryIssueResult {
    const moduleRefKey = processModuleKey(input.moduleRef);
    const issueSnapshot = canonicalJson(input.issue);
    const issueHash = sha256Hex(input.issue);
    const existingAttempt = readAttemptBySourceNodeRun(
      this.db,
      input.sourceNodeRunId,
    );

    if (existingAttempt) {
      const caseRow = assertReplayMatches(
        this.db,
        existingAttempt,
        input,
        issueHash,
        moduleRefKey,
      );
      const attemptRecord = rowToAttempt(existingAttempt);
      return {
        caseRecord: rowToCase(caseRow),
        attemptRecord,
        feedback: attemptRecord.feedback,
        replayed: true,
        exhausted: caseRow.status === 'exhausted'
          || attemptRecord.attempt > caseRow.max_attempts,
      };
    }

    let caseRow = this.db.prepare(
      `SELECT * FROM factory_recovery_cases
        WHERE process_run_id=? AND policy_id=? AND status='active'
        ORDER BY id DESC LIMIT 1`,
    ).get(input.processRunId, input.issue.policyId) as RecoveryCaseRow | undefined;

    if (caseRow) {
      assertActiveCaseMatches(caseRow, input, moduleRefKey);
    } else {
      // Bounded-recovery invariant: an exhausted policy does not silently gain
      // a fresh budget merely because the ProcessRun was resumed. The generic
      // executor is allowed to re-run the verifier as a probe after external
      // or human repair. If that probe rejects again, return the same terminal
      // case and its last durable feedback without creating a new attempt.
      const exhaustedCase = this.db.prepare(
        `SELECT * FROM factory_recovery_cases
          WHERE process_run_id=? AND policy_id=? AND status='exhausted'
          ORDER BY id DESC LIMIT 1`,
      ).get(input.processRunId, input.issue.policyId) as RecoveryCaseRow | undefined;
      if (exhaustedCase) {
        assertActiveCaseMatches(exhaustedCase, input, moduleRefKey);
        const lastAttempt = readLastAttemptForCase(this.db, exhaustedCase.id);
        if (!lastAttempt) {
          throw new Error(
            `RECOVERY_EXHAUSTED_CASE_HAS_NO_ATTEMPT: case ${exhaustedCase.id}`,
          );
        }
        const attemptRecord = rowToAttempt(lastAttempt);
        return {
          caseRecord: rowToCase(exhaustedCase),
          attemptRecord,
          feedback: attemptRecord.feedback,
          replayed: true,
          exhausted: true,
        };
      }

      const pendingIssueRef = 'pending';
      const info = this.db.prepare(
        `INSERT INTO factory_recovery_cases
           (process_run_id, module_name, module_version, module_ref_key,
            policy_id, verify_node_id, repair_node_id, max_attempts, status,
            attempt_count, opened_by_node_run_id, last_source_node_run_id,
            last_issue_ref, last_issue_hash, last_reason_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
      ).run(
        input.processRunId,
        input.moduleRef.name,
        input.moduleRef.version,
        moduleRefKey,
        input.issue.policyId,
        input.verifyNodeId,
        input.repairNodeId,
        input.maxAttempts,
        input.sourceNodeRunId,
        input.sourceNodeRunId,
        pendingIssueRef,
        issueHash,
        input.issue.reasonCode,
      );
      caseRow = readCaseRow(this.db, Number(info.lastInsertRowid)) ?? undefined;
      if (!caseRow) {
        throw new Error('RECOVERY_CASE_CREATE_FAILED: row vanished after insert');
      }
    }

    const attempt = caseRow.attempt_count + 1;
    const exhausted = attempt > caseRow.max_attempts;
    const issueRef = `recovery-case:${caseRow.id}:attempt:${attempt}`;
    const feedback: RecoveryFeedback = {
      schemaVersion: RECOVERY_FEEDBACK_SCHEMA,
      caseId: caseRow.id,
      processRunId: input.processRunId,
      moduleRef: input.moduleRef,
      sourceNodeRunId: input.sourceNodeRunId,
      verifyNodeId: input.verifyNodeId,
      repairNodeId: input.repairNodeId,
      attempt,
      maxAttempts: input.maxAttempts,
      issueRef,
      issueHash,
      issue: input.issue,
      sourceProduction: input.sourceProduction,
    };
    const feedbackSnapshot = canonicalJson(feedback);
    const feedbackHash = sha256Hex(feedback);

    const attemptInfo = this.db.prepare(
      `INSERT INTO factory_recovery_attempts
         (recovery_case_id, source_node_run_id, attempt, issue_ref,
          issue_schema, issue_hash, issue_snapshot, feedback_schema,
          feedback_hash, feedback_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      caseRow.id,
      input.sourceNodeRunId,
      attempt,
      issueRef,
      RECOVERY_ISSUE_SCHEMA,
      issueHash,
      issueSnapshot,
      RECOVERY_FEEDBACK_SCHEMA,
      feedbackHash,
      feedbackSnapshot,
    );

    this.db.prepare(
      `UPDATE factory_recovery_cases
          SET status=?,
              attempt_count=?,
              last_source_node_run_id=?,
              last_issue_ref=?,
              last_issue_hash=?,
              last_reason_code=?,
              updated_at=datetime('now'),
              resolved_at=CASE WHEN ?='exhausted' THEN datetime('now') ELSE NULL END
        WHERE id=? AND status='active' AND attempt_count=?`,
    ).run(
      exhausted ? 'exhausted' : 'active',
      attempt,
      input.sourceNodeRunId,
      issueRef,
      issueHash,
      input.issue.reasonCode,
      exhausted ? 'exhausted' : 'active',
      caseRow.id,
      caseRow.attempt_count,
    );

    const updatedCase = readCaseRow(this.db, caseRow.id);
    const attemptRow = this.db.prepare(
      'SELECT * FROM factory_recovery_attempts WHERE id=?',
    ).get(Number(attemptInfo.lastInsertRowid)) as RecoveryAttemptRow | undefined;
    if (!updatedCase || !attemptRow) {
      throw new Error('RECOVERY_ATTEMPT_CREATE_FAILED: row vanished after insert');
    }

    return {
      caseRecord: rowToCase(updatedCase),
      attemptRecord: rowToAttempt(attemptRow),
      feedback,
      replayed: false,
      exhausted,
    };
  }

  resolveActive(
    processRunId: number,
    policyId: string,
    resolvedByNodeRunId: number,
  ): RecoveryCaseRecord | null {
    const resolve = (): RecoveryCaseRecord | null => {
      const active = this.db.prepare(
        `SELECT * FROM factory_recovery_cases
          WHERE process_run_id=? AND policy_id=?
            AND status IN ('active','exhausted')
          ORDER BY id DESC LIMIT 1`,
      ).get(processRunId, policyId) as RecoveryCaseRow | undefined;
      if (!active) return null;

      // GenericFlowExecutor rechecks an exhausted verifier on explicit resume.
      // Before that probe it calls resolveActive with the SAME failed NodeRun
      // that exhausted the case. Treat that call as a no-op: only a later,
      // successful verifier NodeRun may resolve the exhausted budget. This
      // prevents resume itself from laundering exhaustion into a fresh case.
      if (
        active.status === 'exhausted'
        && resolvedByNodeRunId === active.last_source_node_run_id
      ) {
        return null;
      }

      const info = this.db.prepare(
        `UPDATE factory_recovery_cases
            SET status='resolved',
                resolved_by_node_run_id=?,
                resolved_at=datetime('now'),
                updated_at=datetime('now')
          WHERE id=? AND status IN ('active','exhausted')`,
      ).run(resolvedByNodeRunId, active.id);
      if (info.changes !== 1) {
        throw new Error(
          `RECOVERY_CASE_CONCURRENT_TRANSITION: case ${active.id} is no longer resolvable`,
        );
      }
      const row = readCaseRow(this.db, active.id);
      if (!row) throw new Error(`RECOVERY_CASE_MISSING: case ${active.id} vanished`);
      return rowToCase(row);
    };

    if (this.db.inTransaction) return resolve();
    return this.db.transaction(resolve).immediate();
  }

  readCase(id: number): RecoveryCaseRecord | null {
    const row = readCaseRow(this.db, id);
    return row ? rowToCase(row) : null;
  }

  readActive(
    processRunId: number,
    policyId: string,
  ): RecoveryCaseRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_recovery_cases
        WHERE process_run_id=? AND policy_id=? AND status='active'
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId, policyId) as RecoveryCaseRow | undefined;
    return row ? rowToCase(row) : null;
  }

  readActiveForVerifier(
    processRunId: number,
    verifyNodeId: string,
  ): RecoveryCaseRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_recovery_cases
        WHERE process_run_id=? AND verify_node_id=? AND status='active'
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId, verifyNodeId) as RecoveryCaseRow | undefined;
    return row ? rowToCase(row) : null;
  }

  listForProcessRun(processRunId: number): readonly RecoveryCaseRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_recovery_cases
        WHERE process_run_id=?
        ORDER BY id DESC`,
    ).all(processRunId) as RecoveryCaseRow[];
    return rows.map(rowToCase);
  }

  listAttempts(caseId: number): readonly RecoveryAttemptRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_recovery_attempts
        WHERE recovery_case_id=?
        ORDER BY attempt ASC`,
    ).all(caseId) as RecoveryAttemptRow[];
    return rows.map(rowToAttempt);
  }
}
