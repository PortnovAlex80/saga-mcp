/**
 * RECONCILIATION DESK — SEAM-ARCHITECT Layer 3, the durable append-only
 * reconciliation ledger (K13 house pattern, mirroring
 * factory_replan_mandates in sqlite-replan-mandate-ledger.ts).
 *
 * The ledger IS the count the CAP counts on and the ratchet the
 * structural-seam denial reads: one immutable row per SEALED reconciliation
 * round, keyed by the case lineage — resolved from the workplace's process
 * run as (epic, module family), the same cross-run identity the re-plan
 * mandate ledger uses. A reconciliation round that never lands here is
 * invisible to the next admission decision.
 *
 * Idempotency: the row key is a content-addressed reconciliation_ref
 * (sha256 over workplace + seam keys + sanction). A replayed append of the
 * same sealed record returns the existing row id verbatim — a crash between
 * seal and ledger-append can never double-count a round against its own cap.
 */

import type Database from 'better-sqlite3';
import { sha256Hex, canonicalJson } from '../../shared/canonical-json.js';
import {
  admitReconciliation,
  type PriorReconciliation,
  type ReconciliationAdmission,
  type SealedReconciliationRecord,
  type SeamDefect,
  type SeamOwnership,
} from '../../process-modules/domain/workplace/reconciliation-desk.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

const RECONCILIATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS factory_reconciliation_records (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  case_lineage_key   TEXT NOT NULL,
  workplace_ref      TEXT NOT NULL,
  reconciliation_ref TEXT NOT NULL,
  seam_keys          TEXT NOT NULL,
  report_json        TEXT NOT NULL,
  sanction_json      TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workplace_ref, reconciliation_ref)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_records_lineage
  ON factory_reconciliation_records(case_lineage_key, id);

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_records_no_update
BEFORE UPDATE ON factory_reconciliation_records
BEGIN
  SELECT RAISE (ABORT, 'factory_reconciliation_records is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_reconciliation_records_no_delete
BEFORE DELETE ON factory_reconciliation_records
BEGIN
  SELECT RAISE (ABORT, 'factory_reconciliation_records is append-only');
END;
`;

function ensureReconciliationTable(db: Database.Database): void {
  const present = db.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type='table' AND name='factory_reconciliation_records'`,
  ).get() as { n: number };
  if (present.n === 0) db.exec(RECONCILIATION_TABLE_DDL);
}

interface RecordRow {
  readonly id: number;
  readonly seam_keys: string;
}

export interface AppendSealedRecordResult {
  readonly id: number;
  /** True when the row was already present (idempotent replay). */
  readonly replayed: boolean;
}

export class SqliteReconciliationLedger {
  constructor(private readonly db: Database.Database) {
    ensureReconciliationTable(db);
  }

  /**
   * Admission over the durable lineage: consults prior sealed rounds for the
   * cap and the structural ratchet, then delegates to the pure
   * {@link admitReconciliation} decision. Read-only — denials and admissions
   * never write; only sealed rounds append.
   */
  admitReconciliation(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly seam: SeamDefect;
    readonly ownership: SeamOwnership;
    readonly survivingReplanKeys?: readonly string[];
  }): ReconciliationAdmission {
    const prior = this.db.prepare(
      'SELECT id, seam_keys FROM factory_reconciliation_records '
      + 'WHERE case_lineage_key=? ORDER BY id',
    ).all(this.lineageKeyFor(input.workplaceRef)) as RecordRow[];
    return admitReconciliation({
      seam: input.seam,
      ownership: input.ownership,
      priorReconciliations: prior.map(row => ({
        seamKeys: JSON.parse(row.seam_keys) as string[],
      } satisfies PriorReconciliation)),
      ...(input.survivingReplanKeys
        ? { survivingReplanKeys: [...input.survivingReplanKeys] }
        : {}),
    });
  }

  /**
   * Append one sealed reconciliation round. Idempotent on the content-addressed
   * (workplace, reconciliation_ref) key; the record payload is stored verbatim
   * (JSON) so any later audit reads exactly what was sanctioned.
   */
  appendSealedRecord(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly record: SealedReconciliationRecord;
  }): AppendSealedRecordResult {
    const serialized = serializeWorkplaceRef(input.workplaceRef);
    const seamKeys = [...input.record.seamKeys].sort();
    const reconciliationRef = sha256Hex(canonicalJson({
      workplace: serialized,
      seamKeys,
      sanction: input.record.sanction,
    }));
    return this.db.transaction((): AppendSealedRecordResult => {
      const existing = this.db.prepare(
        'SELECT id FROM factory_reconciliation_records '
        + 'WHERE workplace_ref=? AND reconciliation_ref=?',
      ).get(serialized, reconciliationRef) as { id: number } | undefined;
      if (existing) return { id: existing.id, replayed: true };
      const inserted = this.db.prepare(
        `INSERT INTO factory_reconciliation_records
           (case_lineage_key, workplace_ref, reconciliation_ref, seam_keys,
            report_json, sanction_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        this.lineageKeyFor(input.workplaceRef),
        serialized,
        reconciliationRef,
        JSON.stringify(seamKeys),
        canonicalJson(input.record.report),
        canonicalJson(input.record.sanction),
      );
      return { id: Number(inserted.lastInsertRowid), replayed: false };
    })();
  }

  /**
   * The case lineage of one workplace: cross-run stable, mirroring the
   * re-plan mandate ledger. When the process-run table is not materialized
   * (hermetic harnesses), the run-scoped key is the best available identity.
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
