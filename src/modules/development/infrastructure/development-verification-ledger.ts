/**
 * CC-GAP-8 — module-local append-only criterion-key verification ledger
 * (SQLite infrastructure).
 *
 * The ledger opens AT GRAPH MATERIALIZATION (`materializeValidatedTaskGraph`):
 * every criterion key named by a verification item is appended as `proposed`
 * (planner provenance) and immediately `pending` (kernel obligation with
 * owner + unblock condition). It is APPEND-ONLY (triggers reject UPDATE and
 * DELETE), idempotent on replay, and never back-fills legacy graphs — a run
 * whose graph materialized before this ledger is typed `legacy-unaccounted`
 * by the projection, with frozen evidence untouched.
 *
 * Execution facts append from the settlement-state seam
 * (`buildAcceptanceVerification`), where the exact trusted-receipt outcome
 * (passed|failed) is resolved per criterion key and candidate. A failed
 * execution is a recorded fact, never a discharge. The ONLY discharges are
 * an exact passed receipt and an operator-attributed waiver with provenance.
 *
 * CC-GAP-8 terminal repair: TERMINAL-ROUTE facts append at the settlement
 * seam when the run terminates without executing an obligation —
 * `terminal-unknown` (environment/readiness uncertainty, never product
 * failure), `terminal-blocked`, `terminal-human-required` (attributed to the
 * exact open human gates) — each with settlement-certificate provenance.
 * They close the row for this run without discharging it and never poison a
 * later executed/waived append (latest event wins).
 *
 * This store is Development-module-local. It deliberately does NOT touch
 * `factory_transition_obligations` (the conveyor transition ledger), GAP-9
 * routing, GAP-7 warrants, or GAP-10 role chips.
 */

import type Database from 'better-sqlite3';
import type {
  DevelopmentTaskGraphSnapshot,
} from '../domain/development-schemas.js';
import type {
  VerificationLedgerEvent,
  VerificationTerminalRouteKind,
} from '../domain/verification-accounting.js';
import {
  projectCriterionLedgerAccounting,
  projectLegacyUnaccountedVerification,
  terminalRouteEventState,
  type VerificationAccountingProjection,
} from '../domain/verification-accounting.js';

const LEDGER_TABLE = 'factory_development_verification_ledger';
const TASK_GRAPH_PRODUCT_KIND = 'development.task-graph';

export function ensureDevelopmentVerificationLedgerSchema(
  db: Database.Database,
): void {
  const columns = db.prepare(
    `PRAGMA table_info(${LEDGER_TABLE})`,
  ).all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some(column => column.name === 'terminal_route')) {
    // v1 -> v2 migration: the append-only rows are preserved verbatim; only
    // the table shape changes (terminal-route columns + the extended
    // entry_state CHECK). Rebuild in ONE transaction — triggers dropped, new
    // table created, rows copied, old table replaced, triggers recreated.
    migrateLedgerV1ToV2(db);
    return;
  }
  createLedgerSchemaV2(db);
}

