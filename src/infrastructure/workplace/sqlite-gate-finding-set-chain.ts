/**
 * FINDING-TRAJECTORY BUDGET — the append-only finding-set chain repository
 * (docs/architecture/FINDING-TRAJECTORY-BUDGET.md, unit 2 of 3).
 *
 * One immutable row per repair_required GateDecision, written in the SAME
 * transaction as the decision (the executor's runGate closure): the decision
 * and its finding-set identity land atomically, and a crash between them is
 * impossible. Findings are decoded through the ONE shared
 * `decodeFindingsForDecision` (extracted from the recovery-feedback writer),
 * so the feedback sheet on the worker's desk and the convergence budget read
 * the same findings by construction — they cannot diverge.
 *
 * The chain is scoped by (workplace, gate, repair-target-role) AND
 * check_plan_digest: the reader derives the scope from the LATEST row of the
 * (workplace, role) pair and returns only rows matching that scope. A check
 * plan change therefore starts a fresh chain — findings produced under a
 * different plan are not comparable evidence (T7).
 *
 * K13 house pattern: the base DDL lives in schema.ts; the constructor
 * PRAGMA-guarded CREATE converges a pre-table database in place (never resets
 * rows).
 */

import type Database from 'better-sqlite3';
import {
  findingSet,
  type FindingSet,
} from '../../process-modules/domain/workplace/finding-trajectory.js';
import {
  decodeFindingsForDecision,
} from './sqlite-production-cell-projection-persistence.js';

const CHAIN_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS factory_gate_finding_set_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workplace_ref           TEXT NOT NULL,
  gate_ref                TEXT NOT NULL,
  repair_target_role      TEXT NOT NULL CHECK (repair_target_role IN ('author','reviewer')),
  check_plan_digest       TEXT NOT NULL,
  gate_decision_key       TEXT NOT NULL UNIQUE,
  finding_set_digest      TEXT NOT NULL,
  finding_count           INTEGER NOT NULL CHECK (finding_count >= 0),
  fatal_finding_count     INTEGER NOT NULL CHECK (fatal_finding_count >= 0),
  finding_keys            TEXT NOT NULL,
  fatal_finding_keys      TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (gate_decision_key) REFERENCES factory_gate_decisions(decision_key) ON DELETE RESTRICT,
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_gate_finding_set_chain_scope
  ON factory_gate_finding_set_chain(workplace_ref, repair_target_role, gate_ref, check_plan_digest, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_gate_finding_set_chain_no_update
  BEFORE UPDATE ON factory_gate_finding_set_chain
  BEGIN
    SELECT RAISE(ABORT, 'factory_gate_finding_set_chain is immutable (append-only)');
  END;

CREATE TRIGGER IF NOT EXISTS trg_gate_finding_set_chain_no_delete
  BEFORE DELETE ON factory_gate_finding_set_chain
  BEGIN
    SELECT RAISE(ABORT, 'factory_gate_finding_set_chain is immutable (append-only)');
  END;
`;

/** K13 lazy-ensure: converge an existing DB with the base DDL, never reset. */
function ensureChainTable(db: Database.Database): void {
  const present = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type='table' AND name='factory_gate_finding_set_chain'`,
  ).get() as { n: number };
  if (present.n === 0) db.exec(CHAIN_TABLE_DDL);
}

export interface AppendFindingSetChainInput {
  readonly workplaceRef: string;
  readonly gateDecisionKey: string;
  readonly gateRef: string;
  readonly repairTargetRole: 'author' | 'reviewer';
  readonly checkPlanDigest: string;
  readonly checkReceiptRefs: readonly string[];
  /** Used when a receipt carries no decodable subject (same fallback as feedback). */
  readonly fallbackSubjectRef: string;
}

export interface GateFindingSetChainRow {
  readonly gateDecisionKey: string;
  readonly gateRef: string;
  readonly repairTargetRole: 'author' | 'reviewer';
  readonly checkPlanDigest: string;
  readonly set: FindingSet;
  readonly createdAt: string;
}

