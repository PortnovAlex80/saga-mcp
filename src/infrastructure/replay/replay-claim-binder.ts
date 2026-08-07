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
import { ensureReplayCapsuleSchema } from './sqlite-replay-capsule-repository.js';

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

/**
 * Compute the replay identity entirely from server-authored durable bindings.
 * No model output, live prompt text or moving task status participates.
 */
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
 * Final pre-spawn step for a fenced assignment.
 *
 * Miss: freeze the replay key and leave the front-selected LLM route untouched.
 * Hit: freeze the exact capsule and switch only THIS WorkerExecution to the
 * deterministic replay executor. The project's selected model remains stored
 * in lifecycle controls for future misses; replay is not a model selection.
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
    context.executor_kind = 'factory-replay';
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
