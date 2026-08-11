import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type { PostAcceptanceEffect } from '../../../process-modules/application/post-acceptance-effects.js';
import { serializeWorkplaceRef } from '../../../process-modules/domain/workplace/workplace-ref.js';
import {
  isWorkplaceProductionSnapshot,
} from '../../../process-modules/shared/workplace-production-snapshot.js';

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

interface CandidateProductRow {
  product_schema: string;
  product_ref: string;
  product_digest: string;
  process_run_id: number | null;
  node_id: string | null;
  schema_id: string | null;
  artifact_ref: string | null;
  product_hash: string | null;
  payload_snapshot: string | null;
  payload_hash: string | null;
}

/**
 * Projection effect after an authoritative Cell GateDecision=accepted.
 *
 * It does not decide quality. It only projects the already-recorded decision
 * onto the mutable artifact catalogue, guarded by exact producer lineage and
 * content hash. A changed artifact is a different product and fails closed.
 */
export function createFormalizationAcceptProductsEffect(
  db: SqlDatabasePort,
): PostAcceptanceEffect {
  return {
    effectId: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    run(input) {
      const acceptedSnapshot = readAcceptedWorkplaceSnapshot(db, input);
      // Select the LATEST production per artifact_id. A worker may edit the
      // same artifact multiple times within one execution (iterating on format,
      // fixing validation errors). Each edit appends a new production row. The
      // acceptance effect must compare the artifact's current content_hash
      // against the FINAL production (the last write), not every intermediate
      // write — otherwise an artifact that was edited N times before the worker
      // settled on the accepted version would always fail with content drift on
      // the first intermediate hash.
      // Managed-production CandidateSets freeze the complete Workplace desk,
      // which may contain contributions from several executions after crash
      // recovery. The immutable accepted snapshot is the effect authority;
      // filtering by only the presenter execution silently loses earlier
      // contributions. Typed-submission cells have no such snapshot and keep
      // the legacy execution-scoped projection behavior.
      const produced: ProducedArtifactRow[] = acceptedSnapshot
        ? acceptedSnapshot.artifacts.map(artifact => ({
            artifact_id: artifact.artifactId,
            content_hash: artifact.contentHash,
          }))
        : db.prepare(
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

function readAcceptedWorkplaceSnapshot(
  db: SqlDatabasePort,
  input: Parameters<PostAcceptanceEffect['run']>[0],
) {
  const members = db.prepare(
    `SELECT m.product_schema,m.product_ref,m.product_digest,
            p.process_run_id,p.node_id,p.schema_id,p.artifact_ref,
            p.product_hash,p.payload_snapshot,p.payload_hash
       FROM factory_candidate_set_members m
       LEFT JOIN factory_process_products p
         ON p.schema_id=m.product_schema
        AND p.artifact_ref=m.product_ref
        AND p.product_hash=m.product_digest
      WHERE m.candidate_set_ref=?
        AND m.product_schema=?
      ORDER BY m.ordinal`,
  ).all(input.candidateSetRef, input.expectedProductSchema) as CandidateProductRow[];
  if (members.length !== 1) return null;
  const member = members[0]!;
  // A typed submission is not stored in factory_process_products. It is a
  // valid legacy source for cells whose productSource is typed-submission.
  if (member.process_run_id === null) return null;
  if (
    member.process_run_id !== input.processRunId
    || member.node_id !== input.nodeId
    || member.schema_id !== input.expectedProductSchema
    || member.artifact_ref !== member.product_ref
    || member.product_hash !== member.product_digest
    || member.payload_hash !== member.product_digest
    || member.payload_snapshot === null
  ) {
    throw new Error(
      `FORMALIZATION_ACCEPTANCE_PRODUCT_MISMATCH: ${input.candidateSetRef}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(member.payload_snapshot);
  } catch {
    throw new Error(
      `FORMALIZATION_ACCEPTANCE_PRODUCT_CORRUPT: ${input.candidateSetRef}`,
    );
  }
  if (
    !isWorkplaceProductionSnapshot(payload)
    || payload.workplaceRef !== serializeWorkplaceRef(input.workplaceRef)
    || payload.expectedSchemaRef !== input.expectedProductSchema
    || payload.presenterExecutionRef !== input.producerExecutionRef
  ) {
    throw new Error(
      `FORMALIZATION_ACCEPTANCE_SNAPSHOT_MISMATCH: ${input.candidateSetRef}`,
    );
  }
  return payload;
}
