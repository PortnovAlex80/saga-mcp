import type Database from 'better-sqlite3';
import {
  EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
  LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
  ExactCandidateAcceptanceRejected,
  type AcceptExactCandidatesCommand,
  type ExactArtifactCandidate,
  type ExactCandidateAcceptance,
  type ExactCandidateAcceptanceDecision,
  type ExactCandidateAcceptanceItem,
  type ExactCandidateAcceptanceItemDisposition,
  type ExactCandidateProductionLineage,
} from '../application/exact-candidate-acceptance.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

interface NormalizedAcceptanceRequest {
  readonly schemaVersion: typeof EXACT_CANDIDATE_ACCEPTANCE_SCHEMA;
  readonly idempotencyKey: string;
  readonly lineage: ExactCandidateProductionLineage;
  readonly candidates: readonly ExactArtifactCandidate[];
  readonly requireApprovedReview: boolean;
  readonly authority: string;
  readonly reasonCode: string;
  readonly context: Readonly<Record<string, unknown>>;
}

interface ProcessRunIdentityRow {
  id: number;
  project_id: number;
  epic_id: number | null;
  module_ref_key: string;
}

interface TaskIdentityRow {
  id: number;
  epic_id: number;
  status: string;
}

interface WorkerExecutionIdentityRow {
  execution_id: string;
  project_id: number;
  epic_id: number;
  task_id: number;
}

interface ArtifactRow {
  id: number;
  project_id: number;
  epic_id: number;
  type: string;
  status: string;
  content_hash: string | null;
  accepted_hash: string | null;
  drift_state: string;
}

interface ManagedArtifactProductionRow {
  id: number;
  artifact_type: string;
  artifact_status: string;
  content_hash: string | null;
}

interface ApprovedReviewReceiptRow {
  command_id: string;
  execution_id: string | null;
  result_json: string | null;
  accepted_at: string;
}

interface ExactReviewEvidence {
  producer: ApprovedReviewReceiptRow;
  reviewer: ApprovedReviewReceiptRow;
}

interface AcceptanceDecisionRow {
  id: number;
  schema_version: string;
  idempotency_key: string;
  request_hash: string;
  request_snapshot: string;
  candidate_set_hash: string;
  process_run_id: number;
  module_ref: string;
  node_id: string;
  intent_id: number;
  task_id: number;
  execution_id: string;
  project_id: number;
  epic_id: number;
  review_required: 0 | 1;
  producer_receipt_command_id: string | null;
  producer_receipt_hash: string | null;
  review_receipt_command_id: string | null;
  review_receipt_hash: string | null;
  authority: string;
  reason_code: string;
  decision_hash: string;
  decided_at: string;
}

interface AcceptanceItemRow {
  ordinal: number;
  artifact_id: number;
  artifact_type: string;
  expected_content_hash: string;
  ledger_id: number;
  disposition: ExactCandidateAcceptanceItemDisposition;
  prior_status: string;
  prior_accepted_hash: string | null;
  prior_drift_state: string;
  final_status: 'accepted';
  final_accepted_hash: string;
  final_drift_state: 'clean';
}

interface PreparedCandidate {
  readonly candidate: ExactArtifactCandidate;
  readonly artifact: ArtifactRow;
  readonly ledger: ManagedArtifactProductionRow;
  readonly disposition: ExactCandidateAcceptanceItemDisposition;
}

