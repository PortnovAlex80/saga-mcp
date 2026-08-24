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
  type CapsuleInvalidationRecord,
} from './sqlite-replay-capsule-repository.js';
import { captureReplayCapsuleFailClosed } from './replay-capsule-completeness.js';
import { requireAcceptedCandidatePresentations } from './replay-presentation-authority.js';
// P6 consolidation: the STRICT key-material resolver is a single exported
// function shared with the claim-side repository — no second hand-rolled
// copy of the SQL/subject formula can drift again.
import {
  readWorkplaceRefForTask,
  resolveReplayKeyMaterial,
} from './replay-key-material.js';
import {
  selectReplayCapsule,
  semanticReplayPayloadHash,
} from './replay-capsule-selection.js';
import { journalEvent } from '../../observability/run-journal.js';

export { resolveReplayKeyMaterial };

// ---------------------------------------------------------------------------
// BLINDSIGHT F4 — typed invalidation routing.
//
// factory_replay_capsule_invalidations records SIX typed reasons, but the
// claim-side consumer collapsed them into a boolean EXISTS: a capsule killed
// by a payload CONFLICT (divergent payloads under one semantic key — the
// replay pipeline itself is inconsistent) took the same silent-miss route as
// routine obsolescence. The typed reason was written durably and dropped at
// the decision boundary. The classification below routes the recovery by
// REASON:
//   - integrity-suspect (payload-conflict, refused): corruption-class
//     evidence — the miss is typed AND journaled loudly so the operator
//     escalates instead of trusting silent regeneration;
//   - obsolete (package-changed, acceptance-superseded, restart-required,
//     stage-reset): the designed invalidate+rebuild route — typed in the
//     bound context, no alarm.
// ---------------------------------------------------------------------------

/** Reasons whose evidence implicates the replay pipeline itself, not the capsule's age. */
const INTEGRITY_SUSPECT_INVALIDATION_REASONS = new Set<CapsuleInvalidationRecord['reason']>([
  'payload-conflict',
  'refused',
]);

export type CapsuleInvalidationClassification =
  | 'integrity-suspect'
  | 'obsolete';

export interface CapsuleInvalidationRouting {
  readonly classification: CapsuleInvalidationClassification;
  /** The governing typed reason (integrity-suspect dominates when both classes exist). */
  readonly reason: CapsuleInvalidationRecord['reason'];
  readonly capsuleRef: string;
  readonly observedDigest: string | null;
  readonly expectedDigest: string | null;
  readonly authorityRef: string;
  readonly recordedAt: string;
}

/**
 * Classify typed invalidation evidence for routing. Returns null only when
 * there is no evidence (the caller keeps the plain hit path — no fabricated
 * reasons). Integrity-suspect DOMINATES: when a capsule carries both
 * classes of evidence, the escalation class wins (fail-closed).
 */
export function classifyCapsuleInvalidations(
  records: readonly CapsuleInvalidationRecord[],
): CapsuleInvalidationRouting | null {
  if (records.length === 0) return null;
  const newest = records[records.length - 1]!;
  const suspect = records.find(
    record => INTEGRITY_SUSPECT_INVALIDATION_REASONS.has(record.reason),
  );
  const governing = suspect ?? newest;
  return {
    classification: suspect ? 'integrity-suspect' : 'obsolete',
    reason: governing.reason,
    capsuleRef: governing.capsuleRef,
    observedDigest: governing.observedDigest,
    expectedDigest: governing.expectedDigest,
    authorityRef: governing.authorityRef,
    recordedAt: governing.recordedAt,
  };
}

/**
 * R-E1 — the certification sweep's observable outcome. "0 capsules needed"
 * and "0 of 12 workplaces certified because every capture failed" must never
 * be the same journal line again.
 */
export interface ReplayCertificationSweepSummary {
  /** Terminal-accepted workplaces in project scope the sweep considered. */
  readonly considered: number;
  /** Capsules captured (or proven already present) this run. */
  readonly certified: number;
  /** Workplaces whose certification threw (non-fatal per workplace). */
  readonly failed: number;
  /** Counted skip reasons, e.g. { 'candidate-set-missing': 2 }. */
  readonly skipped: Readonly<Record<string, number>>;
}

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
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * ADR-080 — best-effort lifecycle attribution for invalidation evidence:
 * the claim's process run maps to its owning lifecycle run through the
 * authoritative ownership chain (factory_stage_runs).
 */
