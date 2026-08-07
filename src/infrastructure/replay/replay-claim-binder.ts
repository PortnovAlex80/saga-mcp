import type Database from 'better-sqlite3';
import type { Task } from '../../types.js';
import { executionContextHash } from '../../shared/authority/execution-context.js';
import {
  REPLAY_POLICY_DIGEST,
  REPLAY_POLICY_REF,
  computeReplayKey,
  type ReplayClaimSelection,
  type ReplayKeyMaterial,
} from '../../replay/replay-capsule.js';
import {
  ensureReplayCapsuleSchema,
  SqliteReplayCapsuleRepository,
} from './sqlite-replay-capsule-repository.js';

function metadataObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function resolveReplayKeyMaterial(
  db: Database.Database,
  task: Task,
  role: 'author' | 'reviewer',
): ReplayKeyMaterial | null {
  const metadata = metadataObject(task.metadata);
  const processRunId = Number(metadata.process_run_id);
  const nodeId = requiredString(metadata.process_node_id);
  const moduleRef = requiredString(metadata.process_module_ref);
  const productionCellId = requiredString(metadata.production_cell_id);
  const workKey = requiredString(metadata.work_key);
  const nodeInputHash = requiredString(metadata.process_node_input_hash);
  if (!Number.isSafeInteger(processRunId) || processRunId <= 0
      || !nodeId || !moduleRef || !productionCellId || !workKey || !nodeInputHash) {
    return null;
  }
  const run = db.prepare(
    'SELECT project_id,package_digest FROM factory_process_runs WHERE id=?',
  ).get(processRunId) as { project_id: number; package_digest: string | null } | undefined;
  if (!run?.package_digest) return null;

  let subjectCandidateDigest: string | null = null;
  if (role === 'reviewer') {
    if (!task.workplace_ref) return null;
    const subject = db.prepare(
      `SELECT candidate_set_digest
         FROM factory_candidate_sets
        WHERE workplace_ref=? AND role='author'
        ORDER BY sealed_at DESC,candidate_set_ref DESC LIMIT 1`,
    ).get(task.workplace_ref) as { candidate_set_digest: string } | undefined;
    if (!subject) return null;
    subjectCandidateDigest = subject.candidate_set_digest;
  }

  return {
    projectId: run.project_id,
    moduleRef,
    nodeId,
    productionCellId,
    workKey,
    role,
    packageDigest: run.package_digest,
    nodeInputHash,
    subjectCandidateDigest,
  };
}

/**
 * Materialize missing replay capsules only from already-authoritative factory
 * state. This function is intentionally invoked at the pre-spawn assignment
 * boundary, after the claim transaction has committed and before the next
 * capsule lookup.
 *
 * A CandidateSet is certifiable only when its Workplace is durably
 * `terminal(accepted)`. For a reviewed cell that means BOTH the author set and
 * the reviewer assessment set become eligible together, after the final gate
 * transition. Rejected, repair, paused, stale-decision and merely author-gate-
 * accepted candidates never enter the replay corpus.
 *
 * The sweep is idempotent because capsule identity is content addressed and the
 * repository has uniqueness guards. Capture failure is best-effort: replay is
 * an optimization and cannot revoke an already accepted factory transition.
 */
export function certifyAcceptedReplayCapsules(
  db: Database.Database,
  projectId: number,
): void {
  ensureReplayCapsuleSchema(db);
  const repo = new SqliteReplayCapsuleRepository(db);
  const candidates = db.prepare(
    `SELECT cs.candidate_set_ref,cs.producer_execution_ref,cs.role
       FROM factory_candidate_sets cs
       JOIN factory_workplaces w
         ON w.workplace_ref=cs.workplace_ref
       JOIN factory_process_runs pr
         ON pr.id=w.process_run_id
       LEFT JOIN factory_replay_capsules rc
         ON rc.source_execution_ref=cs.producer_execution_ref
        AND rc.source_candidate_set_ref=cs.candidate_set_ref
      WHERE pr.project_id=?
        AND w.loop_state='terminal'
        AND w.terminal_reason='accepted'
        AND rc.id IS NULL
      ORDER BY cs.sealed_at,cs.candidate_set_ref`,
  ).all(projectId) as Array<{
    candidate_set_ref: string;
    producer_execution_ref: string;
    role: 'author' | 'reviewer';
  }>;

  for (const candidate of candidates) {
    try {
      repo.captureAcceptedExecution({
        executionRef: candidate.producer_execution_ref,
        candidateSetRef: candidate.candidate_set_ref,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[replay-certification] skipped candidate=${candidate.candidate_set_ref} `
        + `execution=${candidate.producer_execution_ref} role=${candidate.role}: ${message}\n`,
      );
    }
  }
}

/**
 * Final pre-spawn step for a fenced assignment.
 *
 * Before lookup, archive any accepted production from earlier cells/runs that
 * has not yet been materialized into capsules. This gives replay a crash-safe
 * certification boundary without a second orchestration mode or a pending
 * capture aggregate.
 *
 * Miss: freeze the replay key and leave the front-selected LLM route untouched.
 * Hit: freeze the exact capsule and switch only THIS WorkerExecution to the
 * existing deterministic CLI-compatible executor. The project's selected model
 * remains stored in lifecycle controls for future misses; replay is not a model
 * selection and does not alter workshop model inheritance.
 */
export function bindReplayToClaim(
  db: Database.Database,
  input: {
    task: Task;
    executionId: string;
    role: 'author' | 'reviewer';
  },
): ReplayClaimSelection | null {
  ensureReplayCapsuleSchema(db);
  const keyMaterial = resolveReplayKeyMaterial(db, input.task, input.role);
  if (!keyMaterial) return null;

  // The work assignment adapter calls this after its IMMEDIATE claim
  // transaction commits, so filesystem/Git capture cannot hold the claim lock.
  certifyAcceptedReplayCapsules(db, keyMaterial.projectId);

  const replayKey = computeReplayKey(keyMaterial);
  const capsule = db.prepare(
    `SELECT capsule_ref,payload_hash
       FROM factory_replay_capsules
      WHERE project_id=? AND replay_key=?
      ORDER BY id DESC LIMIT 1`,
  ).get(keyMaterial.projectId, replayKey) as {
    capsule_ref: string;
    payload_hash: string;
  } | undefined;

  const execution = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(input.executionId) as { metadata: string } | undefined;
  if (!execution) throw new Error(`REPLAY_BIND_EXECUTION_NOT_FOUND: ${input.executionId}`);
  const envelope = metadataObject(execution.metadata);
  const context = metadataObject(envelope.execution_context);
  if (Object.keys(context).length === 0) {
    throw new Error(`REPLAY_BIND_EXECUTION_CONTEXT_MISSING: ${input.executionId}`);
  }

  context.replay = {
    key: replayKey,
    key_material: keyMaterial,
    capsule_ref: capsule?.capsule_ref ?? null,
    capsule_payload_hash: capsule?.payload_hash ?? null,
  };
  if (capsule) {
    context.executor_kind = 'claude-cli-simulator';
    context.model_route = { provider: null, model: null, effort: null };
    context.route_policy = {
      ref: REPLAY_POLICY_REF,
      digest: REPLAY_POLICY_DIGEST,
    };
  }
  envelope.execution_context = context;
  envelope.execution_context_hash = executionContextHash(context);
  db.prepare('UPDATE worker_executions SET metadata=? WHERE execution_id=?')
    .run(JSON.stringify(envelope), input.executionId);

  return {
    replayKey,
    capsuleRef: capsule?.capsule_ref ?? null,
    capsulePayloadHash: capsule?.payload_hash ?? null,
  };
}
