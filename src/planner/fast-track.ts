// src/planner/fast-track.ts
//
// SRS-004 §2b.5 + AC-6 — saga-planner fast-track routing.
//
// AC-6 (#222): a discovery brief with decision='fast-track' routes a tech-task
// of XS/S complexity DIRECTLY into the builders' kanban, bypassing formalization
// (PRD/SRS/UC/AC). The brief carries the goal + affected-projects to the dev
// task, and a trace edge `brief ← derived_from ← dev-task` keeps the executor
// anchored to the brief (carry-state for the fast channel). If new risk-triggers
// surface during work, escalate: decision flips fast-track → go and a lesson is
// recorded on the brief (the topic returns to formalization).
//
// ============================================================================
// Merge-safety note (parallel task #225).
// ============================================================================
// This file is a SEPARATE routing signal from `applyImpactCascade` (cascade.ts)
// and `decideTopology` (topology.ts). Per the SRS §2b.5 extension point — "a new
// cascade signal = a new function, not a new branch in applyImpactCascade" —
// fast-track lives in its own file. It does NOT touch the bodies of
// applyImpactCascade / decideTopology, which are owned by body-task AC-9 (#225).
// Different files, different zones → a merge of task/222 with task/225 is clean.
// ============================================================================

import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import type { BriefPayload } from '../validators/brief.js';

/**
 * Outcome of {@link canFastTrack}: either the brief qualifies for the fast-track
 * channel, or it does not (with a human-readable reason).
 */
export interface FastTrackEligibility {
  eligible: boolean;
  /** Present only when `eligible === false` — why the fast channel was refused. */
  reason?: string;
}

/**
 * Result of {@link routeFastTrack}: the dev task created directly in kanban,
 * plus the trace edge linking it back to the brief.
 */
export interface FastTrackRouting {
  dev_task_id: number;
  brief_artifact_id: number;
  trace_id: number;
}

/**
 * The exact, deterministic eligibility rule for the fast-track channel (AC-6).
 *
 * ALL four conditions must hold simultaneously:
 *   1. classification === 'tech-task'
 *   2. complexity.tshirt ∈ {'XS', 'S'}
 *   3. affected_projects.length ≤ 1
 *   4. complexity.risk_triggers is empty (no active risk-triggers)
 *
 * This is a hard contract, not a heuristic: a multi-project or risky task can
 * never take the fast channel. The predicate is pure (no DB) so it can be unit-
 * tested in isolation and reused by both the kickstart skill (to FORM the
 * decision) and the planner (to ROUTE it).
 *
 * @param brief the discovery brief to test.
 * @returns eligibility + reason when refused.
 * @see SRS-004 §2b.5, AC-6
 */
export function canFastTrack(brief: BriefPayload): FastTrackEligibility {
  if (brief.classification !== 'tech-task') {
    return { eligible: false, reason: 'fast-track requires classification=tech-task' };
  }
  if (brief.complexity?.tshirt !== 'XS' && brief.complexity?.tshirt !== 'S') {
    return { eligible: false, reason: 'fast-track requires complexity.tshirt ∈ {XS, S}' };
  }
  if (Array.isArray(brief.affected_projects) && brief.affected_projects.length > 1) {
    return { eligible: false, reason: 'fast-track requires affected_projects.length ≤ 1' };
  }
  const triggers = brief.complexity?.risk_triggers;
  if (Array.isArray(triggers) && triggers.length > 0) {
    return { eligible: false, reason: 'fast-track requires no active risk-triggers' };
  }
  return { eligible: true };
}

/**
 * Route a fast-track brief directly into the builders' kanban, bypassing
 * formalization (AC-6).
 *
 * Creates ONE dev task (status='todo', priority='medium') in the given epic from
 * the brief's goal + affected-projects, then links it back to the brief artifact
 * with a `derived_from` trace edge (source=brief artifact, target=dev task). No
 * PRD/SRS/UC/AC artifacts are created — formalization is skipped by design.
 *
 * The dev task's `tags` carry every `impact:<pid>` from `affected_projects` so
 * downstream workers see the caution cascade even on the fast channel
 * (consistent with FR-11 impact-tag semantics; the full cascade body is #225,
 * here we just stamp the tags the brief already names).
 *
 * @param briefArtifactId the id of the registered `type='brief'` artifact.
 * @param epicId the epic (REQ-NNN episode) to create the dev task in.
 * @param brief the brief payload (goal comes from reasoning; affected-projects
 *   from `affected_projects`).
 * @param db optional DB handle (defaults to the shared `getDb()` — pass a
 *   throwaway connection in tests).
 * @returns the created dev task id + the trace id.
 * @throws if the brief is not eligible for fast-track (call {@link canFastTrack}
 *   first), if the brief artifact does not exist, or if the epic does not exist.
 * @see SRS-004 §2b.5, AC-6
 */
