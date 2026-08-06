import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { assertExecutionFence } from '../worker-executions.js';
import type { ToolHandler } from '../types.js';

// episode_transition) and all their supporting helpers (STAGES, NEXT,
// NEXT_FAST_TRACK, nextStageForTrack, ensureEpic, getOrCreate, acceptedBaseline,
// assertTasksReady, assertTraceability, assertVerificationPassed) were REMOVED.
//
// could move episode_workflows.stage in parallel with the Lifecycle Orchestrator
// — violating rule 1 (one lifecycle authority) and rule 2 ("episode_transition
// as an execution mechanism" must be deleted). Stage advancement is now
// exclusively a module-owned settlement decision routed through the Lifecycle
// Orchestrator; no MCP tool, worker tool, or frontend route may mutate
// episode_workflows.stage. The verification_record tool below is KEPT — it is
// CGAD evidence recording, unrelated to the stage machine.

function handleVerificationRecord(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const artifactId = args.artifact_id as number;
  // REQ-008 — CGAD 4-valued guard verdict. Only 'passed' admits a transition
  // (see assertVerificationPassed: WHERE outcome='passed'). 'failed' blocks.
  // 'unknown' = inputs insufficient, deny-by-default (P14). 'error' = provider
  // or check crashed, deny AND the caller should file an Incident (P8 visibility).
  const outcome = args.outcome as 'passed' | 'failed' | 'unknown' | 'error';
  const evidence = args.evidence as string;
  const recordedBy = (args.recorded_by as string | undefined) ?? null;
  const provider = (args.provider as string | undefined) ?? null;
  if (!['passed', 'failed', 'unknown', 'error'].includes(outcome)) {
    throw new Error(`Invalid verification outcome '${outcome}' (expected passed/failed/unknown/error)`);
  }
  if (!evidence?.trim()) throw new Error('Verification evidence is required');

  const task = db.prepare(
    `SELECT id, epic_id, task_kind, status, assigned_to, current_execution_id,
            verification_target_artifact_id
     FROM tasks WHERE id=?`,
  ).get(taskId) as
    | {
        id: number; epic_id: number; task_kind: string | null; status: string;
        assigned_to: string | null; current_execution_id: string | null;
        verification_target_artifact_id: number | null;
      }
    | undefined;
  const artifact = db.prepare(
    `SELECT id, epic_id, type, accepted_hash, status FROM artifacts WHERE id=?`,
  ).get(artifactId) as
    | { id: number; epic_id: number; type: string; accepted_hash: string | null; status: string }
    | undefined;
  if (!task || task.task_kind !== 'verification.ac') throw new Error(`Task ${taskId} is not a verification.ac task`);
  assertExecutionFence(db, task, args.execution_id);
  if (!recordedBy || task.assigned_to !== recordedBy || !['in_progress', 'review_in_progress'].includes(task.status)) {
    throw new Error(`Verification evidence requires recorded_by to hold active task ${taskId}`);
  }
  if (!artifact || artifact.type !== 'AC' || artifact.epic_id !== task.epic_id) {
    throw new Error(`Artifact ${artifactId} is not an AC in task ${taskId}'s episode`);
  }
  let targetArtifactId = task.verification_target_artifact_id;
  if (targetArtifactId === null) {
    throw new Error(
      `Verification task ${taskId} has no canonical AC target; recreate it with exactly one source_artifact_id`,
    );
  }
  if (artifactId !== targetArtifactId) {
    throw new Error(
      `Verification task ${taskId} targets AC ${targetArtifactId}, not AC ${artifactId}; ` +
      'cross-verification is forbidden',
    );
  }
  if (artifact.status !== 'accepted' || !artifact.accepted_hash) {
    throw new Error(`AC ${artifactId} has no accepted baseline hash`);
  }
  const contentHash = (args.content_hash as string | undefined) ?? artifact.accepted_hash;
  if (outcome === 'passed' && contentHash !== artifact.accepted_hash) {
    throw new Error(`Passing evidence hash does not match AC ${artifactId} accepted baseline`);
  }
  const info = db.prepare(
    `INSERT OR IGNORE INTO verification_evidence
       (task_id, artifact_id, outcome, evidence, content_hash, recorded_by, provider, execution_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId, artifactId, outcome, evidence, contentHash, recordedBy, provider,
    (args.execution_id as string | undefined) ?? null,
  );
  const row = db.prepare(
    `SELECT * FROM verification_evidence
     WHERE task_id=? AND artifact_id=? AND content_hash=? AND execution_id IS ?`,
  ).get(taskId, artifactId, contentHash, (args.execution_id as string | undefined) ?? null);
  if (outcome === 'passed') {
    db.prepare(
      `INSERT OR IGNORE INTO artifact_traces (source_id,target_type,target_id,link_type)
       VALUES (?,'task',?,'verified_by')`,
    ).run(artifactId, taskId);
  }
  logActivity(db, 'task', taskId, info.changes ? 'created' : 'updated', 'verification_evidence', null, outcome,
    `Verification ${outcome} recorded for AC #${artifactId} by task #${taskId}`);
  return row;
}

export const definitions: Tool[] = [
  {
    name: 'verification_record',
    description:
      'Record immutable evidence for an accepted AC baseline using CGAD 4-valued verdict (passed/failed/unknown/error). Only passing evidence creates verified_by; unknown and error are denials (CGAD P14). ' +
      'Call shape: verification_record({ task_id: <integer (a verification.ac task you hold)>, artifact_id: <integer (the AC you are verifying)>, outcome: "passed|failed|unknown|error", evidence: "<string>", recorded_by: "<string (your worker_id, must equal task.assigned_to)>", content_hash: "<string (defaults to AC accepted_hash)>", provider: "<string>", execution_id: "<string (fencing token)>" }). Required: task_id, artifact_id, outcome, evidence.',
    annotations: { title: 'Verification: Record Evidence', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer' },
        artifact_id: { type: 'integer' },
        outcome: { type: 'string', enum: ['passed', 'failed', 'unknown', 'error'] },
        evidence: { type: 'string' },
        content_hash: { type: 'string' },
        recorded_by: { type: 'string' },
        provider: { type: 'string', description: 'CGAD Trusted Guard Input Provider identity (e.g. "test_runner", "cgad-spec-lint", "human_approval"). Optional in v1; required once provider registry (REQ-012) is wired.' },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'artifact_id', 'outcome', 'evidence'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  verification_record: handleVerificationRecord,
};
