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
      // ADR-053 B-4 — consume material coordinates from the authority only.
      const workplaceRef = serializeWorkplaceRef(input.authority.workplaceRef);
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
        const finalAcceptance = db.prepare(
          `SELECT candidate_set_ref,effect_receipt_refs
             FROM factory_cell_final_acceptances
            WHERE workplace_ref=?`,
        ).get(workplaceRef) as {
          candidate_set_ref: string;
          effect_receipt_refs: string;
        } | undefined;
        if (!finalAcceptance) {
          throw new Error(
            `REPLAY_CERTIFICATION_CELL_FINAL_ACCEPTANCE_MISSING: ${workplaceRef}`,
          );
        }
        if (finalAcceptance.candidate_set_ref !== input.authority.candidateSetRef) {
          throw new Error(
            `REPLAY_CERTIFICATION_FINAL_CANDIDATE_MISMATCH: ${workplaceRef}`,
          );
        }
        // ADR-053 B-9 — resolve the accepted final gate decision by its EXACT
        // decision_key (authority.gateDecisionKey), NOT by decided_at recency.
        const decision = db.prepare(
          `SELECT subject_candidate_set_ref,assessment_candidate_set_refs
             FROM factory_gate_decisions
            WHERE decision_key=?`,
        ).get(input.authority.gateDecisionKey) as {
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
            `SELECT cs.candidate_set_ref,
                    (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev
                      WHERE rev.revision_ref = cs.production_revision_ref) AS presenter_ref
               FROM factory_candidate_sets cs
              WHERE cs.candidate_set_ref=? AND cs.workplace_ref=?`,
          ).get(candidateSetRef, workplaceRef) as {
            candidate_set_ref: string;
            presenter_ref: string;
          } | undefined;
          if (!candidate) {
            throw new Error(
              `REPLAY_CERTIFICATION_CANDIDATE_MISSING: ${candidateSetRef}`,
            );
          }
          const worker = db.prepare(
            `SELECT 1 AS present FROM worker_executions WHERE execution_id=?`,
          ).get(candidate.presenter_ref);
          // ProducerRef is wider than WorkerExecutionRef. Kernel presenters
          // preserve provenance but have no executable recipe to certify.
          if (!worker) continue;
          captureReplayCapsuleFailClosed(db, () =>
            repo.captureAcceptedExecution({
              executionRef: candidate.presenter_ref,
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
