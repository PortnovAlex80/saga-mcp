/**
 * Replay capture effect — the DIRECT certification path.
 *
 * Reusable capsules are derived only after the Workplace is durably
 * terminal(accepted), and exact certifiable CandidateSets are taken from the
 * FINAL accepted GateDecision. Reviewed cells certify both the final author
 * subject and reviewer assessment set(s).
 *
 * Capture is fail-closed on completeness: every generic worker product/evidence
 * row recorded for the source execution must be representable in the capsule.
 * A partial derived archive is deleted immediately and never becomes reusable.
 * Lazy certification remains only a crash/reconciliation fallback.
 */
import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import type { ReplayCapsuleRecord } from '../../replay/replay-capsule.js';
import { SqliteReplayCapsuleRepository } from './sqlite-replay-capsule-repository.js';

export const REPLAY_CAPTURE_EFFECT_ID = 'replay-capture' as const;

function parseAssessmentRefs(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('REPLAY_CERTIFICATION_INVALID: assessment_candidate_set_refs is not JSON');
  }
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new Error('REPLAY_CERTIFICATION_INVALID: assessment_candidate_set_refs must be string[]');
  }
  return parsed;
}

function scalarCount(db: Database.Database, sql: string, executionRef: string): number {
  const row = db.prepare(sql).get(executionRef) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

function validateCaptureCompleteness(
  db: Database.Database,
  executionRef: string,
  record: ReplayCapsuleRecord,
): void {
  const typedCount = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM factory_managed_node_submissions WHERE execution_id=?`,
    executionRef,
  );
  const artifactCount = scalarCount(
    db,
    `SELECT COUNT(DISTINCT artifact_id) AS n
       FROM factory_managed_artifact_productions WHERE execution_id=?`,
    executionRef,
  );
  const traceCount = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM factory_managed_trace_productions WHERE execution_id=?`,
    executionRef,
  );

  if (record.payload.typedProducts.length !== typedCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TYPED_PRODUCTS: expected ${typedCount}, captured ${record.payload.typedProducts.length}`,
    );
  }
  if (record.payload.artifacts.length !== artifactCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_ARTIFACTS: expected ${artifactCount}, captured ${record.payload.artifacts.length}`,
    );
  }
  if (record.payload.traces.length !== traceCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TRACES: expected ${traceCount}, captured ${record.payload.traces.length}`,
    );
  }

  // A file-backed source artifact must carry its bytes in the capsule. db_native
  // and external_ref products are allowed to have no embedded file.
  const fileBacked = db.prepare(
    `SELECT a.type,a.code,a.title,a.path,a.content_hash
       FROM factory_managed_artifact_productions p
       JOIN artifacts a ON a.id=p.artifact_id
      WHERE p.execution_id=? AND a.storage_kind='file_backed'
      GROUP BY a.id`,
  ).all(executionRef) as Array<{
    type: string;
    code: string | null;
    title: string;
    path: string;
    content_hash: string | null;
  }>;
  for (const source of fileBacked) {
    const captured = record.payload.artifacts.find(item =>
      item.selector.type === source.type
      && item.selector.code === source.code
      && item.selector.title === source.title
      && item.selector.path === source.path
      && item.selector.contentHash === source.content_hash);
    if (!captured?.file) {
      throw new Error(
        `REPLAY_CAPTURE_FILE_BYTES_MISSING: ${source.type}:${source.code ?? ''}:${source.path}`,
      );
    }
  }

  const execution = db.prepare(
    `SELECT t.execution_mode
       FROM worker_executions we JOIN tasks t ON t.id=we.task_id
      WHERE we.execution_id=?`,
  ).get(executionRef) as { execution_mode: string } | undefined;
  if (execution?.execution_mode === 'git_change' && record.payload.git === null) {
    throw new Error('REPLAY_CAPTURE_GIT_RECIPE_MISSING: git_change execution has no exact Git recipe');
  }
}

function captureExact(
  db: Database.Database,
  repo: SqliteReplayCapsuleRepository,
  executionRef: string,
  candidateSetRef: string,
): void {
  const record = repo.captureAcceptedExecution({ executionRef, candidateSetRef });
  try {
    validateCaptureCompleteness(db, executionRef, record);
  } catch (error) {
    // Capsule is derived data, so deleting an invalid partial archive does not
    // mutate acceptance authority. Lazy certification may retry after the
    // underlying capture defect is fixed.
    db.prepare('DELETE FROM factory_replay_capsules WHERE capsule_ref=?')
      .run(record.capsuleRef);
    throw error;
  }
}

export function createReplayCaptureEffect(db: Database.Database): PostAcceptanceEffect {
  const repo = new SqliteReplayCapsuleRepository(db);
  return {
    effectId: REPLAY_CAPTURE_EFFECT_ID,
    run(input) {
      const workplaceRef = serializeWorkplaceRef(input.workplaceRef);
      const state = db.prepare(
        `SELECT loop_state,terminal_reason
           FROM factory_workplaces
          WHERE workplace_ref=?`,
      ).get(workplaceRef) as {
        loop_state: string;
        terminal_reason: string | null;
      } | undefined;

      if (!state
          || state.loop_state !== 'terminal'
          || state.terminal_reason !== 'accepted') {
        return;
      }

      try {
        const decision = db.prepare(
          `SELECT subject_candidate_set_ref,assessment_candidate_set_refs
             FROM factory_gate_decisions
            WHERE workplace_ref=?
              AND gate_phase='final'
              AND verdict='accepted'
            ORDER BY decided_at DESC,rowid DESC
            LIMIT 1`,
        ).get(workplaceRef) as {
          subject_candidate_set_ref: string;
          assessment_candidate_set_refs: string;
        } | undefined;
        if (!decision) {
          throw new Error(
            `REPLAY_CERTIFICATION_FINAL_DECISION_MISSING: ${workplaceRef}`,
          );
        }

        const candidateRefs = [
          decision.subject_candidate_set_ref,
          ...parseAssessmentRefs(decision.assessment_candidate_set_refs),
        ];

        for (const candidateSetRef of [...new Set(candidateRefs)]) {
          const candidate = db.prepare(
            `SELECT candidate_set_ref,producer_execution_ref
               FROM factory_candidate_sets
              WHERE candidate_set_ref=? AND workplace_ref=?`,
          ).get(candidateSetRef, workplaceRef) as {
            candidate_set_ref: string;
            producer_execution_ref: string;
          } | undefined;
          if (!candidate) {
            throw new Error(
              `REPLAY_CERTIFICATION_CANDIDATE_MISSING: ${candidateSetRef}`,
            );
          }
          captureExact(
            db,
            repo,
            candidate.producer_execution_ref,
            candidate.candidate_set_ref,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[replay-capture] direct certification failed for workplace=${workplaceRef}: ${msg}\n`,
        );
      }
    },
  };
}
