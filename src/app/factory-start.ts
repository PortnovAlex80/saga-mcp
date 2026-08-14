import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import { candidateSetDigestForRevision } from '../process-modules/domain/workplace/candidate-set.js';
import { sha256Hex } from '../shared/canonical-json.js';
import {
  SUBMISSION_VALIDATION_FEEDBACK_SCHEMA,
  persistSubmissionValidationRejection,
} from '../lifecycle/submission-validation-rejections.js';
import type { CheckPlan } from '../process-modules/domain/workplace/gate.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
  type SubmissionValidationReceiptProjection,
} from '../process-modules/application/submission-validation-receipt-authority.js';

export const FACTORY_START_SCHEMA = 'saga.factory-start.v1' as const;

export type FactoryStartCommand =
  | { readonly kind: 'resume'; readonly projectId: number }
  | { readonly kind: 'new'; readonly ideaUrl: string; readonly idempotencyKey?: string }
  | { readonly kind: 'new_start'; readonly projectId: number; readonly idempotencyKey?: string };

export class FactoryStartError extends Error {
  constructor(
    readonly code:
      | 'FACTORY_START_SELECTOR_REQUIRED'
      | 'FACTORY_START_SELECTOR_CONFLICT'
      | 'FACTORY_START_UNKNOWN_FIELD'
      | 'FACTORY_PROJECT_ID_INVALID'
      | 'FACTORY_IDEA_URL_INVALID'
      | 'FACTORY_PROJECT_NOT_FOUND'
      | 'FACTORY_RUN_NOT_RESUMABLE'
      | 'FACTORY_PROJECT_AMBIGUOUS'
      | 'FACTORY_PAUSED_WORKPLACE_NOT_UNIQUE'
      | 'FACTORY_PAUSED_WORKPLACE_UNSAFE'
      | 'FACTORY_RECOVERY_FEEDBACK_REQUIRED'
      | 'FACTORY_RECOVERY_SNAPSHOT_DRIFT'
      | 'FACTORY_FAILED_GATE_NOT_UNIQUE'
      | 'FACTORY_FAILED_GATE_UNSAFE'
      | 'FACTORY_FAILED_GATE_PLAN_INVALID'
      | 'FACTORY_MISSING_PRODUCT_NOT_UNIQUE'
      | 'FACTORY_MISSING_PRODUCT_UNSAFE'
      | 'FACTORY_ORPHANED_LAUNCH_NOT_UNIQUE'
      | 'FACTORY_ORPHANED_LAUNCH_UNSAFE',
    message: string,
  ) {
    super(message);
    this.name = 'FactoryStartError';
  }
}

/**
 * Decode the sole public factory-start contract.  Technical launch coordinates
 * are deliberately not accepted; they are durable server-owned state.
 */
export function decodeFactoryStartCommand(
  value: unknown,
): FactoryStartCommand {
  if (!isRecord(value)) {
    throw new FactoryStartError(
      'FACTORY_START_SELECTOR_REQUIRED',
      'body must contain exactly one of project_id or idea_url',
    );
  }
  const allowed = new Set(['project_id', 'idea_url', 'mode', 'idempotency_key']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new FactoryStartError(
      'FACTORY_START_UNKNOWN_FIELD',
      `unsupported factory start field(s): ${unknown.join(', ')}`,
    );
  }
  const hasProject = Object.hasOwn(value, 'project_id');
  const hasIdeaUrl = Object.hasOwn(value, 'idea_url');
  if (hasProject === hasIdeaUrl) {
    throw new FactoryStartError(
      hasProject
        ? 'FACTORY_START_SELECTOR_CONFLICT'
        : 'FACTORY_START_SELECTOR_REQUIRED',
      'pass exactly one of project_id or idea_url',
    );
  }
  // Optional client-supplied start-command idempotency key. When absent the
  // starter mints a per-start key. Source bytes are NOT idempotency (§3).
  const idempotencyKey = typeof value.idempotency_key === 'string'
    && value.idempotency_key.trim().length > 0
      ? value.idempotency_key.trim()
      : undefined;
  if (hasProject) {
    const projectId = Number(value.project_id);
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      throw new FactoryStartError(
        'FACTORY_PROJECT_ID_INVALID',
        'project_id must be a positive integer',
      );
    }
    // mode disambiguates resume (continue existing run) vs new_start (intentional
    // new Factory Run for the same Project — CONVEYOR v4.3 §7). Default is resume
    // for backward compatibility.
    const mode = typeof value.mode === 'string' ? value.mode : 'resume';
    if (mode === 'new_start') {
      return { kind: 'new_start', projectId, idempotencyKey };
    }
    if (mode !== 'resume') {
      throw new FactoryStartError(
        'FACTORY_START_UNKNOWN_FIELD',
        `mode must be 'resume' or 'new_start', got '${mode}'`,
      );
    }
    return { kind: 'resume', projectId };
  }
  const rawUrl = value.idea_url;
  if (typeof rawUrl !== 'string') {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must be an HTTPS URL',
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must be an HTTPS URL',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must use HTTPS and must not contain credentials',
    );
  }
  url.hash = '';
  return { kind: 'new', ideaUrl: url.toString(), idempotencyKey };
}

export interface FactoryResumeTarget {
  readonly projectId: number;
  readonly epicId: number;
  readonly lifecycleRunId: number;
  readonly idempotencyKey: string;
  readonly status: 'created' | 'running' | 'paused';
  readonly orderRef: string | null;
}

/** Resolve, but never invent, the exact durable run for a project resume. */
export function resolveFactoryResumeTarget(
  db: Database.Database,
  projectId: number,
): FactoryResumeTarget {
  const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
  if (!project) {
    throw new FactoryStartError(
      'FACTORY_PROJECT_NOT_FOUND',
      `project ${projectId} does not exist`,
    );
  }
  const rows = db.prepare(
    `SELECT lr.id AS lifecycle_run_id, lr.epic_id, lr.idempotency_key,
            lr.status,
            COALESCE(
              (SELECT chain.order_ref FROM factory_order_runs chain
                WHERE chain.lifecycle_run_id=lr.id),
              (SELECT root.order_ref FROM factory_orders root
                WHERE root.lifecycle_run_id=lr.id)
            ) AS order_ref
       FROM factory_lifecycle_runs lr
      WHERE lr.project_id=?
        AND lr.status IN ('created','running','paused')
      ORDER BY lr.id DESC`,
  ).all(projectId) as Array<{
    lifecycle_run_id: number;
    epic_id: number | null;
    idempotency_key: string;
    status: 'created' | 'running' | 'paused';
    order_ref: string | null;
  }>;
  if (rows.length === 0) {
    throw new FactoryStartError(
      'FACTORY_RUN_NOT_RESUMABLE',
      `project ${projectId} has no resumable factory run`,
    );
  }
  if (rows.length !== 1 || rows[0]!.epic_id === null) {
    throw new FactoryStartError(
      'FACTORY_PROJECT_AMBIGUOUS',
      `project ${projectId} does not resolve to exactly one resumable factory order`,
    );
  }
  const row = rows[0]!;
  return {
    projectId,
    epicId: row.epic_id!,
    lifecycleRunId: row.lifecycle_run_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    orderRef: row.order_ref,
  };
}

