import type Database from 'better-sqlite3';
import type { PostAcceptanceEffect } from '../../../process-modules/application/post-acceptance-effects.js';

export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID =
  'formalization.accept-exact-products.v1';

interface ProducedArtifactRow {
  artifact_id: number;
  content_hash: string | null;
}

interface ArtifactRow {
  id: number;
  status: string;
  content_hash: string | null;
  accepted_hash: string | null;
  drift_state: string;
}

/**
 * Projection effect after an authoritative Cell GateDecision=accepted.
 *
 * It does not decide quality. It only projects the already-recorded decision
 * onto the mutable artifact catalogue, guarded by exact producer lineage and
 * content hash. A changed artifact is a different product and fails closed.
 */
export function createFormalizationAcceptProductsEffect(
  db: Database.Database,
): PostAcceptanceEffect {
  return {
    effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    run(input) {
      // Select the LATEST production per artifact_id. A worker may edit the
      // same artifact multiple times within one execution (iterating on format,
      // fixing validation errors). Each edit appends a new production row. The
      // acceptance effect must compare the artifact's current content_hash
      // against the FINAL production (the last write), not every intermediate
      // write — otherwise an artifact that was edited N times before the worker
      // settled on the accepted version would always fail with content drift on
      // the first intermediate hash.
      const produced = db.prepare(
        `SELECT artifact_id,content_hash
           FROM factory_managed_artifact_productions
          WHERE process_run_id=? AND execution_id=?
            AND id IN (
              SELECT MAX(id) FROM factory_managed_artifact_productions
               WHERE process_run_id=? AND execution_id=?
               GROUP BY artifact_id
            )
          ORDER BY id`,
      ).all(
        input.processRunId,
        input.producerExecutionRef,
        input.processRunId,
        input.producerExecutionRef,
      ) as ProducedArtifactRow[];

      const apply = db.transaction(() => {
        for (const item of produced) {
          if (!item.content_hash) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_HASH_MISSING: artifact ${item.artifact_id}`,
            );
          }
          const artifact = db.prepare(
            `SELECT id,status,content_hash,accepted_hash,drift_state
               FROM artifacts WHERE id=?`,
          ).get(item.artifact_id) as ArtifactRow | undefined;
          if (!artifact) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_ARTIFACT_MISSING: ${item.artifact_id}`,
            );
          }
          if (artifact.content_hash !== item.content_hash) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_CONTENT_DRIFT: artifact ${item.artifact_id}`,
            );
          }
          if (
            artifact.status === 'accepted'
            && artifact.accepted_hash === item.content_hash
            && artifact.drift_state === 'clean'
          ) {
            continue;
          }
          const updated = db.prepare(
            `UPDATE artifacts
                SET status='accepted', accepted_hash=?, drift_state='clean',
                    updated_at=datetime('now')
              WHERE id=? AND content_hash=?`,
          ).run(item.content_hash, item.artifact_id, item.content_hash);
          if (updated.changes !== 1) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_CAS_FAILED: artifact ${item.artifact_id}`,
            );
          }
        }
      });
      apply.immediate();
    },
  };
}
