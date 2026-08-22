import type Database from 'better-sqlite3';
import type { ReplayCapsuleRecord } from '../../replay/replay-capsule.js';
import { isWorkplaceProductionSnapshot } from '../../process-modules/shared/workplace-production-snapshot.js';
import { SqliteSealedProductMaterialRepository } from '../workplace/sqlite-sealed-product-material-repository.js';

interface CandidateMemberRow {
  product_schema: string;
  product_ref: string;
  product_digest: string;
}

function candidateMembers(
  db: Database.Database,
  candidateSetRef: string,
): CandidateMemberRow[] {
  const candidate = db.prepare(
    'SELECT candidate_set_ref FROM factory_candidate_sets WHERE candidate_set_ref=?',
  ).get(candidateSetRef) as { candidate_set_ref: string } | undefined;
  if (!candidate) {
    throw new Error(`REPLAY_CAPTURE_CANDIDATE_NOT_FOUND: ${candidateSetRef}`);
  }
  return db.prepare(
    `SELECT product_schema,product_ref,product_digest
       FROM factory_candidate_set_members
      WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(candidateSetRef) as CandidateMemberRow[];
}

function readPersistedProduct(
  db: Database.Database,
  member: CandidateMemberRow,
): unknown {
  return new SqliteSealedProductMaterialRepository(db).readExact({
    schemaId: member.product_schema,
    ref: member.product_ref,
    digest: member.product_digest,
  });
}

/**
 * F-R1 (night triage 2026-08-22): a reviewed cell's CandidateSet is
 * cumulative on the accepted-author revision (ADR-053 C14) — the author's
 * typed product legitimately rides the reviewer's set. Certifying foreign
 * members into the REVIEWER capsule made replay re-submit the author
 * product under the reviewer WorkIntent (MANAGED_NODE_SUBMISSION_SCHEMA_
 * MISMATCH, formalization/restart-idempotency). A member belongs to a
 * capsule only if the capsule's OWN cell produced it; foreign members stay
 * certified by their own cell's capsule.
 *
 * "Own cell" is the TASK, not the execution (2026-08-22 packaging defect):
 * a retry/repair successor execution of the SAME task accepts a cumulative
 * CandidateSet whose implementation product was submitted by a predecessor
 * execution of that task (P18 cross-execution repair). Skipping it as
 * foreign left the accepted capsule without the implementation product and
 * its Git recipe — REPLAY_CAPTURE_GIT_RECIPE_MISSING, nondeterministic
 * whenever the retry path fired. Foreign means another TASK's material.
 */
export function isForeignManagedSubmission(
  db: Database.Database,
  productRef: string,
  executionRef: string,
): boolean {
  if (!productRef.startsWith('managed-node-submission:')) return false;
  const id = Number(productRef.slice('managed-node-submission:'.length));
  if (!Number.isSafeInteger(id) || id < 1) return false;
  const row = db.prepare(
    'SELECT execution_id, task_id FROM factory_managed_node_submissions WHERE id=?',
  ).get(id) as { execution_id: string; task_id: number } | undefined;
  if (!row) return false;
  if (row.execution_id === executionRef) return false;
  const own = db.prepare(
    'SELECT task_id FROM worker_executions WHERE execution_id=?',
  ).get(executionRef) as { task_id: number } | undefined;
  if (own && row.task_id === own.task_id) return false;
  return true;
}

/**
 * Prove that a capsule is a complete reconstruction recipe for the exact
 * accepted CandidateSet. The CandidateSet ProductRefs are the oracle; physical
 * writes made by sourceExecutionRef are provenance only and may legitimately
 * be empty after P18 cross-execution repair.
 */
export function assertReplayCapsuleComplete(
  db: Database.Database,
  executionRef: string,
  record: ReplayCapsuleRecord,
): void {
  if (record.sourceExecutionRef !== executionRef) {
    throw new Error(
      `REPLAY_CAPTURE_SOURCE_EXECUTION_MISMATCH: expected ${executionRef}, got ${record.sourceExecutionRef}`,
    );
  }

  const members = candidateMembers(db, record.sourceCandidateSetRef);
  if (members.length === 0) {
    throw new Error(`REPLAY_CAPTURE_CANDIDATE_EMPTY: ${record.sourceCandidateSetRef}`);
  }

  const expectedTyped = new Map<string, CandidateMemberRow>();
  const expectedArtifactIds = new Set<number>();
  // CONVEYOR §9 — trace completeness counts CONTENT identities, not rowids:
  // a re-sealed snapshot may embed both generations of a revised trace
  // (deleted rowids + re-created twins) which collapse to one identity each.
  const expectedTraceIdentities = new Set<string>();

  for (const member of members) {
    const product = readPersistedProduct(db, member);
    if (!isWorkplaceProductionSnapshot(product)) {
      // F-R1: foreign (parent-revision) typed members are certified by their
      // OWN capsule — they are not this capsule's reconstruction duty.
      if (isForeignManagedSubmission(db, member.product_ref, executionRef)) continue;
      expectedTyped.set(`${member.product_schema}:${member.product_digest}`, member);
      continue;
    }
    for (const artifact of product.artifacts) expectedArtifactIds.add(artifact.artifactId);
    for (const trace of product.traces) {
      const key = typeof trace.traceHash === 'string' && trace.traceHash.length === 64
        ? trace.traceHash
        : JSON.stringify([trace.sourceId, trace.targetType, trace.targetId, trace.linkType]);
      expectedTraceIdentities.add(key);
    }
  }

  const actualTyped = new Set(
    record.payload.typedProducts.map(item => `${item.schema}:${item.contentHash}`),
  );
  if (actualTyped.size !== expectedTyped.size
      || [...expectedTyped.keys()].some(key => !actualTyped.has(key))) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TYPED_PRODUCTS: expected ${expectedTyped.size}, captured ${actualTyped.size}`,
    );
  }

  if (record.payload.artifacts.length !== expectedArtifactIds.size) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_ARTIFACTS: expected ${expectedArtifactIds.size}, captured ${record.payload.artifacts.length}`,
    );
  }
  if (record.payload.traces.length !== expectedTraceIdentities.size) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TRACES: expected ${expectedTraceIdentities.size}, captured ${record.payload.traces.length}`,
    );
  }

  const sourceArtifacts = [...expectedArtifactIds].map(id => db.prepare(
    `SELECT id,type,code,title,path,content_hash,storage_kind,parent_artifact_id
       FROM artifacts WHERE id=?`,
  ).get(id) as {
    id: number;
    type: string;
    code: string | null;
    title: string;
    path: string;
    content_hash: string | null;
    storage_kind: string;
    parent_artifact_id: number | null;
  } | undefined).filter((row): row is NonNullable<typeof row> => row !== undefined);
  if (sourceArtifacts.length !== expectedArtifactIds.size) {
    throw new Error(
      `REPLAY_CAPTURE_ARTIFACT_NOT_FOUND: expected ${expectedArtifactIds.size}, resolved ${sourceArtifacts.length}`,
    );
  }

  for (const source of sourceArtifacts) {
    const captured = record.payload.artifacts.find(item =>
      item.selector.type === source.type
      && item.selector.code === source.code
      && item.selector.title === source.title
      && item.selector.path === source.path
      && item.selector.contentHash === source.content_hash);
    if (!captured) {
      throw new Error(
        `REPLAY_CAPTURE_ARTIFACT_SELECTOR_MISSING: ${source.type}:${source.code ?? ''}:${source.path}`,
      );
    }
    if (source.storage_kind === 'file_backed' && !captured.file) {
      throw new Error(
        `REPLAY_CAPTURE_FILE_BYTES_MISSING: ${source.type}:${source.code ?? ''}:${source.path}`,
      );
    }
    if (source.parent_artifact_id !== null && captured.parent === null) {
      throw new Error(
        `REPLAY_CAPTURE_PARENT_SELECTOR_MISSING: ${source.type}:${source.code ?? ''}:${source.path}`,
      );
    }
  }

  for (const trace of record.payload.traces) {
    if (trace.targetType === 'artifact' && trace.targetArtifact === null) {
      throw new Error('REPLAY_CAPTURE_TRACE_ARTIFACT_TARGET_MISSING');
    }
    if (trace.targetType === 'task' && !trace.targetTaskGenerationKey) {
      throw new Error('REPLAY_CAPTURE_TRACE_TASK_TARGET_IDENTITY_MISSING');
    }
  }

  const execution = db.prepare(
    `SELECT t.execution_mode
       FROM worker_executions we JOIN tasks t ON t.id=we.task_id
      WHERE we.execution_id=?`,
  ).get(executionRef) as { execution_mode: string } | undefined;
  // Carry-forward capsules (presentedBy) certify KERNEL-presented
  // carried-forward material — never a worker execution's git production.
  // git: null is their DESIGNED shape even when bound to a git_change
  // execution; demanding a recipe from kernel-presented material killed
  // whole stages non-deterministically (2026-08-22, 50/50 repro).
  const isCarryForward = typeof record.payload.presentedBy === 'string';
  if (!isCarryForward
    && execution?.execution_mode === 'git_change' && record.payload.git === null) {
    const hasImplementation = record.payload.typedProducts.some(item =>
      item.schema === 'factory.development-implementation-result.v1');
    throw new Error(
      `REPLAY_CAPTURE_GIT_RECIPE_MISSING: git_change execution has no exact Git recipe `
      + `(implementation product ${hasImplementation
        ? 'present but recipe unresolved'
        : 'ABSENT from capsule typed products'})`,
    );
  }
}

/**
 * Derived capsule rows have no transition authority. If completeness proof
 * fails, remove the partial archive so neither direct nor lazy paths can later
 * select it as a hit.
 */
export function captureReplayCapsuleFailClosed(
  db: Database.Database,
  capture: () => ReplayCapsuleRecord,
): ReplayCapsuleRecord {
  const record = capture();
  try {
    assertReplayCapsuleComplete(db, record.sourceExecutionRef, record);
    return record;
  } catch (error) {
    db.prepare('DELETE FROM factory_replay_capsules WHERE capsule_ref=?')
      .run(record.capsuleRef);
    throw error;
  }
}
