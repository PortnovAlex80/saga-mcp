import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { assertExecutionFence } from '../worker-executions.js';
import type { ToolHandler } from '../types.js';
import { refreshArtifactHash } from '../helpers/artifact-file.js';

const STAGES = [
  'discovery', 'formalization', 'planning', 'development',
  'verification', 'integration', 'completed', 'cancelled',
] as const;
type Stage = typeof STAGES[number];

const NEXT: Partial<Record<Stage, Stage>> = {
  discovery: 'formalization',
  formalization: 'planning',
  planning: 'development',
  development: 'verification',
  verification: 'integration',
  integration: 'completed',
};

function ensureEpic(epicId: number): void {
  const epic = getDb().prepare('SELECT id FROM epics WHERE id=?').get(epicId);
  if (!epic) throw new Error(`Epic ${epicId} not found`);
}

function getOrCreate(epicId: number) {
  const db = getDb();
  ensureEpic(epicId);
  db.prepare('INSERT OR IGNORE INTO episode_workflows (epic_id) VALUES (?)').run(epicId);
  return db.prepare('SELECT * FROM episode_workflows WHERE epic_id=?').get(epicId) as {
    epic_id: number; stage: Stage; track: 'formal' | 'fast-track';
    baseline_artifact_id: number | null;
    baseline_hash: string | null; metadata: string; created_at: string; updated_at: string;
  };
}

function acceptedBaseline(epicId: number) {
  const db = getDb();
  const ids = db.prepare('SELECT id FROM artifacts WHERE epic_id=?').all(epicId) as Array<{ id: number }>;
  for (const row of ids) refreshArtifactHash(db, row.id);
  const all = db.prepare(
    `SELECT id, code, status, content_hash, accepted_hash, drift_state
     FROM artifacts WHERE epic_id=? AND type='AC' ORDER BY id`,
  ).all(epicId) as Array<{
    id: number; code: string | null; status: string;
    content_hash: string | null; accepted_hash: string | null; drift_state: string;
  }>;
  if (all.length === 0) throw new Error('Planning gate failed: episode has no AC artifacts');
  const invalid = all.filter(a =>
    a.status !== 'accepted' || !a.accepted_hash || !a.content_hash
    || a.accepted_hash !== a.content_hash || a.drift_state !== 'clean');
  if (invalid.length) {
    throw new Error(
      `Planning gate failed: AC baseline is not accepted and clean: ${invalid.map(a => a.code ?? `#${a.id}`).join(', ')}`,
    );
  }
  const digest = createHash('sha256')
    .update(all.map(a => `${a.id}:${a.accepted_hash}`).join('\n'))
    .digest('hex');
  return { artifacts: all, hash: digest };
}

