import type Database from 'better-sqlite3';
import { withImmediateTransaction } from '../lifecycle/work-assignment-core.js';

/**
 * HUMAN-GATE-CONSOLE (docs/architecture/HUMAN-GATE-CONSOLE.md).
 *
 * The operator-facing answer to a `GATE_HUMAN_REQUIRED` park. A gate that
 * returns `human_required` parks the workplace (`blocked/paused`) with a
 * durable reason; until now nothing on the operator side could ANSWER it —
 * `unpark` blindly re-queued the worker and the indeterminate check re-parked
 * the line (observed on Elite 2: park id 1 → unpark → park id 2, same
 * `warrant-blocked-environment` unknown).
 *
 * This module owns:
 *   - the append-only `factory_human_gate_resolutions` table (schema also
 *     mirrored in schema.ts; ensured here so older DBs get it lazily);
 *   - `listPendingHumanGateParks` — the console projection: every
 *     blocked/paused workplace whose active park reason is
 *     GATE_HUMAN_REQUIRED, with the context a human needs to decide;
 *   - `resolveHumanGate` — record the operator decision + resume the
 *     workplace through the canonical `repair-requeued` CAS transition, in
 *     ONE transaction.
 *
 * The decision's ENGINE effect is deliberate and indirect: the resumed
 * certification re-runs the check, and the check PROVIDER (≥1.16.0 of
 * factory.local-runnability.v1) converts its `unknown` into `passed`
 * (accept) or `failed` (reject, feedback rides the diagnostic) citing the
 * resolution row as evidence. No receipts are forged, no new transitions
 * invented — the human answer enters as check evidence with provenance.
 */

/** Park reason code emitted by every human_required gate park. */
export const GATE_HUMAN_REQUIRED_CODE = 'GATE_HUMAN_REQUIRED';

const FEEDBACK_LIMIT = 4000;

export interface PendingHumanGatePark {
  readonly workplaceRef: string;
  readonly processRunId: number;
  readonly projectId: number | null;
  readonly projectName: string | null;
  readonly epicId: number | null;
  readonly epicName: string | null;
  readonly moduleRef: string;
  readonly productionCellId: string;
  readonly workKey: string;
  readonly nextRole: 'author' | 'reviewer';
  readonly parkReasonId: number;
  readonly parkMessage: string;
  readonly parkedAt: string;
  /** The human_required GateDecision the park names (from the message). */
  readonly gateDecisionKey: string | null;
  /** Per-check receipt summary of that decision: provider → outcome. */
  readonly checks: ReadonlyArray<{ providerId: string; outcome: string }>;
  /**
   * The candidate-bytes binding of the runnability subject at park time
   * (`local-readiness-subject:<hash>:<commit>:<tree>`), extracted from the
   * unknown receipt's evidence. Null when the decision has no runnability
   * unknown (other human-required classes — e.g. monotonicity escalation).
   */
  readonly subjectBinding: string | null;
  /** Repository local paths bound to the project (where the product lives). */
  readonly repositoryPaths: ReadonlyArray<string>;
}

export interface ResolveHumanGateInput {
  readonly workplaceRef: string;
  readonly decision: 'accept' | 'reject';
  /** REQUIRED for reject — what the operator did not like. */
  readonly feedback?: string;
  readonly actorId: string;
}

export interface ResolvedHumanGate {
  readonly resolutionId: number;
  readonly workplaceRef: string;
  readonly revision: number;
  readonly gateDecisionKey: string | null;
  readonly subjectBinding: string | null;
}

