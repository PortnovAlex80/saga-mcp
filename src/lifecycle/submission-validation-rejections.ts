import type { Database } from 'better-sqlite3';
import type {
  ContractRef,
  SubmissionGap,
} from '../process-modules/application/node-submission-policy.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';

export const SUBMISSION_VALIDATION_FEEDBACK_SCHEMA =
  'factory.submission-validation-recovery-feedback.v1' as const;

export interface PersistSubmissionValidationRejectionInput {
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly taskId: number;
  readonly actorKind: 'managed_execution' | 'admin';
  readonly workerId?: string | null;
  readonly rejectionCode: string;
  readonly gaps: readonly SubmissionGap[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly contractRef?: ContractRef;
  readonly inputSnapshotHash: string;
}

export interface PersistedSubmissionValidationRejection {
  readonly id: number;
  readonly rejectionRef: string;
  readonly rejectionDigest: string;
  readonly feedback: Readonly<Record<string, unknown>>;
  readonly replayed: boolean;
}

interface TaskFeedbackRow {
  id: number;
  assigned_to: string | null;
  current_execution_id: string | null;
  workplace_ref: string | null;
  metadata: string;
}

/**
 * Persist one exact rejected preflight while the caller's worker_done
 * transaction is still open. Task/Workplace phase and ownership are untouched;
 * only append-only evidence plus the next-execution feedback pointer are added.
 */
export function persistSubmissionValidationRejection(
  db: Database,
  input: PersistSubmissionValidationRejectionInput,
): PersistedSubmissionValidationRejection {
  const task = db.prepare(
    `SELECT id, assigned_to, current_execution_id, workplace_ref, metadata
       FROM tasks WHERE id=?`,
  ).get(input.taskId) as TaskFeedbackRow | undefined;
  if (!task) throw new Error(`SUBMISSION_REJECTION_TASK_MISSING: ${input.taskId}`);
  if (input.actorKind === 'managed_execution') {
    if (
      !input.workerId
      || task.assigned_to !== input.workerId
      || task.current_execution_id !== input.executionId
    ) {
      throw new Error(
        `SUBMISSION_REJECTION_FENCE_MISMATCH: task ${input.taskId} is not owned by `
        + `${input.workerId ?? '(missing)'}/${input.executionId}`,
      );
    }
  }

  const artifactIds = [...new Set(input.gaps
    .map(gap => gap.artifactId)
    .filter(id => Number.isSafeInteger(id) && id > 0))]
    .sort((left, right) => left - right);
  const observedArtifacts = artifactIds.length === 0
    ? []
    : db.prepare(
        `SELECT id, type, code, path, status, content_hash, accepted_hash,
                storage_kind, project_repository_id
           FROM artifacts
          WHERE id IN (${artifactIds.map(() => '?').join(',')})
          ORDER BY id`,
      ).all(...artifactIds) as Array<Record<string, unknown>>;
  const observedSetDigest = sha256Hex(observedArtifacts);
  const details = input.details ?? {};
  const rejectionBody = {
    validatorId: input.validatorId,
    validatorVersion: input.validatorVersion,
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    nodeId: input.nodeId,
    executionId: input.executionId,
    taskId: input.taskId,
    workplaceRef: task.workplace_ref,
    rejectionCode: input.rejectionCode,
    gaps: input.gaps,
    details,
    contractRef: input.contractRef ?? null,
    inputSnapshotHash: input.inputSnapshotHash,
    observedArtifacts,
    observedSetDigest,
  };
  const rejectionDigest = sha256Hex(rejectionBody);
  const rejectionRef = `submission-validation-rejection:${rejectionDigest}`;
  const issue = {
    schemaVersion: 'factory.recovery-issue.v1',
    policyId: `submission-validation:${input.validatorId}`,
    disposition: 'repair',
    reasonCode: input.rejectionCode,
    summary: `Submission preflight ${input.validatorId}@${input.validatorVersion} rejected the current node output.`,
    findings: input.gaps.map(gap => ({
      code: `${input.rejectionCode}:${gap.missing.relation}`,
      severity: 'error',
      message: gap.message
        ?? `${gap.artifactCode ?? gap.artifactId}: ${gap.missing.relation} requires ${gap.missing.requiredTargetTypes.join('|')}`,
      subjectRef: gap.artifactId > 0 ? `artifact:${gap.artifactId}` : null,
      path: gap.artifactCode,
      expected: gap.missing,
      actual: gap.existingTargets,
      evidenceRefs: [rejectionRef],
    })),
    subjectRefs: observedArtifacts.map(artifact => ({
      kind: 'artifact',
      ref: `artifact:${String(artifact.id)}`,
      schema: String(artifact.type),
      contentHash: typeof artifact.content_hash === 'string'
        ? artifact.content_hash
        : null,
    })),
    acceptanceCriteria: [
      'Repair every structured gap against the exact frozen input and pinned contract.',
      'Re-read persisted artifacts and traces, then call worker_done again.',
      'Exactly one worker_done call may be accepted; rejected preflights are non-terminal.',
    ],
    allowedChanges: ['Current node output artifacts and their declared trace links only.'],
    context: details,
  };
  const feedback = {
    schemaVersion: SUBMISSION_VALIDATION_FEEDBACK_SCHEMA,
    rejectionRef,
    rejectionDigest,
    validator: {
      id: input.validatorId,
      version: input.validatorVersion,
      contractRef: input.contractRef ?? null,
    },
    origin: {
      processRunId: input.processRunId,
      moduleRef: input.moduleRef,
      nodeId: input.nodeId,
      workplaceRef: task.workplace_ref,
      taskId: input.taskId,
      executionId: input.executionId,
      inputSnapshotHash: input.inputSnapshotHash,
    },
    observedArtifacts,
    observedSetDigest,
    issue,
    resumeStep: 'Read this file first, repair the existing node output in place, update its registered hash, and retry worker_done.',
  };

  const inserted = db.prepare(
    `INSERT OR IGNORE INTO factory_submission_validation_rejections
       (rejection_ref, rejection_digest, validator_id, validator_version,
        process_run_id, module_ref, node_id, execution_id, task_id,
        workplace_ref, actor_kind, rejection_code, gaps_json, details_json,
        contract_ref, input_snapshot_hash, observed_artifacts,
        observed_set_digest, feedback_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rejectionRef,
    rejectionDigest,
    input.validatorId,
    input.validatorVersion,
    input.processRunId,
    input.moduleRef,
    input.nodeId,
    input.executionId,
    input.taskId,
    task.workplace_ref,
    input.actorKind,
    input.rejectionCode,
    canonicalJson(input.gaps),
    canonicalJson(details),
    input.contractRef ? canonicalJson(input.contractRef) : null,
    input.inputSnapshotHash,
    canonicalJson(observedArtifacts),
    observedSetDigest,
    canonicalJson(feedback),
  );
  const persisted = db.prepare(
    `SELECT id, feedback_json
       FROM factory_submission_validation_rejections
      WHERE rejection_ref=?`,
  ).get(rejectionRef) as { id: number; feedback_json: string } | undefined;
  if (!persisted) throw new Error(`SUBMISSION_REJECTION_PERSIST_FAILED: ${rejectionRef}`);

  const metadata = parseMetadata(task.metadata);
  metadata.recovery_feedback = JSON.parse(persisted.feedback_json);
  metadata.managed_submission_last_rejection_ref = rejectionRef;
  metadata.managed_submission_last_rejection_digest = rejectionDigest;
  metadata.managed_submission_last_execution_id = input.executionId;
  db.prepare(
    `UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`,
  ).run(JSON.stringify(metadata), input.taskId);

  return {
    id: persisted.id,
    rejectionRef,
    rejectionDigest,
    feedback: JSON.parse(persisted.feedback_json) as Record<string, unknown>,
    replayed: inserted.changes === 0,
  };
}

/** Remove only this transport's resolved feedback; immutable rows remain. */
export function clearSubmissionValidationFeedback(db: Database, taskId: number): void {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId) as
    | { metadata: string }
    | undefined;
  if (!row) return;
  const metadata = parseMetadata(row.metadata);
  const feedback = metadata.recovery_feedback;
  if (
    !feedback
    || typeof feedback !== 'object'
    || Array.isArray(feedback)
    || (feedback as Record<string, unknown>).schemaVersion !== SUBMISSION_VALIDATION_FEEDBACK_SCHEMA
  ) return;
  delete metadata.recovery_feedback;
  delete metadata.managed_submission_last_rejection_ref;
  delete metadata.managed_submission_last_rejection_digest;
  delete metadata.managed_submission_last_execution_id;
  db.prepare(`UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(metadata), taskId);
}

export function readLatestSubmissionRejectionForExecution(
  db: Database,
  executionId: string,
): { rejectionRef: string; rejectionCode: string } | null {
  let row: { rejection_ref: string; rejection_code: string } | undefined;
  try {
    row = db.prepare(
      `SELECT rejection_ref, rejection_code
         FROM factory_submission_validation_rejections
        WHERE execution_id=? ORDER BY id DESC LIMIT 1`,
    ).get(executionId) as typeof row;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return null;
    throw error;
  }
  return row
    ? { rejectionRef: row.rejection_ref, rejectionCode: row.rejection_code }
    : null;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
