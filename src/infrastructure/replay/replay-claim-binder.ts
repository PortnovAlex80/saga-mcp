import type Database from 'better-sqlite3';
import type { Task } from '../../types.js';
import { executionContextHash } from '../../shared/authority/execution-context.js';
import {
  computeReplayKey,
  type ReplayClaimSelection,
} from '../../replay/replay-capsule.js';
import {
  ensureReplayCapsuleSchema,
  SqliteReplayCapsuleRepository,
} from './sqlite-replay-capsule-repository.js';
import { captureReplayCapsuleFailClosed } from './replay-capsule-completeness.js';
import { acceptedCandidatePresentationRefs } from './replay-presentation-authority.js';
// P6 consolidation: the STRICT key-material resolver is a single exported
// function shared with the claim-side repository — no second hand-rolled
// copy of the SQL/subject formula can drift again.
import {
  readWorkplaceRefForTask,
  resolveReplayKeyMaterial,
} from './replay-key-material.js';

export { resolveReplayKeyMaterial };

/**
 * A capsule becomes ineligible for subsequent recovery attempts in the SAME
 * Workplace after either CURRENT Gate rejection or replay execution failure.
 * The fact is derived from durable evidence; no replay-blacklist aggregate
 * exists. The next WorkerExecution therefore resolves a normal miss and uses
 * its already-selected inference route.
 */
function isCapsuleIneligibleInWorkplace(
  db: Database.Database,
  workplaceRef: string,
  capsuleRef: string,
): boolean {
  const rejectedByGate = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
      WHERE gd.workplace_ref=?
        AND gd.verdict!='accepted'
        AND EXISTS (
          SELECT 1
            FROM factory_gate_presentation_attempts gpa
           WHERE gpa.gate_run_ref=gd.gate_run_ref
             AND gpa.replay_capsule_ref=?
        )
      LIMIT 1`,
  ).get(workplaceRef, capsuleRef);
  if (rejectedByGate) return true;

  const failedReplay = db.prepare(
    `SELECT 1
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
      WHERE t.workplace_ref=?
        AND we.state IN ('lost','spawn_failed','terminated')
        AND json_extract(we.metadata,'$.execution_context.replay.capsule_ref')=?
      LIMIT 1`,
  ).get(workplaceRef, capsuleRef);
  return failedReplay !== undefined;
}

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

// resolveReplayKeyMaterial is re-exported from the shared
// replay-key-material module (see the import block above) — the local
// hand-rolled copy was removed (P6 consolidation).

function parseStringArray(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`REPLAY_CERTIFICATION_INVALID: ${label} is not JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new Error(`REPLAY_CERTIFICATION_INVALID: ${label} must be a string array`);
  }
  return parsed;
}

/**
 * Crash/reconciliation fallback. Direct post-terminal capture is normal; this
 * sweep only backfills missing capsules from authoritative final acceptance.
 * It uses the SAME fail-closed completeness proof as direct capture.
 */
export function certifyAcceptedReplayCapsules(
  db: Database.Database,
  projectId: number,
): void {
  ensureReplayCapsuleSchema(db);
  const repo = new SqliteReplayCapsuleRepository(db);
  const workplaces = db.prepare(
    `SELECT w.workplace_ref
       FROM factory_workplaces w
       JOIN factory_process_runs pr ON pr.id=w.process_run_id
      WHERE pr.project_id=?
        AND w.loop_state='terminal'
        AND w.terminal_reason='accepted'`,
  ).all(projectId) as Array<{ workplace_ref: string }>;

  for (const workplace of workplaces) {
    try {
      const decision = db.prepare(
        `SELECT gd.decision_key,gd.subject_candidate_set_ref,gd.assessment_candidate_set_refs
           FROM factory_cell_final_acceptances cfa
           JOIN factory_gate_decisions gd
             ON gd.decision_key=cfa.gate_decision_key
          WHERE cfa.workplace_ref=?
            AND gd.gate_phase='final'
            AND gd.verdict='accepted'`,
      ).get(workplace.workplace_ref) as {
        decision_key: string;
        subject_candidate_set_ref: string;
        assessment_candidate_set_refs: string;
      } | undefined;
      if (!decision) {
        process.stderr.write(
          `[replay-certification] terminal accepted workplace has no final accepted GateDecision: `
          + `${workplace.workplace_ref}\n`,
        );
        continue;
      }

      const candidateRefs = [
        decision.subject_candidate_set_ref,
        ...parseStringArray(
          decision.assessment_candidate_set_refs,
          'assessment_candidate_set_refs',
        ),
      ];

      for (const candidateSetRef of [...new Set(candidateRefs)]) {
        const candidate = db.prepare(
          `SELECT candidate_set_ref FROM factory_candidate_sets
            WHERE candidate_set_ref=? AND workplace_ref=?`,
        ).get(candidateSetRef, workplace.workplace_ref) as {
          candidate_set_ref: string;
        } | undefined;
        if (!candidate) continue;
        const presentationRefs = acceptedCandidatePresentationRefs(db, {
          workplaceRef: workplace.workplace_ref,
          finalDecisionKey: decision.decision_key,
          finalSubjectCandidateSetRef: decision.subject_candidate_set_ref,
          candidateSetRef,
        });
        for (const presentationRef of presentationRefs) {
          captureReplayCapsuleFailClosed(db, () =>
            repo.captureAcceptedExecution({
              executionRef: presentationRef,
              candidateSetRef: candidate.candidate_set_ref,
            }));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[replay-certification] workplace=${workplace.workplace_ref}: ${message}\n`,
      );
    }
  }
}

/**
 * Final pre-spawn step for a fenced assignment.
 *
 * Miss freezes the replay semantic key and leaves the selected inference route
 * untouched. Hit freezes only exact capsule ref/hash. Replay never changes
 * executor_kind/model_route and never creates another launch mode.
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

  certifyAcceptedReplayCapsules(db, keyMaterial.projectId);

  const replayKey = computeReplayKey(keyMaterial);
  const capsules = db.prepare(
    `SELECT capsule_ref,payload_hash
       FROM factory_replay_capsules
      WHERE project_id=? AND replay_key=?`,
  ).all(keyMaterial.projectId, replayKey) as Array<{
    capsule_ref: string;
    payload_hash: string;
  }>;
  if (capsules.length > 1) {
    throw new Error(`REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS: ${replayKey}`);
  }
  const capsule = capsules[0];

  const workplaceRef = readWorkplaceRefForTask(db, input.task);
  const effectiveCapsule = capsule && workplaceRef
    && isCapsuleIneligibleInWorkplace(db, workplaceRef, capsule.capsule_ref)
      ? undefined
      : capsule;

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
    capsule_ref: effectiveCapsule?.capsule_ref ?? null,
    capsule_payload_hash: effectiveCapsule?.payload_hash ?? null,
  };
  envelope.execution_context = context;
  envelope.execution_context_hash = executionContextHash(context);
  db.prepare('UPDATE worker_executions SET metadata=? WHERE execution_id=?')
    .run(JSON.stringify(envelope), input.executionId);

  return {
    replayKey,
    capsuleRef: effectiveCapsule?.capsule_ref ?? null,
    capsulePayloadHash: effectiveCapsule?.payload_hash ?? null,
  };
}