function createLedgerSchemaV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id        INTEGER NOT NULL
                              REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      project_id            INTEGER NOT NULL,
      epic_id               INTEGER NOT NULL,
      graph_hash            TEXT NOT NULL,
      criterion_key         TEXT NOT NULL,
      verification_item_key TEXT NOT NULL,
      required              INTEGER NOT NULL,
      criticality           TEXT
                            CHECK (criticality IS NULL
                                   OR criticality IN ('blocker','degradable','nice_to_have')),
      entry_state           TEXT NOT NULL
                            CHECK (entry_state IN ('proposed','pending','executed','waived',
                                                   'terminal-unknown','terminal-blocked',
                                                   'terminal-human-required')),
      outcome               TEXT
                            CHECK (outcome IS NULL OR outcome IN ('passed','failed')),
      candidate_hash        TEXT,
      receipt_ref           TEXT,
      receipt_digest        TEXT,
      waiver_operator       TEXT,
      waiver_reason         TEXT,
      waiver_provenance_ref TEXT,
      proposed_from_ref     TEXT,
      terminal_route        TEXT
                            CHECK (terminal_route IS NULL
                                   OR terminal_route IN ('unknown','blocked','human-required')),
      terminal_reason_codes TEXT
                            CHECK (terminal_reason_codes IS NULL
                                   OR terminal_reason_codes LIKE '[%'),
      terminal_provenance_ref TEXT,
      terminal_attributed_to TEXT
                            CHECK (terminal_attributed_to IS NULL
                                   OR terminal_attributed_to LIKE '[%'),
      recorded_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_factory_development_verification_ledger_run
      ON ${LEDGER_TABLE}(process_run_id, criterion_key, id);

    CREATE INDEX IF NOT EXISTS idx_factory_development_verification_ledger_epic
      ON ${LEDGER_TABLE}(epic_id, process_run_id, id);

    -- CC-GAP-8 append-only invariant: an accounting fact, once recorded, is
    -- never rewritten and never deleted. Discharge is a NEW event, never a
    -- mutation of an old one.
    CREATE TRIGGER IF NOT EXISTS trg_factory_development_verification_ledger_no_update
      BEFORE UPDATE ON ${LEDGER_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'DEVELOPMENT_VERIFICATION_LEDGER_APPEND_ONLY');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_factory_development_verification_ledger_no_delete
      BEFORE DELETE ON ${LEDGER_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'DEVELOPMENT_VERIFICATION_LEDGER_DELETE_FORBIDDEN');
      END;
  `);
}

/**
 * v1 -> v2: preserve every recorded fact verbatim. The DELETE trigger blocks
 * the plain drop-and-copy, so triggers are dropped INSIDE the migration
 * transaction and recreated from the v2 shape at the end. A crash mid-way
 * rolls the transaction back whole (SQLite DDL is transactional here).
 */
function migrateLedgerV1ToV2(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS trg_factory_development_verification_ledger_no_update`);
    db.exec(`DROP TRIGGER IF EXISTS trg_factory_development_verification_ledger_no_delete`);
    db.exec(`
      CREATE TABLE ${LEDGER_TABLE}__v2 (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        process_run_id        INTEGER NOT NULL
                                REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
        project_id            INTEGER NOT NULL,
        epic_id               INTEGER NOT NULL,
        graph_hash            TEXT NOT NULL,
        criterion_key         TEXT NOT NULL,
        verification_item_key TEXT NOT NULL,
        required              INTEGER NOT NULL,
        criticality           TEXT
                              CHECK (criticality IS NULL
                                     OR criticality IN ('blocker','degradable','nice_to_have')),
        entry_state           TEXT NOT NULL
                                CHECK (entry_state IN ('proposed','pending','executed','waived',
                                                       'terminal-unknown','terminal-blocked',
                                                       'terminal-human-required')),
        outcome               TEXT
                                CHECK (outcome IS NULL OR outcome IN ('passed','failed')),
        candidate_hash        TEXT,
        receipt_ref           TEXT,
        receipt_digest        TEXT,
        waiver_operator       TEXT,
        waiver_reason         TEXT,
        waiver_provenance_ref TEXT,
        proposed_from_ref     TEXT,
        terminal_route        TEXT
                              CHECK (terminal_route IS NULL
                                     OR terminal_route IN ('unknown','blocked','human-required')),
        terminal_reason_codes TEXT
                              CHECK (terminal_reason_codes IS NULL
                                     OR terminal_reason_codes LIKE '[%'),
        terminal_provenance_ref TEXT,
        terminal_attributed_to TEXT
                              CHECK (terminal_attributed_to IS NULL
                                     OR terminal_attributed_to LIKE '[%'),
        recorded_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      INSERT INTO ${LEDGER_TABLE}__v2
        (id,process_run_id,project_id,epic_id,graph_hash,criterion_key,
         verification_item_key,required,criticality,entry_state,outcome,
         candidate_hash,receipt_ref,receipt_digest,waiver_operator,waiver_reason,
         waiver_provenance_ref,proposed_from_ref,recorded_at)
      SELECT id,process_run_id,project_id,epic_id,graph_hash,criterion_key,
             verification_item_key,required,criticality,entry_state,outcome,
             candidate_hash,receipt_ref,receipt_digest,waiver_operator,waiver_reason,
             waiver_provenance_ref,proposed_from_ref,recorded_at
        FROM ${LEDGER_TABLE}
       ORDER BY id
    `);
    db.exec(`DROP TABLE ${LEDGER_TABLE}`);
    db.exec(`ALTER TABLE ${LEDGER_TABLE}__v2 RENAME TO ${LEDGER_TABLE}`);
  })();
  createLedgerSchemaV2(db);
}