function keyLifecycleRunId(db: Database.Database, task: Task): number | null {
  const processRunId = Number(metadataObject(task.metadata).process_run_id);
  if (!Number.isSafeInteger(processRunId) || processRunId <= 0) return null;
  const row = db.prepare(
    'SELECT lifecycle_run_id FROM factory_stage_runs WHERE process_run_id=? LIMIT 1',
  ).get(processRunId) as { lifecycle_run_id: number | null } | undefined;
  return row?.lifecycle_run_id ?? null;
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
 *
 * R-D2 — the sweep's workplace selection is NO LONGER gated on
 * `factory_cell_final_acceptances`: that row is written by the direct capture
 * effect, i.e. it is exactly the row missing when the primary path failed and
 * this fallback is needed. Gating the fallback on the primary's success
 * precondition made every crash-window workplace invisible to both paths.
 * Selection is now terminal-accepted workplaces of the project, regardless of
 * cfa-row presence; the accepted decision resolves through the cfa when it
 * exists and through the accepted-authority head otherwise. Each workplace is
 * idempotent by capsule evidence (source_candidate_set_ref), and every skip is
 * counted and logged — the sweep can finally see its own failures (R-C6/R-E1).
 */
export function certifyAcceptedReplayCapsules(
  db: Database.Database,
  projectId: number,
): ReplayCertificationSweepSummary {
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

  const skipped: Record<string, number> = {};
  const skip = (reason: string, workplaceRef: string, detail?: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    process.stderr.write(
      `[replay-certification] skip(${reason}): ${workplaceRef}`
      + (detail ? ` — ${detail}` : '') + '\n',
    );
  };
  let certified = 0;
  let failed = 0;

  for (const workplace of workplaces) {
    try {
      // Preferred: the authoritative FinalAcceptance's decision. Fallback
      // (R-D2): the accepted-authority head's author gate decision — the
      // decision recordFinalAcceptanceAndCapture would have used.
      const decision = db.prepare(
        `SELECT gd.decision_key,gd.subject_candidate_set_ref,gd.assessment_candidate_set_refs
           FROM factory_cell_final_acceptances cfa
           JOIN factory_gate_decisions gd
             ON gd.decision_key=cfa.gate_decision_key
          WHERE cfa.workplace_ref=?
            AND gd.verdict='accepted'`,
      ).get(workplace.workplace_ref) as {
        decision_key: string;
        subject_candidate_set_ref: string;
        assessment_candidate_set_refs: string;
      } | undefined
        ?? db.prepare(
          `SELECT gd.decision_key,gd.subject_candidate_set_ref,gd.assessment_candidate_set_refs
             FROM factory_accepted_authority_head h
             JOIN factory_gate_decisions gd
               ON gd.decision_key=h.accepted_author_gate_decision_key
            WHERE h.workplace_ref=?
              AND gd.verdict='accepted'`,
        ).get(workplace.workplace_ref) as {
          decision_key: string;
          subject_candidate_set_ref: string;
          assessment_candidate_set_refs: string;
        } | undefined;
      if (!decision) {
        skip(
          'no-accepted-decision', workplace.workplace_ref,
          'no exact accepted FinalAcceptance or authority-head GateDecision',
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
        if (!candidate) {
          // R-C6 — a missing candidate row is a counted, logged skip (typical
          // after a partial reset), never a silent continue.
          skip('candidate-set-missing', workplace.workplace_ref, candidateSetRef);
          continue;
        }
        // Idempotency by sealed material: a capsule already citing this exact
        // CandidateSet proves the material is certified (capture is idempotent
        // by capsule_ref; re-running the completeness proof would only
        // re-derive the same row).
        const alreadyCertified = db.prepare(
          `SELECT 1 FROM factory_replay_capsules
            WHERE source_candidate_set_ref=? LIMIT 1`,
        ).get(candidate.candidate_set_ref);
        if (alreadyCertified) {
          skip('already-certified', workplace.workplace_ref, candidate.candidate_set_ref);
          continue;
        }
        const presentations = requireAcceptedCandidatePresentations(db, {
          workplaceRef: workplace.workplace_ref,
          finalDecisionKey: decision.decision_key,
          finalSubjectCandidateSetRef: decision.subject_candidate_set_ref,
          candidateSetRef,
        });
        for (const presentation of presentations) {
          captureReplayCapsuleFailClosed(db, () =>
            repo.captureAcceptedExecution({
              executionRef: presentation.presentationRef,
              candidateSetRef: candidate.candidate_set_ref,
              expectedReplayBinding: presentation,
            }));
          certified += 1;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      // R-E1 companion — the failure is journal-visible (observation only; the
      // journal never feeds a decision), not just a lost stderr line.
      journalEvent('error.thrown', { workplace_ref: workplace.workplace_ref }, {
        error_name: error instanceof Error ? error.name : typeof error,
        message,
        source_site: 'replay-certification-sweep',
      });
      process.stderr.write(
        `[replay-certification] workplace=${workplace.workplace_ref}: ${message}\n`,
      );
    }
  }

  const summary: ReplayCertificationSweepSummary = {
    considered: workplaces.length,
    certified,
    failed,
    skipped,
  };
  process.stderr.write(
    `[replay-certification] sweep summary: ${JSON.stringify(summary)}\n`,
  );
  return summary;
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
  const repo = new SqliteReplayCapsuleRepository(db);
  const keyMaterial = resolveReplayKeyMaterial(db, input.task, input.role);
  if (!keyMaterial) return null;

  certifyAcceptedReplayCapsules(db, keyMaterial.projectId);

  const replayKey = computeReplayKey(keyMaterial);
  // ADR-080 §2 (STAGE-23 loop fix, 2026-08-24): the payload-conflict handler
  // persists invalidation evidence "so the NEXT execution resolves to an
  // ordinary miss" — but the selection read every capsule row regardless of
  // evidence, so two divergent capsules under one key (the double-redevelop
  // shape: parent capsule + child capsule, re-stamped base) re-conflicted on
  // EVERY claim forever. Corruption-class evidence (payload-conflict,
  // refused) must exclude a capsule from the selection; the obsolete class
  // (package-changed et al.) keeps its designed hit-then-typed-miss route.
  const capsuleRows = db.prepare(
    `SELECT c.capsule_ref,c.payload_hash,c.payload_snapshot,
            EXISTS (
              SELECT 1 FROM factory_replay_capsule_invalidations i
               WHERE i.capsule_ref=c.capsule_ref
                 AND i.reason IN ('payload-conflict','refused')
            ) AS integrity_suspect
       FROM factory_replay_capsules c
      WHERE c.project_id=? AND c.replay_key=?
      ORDER BY c.capsule_ref ASC`,
  ).all(keyMaterial.projectId, replayKey) as Array<{
    capsule_ref: string;
    payload_hash: string;
    payload_snapshot: string;
    integrity_suspect: number;
  }>;
  // Semantic payload identity (§15/ADR-080): the raw payload_hash carries the
  // run-scoped product digest; conflict detection must compare the semantic
  // projection so byte-equal material under one key stays a pure alias.
  const capsules = capsuleRows.filter(row => row.integrity_suspect === 0).map(row => ({
    capsule_ref: row.capsule_ref,
    payload_hash: row.payload_hash,
    semantic_payload_hash: semanticReplayPayloadHash(row.payload_snapshot),
  }));
  // ADR-080 §2 payload-conflict: divergent payloads under one semantic key are
  // PERSISTED as evidence first — one append-only row per conflicting capsule,
  // binding both divergent payload hashes, the observing claim, and (when
  // derivable) the lifecycle that observed it.
  //
  // Then it FAILS CLOSED. CONVEYOR §15 is explicit that a corrupt hit "does not
  // silently call a paid model inside the same execution; recovery creates a
  // new execution and resolves again". Degrading to a miss right here would do
  // exactly the forbidden thing. The persisted evidence makes both capsules
  // ineligible, so the NEXT execution resolves to an ordinary miss and takes
  // its normally selected route — invalidation bridging to regeneration
  // (§§3-4) across executions, not inside one. The dispatcher's per-card
  // REPLAY_* valve turns this into a typed card_error, never engine death.
  const selection = selectReplayCapsule(replayKey, capsules);
  if (selection.outcome === 'conflict') {
    for (const candidate of selection.capsules) {
      const other = selection.capsules.find(row => row.capsule_ref !== candidate.capsule_ref);
      repo.recordInvalidation({
        capsuleRef: candidate.capsule_ref,
        reason: 'payload-conflict',
        observedDigest: candidate.payload_hash,
        expectedDigest: other?.payload_hash ?? null,
        lifecycleRunId: keyLifecycleRunId(db, input.task),
        authorityRef: `replay-claim:${input.executionId}`,
      });
    }
    throw new Error(
      `REPLAY_KEY_PAYLOAD_CONFLICT: replay key ${replayKey} carries `
      + `${selection.capsules.length} divergent payloads `
      + `(${selection.capsules.map(row => row.capsule_ref).join(', ')}); `
      + 'invalidation evidence recorded — the next execution resolves as a miss',
    );
  }
  const capsule = selection.outcome === 'hit' ? selection.capsule : undefined;
  // ADR-080 §1 + BLINDSIGHT F4 — derived invalidity from TYPED evidence: the
  // claim degrades to a typed miss whose ROUTE depends on the reason.
  // Integrity-suspect evidence (payload-conflict / refused) is corruption
  // class: the miss is typed in the bound context AND journaled loudly —
  // operator escalation, not silent regeneration. Obsolete-class evidence
  // (package-changed / acceptance-superseded / restart-required /
  // stage-reset) is the designed invalidate+rebuild route: typed in the
  // bound context, no alarm. The previously boolean hasInvalidation() call
  // erased exactly this distinction.
  const selectedInvalidationRouting = capsule
    ? classifyCapsuleInvalidations(repo.readInvalidationsForCapsule(capsule.capsule_ref))
    : null;
  // Loop-kill and typed routing are separate obligations. Integrity-suspect
  // capsules are excluded from conflict selection above, but when that leaves
  // an ordinary miss the decision boundary must still receive the exact
  // durable reason that caused the exclusion. Choose by capsule_ref (the SQL
  // order above) so multiple poisoned aliases produce a stable audit route.
  const excludedInvalidationRouting = selection.outcome === 'miss'
    ? capsuleRows
        .filter(row => row.integrity_suspect !== 0)
        .map(row => classifyCapsuleInvalidations(repo.readInvalidationsForCapsule(row.capsule_ref)))
        .find((route): route is CapsuleInvalidationRouting => route !== null)
      ?? null
    : null;
  const invalidationRouting = selectedInvalidationRouting ?? excludedInvalidationRouting;
  const invalidated = invalidationRouting !== null;
  if (invalidationRouting?.classification === 'integrity-suspect') {
    const processRunId = Number(metadataObject(input.task.metadata).process_run_id);
    journalEvent('replay.invalidation.integrity-suspect', {
      run_id: Number.isSafeInteger(processRunId) && processRunId > 0
        ? `process-run:${processRunId}`
        : undefined,
    }, {
      replay_key: replayKey,
      capsule_ref: invalidationRouting.capsuleRef,
      reason: invalidationRouting.reason,
      observed_digest: invalidationRouting.observedDigest,
      expected_digest: invalidationRouting.expectedDigest,
      authority_ref: invalidationRouting.authorityRef,
      recorded_at: invalidationRouting.recordedAt,
      route: 'typed-miss+operator-escalation',
    });
  }

  const workplaceRef = readWorkplaceRefForTask(db, input.task);
  const effectiveCapsule = capsule && !invalidated
    ? (
        workplaceRef && isCapsuleIneligibleInWorkplace(db, workplaceRef, capsule.capsule_ref)
          ? undefined
          : capsule
      )
    : undefined;

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
    // BLINDSIGHT F4 — deliver the typed invalidation routing to the spawn
    // decision point: WHY the capsule was refused and WHICH recovery class
    // applies. Present only when evidence exists (never fabricated).
    ...(invalidationRouting
      ? {
          invalidation: {
            capsuleRef: invalidationRouting.capsuleRef,
            reason: invalidationRouting.reason,
            classification: invalidationRouting.classification,
            observedDigest: invalidationRouting.observedDigest,
            expectedDigest: invalidationRouting.expectedDigest,
            authorityRef: invalidationRouting.authorityRef,
            recordedAt: invalidationRouting.recordedAt,
          },
        }
      : {}),
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