export interface PausedWorkplaceRecoveryResult {
  readonly authorizationRef: string;
  readonly rejectionRef: string;
  readonly workplaceRef: string;
  readonly taskId: number;
  readonly resultingRevision: number;
  readonly replayed: boolean;
}

export interface FailedGateRecoveryResult {
  readonly authorizationRef: string;
  readonly lifecycleRunId: number;
  readonly stageRunId: number;
  readonly processRunId: number;
  readonly workplaceRef: string;
  readonly candidateSetRef: string;
  readonly abandonedGateRunRef: string;
  readonly replacementCheckPlanDigest: string;
  readonly resultingLifecycleVersion: number;
  readonly replayed: boolean;
}

export interface MissingProductRecoveryResult {
  readonly authorizationRef: string;
  readonly rejectionRef: string;
  readonly workplaceRef: string;
  readonly taskId: number;
  readonly abandonedLaunchRef: string | null;
  readonly resultingRevision: number;
  readonly replayed: boolean;
}

export interface OrphanedLaunchRecoveryResult {
  readonly recoveryRef: string;
  readonly launchRef: string;
  readonly lifecycleRunId: number;
  readonly executionId: string;
  readonly workplaceRef: string;
  readonly replayed: boolean;
}

/**
 * Close one controller launch whose exact worker was already proved dead and
 * atomically released by WorkerSupervisionService. This does not infer death
 * from time or mutate production state: it consumes the durable `lost` fact,
 * requires a paused/unleased lifecycle and zero active workers, and appends an
 * immutable recovery receipt before failing the stale launch fence.
 */
