/**
 * SQLite implementation of the worker-submission and completion repository.
 *
 * SQL and table knowledge stop here. The LM-facing MCP transport and the
 * application service depend on WorkerSubmissionRepository instead.
 */

import type Database from 'better-sqlite3';
import type { ConditionStatus, EvidenceRecord } from '../../domain/types.js';
import { CONDITION_TASK_KIND } from '../../domain/pipeline-contracts.js';
import type {
  ArtifactProposal,
  CompletionAcceptance,
  PendingWorkerSubmission,
  VerificationProposal,
  WorkerExecutionAuthority,
  WorkerSubmissionRepository,
} from '../../control/ports/worker-submission-ports.js';

interface SubmissionRow {
  id: string;
  execution_id: string;
  submission_kind: 'artifact' | 'verification';
  payload: string;
}

export class SqliteWorkerSubmissionRepository implements WorkerSubmissionRepository {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
  }

  appendArtifact(proposal: ArtifactProposal): void {
    this.insertSubmission(proposal.submissionId, proposal.executionId, 'artifact', proposal);
  }

  appendVerification(proposal: VerificationProposal): void {
    this.insertSubmission(proposal.submissionId, proposal.executionId, 'verification', proposal);
  }

  findActiveExecution(input: {
    readonly episodeSpecId: string;
    readonly conditionType: string;
  }): string | null {
    const rows = this.db.prepare(
      `SELECT a.execution_id
         FROM saga3_worker_assignments a
         JOIN saga3_work_intents wi ON wi.id = a.work_intent_id
        WHERE wi.episode_spec_id = ?
          AND wi.target_condition = ?
          AND a.state IN ('running', 'submitted')
          AND a.execution_id IS NOT NULL
        ORDER BY a.updated_at DESC`,
    ).all(input.episodeSpecId, input.conditionType) as Array<{ execution_id: string }>;
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new Error(
        `Multiple active executions exist for ${input.episodeSpecId}/${input.conditionType}.`,
      );
    }
    return rows[0].execution_id;
  }

  loadAuthority(executionId: string): WorkerExecutionAuthority | null {
    const row = this.db.prepare(
      `SELECT a.id AS assignment_id,
              a.work_intent_id,
              a.execution_id,
              a.lease_epoch,
              a.state AS assignment_state,
              wi.episode_spec_id,
              wi.generation,
              wi.target_condition,
              wi.target_obligation,
              wi.scope_type,
              wi.scope_id,
              es.source_baseline,
              es.environment_baseline
         FROM saga3_worker_assignments a
         JOIN saga3_work_intents wi ON wi.id = a.work_intent_id
         JOIN saga3_episode_specs es ON es.id = wi.episode_spec_id
        WHERE a.execution_id = ?
          AND a.state IN ('running', 'submitted')
        LIMIT 1`,
    ).get(executionId) as {
      assignment_id: string;
      work_intent_id: string;
      execution_id: string;
      lease_epoch: number;
      assignment_state: 'running' | 'submitted';
      episode_spec_id: string;
      generation: number;
      target_condition: string;
      target_obligation: string;
      scope_type: string;
      scope_id: string;
      source_baseline: string | null;
      environment_baseline: string | null;
    } | undefined;

    if (!row) return null;
    return {
      assignmentId: row.assignment_id,
      workIntentId: row.work_intent_id,
      executionId: row.execution_id,
      episodeSpecId: row.episode_spec_id,
      generation: row.generation,
      conditionType: row.target_condition,
      obligationId: row.target_obligation,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      leaseEpoch: row.lease_epoch,
      assignmentState: row.assignment_state,
      sourceFingerprint: row.source_baseline ?? '',
      environmentFingerprint: row.environment_baseline ?? '',
    };
  }

  listPending(executionId: string): readonly PendingWorkerSubmission[] {
    const rows = this.db.prepare(
      `SELECT id, execution_id, submission_kind, payload
         FROM saga3_worker_submissions
        WHERE execution_id = ? AND state = 'pending'
        ORDER BY created_at ASC, id ASC`,
    ).all(executionId) as SubmissionRow[];

    return rows.map((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (row.submission_kind === 'artifact') {
        return {
          kind: 'artifact' as const,
          proposal: {
            submissionId: row.id,
            executionId: row.execution_id,
            kind: String(payload.kind ?? ''),
            path: String(payload.path ?? ''),
            content: String(payload.content ?? ''),
            digest: String(payload.digest ?? ''),
          },
        };
      }
      return {
        kind: 'verification' as const,
        proposal: {
          submissionId: row.id,
          executionId: row.execution_id,
          oracleId: String(payload.oracleId ?? ''),
          oracleVersion: String(payload.oracleVersion ?? ''),
          command: String(payload.command ?? ''),
          diagnosticSummary: String(payload.diagnosticSummary ?? ''),
        },
      };
    });
  }

  commitCompletion(acceptance: CompletionAcceptance): void {
    this.db.transaction(() => {
      const live = this.loadAuthority(acceptance.authority.executionId);
      if (!live) {
        throw new Error('Assignment authority disappeared before completion commit.');
      }
      if (
        live.assignmentId !== acceptance.authority.assignmentId
        || live.workIntentId !== acceptance.authority.workIntentId
        || live.leaseEpoch !== acceptance.authority.leaseEpoch
      ) {
        throw new Error('Assignment authority changed before completion commit.');
      }

      for (const artifact of acceptance.artifacts) {
        this.db.prepare(
          `INSERT INTO saga3_artifacts (id, episode_spec_id, kind, path, digest)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(episode_spec_id, path)
           DO UPDATE SET kind=excluded.kind, digest=excluded.digest`,
        ).run(
          artifact.id,
          acceptance.authority.episodeSpecId,
          artifact.kind,
          artifact.path,
          artifact.digest,
        );
      }

      if (acceptance.evidence) {
        this.insertEvidence(acceptance.evidence);
      }

      const conditionWrite = this.db.prepare(
        `UPDATE saga3_condition_instances
            SET status = ?,
                observed_generation = ?,
                source_fingerprint = ?,
                environment_fingerprint = ?,
                projection_version = projection_version + 1,
                last_transition_at = datetime('now'),
                updated_at = datetime('now')
          WHERE episode_spec_id = ?
            AND condition_type = ?
            AND obligation_id = ?
            AND scope_type = ?
            AND scope_id = ?`,
      ).run(
        acceptance.conditionStatus,
        acceptance.evidence?.generation ?? null,
        acceptance.evidence?.sourceFingerprint ?? null,
        acceptance.evidence?.environmentFingerprint ?? null,
        acceptance.authority.episodeSpecId,
        acceptance.authority.conditionType,
        acceptance.authority.obligationId,
        acceptance.authority.scopeType,
        acceptance.authority.scopeId,
      );
      if (conditionWrite.changes !== 1) {
        throw new Error('Scoped condition was not found during completion commit.');
      }

      const accepted = acceptance.conditionStatus === 'True';
      const assignmentWrite = this.db.prepare(
        `UPDATE saga3_worker_assignments
            SET state = ?, updated_at = datetime('now')
          WHERE id = ? AND execution_id = ? AND lease_epoch = ?`,
      ).run(accepted ? 'verified' : 'failed', acceptance.authority.assignmentId,
        acceptance.authority.executionId, acceptance.authority.leaseEpoch);
      if (assignmentWrite.changes !== 1) {
        throw new Error('Assignment fencing check failed during completion commit.');
      }

      this.db.prepare(
        `UPDATE saga3_work_intents
            SET status = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(accepted ? 'completed' : 'failed', acceptance.authority.workIntentId);
      this.db.prepare(
        `UPDATE saga3_worker_submissions
            SET state = 'processed', processed_at = datetime('now')
          WHERE execution_id = ? AND state = 'pending'`,
      ).run(acceptance.authority.executionId);

      // Tracker projection: close the worker_executions row and the task row
      // that the Saga 3 engine reserved for this condition. The condition
      // projection above is the authority for saga3 state; these tracker rows
      // are the v2 board projection that the tracker-view UI and the live
      // stage-acceptance test read. Without closing them, the board keeps
      // showing the worker as 'running' and the task as 'todo' even after a
      // successful saga3_complete — which is mechanically wrong and blocks
      // downstream stage checks ('worker execution exited cleanly',
      // 'board task is done after worker completion').
      this.db.prepare(
        `UPDATE worker_executions
            SET state = 'exited',
                phase = 'finishing',
                exit_code = 0,
                finished_at = datetime('now')
          WHERE execution_id = ?
            AND state IN ('reserved','running','cancel_requested')`,
      ).run(acceptance.authority.executionId);

      // The condition→task mapping lives in pipeline-contracts.ts
      // (resolveTaskForCondition). Tasks are matched by epic_id + task_kind,
      // which we resolve from episode_spec → epic. We look up the epic once.
      const specRow = this.db.prepare(
        `SELECT epic_id FROM saga3_episode_specs WHERE id = ?`,
      ).get(acceptance.authority.episodeSpecId) as { epic_id: number } | undefined;
      if (specRow?.epic_id) {
        // The task_kind for this condition is derived by resolveTaskForCondition
        // from the same CONDITION_TASK_KIND map. To avoid a circular import
        // (control ports → domain → sqlite), re-derive the small lookup here.
        const taskKind = conditionTaskKind(acceptance.authority.conditionType);
        if (taskKind) {
          this.db.prepare(
            `UPDATE tasks
                SET status = 'done',
                    updated_at = datetime('now')
              WHERE epic_id = ?
                AND task_kind = ?
                AND status IN ('todo','in_progress','review','review_in_progress')`,
          ).run(specRow.epic_id, taskKind);
        }
      }
    })();
  }

  listArtifacts(input: { readonly episodeSpecId?: string; readonly path?: string }) {
    if (input.path) {
      return this.mapArtifactRows(this.db.prepare(
        `SELECT id, episode_spec_id, kind, path, digest, created_at
           FROM saga3_artifacts WHERE path = ? ORDER BY created_at ASC`,
      ).all(input.path));
    }
    if (input.episodeSpecId) {
      return this.mapArtifactRows(this.db.prepare(
        `SELECT id, episode_spec_id, kind, path, digest, created_at
           FROM saga3_artifacts WHERE episode_spec_id = ? ORDER BY created_at ASC`,
      ).all(input.episodeSpecId));
    }
    throw new Error('Artifact query requires episodeSpecId or path.');
  }

  listConditions(episodeSpecId: string) {
    const rows = this.db.prepare(
      `SELECT condition_type, status, obligation_id
         FROM saga3_condition_instances
        WHERE episode_spec_id = ?
        ORDER BY condition_type ASC`,
    ).all(episodeSpecId) as Array<{
      condition_type: string;
      status: ConditionStatus;
      obligation_id: string;
    }>;
    return rows.map((row) => ({
      conditionType: row.condition_type,
      status: row.status,
      obligationId: row.obligation_id,
    }));
  }

  private insertSubmission(
    id: string,
    executionId: string,
    kind: 'artifact' | 'verification',
    payload: object,
  ): void {
    this.db.prepare(
      `INSERT INTO saga3_worker_submissions
         (id, execution_id, submission_kind, payload, state)
       VALUES (?, ?, ?, ?, 'pending')`,
    ).run(id, executionId, kind, JSON.stringify(payload));
  }

  private insertEvidence(evidence: EvidenceRecord): void {
    this.db.prepare(
      `INSERT INTO saga3_evidence_records
         (id, episode_spec_id, condition_type, obligation_id, generation,
          source_fingerprint, environment_fingerprint, oracle_id, oracle_version,
          trust_class, verdict, raw_digest, observed_at, freshness_max_age_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      evidence.id,
      evidence.episodeSpecId,
      evidence.conditionType,
      evidence.obligationId,
      evidence.generation,
      evidence.sourceFingerprint,
      evidence.environmentFingerprint,
      evidence.oracleId,
      evidence.oracleVersion,
      evidence.trustClass,
      evidence.verdict,
      evidence.rawDigest,
      evidence.observedAt,
      evidence.freshnessMaxAgeMs,
    );
  }

  private mapArtifactRows(rows: unknown[]) {
    return (rows as Array<{
      id: string;
      episode_spec_id: string;
      kind: string;
      path: string;
      digest: string;
      created_at: string;
    }>).map((row) => ({
      id: row.id,
      episodeSpecId: row.episode_spec_id,
      kind: row.kind,
      path: row.path,
      digest: row.digest,
      createdAt: row.created_at,
    }));
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saga3_worker_submissions (
        id              TEXT PRIMARY KEY,
        execution_id    TEXT NOT NULL,
        submission_kind TEXT NOT NULL CHECK (submission_kind IN ('artifact', 'verification')),
        payload         TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_saga3_worker_submissions_execution
        ON saga3_worker_submissions(execution_id, state, created_at);
    `);
  }
}

/**
 * Resolve the v2 `task_kind` for a saga3 condition. Mirrors the lookup in
 * pipeline-contracts.ts resolveTaskForCondition but returns only the kind
 * (the caller already has epic_id). Returns null for unmapped conditions
 * (e.g. MandatePresent, which has no task row by design).
 */
function conditionTaskKind(conditionType: string): string | null {
  return CONDITION_TASK_KIND[conditionType]?.task_kind ?? null;
}
