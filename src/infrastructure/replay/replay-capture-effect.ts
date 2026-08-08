/**
 * Replay capture effect — the DIRECT certification path.
 *
 * Reusable capsules are derived only after the Workplace is durably
 * terminal(accepted), and exact certifiable CandidateSets are taken from the
 * FINAL accepted GateDecision. Reviewed cells certify both the final author
 * subject and reviewer assessment set(s).
 *
 * Direct and lazy capture share one fail-closed completeness proof. Capsule
 * materialization remains derived optimization; final acceptance is never
 * revoked by archive failure.
 */
import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { SqliteReplayCapsuleRepository } from './sqlite-replay-capsule-repository.js';
import { captureReplayCapsuleFailClosed } from './replay-capsule-completeness.js';

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
          captureReplayCapsuleFailClosed(db, () =>
            repo.captureAcceptedExecution({
              executionRef: candidate.producer_execution_ref,
              candidateSetRef: candidate.candidate_set_ref,
            }));
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
