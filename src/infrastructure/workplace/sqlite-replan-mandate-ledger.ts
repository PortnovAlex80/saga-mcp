/**
 * RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §6) — the durable
 * re-plan mandate ledger, the executor's ReplanCyclePolicyPort.
 *
 * replanCycleCount is realized as the count of minted mandates over this
 * append-only table (K13 house pattern, mirroring
 * factory_gate_finding_set_chain): one immutable row per minted mandate,
 * keyed by the CASE LINEAGE — resolved from the mandate's process run as
 * (epic, module_ref): the Development planning family of one epic. Cycle 2
 * is a NEW process run, so the lineage key is the only cross-run identity
 * the cap can count on. (factory_lifecycle_runs carries no metadata column —
 * the ledger IS the count.)
 *
 * Idempotency: a decision is recorded together with the mandate; a replayed
 * ask for the SAME (workplace, role) returns the recorded decision verbatim
 * (a crash between record and the workplace park can never double-mint or
 * ratchet-deny against its own row).
 */

import type Database from 'better-sqlite3';
import {
  decideReplanCycle,
  type PriorReplanMandate,
  type ReplanCycleVerdict,
} from '../../process-modules/domain/workplace/replan-cycle-policy.js';
import type { ReplanCycleDecision, ReplanCyclePolicyPort }
  from '../../process-modules/application/node-executors/production-cell-node-executor.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

const MANDATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS factory_replan_mandates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  case_lineage_key TEXT NOT NULL,
  workplace_ref    TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  cycle_number     INTEGER NOT NULL CHECK (cycle_number >= 2),
  surviving_keys   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref, role)
);
CREATE INDEX IF NOT EXISTS idx_replan_mandates_lineage
  ON factory_replan_mandates(case_lineage_key, id);

CREATE TRIGGER IF NOT EXISTS trg_replan_mandates_no_update
BEFORE UPDATE ON factory_replan_mandates
BEGIN
  SELECT RAISE(ABORT, 'factory_replan_mandates is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_replan_mandates_no_delete
BEFORE DELETE ON factory_replan_mandates
BEGIN
  SELECT RAISE(ABORT, 'factory_replan_mandates is append-only');
END;
`;

function ensureMandateTable(db: Database.Database): void {
  const present = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type='table' AND name='factory_replan_mandates'`,
  ).get() as { n: number };
  if (present.n === 0) db.exec(MANDATE_TABLE_DDL);
}

interface MandateRow {
  readonly id: number;
  readonly cycle_number: number;
  readonly surviving_keys: string;
}

export class SqliteReplanMandateLedger implements ReplanCyclePolicyPort {
  constructor(private readonly db: Database.Database) {
    ensureMandateTable(db);
  }

  canReplan(input: {
    workplaceRef: WorkplaceRef;
    role: 'author' | 'reviewer';
    survivingKeys: readonly string[];
  }): ReplanCycleDecision {
    const serialized = serializeWorkplaceRef(input.workplaceRef);
    return this.db.transaction((): ReplanCycleDecision => {
      const replayed = this.db.prepare(
        'SELECT cycle_number FROM factory_replan_mandates WHERE workplace_ref=? AND role=?',
      ).get(serialized, input.role) as { cycle_number: number } | undefined;
      if (replayed) {
        const verdict: ReplanCycleVerdict = {
          allowed: true,
          reason: 'mint',
          cycleNumber: replayed.cycle_number,
          diagnosis: 'replayed mandate decision (idempotent)',
        };
        return toDecision(verdict);
      }
      const lineageKey = this.lineageKeyFor(input.workplaceRef);
      const prior = this.db.prepare(
        'SELECT id, cycle_number, surviving_keys FROM factory_replan_mandates '
        + 'WHERE case_lineage_key=? ORDER BY id',
      ).all(lineageKey) as MandateRow[];
      const verdict = decideReplanCycle({
        survivingKeys: [...input.survivingKeys],
        priorMandates: prior.map(row => ({
          cycleNumber: row.cycle_number,
          survivingKeys: JSON.parse(row.surviving_keys) as string[],
        } satisfies PriorReplanMandate)),
      });
      if (verdict.allowed) {
        this.db.prepare(
          `INSERT INTO factory_replan_mandates
             (case_lineage_key, workplace_ref, role, cycle_number, surviving_keys)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          lineageKey,
          serialized,
          input.role,
          verdict.cycleNumber,
          JSON.stringify([...input.survivingKeys].sort()),
        );
      }
      return toDecision(verdict);
    })();
  }

  /**
   * The Development planning lineage of one epic: cross-run stable. When the
   * process-run table is not materialized (hermetic harnesses), the run-scoped
   * key is the best available lineage identity.
   */
  private lineageKeyFor(ref: WorkplaceRef): string {
    let run: { epic_id: number | null; module_ref_key: string } | undefined;
    try {
      run = this.db.prepare(
        'SELECT epic_id, module_ref_key FROM factory_process_runs WHERE id=?',
      ).get(ref.processRunId) as { epic_id: number | null; module_ref_key: string } | undefined;
    } catch {
      run = undefined;
    }
    if (!run || run.epic_id === null) {
      return `development-case:run:${ref.processRunId}:${ref.moduleRef}`;
    }
    return `development-case:epic:${run.epic_id}:${run.module_ref_key}`;
  }
}

function toDecision(verdict: ReplanCycleVerdict): ReplanCycleDecision {
  return {
    allowed: verdict.allowed,
    cycleNumber: verdict.cycleNumber,
    reason: verdict.reason,
    diagnosis: verdict.diagnosis,
  };
}