function assertTasksReady(epicId: number, stage: string): void {
  const rows = getDb().prepare(
    `SELECT id, execution_mode, status, integration_state, task_kind
     FROM tasks WHERE epic_id=? AND workflow_stage=?`,
  ).all(epicId, stage) as Array<{
    id: number; execution_mode: string; status: string; integration_state: string; task_kind: string | null;
  }>;
  if (rows.length === 0) throw new Error(`${stage} gate failed: no ${stage} tasks exist`);
  // Exclude summary.stage and recovery.heal tasks — they are bookkeeping,
  // not pipeline deliverables. They should NOT block episode transitions.
  const gateable = rows.filter(t =>
    t.task_kind !== 'summary.stage' && t.task_kind !== 'recovery.heal');
  if (gateable.length === 0) {
    throw new Error(`${stage} gate failed: no ${stage} tasks exist (excluding summary/recovery)`);
  }
  const invalid = gateable.filter(t =>
    t.status !== 'done'
    || (t.execution_mode === 'git_change' && t.integration_state !== 'merged'));
  if (invalid.length) {
    throw new Error(`${stage} gate failed: tasks not completed/integrated: ${invalid.map(t => `#${t.id}`).join(', ')}`);
  }
}

/**
 * Traceability gate for formalization → planning transition.
 *
 * Verifies the canonical lineage edges exist in artifact_traces:
 *   - PRD      has outgoing `derived_from` → brief
 *   - SRS      has outgoing `derived_from` → PRD
 *   - Each UC  has outgoing `covers` → ≥1 FR  AND `derived_from` → PRD
 *   - Each AC  has outgoing `derived_from` → ≥1 UC  AND ≥1 FR/NFR
 *
 * Producer-skills (saga-product/architect/analyst) create these edges
 * via trace_add at artifact creation time. Without this gate, an episode
 * could advance to planning with PRD/SRS/UC never linked to their parents
 * — the traceability graph would be silently broken, and later queries
 * (artifact_coverage, tree view) would show orphan nodes.
 *
 * The gate reports the FIRST gap it finds (clear error vs. a wall of text).
 * Saga-reconciler task is the recovery path: it can trace_add missing edges.
 *
 * Note: artifact_traces.target_type is polymorphic — for formalization
 * lineage all targets are artifacts, so we JOIN artifacts t on target_id.
 */
function assertTraceability(epicId: number): void {
  const db = getDb();

  // Helper: does artifact `srcId` have an outgoing edge with given link_type
  // to any artifact of given target_type (within this epic)?
  const hasEdge = (
    srcId: number, linkType: 'derived_from' | 'covers',
    targetType: 'brief' | 'PRD' | 'UC' | 'FR' | 'NFR',
  ): boolean => {
    const row = db.prepare(
      `SELECT 1 FROM artifact_traces at
        JOIN artifacts t ON t.id = at.target_id
       WHERE at.source_id = ?
         AND at.link_type = ?
         AND t.epic_id = ?
         AND t.type = ?
       LIMIT 1`,
    ).get(srcId, linkType, epicId, targetType);
    return !!row;
  };

  // Helper: does artifact `srcId` have an outgoing edge with given link_type
  // to ≥1 artifact of ANY of the given target_types?
  const hasEdgeToAny = (
    srcId: number, linkType: 'derived_from' | 'covers',
    targetTypes: Array<'UC' | 'FR' | 'NFR'>,
  ): boolean => {
    if (targetTypes.length === 0) return false;
    const placeholders = targetTypes.map(() => '?').join(',');
    const row = db.prepare(
      `SELECT 1 FROM artifact_traces at
        JOIN artifacts t ON t.id = at.target_id
       WHERE at.source_id = ?
         AND at.link_type = ?
         AND t.epic_id = ?
         AND t.type IN (${placeholders})
       LIMIT 1`,
    ).get(srcId, linkType, epicId, ...targetTypes);
    return !!row;
  };

  // 1. PRD → brief (derived_from)
  const prd = db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type='PRD' ORDER BY id LIMIT 1`,
  ).get(epicId) as { id: number } | undefined;
  if (prd && !hasEdge(prd.id, 'derived_from', 'brief')) {
    throw new Error(
      `Traceability gate failed: PRD #${prd.id} has no outgoing 'derived_from' trace to a brief artifact. ` +
      `saga-product must call trace_add(PRD → brief, 'derived_from') at artifact creation.`,
    );
  }

  // 2. SRS → PRD (derived_from)
  const srs = db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type='SRS' ORDER BY id LIMIT 1`,
  ).get(epicId) as { id: number } | undefined;
  if (srs && !hasEdge(srs.id, 'derived_from', 'PRD')) {
    throw new Error(
      `Traceability gate failed: SRS #${srs.id} has no outgoing 'derived_from' trace to PRD. ` +
      `saga-architect must call trace_add(SRS → PRD, 'derived_from') at artifact creation.`,
    );
  }

  // 3. Each UC → PRD (derived_from) AND ≥1 FR (covers)
  const ucs = db.prepare(
    `SELECT id, code FROM artifacts WHERE epic_id=? AND type='UC' ORDER BY id`,
  ).all(epicId) as Array<{ id: number; code: string | null }>;
  for (const uc of ucs) {
    if (!hasEdge(uc.id, 'derived_from', 'PRD')) {
      throw new Error(
        `Traceability gate failed: UC ${uc.code ?? `#${uc.id}`} has no 'derived_from' trace to PRD. ` +
        `saga-analyst must call trace_add(UC → PRD, 'derived_from') at artifact creation.`,
      );
    }
    if (!hasEdge(uc.id, 'covers', 'FR')) {
      throw new Error(
        `Traceability gate failed: UC ${uc.code ?? `#${uc.id}`} has no 'covers' trace to any FR. ` +
        `Every UC must cover at least one FR (trace_add(UC → FR, 'covers')).`,
      );
    }
  }

  // 4. Each AC → ≥1 UC (derived_from) AND ≥1 FR/NFR (derived_from)
  const acs = db.prepare(
    `SELECT id, code FROM artifacts WHERE epic_id=? AND type='AC' ORDER BY id`,
  ).all(epicId) as Array<{ id: number; code: string | null }>;
  for (const ac of acs) {
    if (!hasEdge(ac.id, 'derived_from', 'UC')) {
      throw new Error(
        `Traceability gate failed: AC ${ac.code ?? `#${ac.id}`} has no 'derived_from' trace to any UC. ` +
        `saga-analyst must call trace_add(AC → UC, 'derived_from') at artifact creation.`,
      );
    }
    if (!hasEdgeToAny(ac.id, 'derived_from', ['FR', 'NFR'])) {
      throw new Error(
        `Traceability gate failed: AC ${ac.code ?? `#${ac.id}`} has no 'derived_from' trace to any FR or NFR. ` +
        `Every AC must derive from at least one FR or NFR (trace_add(AC → FR/NFR, 'derived_from')).`,
      );
    }
  }
}

