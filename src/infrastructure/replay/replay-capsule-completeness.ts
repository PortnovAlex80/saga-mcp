import type Database from 'better-sqlite3';
import type { ReplayCapsuleRecord } from '../../replay/replay-capsule.js';
import { isWorkplaceProductionSnapshot } from '../../process-modules/shared/workplace-production-snapshot.js';

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
  const row = db.prepare(
    `SELECT payload_snapshot
       FROM factory_process_products
      WHERE schema_id=? AND artifact_ref=? AND product_hash=?
      ORDER BY id DESC LIMIT 1`,
  ).get(member.product_schema, member.product_ref, member.product_digest) as {
    payload_snapshot: string;
  } | undefined;
  if (!row) throw new Error(`REPLAY_CAPTURE_PRODUCT_NOT_FOUND: ${member.product_ref}`);
  return JSON.parse(row.payload_snapshot) as unknown;
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
  const expectedTraceIds = new Set<number>();

  for (const member of members) {
    if (member.product_ref.startsWith('managed-node-submission:')) {
      expectedTyped.set(`${member.product_schema}:${member.product_digest}`, member);
      continue;
    }
    const product = readPersistedProduct(db, member);
    if (!isWorkplaceProductionSnapshot(product)) {
      throw new Error(
        `REPLAY_CAPTURE_UNSUPPORTED_CANDIDATE_PRODUCT: ${member.product_ref}`,
      );
    }
    for (const artifact of product.artifacts) expectedArtifactIds.add(artifact.artifactId);
    for (const trace of product.traces) expectedTraceIds.add(trace.traceId);
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
  if (record.payload.traces.length !== expectedTraceIds.size) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TRACES: expected ${expectedTraceIds.size}, captured ${record.payload.traces.length}`,
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
  if (execution?.execution_mode === 'git_change' && record.payload.git === null) {
    throw new Error(
      'REPLAY_CAPTURE_GIT_RECIPE_MISSING: git_change execution has no exact Git recipe',
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