export function routeFastTrack(
  briefArtifactId: number,
  epicId: number,
  brief: BriefPayload,
  db?: Database.Database,
): FastTrackRouting {
  const conn = db ?? getDb();

  // Guard the hard contract — never route an ineligible brief, even if a caller
  // forces decision='fast-track' on a multi-project/risky topic.
  const eligibility = canFastTrack(brief);
  if (!eligibility.eligible) {
    throw new Error(`routeFastTrack: brief is not eligible for fast-track (${eligibility.reason})`);
  }

  // The brief artifact must exist (source of the derived_from edge).
  const briefRow = conn
    .prepare('SELECT id, type, project_id FROM artifacts WHERE id = ?')
    .get(briefArtifactId) as { id: number; type: string; project_id: number } | undefined;
  if (!briefRow) {
    throw new Error(`routeFastTrack: brief artifact ${briefArtifactId} not found`);
  }
  if (briefRow.type !== 'brief') {
    throw new Error(
      `routeFastTrack: artifact ${briefArtifactId} is type '${briefRow.type}', expected 'brief'`,
    );
  }

  // The epic must exist (FK target for the dev task).
  const epicRow = conn.prepare('SELECT id, project_id FROM epics WHERE id = ?').get(epicId) as
    | { id: number; project_id: number }
    | undefined;
  if (!epicRow) {
    throw new Error(`routeFastTrack: epic ${epicId} not found`);
  }

  // Impact tags: stamp impact:<pid> for every affected project so the caution
  // cascade is visible on the fast channel too (FR-11 semantics; full cascade
  // body is #225, this is the minimal stamp from the brief's own list).
  const tags: string[] = [];
  for (const pid of brief.affected_projects ?? []) {
    tags.push(`impact:${pid}`);
  }

  // The dev task's goal comes from the brief's reasoning (its stated rationale)
  // — that is the executor's anchor. We also note this is a fast-track task and
  // where its context lives.
  const title = `[fast-track] ${brief.reasoning.slice(0, 120) || 'tech-task'}`;
  const description =
    `Routed directly from discovery brief (fast-track, AC-6). ` +
    `Goal: ${brief.reasoning}. ` +
    `Affected projects: ${JSON.stringify(brief.affected_projects ?? [])}. ` +
    `Classification=${brief.classification}, complexity=${brief.complexity?.tshirt}. ` +
    `Escalate to decision=go if new risk-triggers surface.`;
  const sourceRef = JSON.stringify({
    brief_artifact_id: briefArtifactId,
    routed_via: 'fast-track',
    ac: 'AC-6',
  });

  const inserted = conn
    .prepare(
      `INSERT INTO tasks (epic_id, title, description, status, priority, source_ref, tags)
       VALUES (?, ?, ?, 'todo', 'medium', ?, ?)
       RETURNING id`,
    )
    .get(epicId, title, description, sourceRef, JSON.stringify(tags)) as { id: number };
  const devTaskId = inserted.id;

  // Trace edge: brief ← derived_from ← dev-task. In artifact_traces the source
  // is the artifact (brief) and the target is the task, mirroring how an AC
  // artifact 'implements' a dev task. link_type='derived_from' makes the dev
  // task's lineage to the brief grep/query-observable.
  const traceInfo = conn
    .prepare(
      `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type)
       VALUES (?, 'task', ?, 'derived_from')
       ON CONFLICT (source_id, target_type, target_id, link_type) DO NOTHING`,
    )
    .run(briefArtifactId, devTaskId);
  const traceRow = conn
    .prepare(
      `SELECT id FROM artifact_traces
       WHERE source_id = ? AND target_type = 'task' AND target_id = ? AND link_type = 'derived_from'`,
    )
    .get(briefArtifactId, devTaskId) as { id: number };

  // Activity log so the routing is auditable (NFR-5 observability). The schema
  // columns are entity_type/entity_id/action/summary (+ nullable field_name/
  // old_value/new_value) — we use 'summary' for the human-readable detail.
  conn
    .prepare(
      `INSERT INTO activity_log (entity_type, entity_id, action, summary)
       VALUES ('task', ?, 'created', ?)`,
    )
    .run(
      devTaskId,
      `fast-track dev task created from brief ${briefArtifactId}; derived_from trace ${traceInfo.changes > 0 ? 'added' : 'already present'}`,
    );

  return {
    dev_task_id: devTaskId,
    brief_artifact_id: briefArtifactId,
    trace_id: traceRow.id,
  };
}

/**
 * The brief after an escalation (AC-6): decision flipped fast-track → go and a
 * lesson recorded. This is what the planner hands back to formalization.
 */
export interface EscalatedBrief {
  /** The new brief payload — decision is now 'go', lesson appended. */
  brief: BriefPayload;
  /** Whether the escalation actually fired (false if the brief was not fast-track). */
  escalated: boolean;
}

/**
 * Escalate a fast-track brief back to formalization when new risk-triggers
 * surface during work (AC-6).
 *
 * One-way transition: decision flips `fast-track` → `go`, and the trigger that
 * forced the escalation is appended to the brief as a `lesson` in the reasoning
 * (preserving traceability — the same under-estimation won't take the fast
 * channel next time). There is no `go → fast-track` path. If the brief is not
 * currently `fast-track`, this is a no-op (returns the brief unchanged,
 * `escalated: false`) — escalation only narrows the fast channel, never widens
 * another decision.
 *
 * This is a PURE function: it does not mutate the DB. The caller (planner /
 * orchestrator) is responsible for persisting the escalated brief via
 * `artifact_update`. Keeping it pure lets it be unit-tested without a DB.
 *
 * @param brief the current brief payload.
 * @param reason the risk-trigger that forced the escalation (e.g. a new
 *   affected-project surfaced, underestimated complexity). Appended as a lesson.
 * @returns the escalated brief payload + whether the escalation fired.
 * @see SRS-004 §2b.5, AC-6
 */
export function escalateFastTrack(brief: BriefPayload, reason: string): EscalatedBrief {
  if (brief.decision !== 'fast-track') {
    // Only a fast-track brief can be escalated off the fast channel. Anything
    // else is returned untouched — escalation never changes a non-fast decision.
    return { brief, escalated: false };
  }

  const lesson = `ESCALATED to go: ${reason}`;
  const escalated: BriefPayload = {
    ...brief,
    decision: 'go',
    reasoning: `${brief.reasoning} [lesson: ${lesson}]`,
  };
  return { brief: escalated, escalated: true };
}
