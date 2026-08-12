import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type { PostAcceptanceEffect } from '../../../process-modules/application/post-acceptance-effects.js';
import { WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION } from '../../../process-modules/shared/workplace-production-snapshot.js';

export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID =
  'formalization.accept-exact-products.v1';

interface ArtifactRow {
  id: number;
  status: string;
  content_hash: string | null;
  accepted_hash: string | null;
  drift_state: string;
}

interface ProductSnapshotRow {
  payload_snapshot: string;
}

interface SnapshotArtifact {
  artifactId: number;
  contentHash: string;
}

/**
 * Projection effect after an authoritative Cell GateDecision=accepted.
 *
 * ADR-053 / conveyor-v4.3 — accepted products are immutable Workplace
 * production snapshots persisted in `factory_process_products`. Each accepted
 * product ref is `workplace:<module>:<node>:<snapshotHash>` (the universal
 * exact-product store key), NOT `artifact:<id>`. The artifact rows produced by
 * the worker live INSIDE the snapshot, so the effect resolves them by reading
 * the pinned snapshot payload and extracting the (artifactId, contentHash)
 * pairs it carries. A product whose pinned row is missing, whose payload_hash
 * drifted, or whose body is not a Workplace production snapshot fails closed.
 */
export function createFormalizationAcceptProductsEffect(
  db: SqlDatabasePort,
): PostAcceptanceEffect {
  return {
    effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    run(input) {
      const produced = input.authority.acceptedProductRefs.flatMap(p => {
        if (!p.digest) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_HASH_MISSING: ${p.schemaId}/${p.ref}`,
          );
        }
        // The (schemaId, ref, product_hash) triple is exactly the
        // idx_factory_process_products_schema_ref_hash index key, so this is a
        // direct equality probe on the immutable pinned product row.
        // The (schemaId, ref, product_hash) triple is exactly the
        // idx_factory_process_products_schema_ref_hash index key, so this is a
        // direct equality probe pinning the immutable product row by its full
        // ProductRef identity.
        const row = db.prepare(
          `SELECT payload_snapshot
             FROM factory_process_products
            WHERE schema_id=? AND artifact_ref=? AND product_hash=?`,
        ).get(p.schemaId, p.ref, p.digest) as ProductSnapshotRow | undefined;
        if (!row) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_FOUND: ${p.schemaId}/${p.ref}`,
          );
        }
        const snapshot = JSON.parse(row.payload_snapshot) as {
          schemaVersion?: string;
          artifacts?: unknown;
        };
        if (
          snapshot.schemaVersion !== WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION
          || !Array.isArray(snapshot.artifacts)
        ) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_SNAPSHOT: ${p.schemaId}/${p.ref}`,
          );
        }
        const artifacts = snapshot.artifacts as SnapshotArtifact[];
        return artifacts.map(a => ({
          artifact_id: a.artifactId,
          content_hash: a.contentHash,
        }));
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