export function ensureExactCandidateAcceptanceSchema(
  db: Database.Database,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_exact_candidate_acceptance_decisions (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version             TEXT NOT NULL,
      idempotency_key            TEXT NOT NULL UNIQUE,
      request_hash               TEXT NOT NULL,
      request_snapshot           TEXT NOT NULL,
      candidate_set_hash         TEXT NOT NULL,
      process_run_id             INTEGER NOT NULL,
      module_ref                 TEXT NOT NULL,
      node_id                    TEXT NOT NULL,
      intent_id                  INTEGER NOT NULL,
      task_id                    INTEGER NOT NULL,
      execution_id               TEXT NOT NULL,
      project_id                 INTEGER NOT NULL,
      epic_id                    INTEGER NOT NULL,
      review_required            INTEGER NOT NULL CHECK (review_required IN (0,1)),
      producer_receipt_command_id TEXT,
      producer_receipt_hash       TEXT,
      review_receipt_command_id  TEXT,
      review_receipt_hash        TEXT,
      authority                  TEXT NOT NULL,
      reason_code                TEXT NOT NULL,
      decision_hash              TEXT NOT NULL,
      decided_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_exact_acceptance_decision_hash
      ON saga3_exact_candidate_acceptance_decisions(decision_hash);

    CREATE INDEX IF NOT EXISTS idx_saga3_exact_acceptance_lineage
      ON saga3_exact_candidate_acceptance_decisions(
        process_run_id, module_ref, node_id, task_id, execution_id
      );

    CREATE TABLE IF NOT EXISTS saga3_exact_candidate_acceptance_items (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id            INTEGER NOT NULL,
      ordinal                INTEGER NOT NULL,
      artifact_id            INTEGER NOT NULL,
      artifact_type          TEXT NOT NULL,
      expected_content_hash  TEXT NOT NULL,
      ledger_id              INTEGER NOT NULL,
      disposition            TEXT NOT NULL
                               CHECK (disposition IN ('accepted','reaccepted','already-accepted')),
      prior_status           TEXT NOT NULL,
      prior_accepted_hash    TEXT,
      prior_drift_state      TEXT NOT NULL,
      final_status           TEXT NOT NULL CHECK (final_status='accepted'),
      final_accepted_hash    TEXT NOT NULL,
      final_drift_state      TEXT NOT NULL CHECK (final_drift_state='clean'),
      UNIQUE (decision_id, ordinal),
      UNIQUE (decision_id, artifact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_exact_acceptance_item_artifact
      ON saga3_exact_candidate_acceptance_items(artifact_id, decision_id);

    -- Acceptance records are decision receipts, not mutable projections.
    CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_decision_no_update
      BEFORE UPDATE ON saga3_exact_candidate_acceptance_decisions
      BEGIN
        SELECT RAISE(ABORT, 'saga3 exact acceptance decisions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_decision_no_delete
      BEFORE DELETE ON saga3_exact_candidate_acceptance_decisions
      BEGIN
        SELECT RAISE(ABORT, 'saga3 exact acceptance decisions are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_item_no_update
      BEFORE UPDATE ON saga3_exact_candidate_acceptance_items
      BEGIN
        SELECT RAISE(ABORT, 'saga3 exact acceptance items are immutable');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_item_no_delete
      BEFORE DELETE ON saga3_exact_candidate_acceptance_items
      BEGIN
        SELECT RAISE(ABORT, 'saga3 exact acceptance items are immutable');
      END;
  `);
  const decisionColumns = db.prepare(
    'PRAGMA table_info(saga3_exact_candidate_acceptance_decisions)',
  ).all() as { name: string }[];
  if (!decisionColumns.some(column => column.name === 'review_receipt_hash')) {
    db.exec(
      'ALTER TABLE saga3_exact_candidate_acceptance_decisions '
      + 'ADD COLUMN review_receipt_hash TEXT',
    );
  }
  if (!decisionColumns.some(column => column.name === 'producer_receipt_command_id')) {
    db.exec(
      'ALTER TABLE saga3_exact_candidate_acceptance_decisions '
      + 'ADD COLUMN producer_receipt_command_id TEXT',
    );
  }
  if (!decisionColumns.some(column => column.name === 'producer_receipt_hash')) {
    db.exec(
      'ALTER TABLE saga3_exact_candidate_acceptance_decisions '
      + 'ADD COLUMN producer_receipt_hash TEXT',
    );
  }
}

export class SqliteExactCandidateAcceptance
implements ExactCandidateAcceptance {
  constructor(private readonly db: Database.Database) {
    ensureExactCandidateAcceptanceSchema(db);
  }

  accept(
    command: AcceptExactCandidatesCommand,
  ): ExactCandidateAcceptanceDecision {
    const request = normalizeRequest(command);
    const requestSnapshot = canonicalJson(request);
    const requestHash = sha256Hex(request);

    return this.withImmediateTransaction(() => {
      const prior = this.readDecisionRow(request.idempotencyKey);
      if (prior) {
        const matchesCurrent = prior.request_hash === requestHash
          && prior.request_snapshot === requestSnapshot;
        const legacyRequest = {
          ...request,
          schemaVersion: LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
        };
        const legacyRequestSnapshot = canonicalJson(legacyRequest);
        const matchesLegacy =
          prior.schema_version === LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA
          && prior.request_hash === sha256Hex(legacyRequest)
          && prior.request_snapshot === legacyRequestSnapshot;
        if (!matchesCurrent && !matchesLegacy) {
          reject(
            'EXACT_ACCEPTANCE_IDEMPOTENCY_KEY_REUSED',
            `idempotency key '${request.idempotencyKey}' was used for another request`,
            {
              idempotencyKey: request.idempotencyKey,
              storedRequestHash: prior.request_hash,
              submittedRequestHash: requestHash,
            },
          );
        }
        const replay = this.hydrateDecision(prior, true);
        this.assertLineage(replay.lineage);
        this.assertReviewReceiptStillExact(replay);
        this.assertAcceptedDecisionStillExact(replay);
        return replay;
      }

      this.assertLineage(request.lineage);
      const prepared = request.candidates.map(candidate =>
        this.prepareCandidate(request.lineage, candidate));
      const reviewEvidence = request.requireApprovedReview
        ? this.requireApprovedReview(request.lineage)
        : null;
      const producerReceiptHash = reviewEvidence
        ? hashReviewReceipt(reviewEvidence.producer)
        : null;
      const reviewReceiptHash = reviewEvidence
        ? hashReviewReceipt(reviewEvidence.reviewer)
        : null;

      for (const item of prepared) {
        if (item.disposition === 'already-accepted') continue;
        this.compareAndSetAccepted(item);
      }

      const items = prepared.map((item, ordinal) =>
        toDecisionItem(item, ordinal));
      const candidateSetHash = sha256Hex(request.candidates);
      const decisionHash = computeDecisionHash({
        idempotencyKey: request.idempotencyKey,
        requestHash,
        candidateSetHash,
        producerReceiptCommandId:
          reviewEvidence?.producer.command_id ?? null,
        producerReceiptHash,
        reviewReceiptCommandId:
          reviewEvidence?.reviewer.command_id ?? null,
        reviewReceiptHash,
        items,
      });

      const inserted = this.db.prepare(
        `INSERT INTO saga3_exact_candidate_acceptance_decisions
           (schema_version, idempotency_key, request_hash, request_snapshot,
            candidate_set_hash, process_run_id, module_ref, node_id, intent_id,
            task_id, execution_id, project_id, epic_id, review_required,
            producer_receipt_command_id, producer_receipt_hash,
            review_receipt_command_id, review_receipt_hash, authority,
            reason_code, decision_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
        request.idempotencyKey,
        requestHash,
        requestSnapshot,
        candidateSetHash,
        request.lineage.processRunId,
        request.lineage.moduleRef,
        request.lineage.nodeId,
        request.lineage.intentId,
        request.lineage.taskId,
        request.lineage.executionId,
        request.lineage.projectId,
        request.lineage.epicId,
        request.requireApprovedReview ? 1 : 0,
        reviewEvidence?.producer.command_id ?? null,
        producerReceiptHash,
        reviewEvidence?.reviewer.command_id ?? null,
        reviewReceiptHash,
        request.authority,
        request.reasonCode,
        decisionHash,
      );
      const decisionId = Number(inserted.lastInsertRowid);

      const insertItem = this.db.prepare(
        `INSERT INTO saga3_exact_candidate_acceptance_items
           (decision_id, ordinal, artifact_id, artifact_type,
            expected_content_hash, ledger_id, disposition, prior_status,
            prior_accepted_hash, prior_drift_state, final_status,
            final_accepted_hash, final_drift_state)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const [ordinal, item] of items.entries()) {
        insertItem.run(
          decisionId,
          ordinal,
          item.artifactId,
          item.artifactType,
          item.contentHash,
          item.ledgerId,
          item.disposition,
          item.priorStatus,
          item.priorAcceptedHash,
          item.priorDriftState,
          item.finalStatus,
          item.finalAcceptedHash,
          item.finalDriftState,
        );
      }

      const stored = this.readDecisionRow(request.idempotencyKey);
      if (!stored) {
        reject(
          'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
          'inserted decision could not be read back',
          { decisionId, idempotencyKey: request.idempotencyKey },
        );
      }
      return this.hydrateDecision(stored, false);
    });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
  ): ExactCandidateAcceptanceDecision | null {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      reject(
        'EXACT_ACCEPTANCE_INVALID_COMMAND',
        'idempotencyKey must be a non-empty string',
      );
    }
    const row = this.readDecisionRow(idempotencyKey.trim());
    return row ? this.hydrateDecision(row, true) : null;
  }

  isAcceptedExact(
    submittedLineage: ExactCandidateProductionLineage,
    submittedCandidate: ExactArtifactCandidate,
  ): boolean {
    const lineage = normalizeLineage(submittedLineage);
    const artifactId = requirePositiveInteger(
      submittedCandidate?.artifactId,
      'candidate.artifactId',
    );
    const artifactType = requireNonEmpty(
      submittedCandidate?.artifactType,
      'candidate.artifactType',
    );
    const contentHash = requireHash(
      submittedCandidate?.contentHash,
      'candidate.contentHash',
    );
    const row = this.db.prepare(
      `SELECT d.idempotency_key
         FROM saga3_exact_candidate_acceptance_decisions d
         JOIN saga3_exact_candidate_acceptance_items i
           ON i.decision_id=d.id
         JOIN saga3_process_runs pr
           ON pr.id=d.process_run_id
          AND pr.project_id=d.project_id
          AND pr.epic_id=d.epic_id
          AND pr.module_ref_key=d.module_ref
         JOIN saga3_managed_artifact_productions mp
           ON mp.id=i.ledger_id
          AND mp.process_run_id=d.process_run_id
          AND mp.module_ref=d.module_ref
          AND mp.node_id=d.node_id
          AND mp.task_id=d.task_id
          AND mp.artifact_id=i.artifact_id
          AND mp.artifact_type=i.artifact_type
          AND mp.content_hash=i.expected_content_hash
         JOIN artifacts a
           ON a.id=i.artifact_id
        WHERE d.process_run_id=?
          AND d.module_ref=?
          AND d.node_id=?
          AND d.intent_id=?
          AND d.task_id=?
          AND d.execution_id=?
          AND d.project_id=?
          AND d.epic_id=?
          AND i.artifact_id=?
          AND i.artifact_type=?
          AND i.expected_content_hash=?
          AND a.status='accepted'
          AND a.content_hash=?
          AND a.accepted_hash=?
          AND a.drift_state='clean'
        LIMIT 1`,
    ).get(
      lineage.processRunId,
      lineage.moduleRef,
      lineage.nodeId,
      lineage.intentId,
      lineage.taskId,
      lineage.executionId,
      lineage.projectId,
      lineage.epicId,
      artifactId,
      artifactType,
      contentHash,
      contentHash,
      contentHash,
    ) as { idempotency_key: string } | undefined;
    if (!row) return false;

    // A status/hash match alone is not proof. Re-hydrate the immutable
    // decision, verify its exact review evidence and check the whole accepted
    // set so legacy or partially-corrupted receipts cannot authorize replay.
    const decisionRow = this.readDecisionRow(row.idempotency_key);
    if (!decisionRow) return false;
    const decision = this.hydrateDecision(decisionRow, true);
    this.assertLineage(decision.lineage);
    this.assertReviewReceiptStillExact(decision);
    this.assertAcceptedDecisionStillExact(decision);
    return true;
  }

  private assertLineage(lineage: ExactCandidateProductionLineage): void {
    const run = this.db.prepare(
      `SELECT id, project_id, epic_id, module_ref_key
         FROM saga3_process_runs
        WHERE id=?`,
    ).get(lineage.processRunId) as ProcessRunIdentityRow | undefined;
    if (!run) {
      reject(
        'EXACT_ACCEPTANCE_PROCESS_RUN_NOT_FOUND',
        `ProcessRun ${lineage.processRunId} was not found`,
        { processRunId: lineage.processRunId },
      );
    }
    if (run.project_id !== lineage.projectId
      || run.epic_id !== lineage.epicId
      || run.module_ref_key !== lineage.moduleRef) {
      reject(
        'EXACT_ACCEPTANCE_LINEAGE_MISMATCH',
        'ProcessRun scope/module does not match submitted lineage',
        {
          processRunId: lineage.processRunId,
          expectedProjectId: run.project_id,
          submittedProjectId: lineage.projectId,
          expectedEpicId: run.epic_id,
          submittedEpicId: lineage.epicId,
          expectedModuleRef: run.module_ref_key,
          submittedModuleRef: lineage.moduleRef,
        },
      );
    }

    const task = this.db.prepare(
      'SELECT id, epic_id, status FROM tasks WHERE id=?',
    ).get(lineage.taskId) as TaskIdentityRow | undefined;
    if (!task || task.epic_id !== lineage.epicId) {
      reject(
        'EXACT_ACCEPTANCE_LINEAGE_MISMATCH',
        `task ${lineage.taskId} does not belong to epic ${lineage.epicId}`,
        {
          taskId: lineage.taskId,
          taskEpicId: task?.epic_id ?? null,
          lineageEpicId: lineage.epicId,
        },
      );
    }

    const execution = this.db.prepare(
      `SELECT execution_id, project_id, epic_id, task_id
         FROM worker_executions
        WHERE execution_id=?`,
    ).get(lineage.executionId) as WorkerExecutionIdentityRow | undefined;
    if (!execution
      || execution.project_id !== lineage.projectId
      || execution.epic_id !== lineage.epicId
      || execution.task_id !== lineage.taskId) {
      reject(
        'EXACT_ACCEPTANCE_LINEAGE_MISMATCH',
        `execution '${lineage.executionId}' does not match process scope/task`,
        {
          executionId: lineage.executionId,
          executionProjectId: execution?.project_id ?? null,
          executionEpicId: execution?.epic_id ?? null,
          executionTaskId: execution?.task_id ?? null,
          lineageProjectId: lineage.projectId,
          lineageEpicId: lineage.epicId,
          lineageTaskId: lineage.taskId,
        },
      );
    }
  }

  private prepareCandidate(
    lineage: ExactCandidateProductionLineage,
    candidate: ExactArtifactCandidate,
  ): PreparedCandidate {
    const artifact = this.db.prepare(
      `SELECT id, project_id, epic_id, type, status, content_hash,
              accepted_hash, drift_state
         FROM artifacts
        WHERE id=?`,
    ).get(candidate.artifactId) as ArtifactRow | undefined;
    if (!artifact) {
      reject(
        'EXACT_ACCEPTANCE_ARTIFACT_NOT_FOUND',
        `artifact ${candidate.artifactId} was not found`,
        { artifactId: candidate.artifactId },
      );
    }
    if (artifact.project_id !== lineage.projectId
      || artifact.epic_id !== lineage.epicId) {
      reject(
        'EXACT_ACCEPTANCE_ARTIFACT_SCOPE_DRIFT',
        `artifact ${candidate.artifactId} is outside the ProcessRun scope`,
        {
          artifactId: candidate.artifactId,
          artifactProjectId: artifact.project_id,
          artifactEpicId: artifact.epic_id,
          lineageProjectId: lineage.projectId,
          lineageEpicId: lineage.epicId,
        },
      );
    }
    if (artifact.type !== candidate.artifactType) {
      reject(
        'EXACT_ACCEPTANCE_ARTIFACT_TYPE_DRIFT',
        `artifact ${candidate.artifactId} type changed`,
        {
          artifactId: candidate.artifactId,
          expectedType: candidate.artifactType,
          actualType: artifact.type,
        },
      );
    }
    if (artifact.content_hash !== candidate.contentHash) {
      reject(
        'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
        `artifact ${candidate.artifactId} content hash changed`,
        {
          artifactId: candidate.artifactId,
          expectedContentHash: candidate.contentHash,
          actualContentHash: artifact.content_hash,
        },
      );
    }

    // The reviewed task is the product aggregate. An earlier execution of the
    // same task may have written the exact version, but another recovery task
    // must never be adopted implicitly.
    let ledger = this.db.prepare(
      `SELECT id, artifact_type, artifact_status, content_hash
         FROM saga3_managed_artifact_productions
        WHERE process_run_id=? AND module_ref=? AND node_id=?
          AND task_id=? AND artifact_id=?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(
      lineage.processRunId,
      lineage.moduleRef,
      lineage.nodeId,
      lineage.taskId,
      candidate.artifactId,
    ) as ManagedArtifactProductionRow | undefined;
    // Recovery fallback: if no ledger record exists for the current execution
    // (repair worker reused accepted artifacts from a prior run without calling
    // artifact_create again), check epic-wide for the same artifact+hash. If
    // found, the artifact IS canonical — just produced by a different execution
    // of the same epic. This unblocks the deadlock where the worker correctly
    // skips duplicating accepted work but the gate demanded a per-execution
    // receipt.
    //
    // Boundary (REG-12-AC-02/03, exact-candidate-acceptance test "acceptance
    // never adopts a candidate written by another recovery task"): the fallback
    // may ONLY adopt an artifact produced by the SAME task lineage (same task_id)
    // under a different process run. A different recovery task (task_id mismatch)
    // must NEVER be adopted implicitly — that would let one task claim another
    // task's work. The task_id filter below enforces this.
    if (!ledger) {
      ledger = this.db.prepare(
        `SELECT map.id, map.artifact_type, map.artifact_status, map.content_hash
           FROM saga3_managed_artifact_productions map
           JOIN saga3_process_runs pr ON pr.id = map.process_run_id
          WHERE pr.project_id=? AND pr.epic_id=? AND map.module_ref=? AND map.node_id=?
            AND map.task_id=? AND map.artifact_id=?
          ORDER BY map.recorded_at DESC
          LIMIT 1`,
      ).get(
        lineage.projectId,
        lineage.epicId,
        lineage.moduleRef,
        lineage.nodeId,
        lineage.taskId,
        candidate.artifactId,
      ) as ManagedArtifactProductionRow | undefined;
    }
    if (!ledger
      || ledger.artifact_type !== candidate.artifactType
      || ledger.content_hash !== candidate.contentHash) {
      reject(
        'EXACT_ACCEPTANCE_CANDIDATE_NOT_PRODUCED',
        `artifact ${candidate.artifactId} exact version was not the final product of the submitted execution`,
        {
          artifactId: candidate.artifactId,
          expectedType: candidate.artifactType,
          expectedContentHash: candidate.contentHash,
          ledgerId: ledger?.id ?? null,
          ledgerType: ledger?.artifact_type ?? null,
          ledgerContentHash: ledger?.content_hash ?? null,
        },
      );
    }

    const expectedDriftState = artifact.accepted_hash === null
      ? 'unknown'
      : artifact.accepted_hash === artifact.content_hash
        ? 'clean'
        : 'drifted';
    if (!['draft', 'in_review', 'accepted'].includes(artifact.status)
      || artifact.drift_state !== expectedDriftState) {
      reject(
        'EXACT_ACCEPTANCE_ARTIFACT_STATE_INVALID',
        `artifact ${candidate.artifactId} has an inconsistent/non-accepting state`,
        {
          artifactId: candidate.artifactId,
          status: artifact.status,
          acceptedHash: artifact.accepted_hash,
          contentHash: artifact.content_hash,
          driftState: artifact.drift_state,
          expectedDriftState,
        },
      );
    }

    const alreadyAccepted = artifact.status === 'accepted'
      && artifact.accepted_hash === candidate.contentHash
      && artifact.drift_state === 'clean';
    if (alreadyAccepted) {
      reject(
        'EXACT_ACCEPTANCE_PREEXISTING_ACCEPTANCE_UNATTESTED',
        `artifact ${candidate.artifactId} was already accepted without this exact gate decision`,
        {
          artifactId: candidate.artifactId,
          contentHash: candidate.contentHash,
        },
      );
    }
    const disposition: ExactCandidateAcceptanceItemDisposition = alreadyAccepted
      ? 'already-accepted'
      : artifact.accepted_hash === null
        ? 'accepted'
        : 'reaccepted';
    return { candidate, artifact, ledger, disposition };
  }

  private requireApprovedReview(
    lineage: ExactCandidateProductionLineage,
  ): ExactReviewEvidence {
    const taskId = lineage.taskId;
    const task = this.db.prepare(
      'SELECT id, epic_id, status FROM tasks WHERE id=?',
    ).get(taskId) as TaskIdentityRow | undefined;
    if (!task || (task.status !== 'done')) {
      reject(
        'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
        `task ${taskId} is not in a verified terminal state (expected done or removed-legacy-status)`,
        { taskId, taskStatus: task?.status ?? null },
      );
    }

    const receipts = this.db.prepare(
      `SELECT command_id, execution_id, result_json, accepted_at
         FROM command_receipts
        WHERE task_id=? AND command_kind='worker_done' AND accepted=1
        ORDER BY accepted_at DESC, rowid DESC`,
    ).all(taskId) as ApprovedReviewReceiptRow[];
    // Only the latest accepted terminal command is authoritative. Falling
    // back to an older approval after a newer changes_requested verdict would
    // silently accept a superseded review decision.
    const finalReceipt = receipts[0];
    // A reviewer's worker_done(approved) sends the task to 'removed-legacy-status'
    // (not 'done'). 'done' is only set by promoteTaskToDone AFTER the kernel gate
    // accepts — a chicken-and-egg. Accept 'removed-legacy-status' as a valid
    // terminal review receipt (consistent with line 721 which already accepts
    // removed-legacy-status as a verified terminal state).
    if (
      !finalReceipt
      || !(isWorkerDoneReceipt(finalReceipt, taskId, 'done')
           )
      || finalReceipt.execution_id === null
      || finalReceipt.execution_id === lineage.executionId
    ) {
      reject(
        'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
        `task ${taskId} has no final approval from a separate reviewer execution`,
        {
          taskId,
          producerExecutionId: lineage.executionId,
          latestReceiptCommandId: finalReceipt?.command_id ?? null,
          latestReceiptExecutionId: finalReceipt?.execution_id ?? null,
        },
      );
    }
    const reviewerExecution = this.db.prepare(
      `SELECT execution_id, project_id, epic_id, task_id
         FROM worker_executions
        WHERE execution_id=?`,
    ).get(finalReceipt.execution_id) as WorkerExecutionIdentityRow | undefined;
    if (
      !reviewerExecution
      || reviewerExecution.task_id !== taskId
      || reviewerExecution.project_id !== lineage.projectId
      || reviewerExecution.epic_id !== lineage.epicId
    ) {
      reject(
        'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
        `task ${taskId} final review receipt has no matching reviewer execution`,
        {
          taskId,
          reviewerExecutionId: finalReceipt.execution_id,
        },
      );
    }

    const producerReceipt = receipts.find(receipt =>
      receipt.execution_id === lineage.executionId
      && isWorkerDoneReceipt(receipt, taskId, 'review'));
    if (!producerReceipt) {
      reject(
        'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
        `task ${taskId} has no producer completion receipt for execution '${lineage.executionId}'`,
        {
          taskId,
          producerExecutionId: lineage.executionId,
        },
      );
    }
    return {
      producer: producerReceipt,
      reviewer: finalReceipt,
    };
  }

  private compareAndSetAccepted(item: PreparedCandidate): void {
    const changed = this.db.prepare(
      `UPDATE artifacts
          SET status='accepted',
              accepted_hash=?,
              drift_state='clean',
              updated_at=datetime('now')
        WHERE id=?
          AND project_id=?
          AND epic_id=?
          AND type=?
          AND status=?
          AND content_hash=?
          AND accepted_hash IS ?
          AND drift_state=?`,
    ).run(
      item.candidate.contentHash,
      item.artifact.id,
      item.artifact.project_id,
      item.artifact.epic_id,
      item.artifact.type,
      item.artifact.status,
      item.artifact.content_hash,
      item.artifact.accepted_hash,
      item.artifact.drift_state,
    );
    if (changed.changes !== 1) {
      reject(
        'EXACT_ACCEPTANCE_CAS_FAILED',
        `artifact ${item.candidate.artifactId} changed before acceptance`,
        {
          artifactId: item.candidate.artifactId,
          expectedContentHash: item.candidate.contentHash,
        },
      );
    }
  }

  private assertAcceptedDecisionStillExact(
    decision: ExactCandidateAcceptanceDecision,
  ): void {
    for (const item of decision.items) {
      const artifact = this.db.prepare(
        `SELECT id, project_id, epic_id, type, status, content_hash,
                accepted_hash, drift_state
           FROM artifacts
          WHERE id=?`,
      ).get(item.artifactId) as ArtifactRow | undefined;
      if (!artifact) {
        reject(
          'EXACT_ACCEPTANCE_ARTIFACT_NOT_FOUND',
          `accepted artifact ${item.artifactId} no longer exists`,
          { decisionId: decision.decisionId, artifactId: item.artifactId },
        );
      }
      if (artifact.project_id !== decision.lineage.projectId
        || artifact.epic_id !== decision.lineage.epicId) {
        reject(
          'EXACT_ACCEPTANCE_ARTIFACT_SCOPE_DRIFT',
          `accepted artifact ${item.artifactId} scope changed after decision`,
          { decisionId: decision.decisionId, artifactId: item.artifactId },
        );
      }
      if (artifact.type !== item.artifactType) {
        reject(
          'EXACT_ACCEPTANCE_ARTIFACT_TYPE_DRIFT',
          `accepted artifact ${item.artifactId} type changed after decision`,
          {
            decisionId: decision.decisionId,
            artifactId: item.artifactId,
            expectedType: item.artifactType,
            actualType: artifact.type,
          },
        );
      }
      if (artifact.content_hash !== item.contentHash
        || artifact.accepted_hash !== item.contentHash
        || artifact.status !== 'accepted'
        || artifact.drift_state !== 'clean') {
        reject(
          'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
          `accepted artifact ${item.artifactId} drifted after decision`,
          {
            decisionId: decision.decisionId,
            artifactId: item.artifactId,
            expectedContentHash: item.contentHash,
            actualContentHash: artifact.content_hash,
            actualAcceptedHash: artifact.accepted_hash,
            actualStatus: artifact.status,
            actualDriftState: artifact.drift_state,
          },
        );
      }
    }
  }

  private assertReviewReceiptStillExact(
    decision: ExactCandidateAcceptanceDecision,
  ): void {
    if (!decision.requireApprovedReview) return;
    if (!decision.approvedReviewReceiptCommandId) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${decision.decisionId} has no exact review receipt evidence`,
        { decisionId: decision.decisionId },
      );
    }
    const reviewReceipt = this.db.prepare(
      `SELECT command_id, execution_id, result_json, accepted_at
         FROM command_receipts
        WHERE command_id=? AND accepted=1`,
    ).get(
      decision.approvedReviewReceiptCommandId,
    ) as ApprovedReviewReceiptRow | undefined;
    const reviewHashMatches = reviewReceipt
      && (
        decision.schemaVersion === LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA
        && decision.approvedReviewReceiptHash === null
        || decision.approvedReviewReceiptHash !== null
        && hashReviewReceipt(reviewReceipt) === decision.approvedReviewReceiptHash
      );
    if (
      !reviewReceipt
      || !reviewHashMatches
      || !isWorkerDoneReceipt(reviewReceipt, decision.lineage.taskId, 'done')
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${decision.decisionId} review receipt evidence changed`,
        {
          decisionId: decision.decisionId,
          reviewReceiptCommandId: decision.approvedReviewReceiptCommandId,
        },
      );
    }
    if (decision.schemaVersion === LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA) {
      return;
    }
    if (
      !decision.producerCompletionReceiptCommandId
      || !decision.producerCompletionReceiptHash
      || reviewReceipt.execution_id === null
      || reviewReceipt.execution_id === decision.lineage.executionId
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${decision.decisionId} has no separate exact producer/reviewer chain`,
        { decisionId: decision.decisionId },
      );
    }
    const reviewerExecution = this.db.prepare(
      `SELECT execution_id, project_id, epic_id, task_id
         FROM worker_executions
        WHERE execution_id=?`,
    ).get(reviewReceipt.execution_id) as
      WorkerExecutionIdentityRow | undefined;
    if (
      !reviewerExecution
      || reviewerExecution.task_id !== decision.lineage.taskId
      || reviewerExecution.project_id !== decision.lineage.projectId
      || reviewerExecution.epic_id !== decision.lineage.epicId
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${decision.decisionId} reviewer execution lineage changed`,
        {
          decisionId: decision.decisionId,
          reviewerExecutionId: reviewReceipt.execution_id,
        },
      );
    }
    const producerReceipt = this.db.prepare(
      `SELECT command_id, execution_id, result_json, accepted_at
         FROM command_receipts
        WHERE command_id=? AND accepted=1`,
    ).get(
      decision.producerCompletionReceiptCommandId,
    ) as ApprovedReviewReceiptRow | undefined;
    if (
      !producerReceipt
      || producerReceipt.execution_id !== decision.lineage.executionId
      || !isWorkerDoneReceipt(
        producerReceipt,
        decision.lineage.taskId,
        'review',
      )
      || hashReviewReceipt(producerReceipt)
        !== decision.producerCompletionReceiptHash
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${decision.decisionId} producer completion evidence changed`,
        {
          decisionId: decision.decisionId,
          producerReceiptCommandId:
            decision.producerCompletionReceiptCommandId,
        },
      );
    }
  }

  private readDecisionRow(
    idempotencyKey: string,
  ): AcceptanceDecisionRow | undefined {
    return this.db.prepare(
      `SELECT *
         FROM saga3_exact_candidate_acceptance_decisions
        WHERE idempotency_key=?`,
    ).get(idempotencyKey) as AcceptanceDecisionRow | undefined;
  }

  private hydrateDecision(
    row: AcceptanceDecisionRow,
    replayed: boolean,
  ): ExactCandidateAcceptanceDecision {
    if (
      row.schema_version !== EXACT_CANDIDATE_ACCEPTANCE_SCHEMA
      && row.schema_version !== LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} has unsupported schema '${row.schema_version}'`,
        { decisionId: row.id, schemaVersion: row.schema_version },
      );
    }
    let requestSnapshot: unknown;
    try {
      requestSnapshot = JSON.parse(row.request_snapshot);
    } catch {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} request snapshot is not valid JSON`,
        { decisionId: row.id },
      );
    }
    if (
      canonicalJson(requestSnapshot) !== row.request_snapshot
      || sha256Hex(requestSnapshot) !== row.request_hash
    ) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} request snapshot/hash mismatch`,
        { decisionId: row.id, storedRequestHash: row.request_hash },
      );
    }
    const itemRows = this.db.prepare(
      `SELECT ordinal, artifact_id, artifact_type, expected_content_hash,
              ledger_id, disposition, prior_status, prior_accepted_hash,
              prior_drift_state, final_status, final_accepted_hash,
              final_drift_state
         FROM saga3_exact_candidate_acceptance_items
        WHERE decision_id=?
        ORDER BY ordinal`,
    ).all(row.id) as AcceptanceItemRow[];
    const items: ExactCandidateAcceptanceItem[] = itemRows.map(item => ({
      artifactId: item.artifact_id,
      artifactType: item.artifact_type,
      contentHash: item.expected_content_hash,
      ledgerId: item.ledger_id,
      disposition: item.disposition,
      priorStatus: item.prior_status,
      priorAcceptedHash: item.prior_accepted_hash,
      priorDriftState: item.prior_drift_state,
      finalStatus: item.final_status,
      finalAcceptedHash: item.final_accepted_hash,
      finalDriftState: item.final_drift_state,
    }));
    if (items.length === 0) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} has no item rows`,
        { decisionId: row.id },
      );
    }
    const expectedCandidateSetHash = sha256Hex(items.map(item => ({
      artifactId: item.artifactId,
      artifactType: item.artifactType,
      contentHash: item.contentHash,
    })));
    if (row.candidate_set_hash !== expectedCandidateSetHash) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} candidate set hash does not match its items`,
        {
          decisionId: row.id,
          storedCandidateSetHash: row.candidate_set_hash,
          computedCandidateSetHash: expectedCandidateSetHash,
        },
      );
    }
    const expectedDecisionHashes =
      row.schema_version === EXACT_CANDIDATE_ACCEPTANCE_SCHEMA
        ? [computeDecisionHash({
            idempotencyKey: row.idempotency_key,
            requestHash: row.request_hash,
            candidateSetHash: row.candidate_set_hash,
            producerReceiptCommandId: row.producer_receipt_command_id,
            producerReceiptHash: row.producer_receipt_hash,
            reviewReceiptCommandId: row.review_receipt_command_id,
            reviewReceiptHash: row.review_receipt_hash,
            items,
          })]
        : [
            computeLegacyDecisionHash({
              idempotencyKey: row.idempotency_key,
              requestHash: row.request_hash,
              candidateSetHash: row.candidate_set_hash,
              reviewReceiptCommandId: row.review_receipt_command_id,
              items,
            }),
            computeTransitionalDecisionHash({
              idempotencyKey: row.idempotency_key,
              requestHash: row.request_hash,
              candidateSetHash: row.candidate_set_hash,
              reviewReceiptCommandId: row.review_receipt_command_id,
              reviewReceiptHash: row.review_receipt_hash,
              items,
            }),
          ];
    if (!expectedDecisionHashes.includes(row.decision_hash)) {
      reject(
        'EXACT_ACCEPTANCE_STORED_DECISION_CORRUPT',
        `decision ${row.id} hash does not match its immutable items`,
        {
          decisionId: row.id,
          storedDecisionHash: row.decision_hash,
          computedDecisionHashes: expectedDecisionHashes,
        },
      );
    }
    return {
      schemaVersion: row.schema_version,
      decisionId: row.id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      candidateSetHash: row.candidate_set_hash,
      decisionHash: row.decision_hash,
      lineage: {
        processRunId: row.process_run_id,
        moduleRef: row.module_ref,
        nodeId: row.node_id,
        intentId: row.intent_id,
        taskId: row.task_id,
        executionId: row.execution_id,
        projectId: row.project_id,
        epicId: row.epic_id,
      },
      requireApprovedReview: row.review_required === 1,
      producerCompletionReceiptCommandId:
        row.producer_receipt_command_id,
      producerCompletionReceiptHash: row.producer_receipt_hash,
      approvedReviewReceiptCommandId: row.review_receipt_command_id,
      approvedReviewReceiptHash: row.review_receipt_hash,
      authority: row.authority,
      reasonCode: row.reason_code,
      items,
      decidedAt: row.decided_at,
      replayed,
    };
  }

  private withImmediateTransaction<T>(work: () => T): T {
    const ownsTransaction = !this.db.inTransaction;
    const savepoint = 'saga3_exact_candidate_acceptance_apply';
    if (ownsTransaction) {
      this.db.exec('BEGIN IMMEDIATE');
    } else {
      // A caller may coordinate the gate and its other effects in a wider
      // transaction. A savepoint preserves this port's all-or-none candidate
      // set guarantee even when it does not own that outer transaction.
      this.db.exec(`SAVEPOINT ${savepoint}`);
    }
    try {
      const result = work();
      if (ownsTransaction) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      if (ownsTransaction) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }
}

