/**
 * Replay capture effect — the DIRECT certification path.
 *
 * Reusable capsules are derived after the Workplace is durably
 * terminal(accepted) and before CellFinalAcceptance is recorded. That order
 * makes capture a mandatory, retryable precondition: a crash or failure leaves
 * FinalAcceptance absent, so the normal terminal recovery path redrives the
 * same idempotent capture. Exact certifiable CandidateSets come from the final
 * accepted GateDecision.
 *
 * Direct and lazy capture share one fail-closed completeness proof. Capsule
 * materialization is required recovery evidence, not best-effort telemetry.
 */
import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { SqliteReplayCapsuleRepository } from './sqlite-replay-capsule-repository.js';
import { captureReplayCapsuleFailClosed } from './replay-capsule-completeness.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { assertPersistedAcceptedCandidateAuthority } from '../workplace/sqlite-accepted-candidate-authority.js';
import { acceptedCandidatePresentationRefs } from './replay-presentation-authority.js';

export const REPLAY_CAPTURE_EFFECT_ID = 'replay-capture' as const;
export const REPLAY_CAPTURE_EFFECT_VERSION = '1.0.0';
export const REPLAY_CAPTURE_EFFECT_DIGEST = sha256Hex({
  effectId: REPLAY_CAPTURE_EFFECT_ID,
  version: REPLAY_CAPTURE_EFFECT_VERSION,
  invariant: 'exact-final-acceptance-candidate-set-capsule',
});

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
    version: REPLAY_CAPTURE_EFFECT_VERSION,
    effectDigest: REPLAY_CAPTURE_EFFECT_DIGEST,
    run(input) {
      assertPersistedAcceptedCandidateAuthority(db, input.authority);
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
        throw new Error(`REPLAY_CERTIFICATION_WORKPLACE_NOT_ACCEPTED: ${workplaceRef}`);
      }

      {
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
            `SELECT candidate_set_ref FROM factory_candidate_sets
              WHERE candidate_set_ref=? AND workplace_ref=?`,
          ).get(candidateSetRef, workplaceRef) as { candidate_set_ref: string } | undefined;
          if (!candidate) {
            throw new Error(
              `REPLAY_CERTIFICATION_CANDIDATE_MISSING: ${candidateSetRef}`,
            );
          }
          const presentationRefs = acceptedCandidatePresentationRefs(db, {
            workplaceRef,
            finalDecisionKey: input.authority.gateDecisionKey,
            finalSubjectCandidateSetRef: decision.subject_candidate_set_ref,
            candidateSetRef,
          });
          for (const presentationRef of presentationRefs) {
            captureReplayCapsuleFailClosed(db, () =>
              repo.captureAcceptedExecution({
                executionRef: presentationRef,
                candidateSetRef: candidate.candidate_set_ref,
              }));
          }
        }
      }
    },
  };
}