export function ensureHumanGateResolutionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_human_gate_resolutions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      workplace_ref     TEXT NOT NULL,
      process_run_id    INTEGER NOT NULL,
      park_reason_id    INTEGER NOT NULL,
      gate_decision_key TEXT NOT NULL,
      subject_binding   TEXT,
      provider_id       TEXT NOT NULL,
      resolution        TEXT NOT NULL CHECK (resolution IN ('accept','reject')),
      feedback          TEXT,
      actor_id          TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_factory_human_gate_resolutions_ref
      ON factory_human_gate_resolutions(workplace_ref, provider_id);
    CREATE TRIGGER IF NOT EXISTS trg_human_gate_resolutions_no_update
      BEFORE UPDATE ON factory_human_gate_resolutions
    BEGIN
      SELECT RAISE(ABORT, 'factory_human_gate_resolutions is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_human_gate_resolutions_no_delete
      BEFORE DELETE ON factory_human_gate_resolutions
    BEGIN
      SELECT RAISE(ABORT, 'factory_human_gate_resolutions is append-only');
    END;
  `);
}

function gateDecisionKeyFromParkMessage(message: string): string | null {
  const match = message.match(/decision (decision:gate-run:[a-f0-9]{64})/);
  return match ? match[1]! : null;
}

/** Receipt summaries (providerId, outcome) for one gate decision key. */
function readDecisionChecks(
  db: Database.Database,
  decisionKey: string,
): Array<{ providerId: string; outcome: string }> {
  const decision = db.prepare(
    `SELECT check_receipt_refs FROM factory_gate_decisions WHERE decision_key=?`,
  ).get(decisionKey) as { check_receipt_refs: string } | undefined;
  if (!decision) return [];
  let refs: string[] = [];
  try { refs = JSON.parse(decision.check_receipt_refs) as string[]; } catch { return []; }
  const out: Array<{ providerId: string; outcome: string }> = [];
  for (const ref of refs) {
    // receipt:<...>:<N>:<providerId> — the provider rides the ref tail.
    const providerId = ref.split(':').pop() ?? '';
    const row = db.prepare(
      `SELECT outcome FROM factory_check_receipts WHERE check_receipt_ref=?`,
    ).get(ref) as { outcome: string } | undefined;
    if (row) out.push({ providerId, outcome: row.outcome });
  }
  return out;
}

/**
 * The runnability subject binding recorded in the decision's UNKNOWN receipt
 * evidence (`local-readiness-subject:...`). This is the exact candidate BYTES
 * the operator will look at; the provider's conversion guard requires it to
 * match on the post-resume re-run.
 */
function readSubjectBindingFromUnknown(
  db: Database.Database,
  decisionKey: string,
): string | null {
  const decision = db.prepare(
    `SELECT check_receipt_refs FROM factory_gate_decisions WHERE decision_key=?`,
  ).get(decisionKey) as { check_receipt_refs: string } | undefined;
  if (!decision) return null;
  let refs: string[] = [];
  try { refs = JSON.parse(decision.check_receipt_refs) as string[]; } catch { return null; }
  for (const ref of refs) {
    const row = db.prepare(
      `SELECT evidence_refs FROM factory_check_receipts
        WHERE check_receipt_ref=? AND outcome='unknown'`,
    ).get(ref) as { evidence_refs: string } | undefined;
    if (!row) continue;
    try {
      const evidence = JSON.parse(row.evidence_refs) as string[];
      const binding = evidence.find(entry => entry.startsWith('local-readiness-subject:'));
      if (binding) return binding;
    } catch { /* skip malformed */ }
  }
  return null;
}

function projectRepositoryPaths(
  db: Database.Database,
  projectId: number | null,
): string[] {
  if (projectId === null) return [];
  try {
    return (db.prepare(
      `SELECT pr.local_path FROM project_repositories pr
        JOIN repositories r ON r.id=pr.repository_id
       WHERE pr.project_id=? AND pr.local_path IS NOT NULL`,
    ).all(projectId) as Array<{ local_path: string }>).map(row => row.local_path);
  } catch {
    return [];
  }
}

export function listPendingHumanGateParks(
  db: Database.Database,
  projectId?: number,
): PendingHumanGatePark[] {
  let rows: Array<{
    workplace_ref: string; process_run_id: number; module_ref: string;
    production_cell_id: string; work_key: string; next_role: 'author' | 'reviewer';
    park_reason_id: number; message: string; parked_at: string;
    project_id: number | null; project_name: string | null;
    epic_id: number | null; epic_name: string | null;
  }>;
  const baseSql = `
    SELECT w.workplace_ref, w.process_run_id, w.module_ref, w.production_cell_id,
           w.work_key, w.next_role,
           CAST(SUBSTR(w.active_recovery_case_ref, 23) AS INTEGER) AS park_reason_id,
           r.message, r.created_at AS parked_at,
           p.id AS project_id, p.name AS project_name,
           e.id AS epic_id, e.name AS epic_name
      FROM factory_workplaces w
      JOIN factory_workplace_park_reasons r
        ON r.id = CAST(SUBSTR(w.active_recovery_case_ref, 23) AS INTEGER)
      LEFT JOIN factory_process_runs pr ON pr.id = w.process_run_id
      LEFT JOIN projects p ON p.id = pr.project_id
      LEFT JOIN epics e ON e.id = pr.epic_id
     WHERE w.kanban_phase='blocked' AND w.loop_state='paused'
       AND r.reason_code='GATE_HUMAN_REQUIRED'`;
  if (projectId !== undefined) {
    rows = db.prepare(`${baseSql} AND pr.project_id=?`).all(projectId) as typeof rows;
  } else {
    rows = db.prepare(baseSql).all() as typeof rows;
  }
  return rows.map(row => {
    const gateDecisionKey = gateDecisionKeyFromParkMessage(row.message);
    return {
      workplaceRef: row.workplace_ref,
      processRunId: row.process_run_id,
      projectId: row.project_id,
      projectName: row.project_name,
      epicId: row.epic_id,
      epicName: row.epic_name,
      moduleRef: row.module_ref,
      productionCellId: row.production_cell_id,
      workKey: row.work_key,
      nextRole: row.next_role,
      parkReasonId: row.park_reason_id,
      parkMessage: row.message,
      parkedAt: row.parked_at,
      gateDecisionKey,
      checks: gateDecisionKey ? readDecisionChecks(db, gateDecisionKey) : [],
      subjectBinding: gateDecisionKey
        ? readSubjectBindingFromUnknown(db, gateDecisionKey)
        : null,
      repositoryPaths: projectRepositoryPaths(db, row.project_id),
    };
  });
}

export function resolveHumanGate(
  db: Database.Database,
  input: ResolveHumanGateInput,
): ResolvedHumanGate {
  if (input.decision !== 'accept' && input.decision !== 'reject') {
    throw new Error(`HUMAN_GATE_RESOLUTION_INVALID: decision must be 'accept' or 'reject'`);
  }
  const feedback = (input.feedback ?? '').trim().slice(0, FEEDBACK_LIMIT);
  if (input.decision === 'reject' && feedback.length === 0) {
    throw new Error(
      'HUMAN_GATE_FEEDBACK_REQUIRED: a reject must state what the operator '
        + 'did not like — the producing workshop reads this text',
    );
  }
  ensureHumanGateResolutionSchema(db);
  return withImmediateTransaction(db, () => {
    const row = db.prepare(
      `SELECT w.workplace_ref, w.process_run_id, w.next_role, w.revision,
              CAST(SUBSTR(w.active_recovery_case_ref, 23) AS INTEGER) AS park_reason_id,
              r.message
         FROM factory_workplaces w
         JOIN factory_workplace_park_reasons r
           ON r.id = CAST(SUBSTR(w.active_recovery_case_ref, 23) AS INTEGER)
        WHERE w.workplace_ref=? AND w.kanban_phase='blocked' AND w.loop_state='paused'
          AND r.reason_code='GATE_HUMAN_REQUIRED'`,
    ).get(input.workplaceRef) as {
      workplace_ref: string; process_run_id: number;
      next_role: 'author' | 'reviewer'; revision: number;
      park_reason_id: number; message: string;
    } | undefined;
    if (!row) {
      throw new Error(
        `HUMAN_GATE_PARK_NOT_FOUND: workplace '${input.workplaceRef}' is not `
          + 'parked with GATE_HUMAN_REQUIRED (already answered, or never asked)',
      );
    }
    const gateDecisionKey = gateDecisionKeyFromParkMessage(row.message);
    const subjectBinding = gateDecisionKey
      ? readSubjectBindingFromUnknown(db, gateDecisionKey)
      : null;
    const info = db.prepare(
      `INSERT INTO factory_human_gate_resolutions
         (workplace_ref, process_run_id, park_reason_id, gate_decision_key,
          subject_binding, provider_id, resolution, feedback, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workplace_ref,
      row.process_run_id,
      row.park_reason_id,
      gateDecisionKey ?? `park-reason:${row.park_reason_id}`,
      subjectBinding,
      'factory.local-runnability.v1',
      input.decision,
      input.decision === 'reject' ? feedback : (feedback || null),
      input.actorId,
    );
    // Canonical `repair-requeued` resume (production-cell-reducer: "paused →
    // queued after a human-required block is resumed"), the same CAS shape as
    // unparkWorkplaces. Idempotent-by-CAS: a concurrent resume makes this
    // UPDATE miss and the resolution stays as audit.
    const role = row.next_role === 'reviewer' ? 'reviewer' : 'author';
    const targetPhase = role === 'reviewer' ? 'review_in_progress' : 'in_progress';
    const applied = db.prepare(
      `UPDATE factory_workplaces
          SET kanban_phase=?, loop_state='queued', next_role=?,
              revision=revision+1, updated_at=datetime('now')
        WHERE workplace_ref=? AND kanban_phase='blocked' AND loop_state='paused'
          AND revision=?`,
    ).run(targetPhase, role, row.workplace_ref, row.revision);
    db.prepare(
      `INSERT INTO activity_log (entity_type, entity_id, action, summary)
       VALUES ('workplace', ?, 'human-gate-resolved', ?)`,
    ).run(
      row.workplace_ref,
      `operator ${input.actorId} ${input.decision === 'accept'
        ? 'ACCEPTED the human_required gate product'
        : 'REJECTED the human_required gate product'}`
        + (input.decision === 'reject' ? ` — feedback: ${feedback}` : '')
        + ` — workplace resumed (repair-requeued)`,
    );
    return {
      resolutionId: Number(info.lastInsertRowid),
      workplaceRef: row.workplace_ref,
      revision: applied.changes === 1 ? row.revision + 1 : row.revision,
      gateDecisionKey,
      subjectBinding,
    };
  });
}

