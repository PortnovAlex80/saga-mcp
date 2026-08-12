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

interface SnapshotPayload {
  schemaVersion?: string;
  artifacts?: unknown;
}

/**
 * Validate a parsed product payload IS a Workplace production snapshot and
 * extract its (artifactId, contentHash) pairs. A managed-production product
 * whose body is not a snapshot fails closed — it must carry the artifacts the
 * worker produced. (Typed-submission reports are skipped before reaching here.)
 */
function extractSnapshotArtifacts(
  snapshot: SnapshotPayload,
  schemaId: string,
  ref: string,
): Array<{ artifact_id: number; content_hash: string }> {
  if (
    snapshot.schemaVersion !== WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION
    || !Array.isArray(snapshot.artifacts)
  ) {
    throw new Error(
      `FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_SNAPSHOT: ${schemaId}/${ref}`,
    );
  }
  return (snapshot.artifacts as SnapshotArtifact[]).map(a => ({
    artifact_id: a.artifactId,
    content_hash: a.contentHash,
  }));
}

/**
 * Projection effect after an authoritative Cell GateDecision=accepted.
 *
 * ADR-053 / conveyor-v4.3 — a formalization Cell's accepted product is one of:
 *   - a managed-production Workplace snapshot (`factory_process_products`, ref
 *     `workplace:<module>:<node>:<snapshotHash>`) — the artifact-producing
 *     cells (product-contract, use-cases, acceptance-contract, architecture).
 *     The artifact rows the worker created live INSIDE the snapshot, so the
 *     effect resolves them by reading the pinned snapshot payload and
 *     extracting the (artifactId, contentHash) pairs it carries.
 *   - a typed-submission report (`factory_managed_node_submissions`, ref
 *     `managed-node-submission:<id>`) — the reconciliation cell produces an
 *     authoritative report, NOT a desk snapshot. It carries no artifacts to
 *     accept (the WHAT artifacts were already accepted upstream), so such
 *     products are skipped.
 *
 * A managed-production product whose pinned row is missing or whose body is not
 * a Workplace snapshot fails closed. A typed-submission product whose pinned
 * row is missing also fails closed; a present report payload is skipped.
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
        // Typed-submission product (reconciliation report) — authoritative
        // report document, not a desk snapshot: no artifacts to accept. Only a
        // snapshot-typed submission would project artifacts; reports are
        // skipped. A missing pinned row still fails closed.
        const subMatch = /^managed-node-submission:(\d+)$/u.exec(p.ref);
        if (subMatch) {
          const sub = db.prepare(
            `SELECT payload_snapshot
               FROM factory_managed_node_submissions
              WHERE id=?`,
          ).get(Number(subMatch[1])) as ProductSnapshotRow | undefined;
          if (!sub) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_FOUND: ${p.schemaId}/${p.ref}`,
            );
          }
          const parsed = JSON.parse(sub.payload_snapshot) as {
            schemaVersion?: string;
            artifacts?: unknown;
          };
          if (
            parsed.schemaVersion
              !== WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION
          ) {
            return []; // report product — no artifacts to accept
          }
          return extractSnapshotArtifacts(parsed, p.schemaId, p.ref);
        }
        // managed-production Workplace snapshot pinned in
        // factory_process_products by the full ProductRef triple
        // (schema_id, artifact_ref, product_hash) — the indexed exact lookup.
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
        return extractSnapshotArtifacts(snapshot, p.schemaId, p.ref);
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
          // Accept by the artifact's CURRENT (disk-verified) content_hash from
          // the requirements table. The snapshot identifies WHICH artifacts the
          // cell produced; the table's content_hash is the live source of truth.
          //
          // We deliberately do NOT compare the snapshot's sealed contentHash
          // against the table: artifactDiskHash hashes the WHOLE file (it
          // strips the `#anchor`), so all anchors sharing one file converge to
          // one hash that evolves as the worker edits the file during the task.
          // A snapshot-vs-table drift check would reject benign same-task edits,
          // and the managed-production ledger can lag the table because
          // refreshArtifactHash updates artifacts.content_hash from disk without
          // recording a ledger row. Fail closed only when the artifact row is
          // missing or carries no content_hash.
          if (!artifact.content_hash) {
            throw new Error(
              `FORMALIZATION_ACCEPTANCE_HASH_MISSING: artifact ${item.artifact_id}`,
            );
          }
          if (
            artifact.status === 'accepted'
            && artifact.accepted_hash === artifact.content_hash
            && artifact.drift_state === 'clean'
          ) {
            continue;
          }
          const updated = db.prepare(
            `UPDATE artifacts
                SET status='accepted', accepted_hash=?, drift_state='clean',
                    updated_at=datetime('now')
              WHERE id=? AND content_hash=?`,
          ).run(artifact.content_hash, item.artifact_id, artifact.content_hash);
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
