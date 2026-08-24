import type Database from 'better-sqlite3';
import { DEFAULT_DOCUMENTATION_KINDS } from '../modules/documentation/domain/documentation-schemas.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { SqliteLifecycleContinuationRepository } from '../process-modules/persistence/sqlite-lifecycle-continuation-repository.js';

/**
 * Append-only documentation continuation.
 *
 * Retries the `documentation-release` suffix stage after a parent lifecycle
 * run terminated `documentation-blocked` (typically: the PDF render engine
 * was unavailable at first attempt and the operator installed it since).
 * The parent MUST have been started on a definition that contains the
 * documentation stage — the continuation repository slices the parent's own
 * pinned definition snapshot (ADR-038), so a parent that never had the stage
 * cannot grow one retroactively.
 */
export interface PrepareDocumentationContinuationCommand {
  orderRef: string;
  parentLifecycleRunId: number;
  documentKinds?: readonly string[];
  outputRoot?: string;
  actorId: string;
  reason: string;
}

export function prepareDocumentationContinuation(
  db: Database.Database,
  command: PrepareDocumentationContinuationCommand,
) {
  const parent = db.prepare(
    `SELECT project_id,epic_id,status,terminal_status,error
       FROM factory_lifecycle_runs WHERE id=?`,
  ).get(command.parentLifecycleRunId) as {
    project_id: number; epic_id: number | null; status: string;
    terminal_status: string | null; error: string | null;
  } | undefined;
  if (!parent || parent.epic_id === null || parent.status !== 'completed'
    || parent.terminal_status !== 'documentation-blocked') {
    throw new Error('DOCUMENTATION_PARENT_NOT_BLOCKED');
  }
  // Boundary evidence: the parent's own documentation stage input snapshot —
  // the exact accepted Development hand-off this continuation re-consumes.
  const boundary = db.prepare(
    `SELECT pr.input_snapshot FROM factory_stage_runs sr
       JOIN factory_process_runs pr ON pr.id=sr.process_run_id
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='documentation-release'
        AND sr.status='completed'
      ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
  ).get(command.parentLifecycleRunId) as { input_snapshot: string } | undefined;
  if (!boundary) throw new Error('DOCUMENTATION_BOUNDARY_NOT_EXACT');
  const previous = JSON.parse(boundary.input_snapshot) as {
    documentKinds?: readonly string[];
    outputRoot?: string;
  };
  const kinds = command.documentKinds ?? previous.documentKinds
    ?? DEFAULT_DOCUMENTATION_KINDS;
  const outputRoot = command.outputRoot ?? previous.outputRoot;
  if (!outputRoot) throw new Error('DOCUMENTATION_OUTPUT_ROOT_NOT_EXACT');

  const externalBaseline = {
    documentation: { kinds: [...kinds], outputRoot },
  };
  const continuations = new SqliteLifecycleContinuationRepository(
    db, new SqliteLifecycleRunRepository(db),
  );
  const authorization = continuations.authorize({
    orderRef: command.orderRef,
    parentLifecycleRunId: command.parentLifecycleRunId,
    resumeStageId: 'documentation-release',
    expectedParentError: parent.error ?? 'TERMINAL_OUTCOME:documentation-blocked',
    actorId: command.actorId,
    reason: command.reason,
    externalBaselineSnapshot: externalBaseline,
    stageOverrides: [{
      stageId: 'documentation-release',
      moduleRef: { name: 'documentation-release', version: '1.0.0' },
      additiveInputMapping: {
        documentKinds: '$.continuation.externalBaseline.documentation.kinds',
        outputRoot: '$.continuation.externalBaseline.documentation.outputRoot',
      },
    }],
  });
  const consumed = continuations.consume(authorization.authorizationRef);
  return {
    authorizationRef: authorization.authorizationRef,
    childLifecycleRunId: consumed.childLifecycleRunId,
    childIdempotencyKey: consumed.childIdempotencyKey,
    projectId: parent.project_id,
    epicId: parent.epic_id,
    orderRef: command.orderRef,
    documentKinds: [...kinds],
    outputRoot,
  };
}
