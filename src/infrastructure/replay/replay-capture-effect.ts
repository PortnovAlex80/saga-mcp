/**
 * Replay capture post-acceptance effect — the UNIVERSAL hook that archives
 * every accepted Production Cell worker execution into a reusable capsule.
 *
 * Unlike cell-specific effects (git-integration, formalization-accept-products),
 * this effect is ALWAYS invoked for every accepted candidate, regardless of
 * module. It captures the accepted author execution (and, for cells with
 * review, the reviewer execution) so future identical worker invocations can
 * replay the accepted production deterministically instead of calling the LLM.
 *
 * Capture is BEST-EFFORT: a replay-archive failure must NEVER revoke an
 * already-authoritative GateDecision. All errors are caught and logged.
 */
import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { SqliteReplayCapsuleRepository } from './sqlite-replay-capsule-repository.js';

export const REPLAY_CAPTURE_EFFECT_ID = 'replay-capture' as const;

export function createReplayCaptureEffect(db: Database.Database): PostAcceptanceEffect {
  const repo = new SqliteReplayCapsuleRepository(db);
  return {
    effectId: REPLAY_CAPTURE_EFFECT_ID,
    run(input) {
      // Best-effort: never let replay capture failure revoke a GateDecision.
      try {
        repo.captureAcceptedExecution({
          executionRef: input.producerExecutionRef,
          candidateSetRef: input.candidateSetRef,
        });
      } catch (error) {
        // Log but do not throw — the GateDecision is already authoritative.
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[replay-capture] best-effort capture failed for execution=${input.producerExecutionRef}: ${msg}\n`,
        );
      }
    },
  };
}