/**
 * Open the ledger for a freshly materialized graph: append `proposed` (the
 * planner-proposal provenance) then `pending` (the first-class kernel
 * obligation with owner + unblock condition) for EVERY criterion key named
 * by a verification item. Idempotent per (run, graph, criterion key, state);
 * graphs materialized before the ledger existed are never back-filled.
 */
export function openVerificationLedgerAtGraphMaterialization(
  db: Database.Database,
  input: {
    processRunId: number;
    projectId: number;
    epicId: number;
    graph: DevelopmentTaskGraphSnapshot;
  },
): void {
  ensureDevelopmentVerificationLedgerSchema(db);
  const insert = db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (process_run_id,project_id,epic_id,graph_hash,criterion_key,
        verification_item_key,required,criticality,entry_state,proposed_from_ref)
     SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (
        SELECT 1 FROM ${LEDGER_TABLE}
         WHERE process_run_id=? AND graph_hash=? AND criterion_key=? AND entry_state=?
      )`,
  );
  for (const item of input.graph.verificationItems) {
    for (const criterionKey of [...item.acceptanceCriterionKeys].sort()) {
      // The proposal fact: the obligation exists in the planner submission.
      insert.run(
        input.processRunId,
        input.projectId,
        input.epicId,
        input.graph.graphHash,
        criterionKey,
        item.key,
        item.required ? 1 : 0,
        item.criticality,
        'proposed',
        input.graph.plannerSubmission.ref,
        input.processRunId,
        input.graph.graphHash,
        criterionKey,
        'proposed',
      );
      // The kernel obligation: first-class pending entry with owner
      // ('development-verification' cell) and unblock condition (readiness
      // recovery) rendered by the domain projector constants. Pending
      // survives readiness failure and continuation — only executed(passed)
      // or an operator waiver can discharge it.
      insert.run(
        input.processRunId,
        input.projectId,
        input.epicId,
        input.graph.graphHash,
        criterionKey,
        item.key,
        item.required ? 1 : 0,
        item.criticality,
        'pending',
        null,
        input.processRunId,
        input.graph.graphHash,
        criterionKey,
        'pending',
      );
    }
  }
}

/**
 * Append an `executed` fact for one criterion key: the outcome of the exact
 * trusted-receipt verification against the exact candidate. Idempotent per
 * (run, criterion, outcome, receipt digest, candidate). Executed-FAILED is
 * recorded but is NOT a discharge. Legacy runs (no ledger rows at all) are
 * skipped silently — legacy typing must stay whole; a run WITH rows but no
 * entry for the criterion fails closed (partial accounting is a defect).
 *
 * The appended fact carries the SAME `verification_item_key` and `required`
 * truth as the opening proposed/pending fact (read from the ledger, never
 * re-asserted by the caller): an optional obligation (`required=false`) must
 * not morph into a required one in the raw event history just because it
 * executed. The caller-supplied `verificationItemKey` is therefore COMPARED
 * against the opening fact for the exact criterion — a mismatch is a typed
 * fail-closed refusal thrown BEFORE any append (the executed fact can never
 * be silently re-attributed to a different verification item).
 */
export function recordVerificationExecuted(
  db: Database.Database,
  input: {
    processRunId: number;
    criterionKey: string;
    verificationItemKey: string;
    outcome: 'passed' | 'failed';
    receiptRef: string;
    receiptDigest: string;
    candidateHash: string;
  },
): void {
  ensureDevelopmentVerificationLedgerSchema(db);
  const graphHash = readLedgerGraphHash(db, input.processRunId);
  if (graphHash === null) return; // legacy run: never partially accounted
  const opened = db.prepare(
    `SELECT verification_item_key,required FROM ${LEDGER_TABLE}
      WHERE process_run_id=? AND criterion_key=?
        AND entry_state IN ('proposed','pending')
      ORDER BY id LIMIT 1`,
  ).get(input.processRunId, input.criterionKey) as {
    verification_item_key: string;
    required: number;
  } | undefined;
  if (!opened) {
    throw new Error(
      `DEVELOPMENT_VERIFICATION_LEDGER_ENTRY_UNKNOWN: ${input.processRunId}/${input.criterionKey}`,
    );
  }
  if (opened.verification_item_key !== input.verificationItemKey) {
    // Fail closed BEFORE the append: the caller asserts a different
    // verification item than the one that opened this exact criterion —
    // a seam defect, never a silently re-attributed executed fact.
    throw new Error(
      `DEVELOPMENT_VERIFICATION_LEDGER_ITEM_KEY_MISMATCH: ${input.processRunId}/${input.criterionKey}`
        + ` opened=${opened.verification_item_key}`
        + ` caller=${input.verificationItemKey}`,
    );
  }
  db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (process_run_id,project_id,epic_id,graph_hash,criterion_key,
        verification_item_key,required,entry_state,outcome,
        candidate_hash,receipt_ref,receipt_digest)
     SELECT ?,(SELECT project_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            (SELECT epic_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            ?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (
        SELECT 1 FROM ${LEDGER_TABLE}
         WHERE process_run_id=? AND criterion_key=? AND entry_state='executed'
           AND outcome=? AND receipt_digest=? AND candidate_hash=?
      )`,
  ).run(
    input.processRunId,
    input.processRunId,
    input.processRunId,
    graphHash,
    input.criterionKey,
    opened.verification_item_key,
    opened.required,
    'executed',
    input.outcome,
    input.candidateHash,
    input.receiptRef,
    input.receiptDigest,
    input.processRunId,
    input.criterionKey,
    input.outcome,
    input.receiptDigest,
    input.candidateHash,
  );
}

