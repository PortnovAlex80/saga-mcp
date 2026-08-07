import type Database from 'better-sqlite3';
import type { Task } from '../../types.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { executionContextHash } from '../../shared/authority/execution-context.js';
import {
  computeReplayKey,
  type ReplayClaimSelection,
  type ReplayKeyMaterial,
} from '../../replay/replay-capsule.js';
import {
  ensureReplayCapsuleSchema,
  SqliteReplayCapsuleRepository,
} from './sqlite-replay-capsule-repository.js';

/**
 * Read the workplace_ref for a task. The dispatcher stamps it on the task row
 * (tasks.workplace_ref) during Production Cell assignment.
 */
function readWorkplaceRefForTask(db: Database.Database, task: Task): string | null {
  if (task.workplace_ref) return task.workplace_ref;
  const row = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(task.id) as { workplace_ref: string | null } | undefined;
  return row?.workplace_ref ?? null;
}

/**
 * CONVEYOR v4.3 PART 10: determine whether a capsule was already replayed in
 * the given Workplace and the CURRENT Gate rejected the resulting CandidateSet.
 *
 * Derive ineligibility from durable Gate evidence: join the subject
 * CandidateSet's producer execution to its frozen replay.capsule_ref, and check
 * for a non-accepted Gate decision. No blacklist aggregate.
 */