function normalizeRequest(
  command: AcceptExactCandidatesCommand,
): NormalizedAcceptanceRequest {
  if (!command || typeof command !== 'object') {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      'command must be an object',
    );
  }
  const idempotencyKey = requireNonEmpty(
    command.idempotencyKey,
    'idempotencyKey',
  );
  const authority = requireNonEmpty(command.authority, 'authority');
  const reasonCode = requireNonEmpty(command.reasonCode, 'reasonCode');
  if (typeof command.requireApprovedReview !== 'boolean') {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      'requireApprovedReview must be a boolean',
    );
  }
  const lineage = normalizeLineage(command.lineage);
  if (!Array.isArray(command.candidates) || command.candidates.length === 0) {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      'candidates must be a non-empty array',
    );
  }
  const seen = new Set<number>();
  const candidates = command.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      reject(
        'EXACT_ACCEPTANCE_INVALID_COMMAND',
        `candidate ${index} must be an object`,
      );
    }
    const artifactId = requirePositiveInteger(
      candidate.artifactId,
      `candidates[${index}].artifactId`,
    );
    if (seen.has(artifactId)) {
      reject(
        'EXACT_ACCEPTANCE_INVALID_COMMAND',
        `artifact ${artifactId} appears more than once`,
        { artifactId },
      );
    }
    seen.add(artifactId);
    return {
      artifactId,
      artifactType: requireNonEmpty(
        candidate.artifactType,
        `candidates[${index}].artifactType`,
      ),
      contentHash: requireHash(
        candidate.contentHash,
        `candidates[${index}].contentHash`,
      ),
    };
  }).sort((left, right) => left.artifactId - right.artifactId);
  const context = command.context ?? {};
  if (!isRecord(context)) {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      'context must be an object when supplied',
    );
  }
  // Fail here, before acquiring a write lock, if context is not canonically
  // representable (undefined, bigint, cycles, etc.).
  try {
    canonicalJson(context);
  } catch (error) {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      `context is not canonical JSON: ${errorMessage(error)}`,
    );
  }
  return {
    schemaVersion: EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
    idempotencyKey,
    lineage,
    candidates,
    requireApprovedReview: command.requireApprovedReview,
    authority,
    reasonCode,
    context,
  };
}