/**
 * The provider-side consult (see local-runnability-check-provider.ts ≥1.16.0):
 * the LATEST resolution for (workplace, provider), gated on the exact subject
 * binding. Returns null when no resolution applies — the provider then keeps
 * its 1.15 behavior unchanged (fail-closed).
 *
 * Structurally typed over the minimal prepare/get surface so both the
 * better-sqlite3 handle (tracker/engine) and SqlDatabasePort (check provider)
 * can consult without a dependency on the concrete driver.
 */
export function consultHumanGateResolution(
  db: { prepare(source: string): { get(...args: unknown[]): unknown } },
  workplaceRef: string,
  providerId: string,
  subjectBinding: string | null,
): { resolution: 'accept' | 'reject'; feedback: string | null; id: number; actorId: string } | null {
  let row: {
    id: number; resolution: 'accept' | 'reject';
    feedback: string | null; actor_id: string; subject_binding: string | null;
  } | undefined;
  try {
    row = db.prepare(
      `SELECT id, resolution, feedback, actor_id, subject_binding
         FROM factory_human_gate_resolutions
        WHERE workplace_ref=? AND provider_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(workplaceRef, providerId) as typeof row;
  } catch {
    // Table absent (pre-console DB): no conversion, 1.15 behavior.
    return null;
  }
  if (!row) return null;
  // Bytes guard: the operator accepted/rejected ONE exact candidate. A check
  // over different bytes is a fresh question — no conversion.
  if (subjectBinding === null || row.subject_binding === null
    || subjectBinding !== row.subject_binding) {
    return null;
  }
  return {
    resolution: row.resolution,
    feedback: row.feedback,
    id: row.id,
    actorId: row.actor_id,
  };
}
