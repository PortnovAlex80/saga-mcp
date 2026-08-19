import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type {
  AcceptedCandidateAuthority,
  PostAcceptanceEffect,
  PostAcceptanceEffectResult,
} from '../../../process-modules/application/post-acceptance-effects.js';
import { WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION } from '../../../process-modules/shared/workplace-production-snapshot.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import { FORMALIZATION_RECONCILIATION_SCHEMA } from '../domain/formalization-schemas.js';
import type { ProductRef } from '../../../process-modules/domain/spi/production-envelope.js';
import { appendArtifactDriftTransition } from '../../../shared/artifact-drift-events.js';

export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID =
  'formalization.accept-exact-products.v1';
export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_VERSION = '1.0.0';
export const FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_DIGEST = sha256Hex({
  effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
  version: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_VERSION,
  invariant: 'accepted-authority-exact-artifact-hash-transition',
});

interface ArtifactRow {
  id: number;
  status: string;
  content_hash: string | null;
  accepted_hash: string | null;
  drift_state: string;
}

/** Fail closed: the DB CHECK constrains the column to this union. */
function asDriftState(value: string): 'unknown' | 'clean' | 'drifted' {
  if (value === 'unknown' || value === 'clean' || value === 'drifted') return value;
  throw new Error(`FORMALIZATION_ACCEPTANCE_DRIFT_STATE_INVALID: ${value}`);
}

interface SnapshotArtifact {
  artifactId: number;
  contentHash: string;
}

interface SnapshotPayload {
  schemaVersion?: string;
  artifacts?: unknown;
}

function extractSnapshotArtifacts(
  snapshot: SnapshotPayload,
  schemaId: string,
  ref: string,
): Array<{ artifact_id: number; content_hash: string }> {
  if (
    snapshot.schemaVersion !== WORKPLACE_PRODUCTION_SNAPSHOT_SCHEMA_VERSION
    || !Array.isArray(snapshot.artifacts)
  ) {
    throw new Error(`FORMALIZATION_ACCEPTANCE_PRODUCT_NOT_SNAPSHOT: ${schemaId}/${ref}`);
  }
  return (snapshot.artifacts as SnapshotArtifact[]).map(artifact => ({
    artifact_id: artifact.artifactId,
    content_hash: artifact.contentHash,
  }));
}

/**
 * Projection effect after an authoritative GateDecision=accepted. The exact
 * schema/content material comes from AcceptedCandidateAuthority. Typed reports
 * have no artifacts to accept; Workplace snapshots carry exact artifact ids
 * and sealed content hashes.
 */
export function createFormalizationAcceptProductsEffect(
  db: SqlDatabasePort,
  authority: {
    assertPersisted(value: AcceptedCandidateAuthority): void;
    readSealedProduct(ref: ProductRef): unknown;
  },
): PostAcceptanceEffect {
  return {
    effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    version: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_VERSION,
    effectDigest: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_DIGEST,
    run(input): PostAcceptanceEffectResult | undefined {
      authority.assertPersisted(input.authority);
      const produced = input.authority.acceptedProductRefs.flatMap(product => {
        if (!product.digest) {
          throw new Error(
            `FORMALIZATION_ACCEPTANCE_HASH_MISSING: ${product.schemaId}/${product.ref}`,
          );
        }
        const snapshot = authority.readSealedProduct(product) as SnapshotPayload;
        if (product.schemaId === FORMALIZATION_RECONCILIATION_SCHEMA) {
          return [];
        }
        return extractSnapshotArtifacts(snapshot, product.schemaId, product.ref);
      });

      // TB-6: drift detection is a read-only pre-pass, so a repair outcome is
      // decided BEFORE the mutation transaction opens — no partial mutation is
      // ever committed. Detection is unchanged and fail-closed; the RESPONSE
      // is a repair_required outcome the executor routes into
      // acceptance-effect repair instead of a terminal stage failure.
      for (const item of produced) {
        const artifact = db.prepare(
          `SELECT id,status,content_hash,accepted_hash,drift_state
             FROM artifacts WHERE id=?`,
        ).get(item.artifact_id) as ArtifactRow | undefined;
        if (!artifact) {
          throw new Error(`FORMALIZATION_ACCEPTANCE_ARTIFACT_MISSING: ${item.artifact_id}`);
        }
        // The sealed snapshot hash is the accepted authority. A later mutable
        // artifact row may not silently substitute different material.
        if (!artifact.content_hash) {
          return {
            outcome: 'repair_required',
            reason: `FORMALIZATION_ACCEPTANCE_HASH_MISSING: artifact ${item.artifact_id}`,
            evidence: { artifactId: item.artifact_id, sealedHash: item.content_hash },
          };
        }
        if (artifact.content_hash !== item.content_hash) {
          return {
            outcome: 'repair_required',
            reason: `FORMALIZATION_ACCEPTANCE_HASH_DRIFT: artifact ${item.artifact_id}`,
            evidence: {
              artifactId: item.artifact_id,
              sealedHash: item.content_hash,
              rowHash: artifact.content_hash,
            },
          };
        }
      }

      const apply = db.transaction(() => {
        for (const item of produced) {
          const artifact = db.prepare(
            `SELECT id,status,content_hash,accepted_hash,drift_state
               FROM artifacts WHERE id=?`,
          ).get(item.artifact_id) as ArtifactRow | undefined;
          if (!artifact) {
            throw new Error(`FORMALIZATION_ACCEPTANCE_ARTIFACT_MISSING: ${item.artifact_id}`);
          }
          if (
            artifact.status === 'accepted'
            && artifact.accepted_hash === item.content_hash
            && artifact.drift_state === 'clean'
          ) {
            continue;
          }
          // BLINDSIGHT F6 — acceptance OVERWRITES drift_state to 'clean';
          // chain the transition before the projection is replaced so a
          // drifted-then-accepted artifact keeps durable proof of the drift
          // episode. Same-state acceptance appends nothing.
          appendArtifactDriftTransition(db, {
            artifactId: artifact.id,
            fromState: asDriftState(artifact.drift_state),
            toState: 'clean',
            observedContentHash: item.content_hash,
            acceptedHash: item.content_hash,
            cause: 'formalization-acceptance',
            observedBy: 'formalization-accept-products-effect',
          });
          const updated = db.prepare(
            `UPDATE artifacts
                SET status='accepted', accepted_hash=?, drift_state='clean',
                    updated_at=datetime('now')
              WHERE id=? AND content_hash=?`,
          ).run(item.content_hash, artifact.id, item.content_hash);
          if (updated.changes !== 1) {
            throw new Error(`FORMALIZATION_ACCEPTANCE_CAS_FAILED: artifact ${item.artifact_id}`);
          }
        }
      });
      apply.immediate();
      return undefined;
    },
  };
}