function normalizeLineage(
  lineage: ExactCandidateProductionLineage,
): ExactCandidateProductionLineage {
  if (!lineage || typeof lineage !== 'object') {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      'lineage must be an object',
    );
  }
  return {
    processRunId: requirePositiveInteger(
      lineage.processRunId,
      'lineage.processRunId',
    ),
    moduleRef: requireNonEmpty(lineage.moduleRef, 'lineage.moduleRef'),
    nodeId: requireNonEmpty(lineage.nodeId, 'lineage.nodeId'),
    intentId: requirePositiveInteger(lineage.intentId, 'lineage.intentId'),
    taskId: requirePositiveInteger(lineage.taskId, 'lineage.taskId'),
    executionId: requireNonEmpty(lineage.executionId, 'lineage.executionId'),
    projectId: requirePositiveInteger(lineage.projectId, 'lineage.projectId'),
    epicId: requirePositiveInteger(lineage.epicId, 'lineage.epicId'),
  };
}

function toDecisionItem(
  item: PreparedCandidate,
  _ordinal: number,
): ExactCandidateAcceptanceItem {
  return {
    artifactId: item.candidate.artifactId,
    artifactType: item.candidate.artifactType,
    contentHash: item.candidate.contentHash,
    ledgerId: item.ledger.id,
    disposition: item.disposition,
    priorStatus: item.artifact.status,
    priorAcceptedHash: item.artifact.accepted_hash,
    priorDriftState: item.artifact.drift_state,
    finalStatus: 'accepted',
    finalAcceptedHash: item.candidate.contentHash,
    finalDriftState: 'clean',
  };
}