function assertVerificationPassed(epicId: number): void {
  const missing = getDb().prepare(
    `SELECT a.id, a.code
     FROM artifacts a
     WHERE a.epic_id=? AND a.type='AC' AND a.status='accepted'
       AND NOT EXISTS (
         SELECT 1 FROM verification_evidence v
         WHERE v.artifact_id=a.id AND v.outcome='passed'
           AND v.content_hash=a.accepted_hash
       )`,
  ).all(epicId) as Array<{ id: number; code: string | null }>;
  if (missing.length) {
    throw new Error(`Verification gate failed: no passing baseline evidence for ${missing.map(a => a.code ?? `#${a.id}`).join(', ')}`);
  }
}

function handleEpisodeStatus(args: Record<string, unknown>) {
  const epicId = args.epic_id as number;
  const db = getDb();
  const artifactIds = db.prepare('SELECT id FROM artifacts WHERE epic_id=?').all(epicId) as Array<{ id: number }>;
  for (const row of artifactIds) refreshArtifactHash(db, row.id);
  const workflow = getOrCreate(epicId);
  const counts = db.prepare(
    `SELECT workflow_stage AS stage, status, count(*) AS count
     FROM tasks WHERE epic_id=? AND workflow_stage IS NOT NULL
     GROUP BY workflow_stage, status`,
  ).all(epicId);
  const drift = db.prepare(
    `SELECT count(*) AS count FROM artifacts
     WHERE epic_id=? AND status='accepted' AND drift_state!='clean'`,
  ).get(epicId) as { count: number };
  return { workflow, task_counts: counts, accepted_artifact_drift_count: drift.count };
}

function handleEpisodeTransition(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number;
  const to = args.to_stage as Stage;
  if (!STAGES.includes(to)) throw new Error(`Unknown episode stage '${to}'`);
  const current = getOrCreate(epicId);
  if (current.stage === to) return { changed: false, workflow: current };
  if (to !== 'cancelled' && NEXT[current.stage] !== to) {
    throw new Error(`Invalid episode transition ${current.stage} -> ${to}`);
  }

  let baselineArtifactId = current.baseline_artifact_id;
  let baselineHash = current.baseline_hash;
  if (current.stage === 'formalization' && to === 'planning') {
    // Slice 3 of formalization-mechanics fix: previously this branch checked
    // ONLY the AC baseline (artifacts). Every other stage transition
    // (planning→development, development→verification, etc.) calls
    // assertTasksReady. The omission here let an episode advance to
    // planning while a formalization task (typically recovery.heal) was
    // still in 'review', stranding that task permanently — countActiveTasks
    // and claimTask both filter by ew.stage = t.workflow_stage, so a
    // cross-stage task is invisible and unclaimable.
    //
    // assertTasksReady excludes task_kind in ('summary.stage','recovery.heal'),
    // so this gate now also catches the real formalization deliverables
    // (PRD/SRS/UC/AC/reconciliation) being incomplete.
    assertTasksReady(epicId, 'formalization');
    // Traceability gate (formalization-traceability fix): verify the
    // canonical lineage edges exist in artifact_traces BEFORE accepting
    // the baseline. Producer-skills create these edges at artifact
    // creation time; if any is missing, the episode must NOT advance to
    // planning — the missing edge is a real defect in the formalization
    // output. The saga-reconciler task can repair it via trace_add.
    assertTraceability(epicId);
    const baseline = acceptedBaseline(epicId);
    baselineArtifactId = (args.baseline_artifact_id as number | undefined) ?? baseline.artifacts[0].id;
    if (!baseline.artifacts.some(a => a.id === baselineArtifactId)) {
      throw new Error(`Baseline artifact ${baselineArtifactId} is not an accepted AC in epic ${epicId}`);
    }
    baselineHash = baseline.hash;
  } else if (current.stage === 'planning' && to === 'development') {
    assertTasksReady(epicId, 'planning');
  } else if (current.stage === 'development' && to === 'verification') {
    assertTasksReady(epicId, 'development');
  } else if (current.stage === 'verification' && to === 'integration') {
    assertTasksReady(epicId, 'verification');
    assertVerificationPassed(epicId);
  } else if (current.stage === 'integration' && to === 'completed') {
    assertTasksReady(epicId, 'integration');
  }

  db.prepare(
    `UPDATE episode_workflows
     SET stage=?, baseline_artifact_id=?, baseline_hash=?, updated_at=datetime('now')
     WHERE epic_id=?`,
  ).run(to, baselineArtifactId, baselineHash, epicId);
  logActivity(db, 'epic', epicId, 'status_changed', 'episode_stage', current.stage, to,
    `Episode #${epicId}: ${current.stage} -> ${to}`);
  return { changed: true, workflow: getOrCreate(epicId) };
}

export function advanceReadyEpisodes(projectId: number): Array<{
  epic_id: number; from: Stage; to: Stage;
}> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ew.epic_id, ew.stage
     FROM episode_workflows ew JOIN epics e ON e.id=ew.epic_id
     WHERE e.project_id=? AND ew.stage NOT IN ('discovery','completed','cancelled')`,
  ).all(projectId) as Array<{ epic_id: number; stage: Stage }>;
  const advanced: Array<{ epic_id: number; from: Stage; to: Stage }> = [];
  for (const row of rows) {
    let stage = row.stage;
    for (let guard = 0; guard < 5; guard += 1) {
      const to = NEXT[stage];
      if (!to) break;
      try {
        const result = handleEpisodeTransition({ epic_id: row.epic_id, to_stage: to }) as {
          changed: boolean; workflow: { stage: Stage };
        };
        if (!result.changed) break;
        db.prepare(
          `UPDATE episode_workflows
           SET metadata=json_remove(metadata,'$.last_gate_error','$.last_gate_from','$.last_gate_to'),
               updated_at=datetime('now')
           WHERE epic_id=?`,
        ).run(row.epic_id);
        advanced.push({ epic_id: row.epic_id, from: stage, to });
        stage = result.workflow.stage;
      } catch (error) {
        db.prepare(
          `UPDATE episode_workflows
           SET metadata=json_set(metadata,
             '$.last_gate_error',?,
             '$.last_gate_from',?,
             '$.last_gate_to',?,
             '$.last_gate_checked_at',datetime('now')),
             updated_at=datetime('now')
           WHERE epic_id=?`,
        ).run(error instanceof Error ? error.message : String(error), stage, to, row.epic_id);
        break;
      }
    }
  }
  return advanced;
}

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
    const legacyTargets = db.prepare(
      `SELECT tr.source_id
       FROM artifact_traces tr JOIN artifacts a ON a.id=tr.source_id
       WHERE tr.target_type='task' AND tr.target_id=? AND tr.link_type='depends_on'
         AND a.type='AC'`,
    ).all(taskId) as Array<{ source_id: number }>;
    if (legacyTargets.length === 1) {
      targetArtifactId = legacyTargets[0]!.source_id;
      db.prepare(
        `UPDATE tasks SET verification_target_artifact_id=?, updated_at=datetime('now')
         WHERE id=? AND verification_target_artifact_id IS NULL`,
      ).run(targetArtifactId, taskId);
    }
  }
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
    name: 'episode_status',
    description: 'Read the executable stage, stage task counts, baseline and drift state for one REQ episode.',
    annotations: { title: 'Episode: Status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { epic_id: { type: 'integer' } }, required: ['epic_id'] },
  },
  {
    name: 'episode_transition',
    description: 'Advance an episode by one stage after enforcing artifact, integration and verification hard gates.',
    annotations: { title: 'Episode: Transition', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer' },
        to_stage: { type: 'string', enum: [...STAGES] },
        baseline_artifact_id: { type: 'integer' },
      },
      required: ['epic_id', 'to_stage'],
    },
  },
  {
    name: 'verification_record',
    description: 'Record immutable evidence for an accepted AC baseline using CGAD 4-valued verdict (passed/failed/unknown/error). Only passing evidence creates verified_by; unknown and error are denials (CGAD P14).',
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
  episode_status: handleEpisodeStatus,
  episode_transition: handleEpisodeTransition,
  verification_record: handleVerificationRecord,
};