export function recoverOrphanedFactoryLaunch(
  db: Database.Database,
  input: {
    readonly lifecycleRunId: number;
    readonly actorId: string;
    readonly reason: string;
  },
): OrphanedLaunchRecoveryResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare(
      `SELECT r.recovery_ref,r.launch_ref,r.lifecycle_run_id,r.execution_id,
              r.workplace_ref,l.state
         FROM factory_orphaned_launch_recovery_receipts r
         JOIN factory_launch_requests l ON l.launch_ref=r.launch_ref
        WHERE r.lifecycle_run_id=? AND r.actor_id=? AND r.reason=?
          AND NOT EXISTS (
            SELECT 1 FROM factory_launch_requests current_launch
             WHERE current_launch.lifecycle_run_id=r.lifecycle_run_id
               AND current_launch.launch_ref<>r.launch_ref
               AND current_launch.state IN ('requested','claimed','running')
          )
        ORDER BY r.recovered_at DESC LIMIT 1`,
    ).get(input.lifecycleRunId, input.actorId, input.reason) as {
      recovery_ref: string;
      launch_ref: string;
      lifecycle_run_id: number;
      execution_id: string;
      workplace_ref: string;
      state: string;
    } | undefined;
    if (prior && prior.state === 'failed') {
      db.exec('COMMIT');
      return {
        recoveryRef: prior.recovery_ref,
        launchRef: prior.launch_ref,
        lifecycleRunId: prior.lifecycle_run_id,
        executionId: prior.execution_id,
        workplaceRef: prior.workplace_ref,
        replayed: true,
      };
    }

    const rows = db.prepare(
      `SELECT l.launch_ref,l.claim_token,l.order_ref,
              lr.status AS lifecycle_status,lr.execution_lease_owner AS lifecycle_lease,
              sr.status AS stage_status,pr.id AS process_run_id,
              pr.status AS process_status,pr.execution_lease_owner AS process_lease,
              w.workplace_ref,w.revision,w.kanban_phase,w.loop_state,w.next_role,
              w.active_reservation_ref,w.active_gate_ref,w.active_recovery_case_ref,
              t.id AS task_id,t.assigned_to,t.current_execution_id,
              we.execution_id,we.state AS execution_state,we.finished_at
         FROM factory_launch_requests l
         JOIN factory_lifecycle_runs lr ON lr.id=l.lifecycle_run_id
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
         JOIN factory_process_runs pr ON pr.id=sr.process_run_id
         JOIN factory_workplaces w ON w.process_run_id=pr.id
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
         JOIN worker_executions we ON we.task_id=t.id
        WHERE l.lifecycle_run_id=?
          AND l.state IN ('requested','claimed','running')
          AND we.state='lost'
          AND we.finished_at=(
            SELECT MAX(we2.finished_at)
              FROM worker_executions we2
              JOIN tasks t2 ON t2.id=we2.task_id
              JOIN factory_workplaces w2 ON w2.workplace_ref=t2.workplace_ref
             WHERE w2.process_run_id=pr.id AND we2.state='lost'
          )
        ORDER BY we.finished_at DESC`,
    ).all(input.lifecycleRunId) as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      throw new FactoryStartError(
        'FACTORY_ORPHANED_LAUNCH_NOT_UNIQUE',
        `lifecycle ${input.lifecycleRunId} resolves to ${rows.length} lost-worker launch candidates; expected exactly one`,
      );
    }
    const row = rows[0]!;
    const activeExecutions = (db.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions
        WHERE epic_id=(SELECT epic_id FROM factory_lifecycle_runs WHERE id=?)
          AND state IN ('reserved','running','cancel_requested')`,
    ).get(input.lifecycleRunId) as { n: number }).n;
    const submissions = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
        WHERE execution_id=?`,
    ).get(row.execution_id) as { n: number }).n;
    const acceptedDone = (db.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts
        WHERE execution_id=? AND command_kind='worker_done' AND accepted=1`,
    ).get(row.execution_id) as { n: number }).n;
    if (
      row.lifecycle_status !== 'paused'
      || row.lifecycle_lease !== null
      || row.stage_status !== 'paused'
      || row.process_status !== 'paused'
      || row.process_lease !== null
      || row.execution_state !== 'lost'
      || (
        (row.next_role === 'author' && row.kanban_phase !== 'in_progress')
        || (row.next_role === 'reviewer' && row.kanban_phase !== 'review_in_progress')
      )
      || row.loop_state !== 'repair_wait'
      || !['author', 'reviewer'].includes(String(row.next_role))
      || row.active_reservation_ref !== null
      || row.active_gate_ref !== null
      || row.active_recovery_case_ref !== null
      || row.assigned_to !== null
      || row.current_execution_id !== null
      || activeExecutions !== 0
      || submissions !== 0
      || acceptedDone !== 0
    ) {
      throw new FactoryStartError(
        'FACTORY_ORPHANED_LAUNCH_UNSAFE',
        'orphaned-launch recovery requires one latest supervised lost worker, zero active workers/products/completions, and an unleased paused lifecycle',
      );
    }
    const recoveryRef = `orphaned-launch-recovery:${sha256Hex({
      launchRef: row.launch_ref,
      lifecycleRunId: input.lifecycleRunId,
      processRunId: row.process_run_id,
      workplaceRef: row.workplace_ref,
      workplaceRevision: row.revision,
      executionId: row.execution_id,
      actorId: input.actorId,
      reason: input.reason,
    })}`;
    db.prepare(
      `INSERT INTO factory_orphaned_launch_recovery_receipts
         (recovery_ref,launch_ref,lifecycle_run_id,process_run_id,workplace_ref,
          workplace_revision,task_id,execution_id,observed_execution_state,
          actor_id,reason)
       VALUES (?,?,?,?,?,?,?,?,'lost',?,?)`,
    ).run(
      recoveryRef,
      row.launch_ref,
      input.lifecycleRunId,
      row.process_run_id,
      row.workplace_ref,
      row.revision,
      row.task_id,
      row.execution_id,
      input.actorId,
      input.reason,
    );
    const incident = JSON.stringify({
      code: 'ORPHANED_FACTORY_LAUNCH_RECOVERED',
      lifecycleRunId: input.lifecycleRunId,
      executionId: row.execution_id,
      workplaceRef: row.workplace_ref,
      recoveryRef,
    });
    const launchUpdate = db.prepare(
      `UPDATE factory_launch_requests
          SET state='failed',error=?,completed_at=datetime('now')
        WHERE launch_ref=? AND claim_token=?
          AND state IN ('requested','claimed','running')`,
    ).run(incident, row.launch_ref, row.claim_token);
    if (launchUpdate.changes !== 1) {
      throw new FactoryStartError(
        'FACTORY_ORPHANED_LAUNCH_UNSAFE',
        `launch ${String(row.launch_ref)} fence changed during recovery`,
      );
    }
    db.prepare(
      `UPDATE factory_orders SET state='paused',last_error=?,updated_at=datetime('now')
        WHERE order_ref=?`,
    ).run(incident, row.order_ref);
    db.exec('COMMIT');
    return {
      recoveryRef,
      launchRef: String(row.launch_ref),
      lifecycleRunId: input.lifecycleRunId,
      executionId: String(row.execution_id),
      workplaceRef: String(row.workplace_ref),
      replayed: false,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

/**
 * Recover the exact incident where an accepted worker_done moved a Production
 * Cell to verifying even though its execution persisted no typed product.
 * The false completion receipt and stale launch remain immutable evidence;
 * only the same Workplace receives one new author opportunity.
 */
export function recoverMissingProductionCellProduct(
  db: Database.Database,
  input: {
    readonly lifecycleRunId: number;
    readonly expectedSchema: string;
    readonly actorId: string;
    readonly reason: string;
  },
): MissingProductRecoveryResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare(
      `SELECT a.authorization_ref,a.rejection_ref,a.workplace_ref,a.task_id,
              c.resulting_revision,w.loop_state
         FROM factory_operator_recovery_authorizations a
         JOIN factory_operator_recovery_consumptions c
           ON c.authorization_ref=a.authorization_ref
         JOIN factory_workplaces w ON w.workplace_ref=a.workplace_ref
        WHERE a.lifecycle_run_id=? AND a.actor_id=? AND a.reason=?
        ORDER BY a.authorized_at DESC LIMIT 1`,
    ).get(input.lifecycleRunId, input.actorId, input.reason) as {
      authorization_ref: string;
      rejection_ref: string;
      workplace_ref: string;
      task_id: number;
      resulting_revision: number;
      loop_state: string;
    } | undefined;
    if (prior && prior.loop_state === 'queued') {
      db.exec('COMMIT');
      return {
        authorizationRef: prior.authorization_ref,
        rejectionRef: prior.rejection_ref,
        workplaceRef: prior.workplace_ref,
        taskId: prior.task_id,
        abandonedLaunchRef: null,
        resultingRevision: prior.resulting_revision,
        replayed: true,
      };
    }

    const candidates = db.prepare(
      `SELECT lr.id AS lifecycle_run_id,lr.execution_lease_owner AS lifecycle_lease,
              sr.id AS stage_run_id,sr.process_run_id,
              pr.execution_lease_owner AS process_lease,
              w.workplace_ref,w.revision,w.next_role,w.active_reservation_ref,
              w.active_gate_ref,w.active_recovery_case_ref,
              t.id AS task_id,t.status AS task_status,t.assigned_to,
              t.current_execution_id,t.metadata,t.execution_mode,
              we.execution_id,we.state AS execution_state,we.exit_code,we.last_error
         FROM factory_lifecycle_runs lr
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
         JOIN factory_process_runs pr ON pr.id=sr.process_run_id
         JOIN factory_workplaces w ON w.process_run_id=pr.id
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
         JOIN worker_executions we ON we.execution_id=w.active_reservation_ref
        WHERE lr.id=? AND lr.status='paused' AND sr.status='paused' AND pr.status='paused'
          AND w.kanban_phase='in_progress' AND w.loop_state='verifying'`,
    ).all(input.lifecycleRunId) as Array<Record<string, unknown>>;
    if (candidates.length !== 1) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_NOT_UNIQUE',
        `lifecycle ${input.lifecycleRunId} resolves to ${candidates.length} incomplete verifying workplaces; expected exactly one`,
      );
    }
    const row = candidates[0]!;
    if (
      row.lifecycle_lease !== null
      || row.process_lease !== null
      || row.next_role !== 'author'
      || row.active_gate_ref !== null
      || row.active_recovery_case_ref !== null
      || row.task_status !== 'in_progress'
      || row.assigned_to !== null
      || row.current_execution_id !== null
      || row.execution_state !== 'exited'
      || row.exit_code !== 0
      || row.last_error !== null
      || row.execution_mode !== 'artifact_change'
    ) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_UNSAFE',
        `workplace ${String(row.workplace_ref)} does not match the exact missing-product incident`,
      );
    }
    const activeExecutions = (db.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions
        WHERE epic_id=(SELECT epic_id FROM factory_lifecycle_runs WHERE id=?)
          AND state IN ('reserved','running','cancel_requested')`,
    ).get(input.lifecycleRunId) as { n: number }).n;
    const acceptedDone = (db.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts
        WHERE task_id=? AND execution_id=? AND command_kind='worker_done' AND accepted=1`,
    ).get(row.task_id, row.execution_id) as { n: number }).n;
    const submissions = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
        WHERE task_id=? AND execution_id=?`,
    ).get(row.task_id, row.execution_id) as { n: number }).n;
    const candidateSets = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_candidate_sets WHERE workplace_ref=?`,
    ).get(row.workplace_ref) as { n: number }).n;
    const gateRuns = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_gate_runs WHERE workplace_ref=?`,
    ).get(row.workplace_ref) as { n: number }).n;
    if (
      activeExecutions !== 0
      || acceptedDone !== 1
      || submissions !== 0
      || candidateSets !== 0
      || gateRuns !== 0
    ) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_UNSAFE',
        'missing-product recovery requires zero live workers/products/candidates/gates and exactly one false completion receipt',
      );
    }
    const metadata = parseMetadata(String(row.metadata ?? '{}'));
    const processRunId = Number(row.process_run_id);
    const moduleRef = String(metadata.process_module_ref ?? '');
    const nodeId = String(metadata.process_node_id ?? '');
    const executionId = String(row.execution_id);
    if (!moduleRef || !nodeId || !Number.isSafeInteger(processRunId)) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_UNSAFE',
        'missing-product recovery requires the exact managed process binding',
      );
    }
    const rejection = persistSubmissionValidationRejection(db, {
      validatorId: 'factory.production-cell-product-contract',
      validatorVersion: '1.0.0',
      processRunId,
      moduleRef,
      nodeId,
      executionId,
      taskId: Number(row.task_id),
      actorKind: 'admin',
      rejectionCode: 'PRODUCTION_CELL_PRODUCT_REQUIRED',
      gaps: [{
        artifactId: 0,
        artifactCode: null,
        artifactType: 'typed-product',
        existingTargets: [],
        missing: {
          relation: 'product_submit',
          requiredTargetTypes: [input.expectedSchema],
          minimum: 1,
        },
        message:
          `Submit one ${input.expectedSchema} as an object before worker_done. `
          + `For managed source use content fields {schemaVersion,workItemKey,baseCommit,entries}; `
          + `each create/modify entry uses {path,operation,content}. Factory computes digest.`,
      }],
      details: {
        expectedSchema: input.expectedSchema,
        exactCall:
          `product_submit({schema:"${input.expectedSchema}",content:{schemaVersion:"${input.expectedSchema}",workItemKey:"<key>",baseCommit:"<commit>",entries:[{path:"<scope>",operation:"modify",content:"<full UTF-8>"}]}})`,
        forbiddenAliases: ['body', 'contentHash', 'metadata'],
      },
      inputSnapshotHash: String(
        metadata.process_node_input_hash ?? metadata.process_input_hash ?? '',
      ),
    });
    const authorizationRef = `operator-recovery:${sha256Hex({
      lifecycleRunId: input.lifecycleRunId,
      workplaceRef: row.workplace_ref,
      expectedRevision: row.revision,
      rejectionRef: rejection.rejectionRef,
      actorId: input.actorId,
      reason: input.reason,
    })}`;
    db.prepare(
      `INSERT INTO factory_operator_recovery_authorizations
         (authorization_ref,lifecycle_run_id,stage_run_id,process_run_id,
          workplace_ref,expected_revision,task_id,repair_role,rejection_ref,
          rejection_digest,actor_id,reason)
       VALUES (?,?,?,?,?,?,?,'author',?,?,?,?)`,
    ).run(
      authorizationRef,
      input.lifecycleRunId,
      row.stage_run_id,
      processRunId,
      row.workplace_ref,
      row.revision,
      row.task_id,
      rejection.rejectionRef,
      rejection.rejectionDigest,
      input.actorId,
      input.reason,
    );
    const runtime = new ConveyorRuntime(db);
    const rejected = runtime.rejectIncompleteCompletion({
      workplaceRef: deserializeWorkplaceRef(String(row.workplace_ref)),
      taskId: Number(row.task_id),
      role: 'author',
    });
    const resumed = runtime.requeueForRepair({
      workplaceRef: deserializeWorkplaceRef(String(row.workplace_ref)),
      taskId: Number(row.task_id),
      role: 'author',
    });
    if (
      !rejected.applied
      || !resumed.applied
      || resumed.workplace.loopState !== 'queued'
      || resumed.workplace.revision !== Number(row.revision) + 2
    ) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_UNSAFE',
        `workplace ${String(row.workplace_ref)} changed during recovery`,
      );
    }
    const activeLaunches = db.prepare(
      `SELECT launch_ref FROM factory_launch_requests
        WHERE lifecycle_run_id=? AND state IN ('requested','claimed','running')`,
    ).all(input.lifecycleRunId) as Array<{ launch_ref: string }>;
    if (activeLaunches.length > 1) {
      throw new FactoryStartError(
        'FACTORY_MISSING_PRODUCT_UNSAFE',
        'missing-product recovery found more than one active launch',
      );
    }
    const abandonedLaunchRef = activeLaunches[0]?.launch_ref ?? null;
    if (abandonedLaunchRef) {
      const incident = JSON.stringify({
        code: 'PRODUCTION_CELL_PRODUCT_REQUIRED',
        lifecycleRunId: input.lifecycleRunId,
        workplaceRef: row.workplace_ref,
        executionId,
        recoveryAuthorizationRef: authorizationRef,
      });
      db.prepare(
        `UPDATE factory_launch_requests
            SET state='failed',error=?,completed_at=datetime('now')
          WHERE launch_ref=? AND state IN ('requested','claimed','running')`,
      ).run(incident, abandonedLaunchRef);
      db.prepare(
        `UPDATE factory_orders SET state='paused',last_error=?,updated_at=datetime('now')
          WHERE order_ref=(SELECT order_ref FROM factory_launch_requests WHERE launch_ref=?)`,
      ).run(incident, abandonedLaunchRef);
    }
    db.prepare(
      `INSERT INTO factory_operator_recovery_consumptions
         (authorization_ref,resulting_revision) VALUES (?,?)`,
    ).run(authorizationRef, resumed.workplace.revision);
    db.exec('COMMIT');
    return {
      authorizationRef,
      rejectionRef: rejection.rejectionRef,
      workplaceRef: String(row.workplace_ref),
      taskId: Number(row.task_id),
      abandonedLaunchRef,
      resultingRevision: resumed.workplace.revision,
      replayed: false,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

/**
 * Reopen one terminal lifecycle whose only failure is a CheckProvider version
 * mismatch after an author CandidateSet was sealed. The old GateRun and its
 * partial receipts remain evidence. Resume re-enters the same verifying
 * Workplace and derives a new GateRun identity from the replacement plan.
 */
export function recoverFailedGateRun(
  db: Database.Database,
  input: {
    readonly projectId: number;
    readonly replacementCheckPlan: CheckPlan;
    readonly actorId: string;
    readonly reason: string;
  },
): FailedGateRecoveryResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare(
      `SELECT a.*,c.resulting_lifecycle_version,lr.status AS lifecycle_status,
              lr.execution_lease_owner
         FROM factory_failed_gate_recovery_authorizations a
         JOIN factory_failed_gate_recovery_consumptions c
           ON c.authorization_ref=a.authorization_ref
         JOIN factory_lifecycle_runs lr ON lr.id=a.lifecycle_run_id
        WHERE lr.project_id=? AND a.actor_id=? AND a.reason=?
        ORDER BY a.authorized_at DESC LIMIT 1`,
    ).get(input.projectId, input.actorId, input.reason) as Record<string, unknown> | undefined;
    if (
      prior
      && prior.lifecycle_status === 'paused'
      && prior.execution_lease_owner === null
      && prior.replacement_check_plan_digest === input.replacementCheckPlan.checkPlanDigest
    ) {
      db.exec('COMMIT');
      return failedGateRecoveryResult(prior, true);
    }

    const rows = db.prepare(
      `SELECT lr.id AS lifecycle_run_id,lr.version AS lifecycle_version,
              lr.error AS lifecycle_error,lr.execution_lease_owner AS lifecycle_lease,
              sr.id AS stage_run_id,sr.error AS stage_error,
              pr.id AS process_run_id,pr.error AS process_error,
              pr.execution_lease_owner AS process_lease,
              w.workplace_ref,w.revision AS workplace_revision,w.next_role,
              w.active_reservation_ref,w.active_gate_ref,w.active_recovery_case_ref,
              t.id AS task_id,t.status AS task_status,t.assigned_to,t.current_execution_id,
              we.state AS execution_state,we.exit_code,we.last_error AS execution_error,
              cs.candidate_set_ref,cs.candidate_set_digest,cs.production_revision_ref,
              cs.subject_candidate_set_ref,
              (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev
                WHERE rev.revision_ref = cs.production_revision_ref) AS presenter_ref,
              cs.role AS candidate_role,
              gr.gate_run_ref,gr.gate_phase,gr.subject_candidate_set_ref,
              gr.assessment_candidate_set_refs,gr.check_plan_ref,
              gr.check_plan_digest,gr.expected_workplace_revision,gr.state AS gate_state,
              nr.id AS failed_node_run_id,nr.error_message AS node_error
         FROM factory_lifecycle_runs lr
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
         JOIN factory_process_runs pr ON pr.id=sr.process_run_id
         JOIN factory_workplaces w ON w.process_run_id=pr.id
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
         JOIN worker_executions we ON we.execution_id=w.active_reservation_ref
         JOIN factory_gate_runs gr
           ON gr.workplace_ref=w.workplace_ref
          AND gr.state='checking'
         JOIN factory_candidate_sets cs
           ON cs.candidate_set_ref=gr.subject_candidate_set_ref
          AND cs.workplace_ref=w.workplace_ref
          AND cs.role='author'
         JOIN factory_node_runs nr ON nr.id=(
           SELECT MAX(n2.id) FROM factory_node_runs n2
            WHERE n2.process_run_id=pr.id AND n2.status='failed'
         )
        WHERE lr.project_id=? AND lr.status='failed' AND lr.terminal_status='failed'
          AND sr.status='failed' AND pr.status='failed'
          AND w.kanban_phase='in_progress' AND w.loop_state='verifying'`,
    ).all(input.projectId) as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_NOT_UNIQUE',
        `project ${input.projectId} resolves to ${rows.length} recoverable failed gates; expected exactly one`,
      );
    }
    const row = rows[0]!;
    const failure = String(row.lifecycle_error ?? '');
    const mismatch = /^CHECK_PROVIDER_VERSION_MISMATCH: expected ([^,]+), got (.+)$/.exec(failure);
    if (
      !mismatch
      || row.stage_error !== failure
      || row.process_error !== failure
      || row.node_error !== failure
      || row.lifecycle_lease !== null
      || row.process_lease !== null
      || row.next_role !== 'author'
      || row.active_gate_ref !== null
      || row.active_recovery_case_ref !== null
      || row.task_status !== 'in_progress'
      || row.assigned_to !== null
      || row.current_execution_id !== null
      || row.execution_state !== 'exited'
      || row.exit_code !== 0
      || row.execution_error !== null
      || row.candidate_role !== 'author'
      || row.gate_phase !== 'author'
      || row.gate_state !== 'checking'
      || row.subject_candidate_set_ref !== row.candidate_set_ref
      || row.expected_workplace_revision !== row.workplace_revision
      || row.active_reservation_ref !== row.presenter_ref
      || row.assessment_candidate_set_refs !== '[]'
    ) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_UNSAFE',
        `failed gate ${String(row.gate_run_ref)} does not satisfy exact replay preconditions`,
      );
    }

    const plan = input.replacementCheckPlan;
    const entries = [...plan.entries];
    if (
      !plan.checkPlanId
      || !plan.checkPlanDigest
      || plan.checkPlanId !== row.check_plan_ref
      || plan.checkPlanDigest === row.check_plan_digest
      || mismatch[1] === mismatch[2]
      || !entries.some(entry => entry.check.version === mismatch[2])
    ) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_PLAN_INVALID',
        `replacement plan '${plan.checkPlanId}' is not the canonical successor of failed plan ${String(row.check_plan_ref)}`,
      );
    }

    const activeExecutions = (db.prepare(
      `SELECT COUNT(*) AS n
         FROM worker_executions we
         JOIN tasks t ON t.id=we.task_id
         JOIN factory_workplaces w ON w.workplace_ref=t.workplace_ref
        WHERE w.process_run_id=?
          AND we.state IN ('reserved','running','cancel_requested')`,
    ).get(row.process_run_id) as { n: number }).n;
    const acceptedDone = (db.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts
        WHERE task_id=? AND execution_id=?
          AND command_kind='worker_done' AND accepted=1`,
    ).get(row.task_id, row.presenter_ref) as { n: number }).n;
    const gateDecisionCount = (db.prepare(
      'SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE gate_run_ref=?',
    ).get(row.gate_run_ref) as { n: number }).n;
    if (activeExecutions !== 0 || acceptedDone !== 1 || gateDecisionCount !== 0) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_UNSAFE',
        'failed gate recovery requires one accepted completion, no live execution and no GateDecision',
      );
    }

    const partialReceipts = db.prepare(
      `SELECT provider_id,provider_version,provider_digest,outcome
         FROM factory_check_receipts WHERE check_run_ref=? ORDER BY created_at,check_receipt_ref`,
    ).all(row.gate_run_ref) as Array<{
      provider_id: string;
      provider_version: string;
      provider_digest: string;
      outcome: string;
    }>;
    if (
      partialReceipts.length >= entries.length
      || partialReceipts.some(receipt => {
        const declared = entries.find(entry => entry.check.providerId === receipt.provider_id);
        return !declared
          || declared.check.version !== receipt.provider_version
          || declared.check.providerDigest !== receipt.provider_digest
          || receipt.outcome !== 'passed';
      })
    ) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_PLAN_INVALID',
        'replacement plan does not preserve the already-passed CheckReceipt prefix',
      );
    }

    verifyCandidateSetDigest(db, row);
    verifyAcceptedSubmissionSnapshot(db, row, plan, mismatch[2]!);

    const authorizationRef = `failed-gate-recovery:${sha256Hex({
      lifecycleRunId: row.lifecycle_run_id,
      stageRunId: row.stage_run_id,
      processRunId: row.process_run_id,
      failedNodeRunId: row.failed_node_run_id,
      workplaceRef: row.workplace_ref,
      workplaceRevision: row.workplace_revision,
      candidateSetRef: row.candidate_set_ref,
      candidateSetDigest: row.candidate_set_digest,
      abandonedGateRunRef: row.gate_run_ref,
      abandonedCheckPlanDigest: row.check_plan_digest,
      replacementCheckPlanDigest: plan.checkPlanDigest,
      actorId: input.actorId,
      reason: input.reason,
    })}`;
    db.prepare(
      `INSERT INTO factory_failed_gate_recovery_authorizations
         (authorization_ref,lifecycle_run_id,stage_run_id,process_run_id,
          failed_node_run_id,workplace_ref,expected_workplace_revision,task_id,
          candidate_set_ref,candidate_set_digest,
          abandoned_gate_run_ref,abandoned_check_plan_ref,abandoned_check_plan_digest,
          replacement_check_plan_ref,replacement_check_plan_digest,
          replacement_check_plan_snapshot,failure_code,actor_id,reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      authorizationRef,row.lifecycle_run_id,row.stage_run_id,row.process_run_id,
      row.failed_node_run_id,row.workplace_ref,row.workplace_revision,row.task_id,
      row.candidate_set_ref,row.candidate_set_digest,
      row.gate_run_ref,row.check_plan_ref,row.check_plan_digest,
      plan.checkPlanId,plan.checkPlanDigest,JSON.stringify(plan),failure,
      input.actorId,input.reason,
    );

    const processUpdate = db.prepare(
      `UPDATE factory_process_runs
          SET status='paused',error=NULL,completed_at=NULL,
              execution_lease_owner=NULL,execution_lease_expires_at=NULL,
              updated_at=datetime('now')
        WHERE id=? AND status='failed' AND error=?`,
    ).run(row.process_run_id, failure);
    const stageUpdate = db.prepare(
      `UPDATE factory_stage_runs
          SET status='paused',error=NULL,completed_at=NULL,updated_at=datetime('now')
        WHERE id=? AND status='failed' AND error=?`,
    ).run(row.stage_run_id, failure);
    const lifecycleUpdate = db.prepare(
      `UPDATE factory_lifecycle_runs
          SET status='paused',terminal_status=NULL,error=NULL,completed_at=NULL,
              execution_lease_owner=NULL,execution_lease_expires_at=NULL,
              version=version+1,updated_at=datetime('now')
        WHERE id=? AND status='failed' AND terminal_status='failed'
          AND version=? AND error=?`,
    ).run(row.lifecycle_run_id, row.lifecycle_version, failure);
    if (
      processUpdate.changes !== 1
      || stageUpdate.changes !== 1
      || lifecycleUpdate.changes !== 1
    ) {
      throw new FactoryStartError(
        'FACTORY_FAILED_GATE_UNSAFE',
        'failed gate state changed during guarded recovery',
      );
    }
    const resultingLifecycleVersion = Number(row.lifecycle_version) + 1;
    db.prepare(
      `INSERT INTO factory_failed_gate_recovery_consumptions
         (authorization_ref,resulting_lifecycle_version) VALUES (?,?)`,
    ).run(authorizationRef, resultingLifecycleVersion);
    db.exec('COMMIT');
    return {
      authorizationRef,
      lifecycleRunId: Number(row.lifecycle_run_id),
      stageRunId: Number(row.stage_run_id),
      processRunId: Number(row.process_run_id),
      workplaceRef: String(row.workplace_ref),
      candidateSetRef: String(row.candidate_set_ref),
      abandonedGateRunRef: String(row.gate_run_ref),
      replacementCheckPlanDigest: plan.checkPlanDigest,
      resultingLifecycleVersion,
      replayed: false,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

/**
 * Explicit operator recovery for the narrow incident class where submission
 * preflight rejections exhausted physical worker attempts before any
 * CandidateSet/GateDecision existed. It never accepts work: it grants exactly
 * one additional author execution through the existing Workplace CAS reducer.
 */
export function resumePausedSubmissionWorkplace(
  db: Database.Database,
  input: {
    readonly lifecycleRunId: number;
    readonly actorId: string;
    readonly reason: string;
  },
): PausedWorkplaceRecoveryResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Idempotent recovery after a host crash between committed requeue and
    // launch creation: return the already-consumed directive.
    const prior = db.prepare(
      `SELECT a.authorization_ref, a.rejection_ref, a.workplace_ref, a.task_id,
              c.resulting_revision, w.loop_state
         FROM factory_operator_recovery_authorizations a
         JOIN factory_operator_recovery_consumptions c
           ON c.authorization_ref=a.authorization_ref
         JOIN factory_workplaces w ON w.workplace_ref=a.workplace_ref
        WHERE a.lifecycle_run_id=? AND a.actor_id=? AND a.reason=?
        ORDER BY a.authorized_at DESC LIMIT 1`,
    ).get(input.lifecycleRunId, input.actorId, input.reason) as {
      authorization_ref: string;
      rejection_ref: string;
      workplace_ref: string;
      task_id: number;
      resulting_revision: number;
      loop_state: string;
    } | undefined;
    if (prior && prior.loop_state === 'queued') {
      db.exec('COMMIT');
      return {
        authorizationRef: prior.authorization_ref,
        rejectionRef: prior.rejection_ref,
        workplaceRef: prior.workplace_ref,
        taskId: prior.task_id,
        resultingRevision: prior.resulting_revision,
        replayed: true,
      };
    }

    const candidates = db.prepare(
      `SELECT lr.id AS lifecycle_run_id, sr.id AS stage_run_id,
              sr.process_run_id, w.workplace_ref, w.revision,
              w.next_role, w.active_reservation_ref, w.active_gate_ref,
              w.active_recovery_case_ref, t.id AS task_id, t.assigned_to,
              t.current_execution_id, t.metadata
         FROM factory_lifecycle_runs lr
         JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
         JOIN factory_workplaces w ON w.process_run_id=sr.process_run_id
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
        WHERE lr.id=? AND lr.status='paused' AND sr.status='paused'
          AND w.kanban_phase='blocked' AND w.loop_state='paused'`,
    ).all(input.lifecycleRunId) as Array<{
      lifecycle_run_id: number;
      stage_run_id: number;
      process_run_id: number;
      workplace_ref: string;
      revision: number;
      next_role: 'author' | 'reviewer';
      active_reservation_ref: string | null;
      active_gate_ref: string | null;
      active_recovery_case_ref: string | null;
      task_id: number;
      assigned_to: string | null;
      current_execution_id: string | null;
      metadata: string;
    }>;
    if (candidates.length !== 1) {
      throw new FactoryStartError(
        'FACTORY_PAUSED_WORKPLACE_NOT_UNIQUE',
        `lifecycle ${input.lifecycleRunId} resolves to ${candidates.length} blocked/paused workplaces; expected exactly one`,
      );
    }
    const candidate = candidates[0]!;
    if (
      candidate.next_role !== 'author'
      || candidate.active_reservation_ref
      || candidate.active_gate_ref
      || candidate.active_recovery_case_ref
      || candidate.assigned_to
      || candidate.current_execution_id
    ) {
      throw new FactoryStartError(
        'FACTORY_PAUSED_WORKPLACE_UNSAFE',
        `workplace ${candidate.workplace_ref} still has an actor/fence or is not an author repair`,
      );
    }
    const activeExecutions = (db.prepare(
      `SELECT COUNT(*) AS n FROM worker_executions
        WHERE task_id=? AND state IN ('reserved','running','cancel_requested')`,
    ).get(candidate.task_id) as { n: number }).n;
    const acceptedDone = (db.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts
        WHERE task_id=? AND command_kind='worker_done' AND accepted=1`,
    ).get(candidate.task_id) as { n: number }).n;
    const candidateSets = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_candidate_sets WHERE workplace_ref=?`,
    ).get(candidate.workplace_ref) as { n: number }).n;
    const gateDecisions = (db.prepare(
      `SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE workplace_ref=?`,
    ).get(candidate.workplace_ref) as { n: number }).n;
    if (activeExecutions !== 0 || acceptedDone !== 0 || candidateSets !== 0 || gateDecisions !== 0) {
      throw new FactoryStartError(
        'FACTORY_PAUSED_WORKPLACE_UNSAFE',
        `operator preflight recovery refuses active/completed/gated workplace ${candidate.workplace_ref}`,
      );
    }

    const metadata = parseMetadata(candidate.metadata);
    const feedback = metadata.recovery_feedback;
    if (
      !feedback
      || typeof feedback !== 'object'
      || Array.isArray(feedback)
      || (feedback as Record<string, unknown>).schemaVersion !== SUBMISSION_VALIDATION_FEEDBACK_SCHEMA
    ) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_FEEDBACK_REQUIRED',
        `task ${candidate.task_id} has no durable submission-validation recovery feedback`,
      );
    }
    const rejectionRef = (feedback as Record<string, unknown>).rejectionRef;
    const rejectionDigest = (feedback as Record<string, unknown>).rejectionDigest;
    if (typeof rejectionRef !== 'string' || typeof rejectionDigest !== 'string') {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_FEEDBACK_REQUIRED',
        `task ${candidate.task_id} recovery feedback has no rejection identity`,
      );
    }
    const rejection = db.prepare(
      `SELECT rejection_digest, observed_artifacts, observed_set_digest
         FROM factory_submission_validation_rejections
        WHERE rejection_ref=? AND task_id=?`,
    ).get(rejectionRef, candidate.task_id) as {
      rejection_digest: string;
      observed_artifacts: string;
      observed_set_digest: string;
    } | undefined;
    if (!rejection || rejection.rejection_digest !== rejectionDigest) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_FEEDBACK_REQUIRED',
        `recovery rejection ${rejectionRef} is missing or digest-mismatched`,
      );
    }
    verifyObservedArtifacts(db, rejection.observed_artifacts, rejection.observed_set_digest);

    const authorizationRef = `operator-recovery:${sha256Hex({
      lifecycleRunId: input.lifecycleRunId,
      workplaceRef: candidate.workplace_ref,
      expectedRevision: candidate.revision,
      rejectionRef,
      rejectionDigest,
      actorId: input.actorId,
      reason: input.reason,
    })}`;
    db.prepare(
      `INSERT INTO factory_operator_recovery_authorizations
         (authorization_ref, lifecycle_run_id, stage_run_id, process_run_id,
          workplace_ref, expected_revision, task_id, repair_role,
          rejection_ref, rejection_digest, actor_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'author', ?, ?, ?, ?)`,
    ).run(
      authorizationRef,
      input.lifecycleRunId,
      candidate.stage_run_id,
      candidate.process_run_id,
      candidate.workplace_ref,
      candidate.revision,
      candidate.task_id,
      rejectionRef,
      rejectionDigest,
      input.actorId,
      input.reason,
    );
    const resumed = new ConveyorRuntime(db).resumeFromHuman({
      workplaceRef: deserializeWorkplaceRef(candidate.workplace_ref),
      taskId: candidate.task_id,
      role: 'author',
    });
    if (!resumed.applied || resumed.workplace.revision !== candidate.revision + 1) {
      throw new FactoryStartError(
        'FACTORY_PAUSED_WORKPLACE_UNSAFE',
        `workplace ${candidate.workplace_ref} changed during operator recovery`,
      );
    }
    db.prepare(
      `INSERT INTO factory_operator_recovery_consumptions
         (authorization_ref, resulting_revision) VALUES (?, ?)`,
    ).run(authorizationRef, resumed.workplace.revision);
    db.exec('COMMIT');
    return {
      authorizationRef,
      rejectionRef,
      workplaceRef: candidate.workplace_ref,
      taskId: candidate.task_id,
      resultingRevision: resumed.workplace.revision,
      replayed: false,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

function failedGateRecoveryResult(
  row: Record<string, unknown>,
  replayed: boolean,
): FailedGateRecoveryResult {
  return {
    authorizationRef: String(row.authorization_ref),
    lifecycleRunId: Number(row.lifecycle_run_id),
    stageRunId: Number(row.stage_run_id),
    processRunId: Number(row.process_run_id),
    workplaceRef: String(row.workplace_ref),
    candidateSetRef: String(row.candidate_set_ref),
    abandonedGateRunRef: String(row.abandoned_gate_run_ref),
    replacementCheckPlanDigest: String(row.replacement_check_plan_digest),
    resultingLifecycleVersion: Number(row.resulting_lifecycle_version),
    replayed,
  };
}

function verifyCandidateSetDigest(
  db: Database.Database,
  row: Record<string, unknown>,
): void {
  const members = db.prepare(
    `SELECT product_schema,product_ref,product_digest,origin,source_candidate_set_ref
       FROM factory_candidate_set_members
      WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(row.candidate_set_ref) as Array<{
    product_schema: string;
    product_ref: string;
    product_digest: string;
    origin: string;
    source_candidate_set_ref: string | null;
  }>;
  if (members.length === 0) {
    throw new FactoryStartError(
      'FACTORY_FAILED_GATE_UNSAFE',
      `CandidateSet ${String(row.candidate_set_ref)} has no members`,
    );
  }
  const products = members.map(member => ({
    schemaId: member.product_schema,
    ref: member.product_ref,
    digest: member.product_digest,
  }));
  for (const product of products) {
    const stored = db.prepare(
      `SELECT 1 AS present FROM factory_process_products
        WHERE process_run_id=? AND schema_id=? AND artifact_ref=? AND product_hash=?`,
    ).get(row.process_run_id, product.schemaId, product.ref, product.digest);
    if (!stored) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
        `CandidateSet product ${product.ref} no longer matches the durable product store`,
      );
    }
  }
  const actualDigest = candidateSetDigestForRevision({
    workplaceRef: String(row.workplace_ref),
    productionRevisionRef: String(row.production_revision_ref),
    role: String(row.candidate_role) as 'author' | 'reviewer',
    subjectCandidateSetRef: row.subject_candidate_set_ref == null
      ? null
      : String(row.subject_candidate_set_ref),
  });
  if (actualDigest !== row.candidate_set_digest) {
    throw new FactoryStartError(
      'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
      `CandidateSet ${String(row.candidate_set_ref)} digest no longer verifies`,
    );
  }
}

function verifyAcceptedSubmissionSnapshot(
  db: Database.Database,
  row: Record<string, unknown>,
  plan: CheckPlan,
  expectedValidatorVersion: string,
): void {
  const revision = db.prepare(
    'SELECT members FROM factory_workplace_production_revisions WHERE revision_ref=?',
  ).get(row.production_revision_ref) as { members: string } | undefined;
  if (!revision) {
    throw new FactoryStartError('FACTORY_RECOVERY_SNAPSHOT_DRIFT', 'accepted production revision is missing');
  }
  const members = JSON.parse(revision.members) as Array<{
    memberKey: string; productRef: string; contentDigest: string;
  }>;
  const proofMembers = members.filter(member => member.memberKey.startsWith('validation/'));
  if (proofMembers.length !== 1) {
    throw new FactoryStartError(
      'FACTORY_FAILED_GATE_UNSAFE',
      `accepted production revision has ${proofMembers.length} validation proofs; expected exactly one`,
    );
  }
  const receiptId = Number(/^submission-validation-receipt:(\d+)$/.exec(proofMembers[0]!.productRef)?.[1]);
  const receipt = db.prepare(
    `SELECT id AS receipt_id,validator_id,validator_version,process_run_id,module_ref,node_id,
            input_snapshot_hash,artifact_ids,trace_ids,artifact_hashes,trace_digest,
            contract_ref,validated_set_digest
       FROM factory_submission_validation_receipts WHERE id=?`,
  ).get(receiptId) as {
    receipt_id: number;
    validator_id: string;
    validator_version: string;
    process_run_id: number;
    module_ref: string;
    node_id: string;
    input_snapshot_hash: string;
    artifact_ids: string;
    trace_ids: string;
    artifact_hashes: string;
    trace_digest: string;
    contract_ref: string | null;
    validated_set_digest: string;
  } | undefined;
  if (!receipt) {
    throw new FactoryStartError(
      'FACTORY_FAILED_GATE_UNSAFE',
      'accepted production revision validation proof does not resolve',
    );
  }
  const providerId = `factory.submission-validator.${receipt.validator_id}`;
  const declaredProvider = plan.entries.find(entry => entry.check.providerId === providerId);
  if (
    !declaredProvider
    || declaredProvider.check.version !== expectedValidatorVersion
    || receipt.input_snapshot_hash !== receipt.validated_set_digest
  ) {
    throw new FactoryStartError(
      'FACTORY_FAILED_GATE_PLAN_INVALID',
      'accepted submission receipt is not pinned to the replacement validator',
    );
  }
  const artifactIds = JSON.parse(receipt.artifact_ids) as unknown;
  const traceIds = JSON.parse(receipt.trace_ids) as unknown;
  const artifactHashes = JSON.parse(receipt.artifact_hashes) as unknown;
  if (
    !Array.isArray(artifactIds)
    || !artifactHashes
    || typeof artifactHashes !== 'object'
    || Array.isArray(artifactHashes)
    || artifactIds.length === 0
  ) {
    throw new FactoryStartError(
      'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
      'accepted submission artifact snapshot is malformed',
    );
  }
  const projection: SubmissionValidationReceiptProjection = {
    receiptId: receipt.receipt_id,
    validatorId: receipt.validator_id,
    validatorVersion: receipt.validator_version,
    processRunId: receipt.process_run_id,
    moduleRef: receipt.module_ref,
    nodeId: receipt.node_id,
    inputSnapshotHash: receipt.input_snapshot_hash,
    artifactIds: artifactIds as number[],
    traceIds: Array.isArray(traceIds) ? traceIds as number[] : [],
    artifactHashes: artifactHashes as Record<string, string>,
    traceDigest: receipt.trace_digest,
    contractRef: receipt.contract_ref === null ? null : JSON.parse(receipt.contract_ref),
    validatedSetDigest: receipt.validated_set_digest,
  };
  if (
    proofMembers[0]!.memberKey !== submissionValidationMemberKey(projection)
    || proofMembers[0]!.contentDigest !== submissionValidationContentDigest(projection)
  ) {
    throw new FactoryStartError(
      'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
      'accepted production revision validation proof digest no longer verifies',
    );
  }
  for (const rawId of artifactIds) {
    const artifactId = Number(rawId);
    const expectedHash = (artifactHashes as Record<string, unknown>)[String(artifactId)];
    if (typeof expectedHash !== 'string' || !expectedHash) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
        `accepted submission has no hash for artifact ${artifactId}`,
      );
    }
    const artifact = db.prepare(
      `SELECT a.path,a.content_hash,a.storage_kind,pr.local_path
         FROM artifacts a
         LEFT JOIN project_repositories pr ON pr.id=a.project_repository_id
        WHERE a.id=?`,
    ).get(artifactId) as {
      path: string;
      content_hash: string | null;
      storage_kind: string;
      local_path: string | null;
    } | undefined;
    if (!artifact || artifact.content_hash !== expectedHash) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
        `artifact ${artifactId} changed after accepted submission`,
      );
    }
    if (artifact.storage_kind === 'file_backed') {
      if (!artifact.local_path) {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `file-backed artifact ${artifactId} has no repository binding`,
        );
      }
      const filePath = path.join(artifact.local_path, artifact.path.split('#')[0]!);
      if (
        !existsSync(filePath)
        || createHash('sha256').update(readFileSync(filePath)).digest('hex') !== expectedHash
      ) {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `artifact ${artifactId} file bytes changed after accepted submission`,
        );
      }
    }
  }
}

function verifyObservedArtifacts(
  db: Database.Database,
  observedJson: string,
  expectedDigest: string,
): void {
  const observed = JSON.parse(observedJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(observed) || sha256Hex(observed) !== expectedDigest) {
    throw new FactoryStartError(
      'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
      'the durable rejection artifact snapshot is malformed or digest-mismatched',
    );
  }
  for (const prior of observed) {
    const id = Number(prior.id);
    const current = db.prepare(
      `SELECT a.id, a.type, a.code, a.path, a.status, a.content_hash,
              a.accepted_hash, a.storage_kind, a.project_repository_id,
              pr.local_path
         FROM artifacts a
         LEFT JOIN project_repositories pr ON pr.id=a.project_repository_id
        WHERE a.id=?`,
    ).get(id) as Record<string, unknown> | undefined;
    if (!current) {
      throw new FactoryStartError(
        'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
        `artifact ${id} no longer exists`,
      );
    }
    for (const key of [
      'id', 'type', 'code', 'path', 'status', 'content_hash', 'accepted_hash',
      'storage_kind', 'project_repository_id',
    ]) {
      if (current[key] !== prior[key]) {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `artifact ${id} changed after rejection (${key})`,
        );
      }
    }
    if (current.storage_kind === 'file_backed') {
      if (typeof current.local_path !== 'string' || typeof current.path !== 'string') {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `file-backed artifact ${id} has no repository path`,
        );
      }
      const filePath = path.join(current.local_path, current.path.split('#')[0]!);
      if (!existsSync(filePath)) {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `artifact ${id} file is missing: ${filePath}`,
        );
      }
      const diskHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      if (diskHash !== current.content_hash) {
        throw new FactoryStartError(
          'FACTORY_RECOVERY_SNAPSHOT_DRIFT',
          `artifact ${id} file hash changed after rejection`,
        );
      }
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