function computeDecisionHash(input: {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly candidateSetHash: string;
  readonly producerReceiptCommandId: string | null;
  readonly producerReceiptHash: string | null;
  readonly reviewReceiptCommandId: string | null;
  readonly reviewReceiptHash: string | null;
  readonly items: readonly ExactCandidateAcceptanceItem[];
}): string {
  return sha256Hex({
    schemaVersion: EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    candidateSetHash: input.candidateSetHash,
    producerReceiptCommandId: input.producerReceiptCommandId,
    producerReceiptHash: input.producerReceiptHash,
    reviewReceiptCommandId: input.reviewReceiptCommandId,
    reviewReceiptHash: input.reviewReceiptHash,
    items: input.items.map(item => ({
      artifactId: item.artifactId,
      artifactType: item.artifactType,
      contentHash: item.contentHash,
      ledgerId: item.ledgerId,
      disposition: item.disposition,
      priorStatus: item.priorStatus,
      priorAcceptedHash: item.priorAcceptedHash,
      priorDriftState: item.priorDriftState,
      finalStatus: item.finalStatus,
      finalAcceptedHash: item.finalAcceptedHash,
      finalDriftState: item.finalDriftState,
    })),
  });
}

function computeLegacyDecisionHash(input: {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly candidateSetHash: string;
  readonly reviewReceiptCommandId: string | null;
  readonly items: readonly ExactCandidateAcceptanceItem[];
}): string {
  return sha256Hex({
    schemaVersion: LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    candidateSetHash: input.candidateSetHash,
    reviewReceiptCommandId: input.reviewReceiptCommandId,
    items: decisionHashItems(input.items),
  });
}

