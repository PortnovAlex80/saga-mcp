// src/tools/observations.ts
//
// REQ-011 — CGAD §4 third truth axis + §17 Runtime Observation Store.
//
// Provides tools to record and query immutable runtime observations:
//   - observation_record: append a new observation (benchmark, canary,
//     shadow, incident, runtime_metric, integration_output). Cannot mutate
//     the acceptance oracle — there is no UPDATE path, only INSERT.
//   - observation_list: query observations by epic / task / artifact / type.
//
// CGAD P17 invariant: runtime observation cannot change the declared truth.
// This file enforces that structurally: no UPDATE or DELETE is exposed.
// A drift between Observed and Declared is itself a finding — record it
// here, then update the oracle via a NEW accepted artifact (separate flow).

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

const OBSERVATION_TYPES = [
  'benchmark', 'canary', 'shadow', 'incident',
  'runtime_metric', 'integration_output', 'other',
] as const;
type ObservationType = typeof OBSERVATION_TYPES[number];

function handleObservationRecord(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const taskId = args.task_id as number | undefined;
  const artifactId = args.artifact_id as number | undefined;
  const observationType = args.observation_type as ObservationType;
  const observedValue = args.observed_value as string;
  const baselineValue = (args.baseline_value as string | undefined) ?? null;
  const contentHash = (args.content_hash as string | undefined) ?? null;
  const observedBy = (args.observed_by as string | undefined) ?? null;
  const metadata = JSON.stringify((args.metadata as Record<string, unknown>) ?? {});

  if (!OBSERVATION_TYPES.includes(observationType)) {
    throw new Error(`Invalid observation_type '${observationType}' (expected one of: ${OBSERVATION_TYPES.join(', ')})`);
  }
  if (!observedValue?.trim()) {
    throw new Error('observed_value is required (the observation itself)');
  }
  if (epicId == null && taskId == null && artifactId == null) {
    throw new Error('At least one of epic_id, task_id, artifact_id must be provided to scope the observation');
  }

  // Cross-validate: if task_id is given, it must belong to the epic_id (if both given).
  if (epicId != null && taskId != null) {
    const task = db.prepare('SELECT epic_id FROM tasks WHERE id=?').get(taskId) as { epic_id: number } | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.epic_id !== epicId) {
      throw new Error(`Task ${taskId} belongs to epic ${task.epic_id}, not ${epicId}`);
    }
  }
  // Cross-validate artifact scope if both epic and artifact given.
  if (epicId != null && artifactId != null) {
    const artifact = db.prepare('SELECT epic_id FROM artifacts WHERE id=?').get(artifactId) as { epic_id: number } | undefined;
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    if (artifact.epic_id !== epicId) {
      throw new Error(`Artifact ${artifactId} belongs to epic ${artifact.epic_id}, not ${epicId}`);
    }
  }

  // CGAD P17 invariant: this tool cannot change the acceptance oracle.
  // We do not call refreshArtifactHash, we do not UPDATE artifacts.accepted_hash,
  // we do not flip artifact.status. The observation is recorded as-is; if it
  // contradicts the oracle, the human decides whether to supersede the artifact
  // through the normal artifact_update flow.

  const info = db.prepare(
    `INSERT INTO runtime_observations
       (epic_id, task_id, artifact_id, observation_type, observed_value,
        baseline_value, content_hash, observed_by, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(
    epicId ?? null, taskId ?? null, artifactId ?? null,
    observationType, observedValue, baselineValue,
    contentHash, observedBy, metadata,
  );

  const row = info as { id: number };
  logActivity(db, 'task', taskId ?? 0, 'created', 'runtime_observation', null, observationType,
    `Runtime observation #${row.id} (${observationType}) recorded` +
    (artifactId ? ` against artifact ${artifactId}` : '') +
    (taskId ? ` for task ${taskId}` : ''));
  return info;
}

function handleObservationList(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const taskId = args.task_id as number | undefined;
  const artifactId = args.artifact_id as number | undefined;
  const observationType = args.observation_type as ObservationType | undefined;
  const limit = Math.min(Math.max((args.limit as number | undefined) ?? 50, 1), 200);

  const where: string[] = [];
  const params: unknown[] = [];
  if (epicId != null) { where.push('epic_id=?'); params.push(epicId); }
  if (taskId != null) { where.push('task_id=?'); params.push(taskId); }
  if (artifactId != null) { where.push('artifact_id=?'); params.push(artifactId); }
  if (observationType != null) {
    if (!OBSERVATION_TYPES.includes(observationType)) {
      throw new Error(`Invalid observation_type '${observationType}'`);
    }
    where.push('observation_type=?'); params.push(observationType);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM runtime_observations ${whereClause} ORDER BY id DESC LIMIT ?`,
  ).all(...params, limit);
  return { observations: rows, count: rows.length };
}

export const definitions: Tool[] = [
  {
    name: 'observation_record',
    description: 'REQ-011 — Record an immutable runtime observation (CGAD §4 third truth axis). Observation types: benchmark/canary/shadow/incident/runtime_metric/integration_output/other. Append-only: cannot mutate the acceptance oracle (CGAD P17). Use a new artifact supersede to update the oracle if observation contradicts it.',
    annotations: { title: 'Observation: Record', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Epic scope (one of epic_id/task_id/artifact_id is required)' },
        task_id: { type: 'integer' },
        artifact_id: { type: 'integer', description: 'If the observation concerns an accepted artifact (e.g. observed runtime vs declared contract)' },
        observation_type: { type: 'string', enum: [...OBSERVATION_TYPES] },
        observed_value: { type: 'string', description: 'The observation itself (free-form — number, JSON, prose)' },
        baseline_value: { type: 'string', description: 'Optional baseline this observation is compared against (e.g. previous benchmark)' },
        content_hash: { type: 'string', description: 'Optional hash of the artefact version observed (for reproducibility)' },
        observed_by: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['observation_type', 'observed_value'],
    },
  },
  {
    name: 'observation_list',
    description: 'REQ-011 — List runtime observations, optionally filtered by epic/task/artifact/type.',
    annotations: { title: 'Observation: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer' },
        task_id: { type: 'integer' },
        artifact_id: { type: 'integer' },
        observation_type: { type: 'string', enum: [...OBSERVATION_TYPES] },
        limit: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  observation_record: handleObservationRecord,
  observation_list: handleObservationList,
};
