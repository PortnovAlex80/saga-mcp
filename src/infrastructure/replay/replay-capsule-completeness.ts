import type Database from 'better-sqlite3';
import type { ReplayCapsuleRecord } from '../../replay/replay-capsule.js';

function scalarCount(
  db: Database.Database,
  sql: string,
  executionRef: string,
): number {
  const row = db.prepare(sql).get(executionRef) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Prove that a captured capsule is a complete reconstruction recipe for the
 * generic worker production/evidence recorded by one execution.
 *
 * This validator is shared by direct post-terminal capture and lazy crash
 * reconstruction. A capsule is reusable only if both paths certify the exact
 * same completeness invariant.
 */
export function assertReplayCapsuleComplete(
  db: Database.Database,
  executionRef: string,
  record: ReplayCapsuleRecord,
): void {
  const typedCount = scalarCount(
    db,
    'SELECT COUNT(*) AS n FROM factory_managed_node_submissions WHERE execution_id=?',
    executionRef,
  );
  const artifactCount = scalarCount(
    db,
    `SELECT COUNT(DISTINCT artifact_id) AS n
       FROM factory_managed_artifact_productions WHERE execution_id=?`,
    executionRef,
  );
  const traceCount = scalarCount(
    db,
    'SELECT COUNT(*) AS n FROM factory_managed_trace_productions WHERE execution_id=?',
    executionRef,
  );

  if (record.payload.typedProducts.length !== typedCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TYPED_PRODUCTS: expected ${typedCount}, captured ${record.payload.typedProducts.length}`,
    );
  }
  if (record.payload.artifacts.length !== artifactCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_ARTIFACTS: expected ${artifactCount}, captured ${record.payload.artifacts.length}`,
    );
  }
  if (record.payload.traces.length !== traceCount) {
    throw new Error(
      `REPLAY_CAPTURE_INCOMPLETE_TRACES: expected ${traceCount}, captured ${record.payload.traces.length}`,
    );
  }

  const sourceArtifacts = db.prepare(
    `SELECT a.id,a.type,a.code,a.title,a.path,a.content_hash,a.storage_kind,
            a.parent_artifact_id
       FROM factory_managed_artifact_productions p
       JOIN artifacts a ON a.id=p.artifact_id
      WHERE p.execution_id=?
      GROUP BY a.id`,
  ).all(executionRef) as Array<{
    id: number;
    type: string;
    code: string | null;
    title: string;
    path: string;
    content_hash: string | null;
    storage_kind: string;
    parent_artifact_id: number | null;
  }>;

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
