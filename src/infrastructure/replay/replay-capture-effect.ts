/**
 * Replay capture effect — the DIRECT certification path.
 *
 * IMPORTANT: a GateRun returning `accepted` is not by itself enough to certify
 * replay data. A decision may still lose the Workplace revision CAS or remain
 * audit-only. A reusable capsule may be created only from a durable
 * `terminal(accepted)` Workplace.
 *
 * ProductionCellNodeExecutor invokes this effect AFTER applying the durable
 * transition, and only when the workplace has become durably `terminal(accepted)`.
 * The guard below therefore passes on the normal path — this is the primary
 * certification mechanism.
 *
 * The lazy claim-bound sweep (`certifyAcceptedReplayCapsules`) remains as a
 * crash/reconciliation fallback: if this effect never ran (process crash between
 * the transition and capture), the sweep backfills the missing capsules before
 * the next replay lookup. No second state machine or pending-capture entity
 * exists: direct capture is the path, lazy sweep is the safety net.
 */
import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { SqliteReplayCapsuleRepository } from './sqlite-replay-capsule-repository.js';

export const REPLAY_CAPTURE_EFFECT_ID = 'replay-capture' as const;

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

      // Certification boundary: never archive a merely proposed/checked
      // acceptance. Only the durable terminal accepted state is replayable.
      if (!state
          || state.loop_state !== 'terminal'
          || state.terminal_reason !== 'accepted') {
        return;
      }

      try {
        repo.captureAcceptedExecution({
          executionRef: input.producerExecutionRef,
          candidateSetRef: input.candidateSetRef,
        });
      } catch (error) {
        // Replay archive is an optimization. Failure must not rewrite an
        // already-authoritative accepted transition.
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[replay-capture] certification failed for execution=${input.producerExecutionRef}: ${msg}\n`,
        );
      }
    },
  };
}