function computeTransitionalDecisionHash(input: {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly candidateSetHash: string;
  readonly reviewReceiptCommandId: string | null;
  readonly reviewReceiptHash: string | null;
  readonly items: readonly ExactCandidateAcceptanceItem[];
}): string {
  return sha256Hex({
    schemaVersion: LEGACY_EXACT_CANDIDATE_ACCEPTANCE_SCHEMA,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    candidateSetHash: input.candidateSetHash,
    reviewReceiptCommandId: input.reviewReceiptCommandId,
    reviewReceiptHash: input.reviewReceiptHash,
    items: decisionHashItems(input.items),
  });
}

function decisionHashItems(
  items: readonly ExactCandidateAcceptanceItem[],
): readonly Record<string, unknown>[] {
  return items.map(item => ({
    artifactId: item.artifactId,
    artifactType: item.artifactType,
    contentHash: item.contentHash,
    ledgerId: item.ledgerId,
    disposition: item.disposition,
    priorStatus: item.priorStatus,
    priorAcceptedHash: item.priorAcceptedHash,
    priorDriftState: item.priorDriftState,
    finalStatus: item.finalStatus,
    finalAcceptedHash: item.finalAcceptedHash,
    finalDriftState: item.finalDriftState,
  }));
}

function hashReviewReceipt(receipt: ApprovedReviewReceiptRow): string {
  return sha256Hex({
    commandId: receipt.command_id,
    executionId: receipt.execution_id,
    resultJson: receipt.result_json,
    acceptedAt: receipt.accepted_at,
  });
}

function isWorkerDoneReceipt(
  receipt: ApprovedReviewReceiptRow,
  taskId: number,
  expectedStatus: 'review' | 'done',
): boolean {
  if (
    !receipt.command_id.endsWith(':worker-done:approved')
    || receipt.result_json === null
  ) {
    return false;
  }
  let result: unknown;
  try {
    result = JSON.parse(receipt.result_json);
  } catch {
    return false;
  }
  return isRecord(result)
    && result.completed === taskId
    && result.completed_new_status === expectedStatus;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      `${name} must be a positive integer`,
      { field: name, value },
    );
  }
  return value as number;
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      `${name} must be a non-empty string`,
      { field: name },
    );
  }
  return value.trim();
}

function requireHash(value: unknown, name: string): string {
  const hash = requireNonEmpty(value, name);
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    reject(
      'EXACT_ACCEPTANCE_INVALID_COMMAND',
      `${name} must be a 64-character hexadecimal SHA-256`,
      { field: name },
    );
  }
  return hash.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reject(
  code: ConstructorParameters<typeof ExactCandidateAcceptanceRejected>[0],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new ExactCandidateAcceptanceRejected(code, message, details);
}