function isCapsuleRejectedInWorkplace(
  db: Database.Database,
  workplaceRef: string,
  capsuleRef: string,
): boolean {
  // Find Gate decisions for this Workplace where the subject CandidateSet was
  // produced by an execution that had this capsule_ref frozen, and the verdict
  // was not 'accepted'. Any such decision means the capsule's replay production
  // was already judged insufficient by the current Gate.
  const rejected = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
       JOIN factory_candidate_sets cs
         ON cs.candidate_set_ref = gd.subject_candidate_set_ref
        AND cs.workplace_ref = gd.workplace_ref
       JOIN worker_executions we
         ON we.execution_id = cs.producer_execution_ref
      WHERE gd.workplace_ref = ?
        AND gd.verdict != 'accepted'
        AND we.metadata LIKE ?`,
  ).get(workplaceRef, `%"capsule_ref":"${capsuleRef}"%`) as { 1: number } | undefined;
  return rejected !== undefined;
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
  // Cross-run-stable semantic input digest (CONVEYOR v4.3 §8). The raw
  // process_node_input_hash carries run-specific provenance and is NOT ReplayKey
  // material. Fall back to it only for legacy tasks authored before this field
  // existed (so an in-flight migration does not break replay lookups); new
  // projections always write semantic_input_digest.
  const semanticInputDigest = requiredString(metadata.semantic_input_digest)
    ?? requiredString(metadata.process_node_input_hash);
  if (!Number.isSafeInteger(processRunId) || processRunId <= 0
      || !nodeId || !moduleRef || !productionCellId || !workKey || !semanticInputDigest) {
    return null;
  }
  const run = db.prepare(
    'SELECT project_id,package_digest FROM factory_process_runs WHERE id=?',
  ).get(processRunId) as { project_id: number; package_digest: string | null } | undefined;
  if (!run?.package_digest) return null;

  let subjectProductionDigest: string | null = null;
  if (role === 'reviewer') {
    if (!task.workplace_ref) return null;
    // Reviewer replay identity is pinned to the semantic AUTHOR production
    // (CONVEYOR v4.3 §10), NOT the run-specific candidate_set_digest (which
    // includes WorkplaceRef/processRunId + producerExecutionRef). Derive a
    // stable digest from the subject author CandidateSet's product content
    // atoms: canonical ordered { schemaId, digest } multiset. This is stable
    // across runs as long as the author produced the same products, even though
    // the CandidateSet ref/digest differ.
    const authorSet = db.prepare(
      `SELECT candidate_set_ref
         FROM factory_candidate_sets
        WHERE workplace_ref=? AND role='author'
        ORDER BY sealed_at DESC,candidate_set_ref DESC LIMIT 1`,
    ).get(task.workplace_ref) as { candidate_set_ref: string } | undefined;
    if (!authorSet) return null;
    const members = db.prepare(
      `SELECT product_schema, product_digest
         FROM factory_candidate_set_members
        WHERE candidate_set_ref=?
        ORDER BY product_schema, product_digest`,
    ).all(authorSet.candidate_set_ref) as Array<{
      product_schema: string;
      product_digest: string;
    }>;
    if (members.length === 0) return null;
    subjectProductionDigest = sha256Hex(
      members.map(m => ({ schemaId: m.product_schema, digest: m.product_digest })),
    );
  }

  return {
    projectId: run.project_id,
    moduleRef,
    nodeId,
    productionCellId,
    workKey,
    role,
    packageDigest: run.package_digest,
    semanticInputDigest,
    subjectProductionDigest,
  };
}

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
 * Materialize missing capsules only from authoritative final acceptance.
 *
 * The source of certification is NOT "all CandidateSets on a terminal
 * Workplace". Repair attempts remain in that history. Instead we select the
 * exact subject + assessment CandidateSet refs named by the latest FINAL
 * `GateDecision(verdict=accepted)` for a Workplace that is durably
 * `terminal(accepted)`.
 *
 * Author-only cell:
 *   final decision subject -> author capsule
 *
 * Reviewed cell:
 *   final decision subject -> exact author capsule
 *   final decision assessments -> exact reviewer capsule(s)
 *
 * This excludes rejected/superseded author attempts and invalid reviewer
 * attempts even if the same Workplace later succeeds.
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
        `SELECT subject_candidate_set_ref,assessment_candidate_set_refs
           FROM factory_gate_decisions
          WHERE workplace_ref=?
            AND gate_phase='final'
            AND verdict='accepted'
          ORDER BY decided_at DESC,rowid DESC
          LIMIT 1`,
      ).get(workplace.workplace_ref) as {
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
          `SELECT cs.candidate_set_ref,cs.producer_execution_ref,cs.role
             FROM factory_candidate_sets cs
             LEFT JOIN factory_replay_capsules rc
               ON rc.source_execution_ref=cs.producer_execution_ref
              AND rc.source_candidate_set_ref=cs.candidate_set_ref
            WHERE cs.candidate_set_ref=?
              AND cs.workplace_ref=?
              AND rc.id IS NULL`,
        ).get(candidateSetRef, workplace.workplace_ref) as {
          candidate_set_ref: string;
          producer_execution_ref: string;
          role: 'author' | 'reviewer';
        } | undefined;
        if (!candidate) continue;

        repo.captureAcceptedExecution({
          executionRef: candidate.producer_execution_ref,
          candidateSetRef: candidate.candidate_set_ref,
        });
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
 * The WorkAssignment adapter invokes this after its IMMEDIATE claim transaction
 * commits and before spawn. We first materialize any still-missing capsules
 * from prior authoritative acceptance, then perform the exact current replay
 * lookup.
 *
 * Miss: freeze the replay key, leave the front-selected LLM route untouched.
 * Hit: freeze the exact capsule ref + payload hash alongside the normal route.
 *
 * CONVEYOR v4.3 (PART 1 — simulator removed from runtime): replay is an
 * internal source of WorkerExecution production, NOT an executor mode. This
 * binder must NOT mutate executor_kind, model_route, or route_policy. The
 * normal WorkerExecution executor resolves the production source internally
 * from execution_context.replay.capsule_ref — the same executor abstraction
 * serves both inference and replay. Project/workshop model configuration is
 * never touched.
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
  const capsule = db.prepare(
    `SELECT capsule_ref,payload_hash
       FROM factory_replay_capsules
      WHERE project_id=? AND replay_key=?
      ORDER BY id DESC LIMIT 1`,
  ).get(keyMaterial.projectId, replayKey) as {
    capsule_ref: string;
    payload_hash: string;
  } | undefined;

  // CONVEYOR v4.3 PART 10: replay rejection ineligibility. If this capsule was
  // already replayed in this Workplace and the CURRENT Gate rejected the
  // resulting CandidateSet, the capsule is ineligible for the recovery
  // execution. It resolves as an ordinary miss and the selected inference model
  // runs. Derive ineligibility from durable Gate evidence — no blacklist
  // aggregate.
  const workplaceRef = readWorkplaceRefForTask(db, input.task);
  let ineligibleCapsuleRef: string | null = null;
  if (capsule && workplaceRef) {
    ineligibleCapsuleRef = isCapsuleRejectedInWorkplace(db, workplaceRef, capsule.capsule_ref)
      ? capsule.capsule_ref
      : null;
  }
  const effectiveCapsule = ineligibleCapsuleRef ? null : capsule;

  const execution = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(input.executionId) as { metadata: string } | undefined;
  if (!execution) throw new Error(`REPLAY_BIND_EXECUTION_NOT_FOUND: ${input.executionId}`);
  const envelope = metadataObject(execution.metadata);
  const context = metadataObject(envelope.execution_context);
  if (Object.keys(context).length === 0) {
    throw new Error(`REPLAY_BIND_EXECUTION_CONTEXT_MISSING: ${input.executionId}`);
  }

  // Freeze only the replay provenance. The normal front-selected executor_kind
  // and model_route remain authoritative; the executor resolves replay as an
  // internal production source when capsule_ref is non-null. We deliberately do
  // NOT set executor_kind='claude-cli-simulator' or null out model_route.
  // When the capsule was rejected in this Workplace (PART 10), capsule_ref is
  // null so the executor runs inference normally.
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
