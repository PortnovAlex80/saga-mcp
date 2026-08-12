import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type { PostAcceptanceEffect } from '../../../process-modules/application/post-acceptance-effects.js';

export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID =
  'formalization.accept-exact-products.v1';

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
 * ADR-053 B-4/B-5 — the effect consumes ONLY `authority.acceptedProductRefs`.
 * Each accepted product carries `ref='artifact:<id>'` and `digest=<contentHash>`,
 * so the artifact rows are resolved directly from the authority — no
 * `factory_process_products` join, no `payload_snapshot` re-derivation, no
 * `processRunId`/`nodeId`/`expectedProductSchema` selectors. A changed artifact
 * (content_hash mismatch) is a different product and fails closed.
 */
export function createFormalizationAcceptProductsEffect(
  db: SqlDatabasePort,
): PostAcceptanceEffect {
  return {
    effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    run(input) {
      const produced = input.authority.acceptedProductRefs.map(p => {
        const match = /^artifact:(\d+)$/u.exec(p.ref);
        if (!match) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_PRODUCT_REF_INVALID: ${p.ref}`,
          );
        }
        if (!p.digest) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_HASH_MISSING: ${p.ref}`,
          );
        }
        return { artifact_id: Number(match[1]), content_hash: p.digest };
      });

      const apply = db.transaction(() => {
        for (const item of produced) {
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