/**
 * Append an operator-attributed waiver for one criterion key. The ONLY
 * non-receipt discharge; requires operator identity, reason and provenance
 * ref (fail closed when any is missing) and an existing accounted entry.
 */
export function recordVerificationWaiver(
  db: Database.Database,
  input: {
    processRunId: number;
    criterionKey: string;
    operator: string;
    reason: string;
    provenanceRef: string;
  },
): void {
  ensureDevelopmentVerificationLedgerSchema(db);
  if (!input.operator.trim() || !input.reason.trim() || !input.provenanceRef.trim()) {
    throw new Error('DEVELOPMENT_VERIFICATION_WAIVER_PROVENANCE_REQUIRED');
  }
  const graphHash = readLedgerGraphHash(db, input.processRunId);
  if (graphHash === null) {
    throw new Error(
      `DEVELOPMENT_VERIFICATION_LEDGER_ENTRY_UNKNOWN: ${input.processRunId}/${input.criterionKey}`,
    );
  }
  const opened = db.prepare(
    `SELECT verification_item_key,required FROM ${LEDGER_TABLE}
      WHERE process_run_id=? AND criterion_key=?
        AND entry_state IN ('proposed','pending')
      ORDER BY id LIMIT 1`,
  ).get(input.processRunId, input.criterionKey) as {
    verification_item_key: string;
    required: number;
  } | undefined;
  if (!opened) {
    throw new Error(
      `DEVELOPMENT_VERIFICATION_LEDGER_ENTRY_UNKNOWN: ${input.processRunId}/${input.criterionKey}`,
    );
  }
  db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (process_run_id,project_id,epic_id,graph_hash,criterion_key,
        verification_item_key,required,entry_state,
        waiver_operator,waiver_reason,waiver_provenance_ref)
     SELECT ?,(SELECT project_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            (SELECT epic_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            ?,?,?,?,'waived',?,?,?`,
  ).run(
    input.processRunId,
    input.processRunId,
    input.processRunId,
    graphHash,
    input.criterionKey,
    opened.verification_item_key,
    opened.required,
    input.operator,
    input.reason,
    input.provenanceRef,
  );
}

/**
 * Append a TERMINAL-ROUTE fact for every criterion key whose latest event is
 * still unexecuted (proposed/pending) or already terminal (a later settlement
 * drive may legitimately re-classify the terminal route; latest event wins).
 * Entries holding an `executed` fact are NEVER overwritten — an executed
 * product verdict (passed or failed) is a recorded fact that a terminal
 * route must not conflate with environment uncertainty.
 *
 * Terminal facts carry provenance (reason codes + settlement certificate
 * ref) and are NEVER a discharge. They do NOT poison later replay/retry: an
 * `executed`/`waived` fact appended afterwards supersedes by sequence, and a
 * continuation run opens its own ledger. Idempotent per
 * (run, criterion, route, provenance ref). Legacy runs (no ledger rows at
 * all) are skipped whole — legacy typing must stay whole.
 */
export function recordVerificationTerminalRoute(
  db: Database.Database,
  input: {
    processRunId: number;
    route: VerificationTerminalRouteKind;
    reasonCodes: readonly string[];
    provenanceRef: string;
    attributedTo?: readonly string[];
  },
): void {
  ensureDevelopmentVerificationLedgerSchema(db);
  const reasonCodes = [...new Set(input.reasonCodes.map(code => code.trim()))]
    .filter(code => code.length > 0);
  if (reasonCodes.length === 0) {
    throw new Error('DEVELOPMENT_VERIFICATION_TERMINAL_PROVENANCE_REQUIRED');
  }
  if (!input.provenanceRef.trim()) {
    throw new Error('DEVELOPMENT_VERIFICATION_TERMINAL_PROVENANCE_REQUIRED');
  }
  const attributedTo = input.attributedTo === undefined
    ? []
    : [...new Set(input.attributedTo.map(gate => gate.trim()))]
      .filter(gate => gate.length > 0);
  if (input.route === 'human-required' && attributedTo.length === 0) {
    throw new Error('DEVELOPMENT_VERIFICATION_TERMINAL_HUMAN_ATTRIBUTION_REQUIRED');
  }
  const entryState = terminalRouteEventState(input.route);
  const graphHash = readLedgerGraphHash(db, input.processRunId);
  if (graphHash === null) return; // legacy run: never partially accounted
  // EXACT-KEY FULL-CHAIN derivation (no newest-wins SQL selector): read the
  // COMPLETE append chain of the run in authoritative append order and fold
  // the current per-criterion state in code. The fold consumes every event —
  // it is the same full-chain reduction the domain projection performs, not a
  // chronology-picked winner row; the append ordinal only sequences the fold.
  const chain = db.prepare(
    `SELECT criterion_key,entry_state FROM ${LEDGER_TABLE}
      WHERE process_run_id=? ORDER BY id`,
  ).all(input.processRunId) as Array<{
    criterion_key: string;
    entry_state: VerificationLedgerEvent['entryState'];
  }>;
  const latestStateByKey = new Map<string, VerificationLedgerEvent['entryState']>();
  for (const event of chain) {
    latestStateByKey.set(event.criterion_key, event.entry_state);
  }
  const closable = new Set(['proposed', 'pending', 'terminal-unknown', 'terminal-blocked', 'terminal-human-required']);
  const insert = db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (process_run_id,project_id,epic_id,graph_hash,criterion_key,
        verification_item_key,required,entry_state,
        terminal_route,terminal_reason_codes,terminal_provenance_ref,
        terminal_attributed_to)
     SELECT ?,(SELECT project_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            (SELECT epic_id FROM ${LEDGER_TABLE} WHERE process_run_id=? LIMIT 1),
            ?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM ${LEDGER_TABLE}
          WHERE process_run_id=? AND criterion_key=? AND entry_state=?
            AND terminal_provenance_ref=?
       )`,
  );
  for (const criterionKey of [...latestStateByKey.keys()].sort()) {
    if (!closable.has(latestStateByKey.get(criterionKey)!)) continue; // executed/waived: never overwritten
    const opened = db.prepare(
      `SELECT verification_item_key,required FROM ${LEDGER_TABLE}
        WHERE process_run_id=? AND criterion_key=?
          AND entry_state IN ('proposed','pending')
        ORDER BY id LIMIT 1`,
    ).get(input.processRunId, criterionKey) as {
      verification_item_key: string;
      required: number;
    } | undefined;
    if (!opened) continue;
    insert.run(
      input.processRunId,
      input.processRunId,
      input.processRunId,
      graphHash,
      criterionKey,
      opened.verification_item_key,
      opened.required,
      entryState,
      input.route,
      JSON.stringify(reasonCodes),
      input.provenanceRef,
      JSON.stringify(attributedTo),
      input.processRunId,
      criterionKey,
      entryState,
      input.provenanceRef,
    );
  }
}

/**
 * Read the ledger of one run in authoritative append order (by row id).
 *
 * READ PATH — this function NEVER creates or migrates the schema. Schema
 * creation and the v1->v2 migration are owned by the WRITE path (graph
 * materialization / executed / waiver / terminal-route recording), which runs
 * on the engine's writable connection. A readonly caller (the tracker route
 * `GET /api/development/verification-accounting` opens the shared DB with
 * `readonly: true`) must receive a truthful answer, not an SQLITE_READONLY
 * error:
 *   - no ledger table at all  -> no events (nothing was ever accounted; the
 *     per-run projection then applies its legacy/null classification);
 *   - v1-shaped table (no terminal columns) -> rows are read with the
 *     terminal facts projected as "none recorded" (truthful for a table that
 *     predates terminal accounting); the writable engine path migrates the
 *     table at its next write.
 */
export function readDevelopmentVerificationLedgerEvents(
  db: Database.Database,
  processRunId: number,
): VerificationLedgerEvent[] {
  const columns = db.prepare(
    `PRAGMA table_info(${LEDGER_TABLE})`,
  ).all() as Array<{ name: string }>;
  if (columns.length === 0) return [];
  const hasTerminalColumns = columns.some(c => c.name === 'terminal_route');
  const terminalColumns = hasTerminalColumns
    ? 'terminal_route,terminal_reason_codes,terminal_provenance_ref,terminal_attributed_to,'
    : '';
  const rows = db.prepare(
    `SELECT id,process_run_id,graph_hash,criterion_key,verification_item_key,
            required,criticality,entry_state,outcome,candidate_hash,
            receipt_ref,receipt_digest,waiver_operator,waiver_reason,
            waiver_provenance_ref,proposed_from_ref,
            ${terminalColumns}recorded_at
       FROM ${LEDGER_TABLE}
      WHERE process_run_id=?
      ORDER BY id`,
  ).all(processRunId) as Array<VerificationLedgerRow | VerificationLedgerRowV1>;
  return rows.map(rowToEvent);
}

/**
 * Project the verification accounting of one run:
 *  - ledger rows exist -> criterion-key-ledger projection (current states,
 *    discharge provenance, stage/order facts);
 *  - a task graph exists but no ledger rows -> `legacy-unaccounted`
 *    (typed, visible, never discharged, never back-filled);
 *  - neither -> null (nothing materialized to account).
 */
export function projectDevelopmentVerificationAccounting(
  db: Database.Database,
  input: { processRunId: number },
): VerificationAccountingProjection | null {
  const events = readDevelopmentVerificationLedgerEvents(db, input.processRunId);
  if (events.length > 0) {
    return projectCriterionLedgerAccounting({
      processRunId: input.processRunId,
      graphHash: events[0]!.graphHash,
      events,
    });
  }
  const graph = readMaterializedTaskGraph(db, input.processRunId);
  if (!graph) return null;
  return projectLegacyUnaccountedVerification({
    processRunId: input.processRunId,
    graphHash: graph.graphHash,
    verificationItems: graph.verificationItems.map(item => ({
      key: item.key,
      required: item.required,
      criticality: item.criticality,
      acceptanceCriterionKeys: [...item.acceptanceCriterionKeys],
    })),
  });
}

/**
 * Epic-wide visibility: every accounted run of the epic, in deterministic
 * process-run order. Pending entries of earlier (readiness-failed) runs stay
 * visible next to their continuations — the obligation history never
 * disappears.
 *
 * READ PATH — never creates or migrates the schema (see
 * `readDevelopmentVerificationLedgerEvents`): the tracker serves this through
 * a readonly connection, where a fresh epic honestly projects `[]` (no
 * development graph materialized under criterion-key accounting yet) instead
 * of failing with SQLITE_READONLY.
 */
export function listDevelopmentVerificationAccountingByEpic(
  db: Database.Database,
  input: { epicId: number },
): VerificationAccountingProjection[] {
  const columns = db.prepare(
    `PRAGMA table_info(${LEDGER_TABLE})`,
  ).all() as Array<{ name: string }>;
  if (columns.length === 0) return [];
  const runs = db.prepare(
    `SELECT DISTINCT process_run_id FROM ${LEDGER_TABLE}
      WHERE epic_id=? ORDER BY process_run_id`,
  ).all(input.epicId) as Array<{ process_run_id: number }>;
  return runs.map(row =>
    projectDevelopmentVerificationAccounting(db, {
      processRunId: row.process_run_id,
    })).flatMap(projection => projection === null ? [] : [projection]);
}

interface VerificationLedgerRow {
  id: number;
  process_run_id: number;
  graph_hash: string;
  criterion_key: string;
  verification_item_key: string;
  required: number;
  criticality: string | null;
  entry_state: VerificationLedgerEvent['entryState'];
  outcome: 'passed' | 'failed' | null;
  candidate_hash: string | null;
  receipt_ref: string | null;
  receipt_digest: string | null;
  waiver_operator: string | null;
  waiver_reason: string | null;
  waiver_provenance_ref: string | null;
  proposed_from_ref: string | null;
  terminal_route: string | null;
  terminal_reason_codes: string | null;
  terminal_provenance_ref: string | null;
  terminal_attributed_to: string | null;
  recorded_at: string;
}

/** v1 row shape: identical to v2 minus the four terminal-fact columns. */
type VerificationLedgerRowV1 = Omit<
  VerificationLedgerRow,
  'terminal_route' | 'terminal_reason_codes' | 'terminal_provenance_ref' | 'terminal_attributed_to'
>;

/** Tolerates v1-shaped rows (no terminal columns) — they read as "no terminal
 *  fact recorded", which is truthful for tables that predate terminal
 *  accounting; the writable path migrates them at its next write. */
function rowToEvent(
  row: VerificationLedgerRow | VerificationLedgerRowV1,
): VerificationLedgerEvent {
  const terminal: Pick<
    VerificationLedgerRow,
    'terminal_route' | 'terminal_reason_codes' | 'terminal_provenance_ref' | 'terminal_attributed_to'
  > | null = 'terminal_route' in row
    ? {
        terminal_route: row.terminal_route,
        terminal_reason_codes: row.terminal_reason_codes,
        terminal_provenance_ref: row.terminal_provenance_ref,
        terminal_attributed_to: row.terminal_attributed_to,
      }
    : null;
  return {
    sequence: row.id,
    processRunId: row.process_run_id,
    graphHash: row.graph_hash,
    criterionKey: row.criterion_key,
    verificationItemKey: row.verification_item_key,
    required: row.required === 1,
    criticality: row.criticality as VerificationLedgerEvent['criticality'],
    entryState: row.entry_state,
    outcome: row.outcome,
    candidateHash: row.candidate_hash,
    receiptRef: row.receipt_ref,
    receiptDigest: row.receipt_digest,
    waiverOperator: row.waiver_operator,
    waiverReason: row.waiver_reason,
    waiverProvenanceRef: row.waiver_provenance_ref,
    proposedFromRef: row.proposed_from_ref,
    terminalRoute: (terminal?.terminal_route ?? null) as VerificationLedgerEvent['terminalRoute'],
    terminalReasonCodes: parseStringArray(terminal?.terminal_reason_codes ?? null),
    terminalProvenanceRef: terminal?.terminal_provenance_ref ?? null,
    terminalAttributedTo: parseStringArray(terminal?.terminal_attributed_to ?? null),
    recordedAt: row.recorded_at,
  };
}

function parseStringArray(value: string | null): readonly string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function readLedgerGraphHash(
  db: Database.Database,
  processRunId: number,
): string | null {
  const row = db.prepare(
    `SELECT graph_hash FROM ${LEDGER_TABLE}
      WHERE process_run_id=? ORDER BY id LIMIT 1`,
  ).get(processRunId) as { graph_hash: string } | undefined;
  return row?.graph_hash ?? null;
}

function readMaterializedTaskGraph(
  db: Database.Database,
  processRunId: number,
): DevelopmentTaskGraphSnapshot | null {
  let row: { payload_snapshot: string } | undefined;
  try {
    row = db.prepare(
      `SELECT payload_snapshot FROM factory_process_products
        WHERE process_run_id=? AND product_kind=?`,
    ).get(processRunId, TASK_GRAPH_PRODUCT_KIND) as
      | { payload_snapshot: string }
      | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const graph = JSON.parse(row.payload_snapshot) as DevelopmentTaskGraphSnapshot;
    return Array.isArray(graph.verificationItems) ? graph : null;
  } catch {
    return null;
  }
}
