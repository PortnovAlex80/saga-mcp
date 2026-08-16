import type Database from 'better-sqlite3';

import { resolveManagedExecutionProvenance } from '../../../process-modules/persistence/sqlite-managed-production-ledger.js';
import { deserializeWorkplaceRef } from '../../../process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceProductionResolver } from '../../../infrastructure/workplace/sqlite-workplace-production-resolver.js';
import {
  buildWorkplaceProductionSnapshot,
  isWorkplaceProductionSnapshot,
} from '../../../process-modules/shared/workplace-production-snapshot.js';
import type { WorkplaceProductionSnapshot } from '../../../process-modules/shared/workplace-production-snapshot.js';
import {
  FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
  FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
  FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
  FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
  FORMALIZATION_RECONCILIATION_SCHEMA,
} from '../domain/formalization-schemas.js';

/**
 * GB-5 (operator decision B, 2026-08-16): tracker_only formalization cells
 * produce managed documents. The CANONICAL product for their bundle schemas is
 * the factory-computed workplace production snapshot built from the managed
 * ledger of the submitting execution ("Factory computes the canonical digest",
 * ADR-053 / CONVEYOR-MENTAL-MODEL §worker-authority). The worker's submitted
 * payload is an intent claim; if it is not already a workplace snapshot it is
 * replaced by the ledger snapshot before the submission seals, so the gate,
 * the CandidateSet and the post-acceptance effects all hash ONE shape.
 *
 * Same tool-layer materializer pattern as materializeManagedSourceChange and
 * the discovery proposal projection: schema-family interception, module-owned.
 */
const SNAPSHOT_WRAPPED_SCHEMAS: ReadonlySet<string> = new Set([
  FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
  FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
  FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
  FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
  FORMALIZATION_RECONCILIATION_SCHEMA,
]);

export function materializeFormalizationSnapshot(
  db: Database.Database,
  schema: string,
  content: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!SNAPSHOT_WRAPPED_SCHEMAS.has(schema)) return content;
  // GB-10: a worker may hand-roll a snapshot-SHAPED payload (the contract
  // documents the shape). Only a fully canonical snapshot — every trace with
  // a numeric traceId/traceHash, every artifact with artifactId/contentHash —
  // passes through; anything less is rebuilt from the managed ledger, the
  // single authority for production identity.
  if (isCanonicalWorkplaceSnapshot(content)) return content;
  const provenance = resolveManagedExecutionProvenance(db, env);
  if (provenance === null) return content;
  const task = db
    .prepare('SELECT workplace_ref FROM tasks WHERE id=?')
    .get(provenance.taskId) as { workplace_ref: string | null } | undefined;
  const workplaceRef = task?.workplace_ref ?? null;
  if (!workplaceRef) return content;
  const material = new SqliteWorkplaceProductionResolver(db)
    .read(deserializeWorkplaceRef(workplaceRef));
  if (material.artifacts.length === 0 && material.traces.length === 0) {
    throw new Error(
      `FORMALIZATION_SNAPSHOT_EMPTY: ${workplaceRef} has no managed artifact `
      + 'material yet — write the artifacts before submitting the bundle',
    );
  }
  return buildWorkplaceProductionSnapshot({
    workplaceRef,
    expectedSchemaRef: schema,
    artifacts: material.artifacts,
    traces: material.traces,
  });
}

function isCanonicalWorkplaceSnapshot(value: unknown): value is WorkplaceProductionSnapshot {
  if (!isWorkplaceProductionSnapshot(value)) return false;
  return value.artifacts.every(a =>
    Number.isSafeInteger(a.artifactId) && typeof a.contentHash === 'string' && a.contentHash !== '',
  ) && value.traces.every(t =>
    Number.isSafeInteger(t.traceId) && typeof t.traceHash === 'string' && t.traceHash !== '',
  );
}