export interface FindingSetChainTail {
  readonly gateRef: string;
  readonly checkPlanDigest: string;
  /** Same-scope rows, OLDEST first — ready for trajectory()/convergingStreak(). */
  readonly sets: readonly FindingSet[];
  /** The decoded findings of the LATEST row (for surviving-key diagnosis). */
  readonly latestKeys: readonly string[];
}

/**
 * Bounded tail read: the ceiling is at most the policy convergenceChainAttempts
 * (default 20), so 64 same-scope rows is far beyond any decision the executor
 * can make from this chain.
 */
const TAIL_LIMIT = 64;

export class SqliteGateFindingSetChain {
  constructor(private readonly db: Database.Database) {
    ensureChainTable(db);
  }

  /**
   * Append the finding-set row of one repair_required decision. Idempotent by
   * the UNIQUE (gate_decision_key) constraint: a replayed decision appends
   * nothing. Call inside the decision's transaction.
   */
  appendForDecision(input: AppendFindingSetChainInput): void {
    const findings = decodeFindingsForDecision(
      this.db,
      input.checkReceiptRefs,
      input.fallbackSubjectRef,
    );
    const set = findingSet(findings);
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_gate_finding_set_chain
         (workplace_ref, gate_ref, repair_target_role, check_plan_digest,
          gate_decision_key, finding_set_digest, finding_count,
          fatal_finding_count, finding_keys, fatal_finding_keys)
       VALUES (@workplaceRef, @gateRef, @role, @planDigest,
               @decisionKey, @digest, @count,
               @fatalCount, @keysJson, @fatalKeysJson)`,
    ).run({
      workplaceRef: input.workplaceRef,
      gateRef: input.gateRef,
      role: input.repairTargetRole,
      planDigest: input.checkPlanDigest,
      decisionKey: input.gateDecisionKey,
      digest: set.digest,
      count: set.count,
      fatalCount: set.fatalKeys.length,
      keysJson: JSON.stringify(set.keys),
      fatalKeysJson: JSON.stringify(set.fatalKeys),
    });
  }

  /**
   * The trajectory tail of one (workplace, role): the scope is derived from
   * the LATEST row — same gate, same check-plan digest. Rows written under a
   * different plan (or gate) are intentionally invisible here: the chain
   * RESETS on a check-plan change (T7).
   */
  readTrajectoryTail(
    workplaceRef: string,
    role: 'author' | 'reviewer',
  ): FindingSetChainTail | null {
    const latest = this.db.prepare(
      `SELECT id, gate_ref, check_plan_digest
         FROM factory_gate_finding_set_chain
        WHERE workplace_ref=? AND repair_target_role=?
        ORDER BY id DESC LIMIT 1`,
    ).get(workplaceRef, role) as
      | { id: number; gate_ref: string; check_plan_digest: string }
      | undefined;
    if (!latest) return null;
    const rows = this.db.prepare(
      `SELECT gate_decision_key, finding_set_digest, finding_count,
              finding_keys, fatal_finding_keys, created_at
         FROM factory_gate_finding_set_chain
        WHERE workplace_ref=? AND repair_target_role=? AND gate_ref=?
          AND check_plan_digest=? AND id<=?
        ORDER BY id DESC LIMIT ${TAIL_LIMIT}`,
    ).all(workplaceRef, role, latest.gate_ref, latest.check_plan_digest, latest.id)
      .reverse() as Array<{
      gate_decision_key: string;
      finding_set_digest: string;
      finding_count: number;
      finding_keys: string;
      fatal_finding_keys: string;
      created_at: string;
    }>;
    if (rows.length === 0) return null;
    const sets = rows.map(row => ({
      digest: row.finding_set_digest,
      count: row.finding_count,
      keys: JSON.parse(row.finding_keys) as string[],
      fatalKeys: JSON.parse(row.fatal_finding_keys) as string[],
    }));
    return {
      gateRef: latest.gate_ref,
      checkPlanDigest: latest.check_plan_digest,
      sets,
      latestKeys: sets[sets.length - 1]!.keys,
    };
  }
}
