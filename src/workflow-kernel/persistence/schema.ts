/**
 * workflow-kernel/persistence/schema.ts - the ONE declarative fresh bootstrap
 * of the event-projected workflow kernel (WP-06, plan phase EK-3).
 *
 * FRESH PROTOCOL ONLY (plan law "Fresh protocol only"):
 *   - a new database is bootstrapped from this single declarative schema;
 *   - the schema records an exact protocol identifier, schema version and
 *     schema fingerprint at creation (protocol_metadata, immutable);
 *   - the runtime NEVER alters an existing schema: the only schema verbs in
 *     this tree are the declarative CREATE statements below, executed once
 *     on a verified-empty database; there is no schema-changing path for an
 *     existing database, no conversion, no row take-over, no parallel-read or
 *     parallel-write channel and no protocol-bring-down guard;
 *   - any non-empty database that is not byte-for-byte this exact protocol
 *     fails closed with FACTORY_DATABASE_PROTOCOL_UNSUPPORTED (database.ts).
 *
 * PHYSICAL NAMES are frozen by the EK-1 complexity budget
 * (docs/refactoring/event-kernel/specs/complexity-budget.json,
 * lawfulRepositoryConvention.aggregateTablePrefixes + the 22 relation kinds
 * of the plan's Target logical model / kernelCompositionConvention.relationNames).
 * The 22 physical tables below map 1:1 onto the 22 frozen relations:
 *
 *   ProtocolMetadata             -> protocol_metadata
 *   FactoryRun                   -> factory_run
 *   LifecycleRun                 -> lifecycle_run
 *   StageRun                     -> stage_run
 *   ProcessRun                   -> process_run
 *   NodeRun                      -> node_run
 *   WorkItem                     -> work_item            (immutable planning fact)
 *   WorkItemDependency           -> work_item_dependency (immutable edge)
 *   Workplace                    -> workplace
 *   WorkIntent                   -> workplace_work_intent
 *   ActivityAttempt              -> activity_attempt
 *   PromptAssemblyReceipt        -> activity_attempt_prompt_assembly_receipt
 *   WorkplaceProductionRevision  -> workplace_production_revision
 *   CandidateSet                 -> workplace_candidate_set
 *   GateDecision                 -> workplace_gate_decision
 *   EffectReceipt                -> workplace_effect_receipt
 *   CellFinalAcceptance          -> workplace_cell_final_acceptance
 *   WorkflowEvent                -> workflow_event        (shared append-only ledger)
 *   TransitionObligation         -> transition_obligation (shared durable ledger)
 *   TypedWait                    -> typed_wait            (shared durable ledger)
 *   TerminalProof                -> terminal_proof        (shared append-only ledger)
 *   KanbanCard                   -> kanban_card           (disposable projection)
 *
 * The CognitionTransport aggregate deliberately has NO physical table: it is
 * the stateless replaceable transport boundary (it "holds no mutable state"
 * per its reducer); its singleton instance is a well-known id and its send
 * cursor is derived from completed obligation:providerSend rows.
 *
 * SOLE WRITER: aggregate-owned tables (prefix rule of the frozen budget) are
 * written ONLY by their owning repository file
 * (src/workflow-kernel/persistence/<aggregate>-repository.ts). The shared
 * ledger tables belong to no aggregate and are written transactionally by
 * whichever repository commits the command (kernel-ledger.ts holds their SQL).
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { UNIVERSE_SCHEMA_VERSION } from '../domain/universe.js';

/* ------------------------------------------------------------------ */
/* Protocol identity                                                   */
/* ------------------------------------------------------------------ */

/** Exact protocol identifier of the event-projected workflow kernel. */
export const PROTOCOL_ID = 'ek.factory.workflow-kernel' as const;

/** Exact schema version; an exact-version open refuses every other value. */
export const SCHEMA_VERSION = 1 as const;

/**
 * The declarative fresh bootstrap: exactly 22 tables, their append-only /
 * CAS guards (triggers) and indices. CREATE statements only - this string is
 * executed verbatim on a verified-empty database and never afterwards.
 */
export const SCHEMA_SQL = `
CREATE TABLE protocol_metadata (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  protocol_id        TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  schema_fingerprint TEXT NOT NULL,
  universe_version   TEXT NOT NULL
);

CREATE TABLE factory_run (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'FactoryRun'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE lifecycle_run (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'LifecycleRun'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE stage_run (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'StageRun'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE process_run (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'ProcessRun'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE node_run (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'NodeRun'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE workplace (
  instance_id   TEXT PRIMARY KEY,
  aggregate     TEXT NOT NULL CHECK (aggregate = 'Workplace'),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  status        TEXT NOT NULL,
  terminal      TEXT,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);

CREATE TABLE activity_attempt (
  instance_id              TEXT PRIMARY KEY,
  aggregate                TEXT NOT NULL CHECK (aggregate = 'ActivityAttempt'),
  revision                 INTEGER NOT NULL CHECK (revision >= 0),
  status                   TEXT NOT NULL,
  terminal                 TEXT,
  last_sequence            INTEGER NOT NULL CHECK (last_sequence >= 0),
  work_intent_ref          TEXT NOT NULL,
  role_contract_ref        TEXT NOT NULL,
  role_contract_digest     TEXT NOT NULL,
  context_revision         INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
  next_request_ordinal     INTEGER NOT NULL DEFAULT 0 CHECK (next_request_ordinal >= 0),
  cumulative_input_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_input_tokens >= 0)
);

CREATE TABLE work_item (
  instance_id             TEXT PRIMARY KEY,
  aggregate               TEXT NOT NULL CHECK (aggregate = 'WorkItem'),
  revision                INTEGER NOT NULL CHECK (revision = 1),
  status                  TEXT NOT NULL CHECK (status = 'planned'),
  terminal                TEXT,
  last_sequence           INTEGER NOT NULL CHECK (last_sequence >= 0),
  planning_input_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE work_item_dependency (
  work_item_ref    TEXT NOT NULL REFERENCES work_item (instance_id),
  depends_on_ref   TEXT NOT NULL REFERENCES work_item (instance_id),
  created_sequence INTEGER NOT NULL CHECK (created_sequence >= 1),
  PRIMARY KEY (work_item_ref, depends_on_ref),
  CHECK (work_item_ref <> depends_on_ref)
);

CREATE TABLE workplace_work_intent (
  intent_ref                 TEXT PRIMARY KEY,
  work_item_ref              TEXT NOT NULL,
  workplace_instance_id      TEXT NOT NULL REFERENCES workplace (instance_id),
  workplace_expected_revision INTEGER NOT NULL CHECK (workplace_expected_revision >= 0),
  completion_command         TEXT NOT NULL,
  protocol_role              TEXT NOT NULL CHECK (protocol_role IN ('author', 'reviewer')),
  role_contract_ref          TEXT NOT NULL,
  role_contract_digest       TEXT NOT NULL,
  input_evidence_refs_json   TEXT NOT NULL DEFAULT '[]',
  created_sequence           INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE workplace_production_revision (
  revision_ref        TEXT PRIMARY KEY,
  workplace_instance_id TEXT NOT NULL REFERENCES workplace (instance_id),
  payload_digest      TEXT NOT NULL,
  created_sequence    INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE workplace_candidate_set (
  candidate_ref        TEXT PRIMARY KEY,
  workplace_instance_id TEXT NOT NULL REFERENCES workplace (instance_id),
  presentation         TEXT NOT NULL CHECK (presentation IN ('author', 'reviewer')),
  payload_digest       TEXT NOT NULL,
  created_sequence     INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE workplace_gate_decision (
  decision_ref         TEXT PRIMARY KEY,
  workplace_instance_id TEXT NOT NULL REFERENCES workplace (instance_id),
  verdict              TEXT NOT NULL CHECK (verdict IN ('accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject')),
  payload_digest       TEXT NOT NULL,
  created_sequence     INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE workplace_effect_receipt (
  receipt_ref          TEXT PRIMARY KEY,
  workplace_instance_id TEXT NOT NULL REFERENCES workplace (instance_id),
  outcome              TEXT NOT NULL CHECK (outcome IN ('success', 'already-applied', 'retryable', 'unknown', 'human-wait', 'policy-terminal', 'repair')),
  payload_digest       TEXT NOT NULL,
  created_sequence     INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE workplace_cell_final_acceptance (
  acceptance_ref       TEXT PRIMARY KEY,
  workplace_instance_id TEXT NOT NULL REFERENCES workplace (instance_id),
  acceptance_digest    TEXT NOT NULL,
  payload_digest       TEXT NOT NULL,
  created_sequence     INTEGER NOT NULL CHECK (created_sequence >= 1)
);

CREATE TABLE activity_attempt_prompt_assembly_receipt (
  receipt_ref                   TEXT PRIMARY KEY,
  activity_attempt_instance_id  TEXT NOT NULL REFERENCES activity_attempt (instance_id),
  admission                     TEXT NOT NULL CHECK (admission IN ('admitted', 'refused')),
  request_ordinal               INTEGER NOT NULL CHECK (request_ordinal >= 1),
  expected_context_revision     INTEGER NOT NULL CHECK (expected_context_revision >= 0),
  digest                        TEXT NOT NULL,
  payload_json                  TEXT NOT NULL,
  created_sequence              INTEGER NOT NULL CHECK (created_sequence >= 1),
  UNIQUE (activity_attempt_instance_id, request_ordinal)
);

CREATE TABLE workflow_event (
  sequence                INTEGER PRIMARY KEY,
  idempotency_key         TEXT NOT NULL UNIQUE,
  kind                    TEXT NOT NULL,
  source_owner            TEXT NOT NULL CHECK (source_owner IN ('FactoryRun', 'LifecycleRun', 'StageRun', 'ProcessRun', 'NodeRun', 'Workplace', 'ActivityAttempt', 'WorkItem', 'CognitionTransport')),
  source_instance_id      TEXT NOT NULL,
  source_revision         INTEGER NOT NULL CHECK (source_revision >= 1),
  source_status           TEXT NOT NULL,
  transition              TEXT NOT NULL,
  evidence_refs_json      TEXT NOT NULL DEFAULT '[]',
  recorded_evidence_json  TEXT NOT NULL DEFAULT '[]',
  work_intent_json        TEXT
);

CREATE TABLE transition_obligation (
  id                       INTEGER PRIMARY KEY,
  kind                     TEXT NOT NULL,
  source                   TEXT NOT NULL,
  source_instance_id       TEXT NOT NULL,
  target                   TEXT NOT NULL,
  target_aggregate         TEXT NOT NULL CHECK (target_aggregate IN ('FactoryRun', 'LifecycleRun', 'StageRun', 'ProcessRun', 'NodeRun', 'Workplace', 'ActivityAttempt', 'WorkItem', 'CognitionTransport')),
  target_instance_id       TEXT,
  evidence_refs_json       TEXT NOT NULL DEFAULT '[]',
  state                    TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'completed')),
  idempotency_key          TEXT NOT NULL UNIQUE,
  completion_evidence_ref  TEXT,
  completed_by_key         TEXT,
  completed_at_sequence    INTEGER,
  completion_evidence_json TEXT
);

CREATE UNIQUE INDEX idx_transition_obligation_completed_by_key
  ON transition_obligation (completed_by_key)
  WHERE completed_by_key IS NOT NULL;

CREATE TABLE typed_wait (
  id                        INTEGER PRIMARY KEY,
  kind                      TEXT NOT NULL CHECK (kind IN ('TypedWait:human-input', 'TypedWait:external-availability', 'TypedWait:policy-quota', 'TypedWait:readiness', 'TypedWait:effect-uncertainty')),
  owner_aggregate           TEXT NOT NULL CHECK (owner_aggregate IN ('FactoryRun', 'LifecycleRun', 'StageRun', 'ProcessRun', 'NodeRun', 'Workplace', 'ActivityAttempt', 'WorkItem', 'CognitionTransport')),
  owner_instance_id         TEXT NOT NULL,
  wake_commands_json        TEXT NOT NULL DEFAULT '[]',
  wake_obligation_kinds_json TEXT NOT NULL DEFAULT '[]',
  dead_wake_conversion      TEXT,
  state                     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'discharged', 'converted')),
  discharge_evidence_ref    TEXT
);

CREATE TABLE terminal_proof (
  id                       INTEGER PRIMARY KEY,
  proof_kind               TEXT NOT NULL,
  scope                    TEXT NOT NULL,
  owner_aggregate          TEXT NOT NULL CHECK (owner_aggregate IN ('FactoryRun', 'LifecycleRun', 'StageRun', 'ProcessRun', 'NodeRun', 'Workplace', 'ActivityAttempt', 'WorkItem', 'CognitionTransport')),
  owner_instance_id        TEXT NOT NULL,
  evidence_closure_json    TEXT NOT NULL DEFAULT '[]',
  member_dispositions_json TEXT,
  created_sequence         INTEGER NOT NULL CHECK (created_sequence >= 1),
  UNIQUE (proof_kind, owner_instance_id, created_sequence)
);

CREATE TABLE kanban_card (
  card_id           TEXT PRIMARY KEY,
  work_item_ref     TEXT NOT NULL,
  lane              TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  projected_sequence INTEGER NOT NULL CHECK (projected_sequence >= 0)
);

/* ------------------------------------------------------------------ */
/* Append-only and CAS guards                                          */
/* ------------------------------------------------------------------ */

CREATE TRIGGER trg_protocol_metadata_no_update
BEFORE UPDATE ON protocol_metadata
BEGIN
  SELECT RAISE (ABORT, 'EK_PROTOCOL_METADATA_IMMUTABLE');
END;

CREATE TRIGGER trg_protocol_metadata_no_delete
BEFORE DELETE ON protocol_metadata
BEGIN
  SELECT RAISE (ABORT, 'EK_PROTOCOL_METADATA_IMMUTABLE');
END;

CREATE TRIGGER trg_factory_run_cas
BEFORE UPDATE ON factory_run
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_factory_run_no_delete
BEFORE DELETE ON factory_run
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_lifecycle_run_cas
BEFORE UPDATE ON lifecycle_run
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_lifecycle_run_no_delete
BEFORE DELETE ON lifecycle_run
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_stage_run_cas
BEFORE UPDATE ON stage_run
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_stage_run_no_delete
BEFORE DELETE ON stage_run
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_process_run_cas
BEFORE UPDATE ON process_run
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_process_run_no_delete
BEFORE DELETE ON process_run
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_node_run_cas
BEFORE UPDATE ON node_run
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_node_run_no_delete
BEFORE DELETE ON node_run
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_workplace_cas
BEFORE UPDATE ON workplace
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE');
END;

CREATE TRIGGER trg_workplace_no_delete
BEFORE DELETE ON workplace
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_activity_attempt_cas
BEFORE UPDATE ON activity_attempt
WHEN NEW.instance_id <> OLD.instance_id
  OR NEW.aggregate <> OLD.aggregate
  OR NEW.revision <> OLD.revision + 1
  OR NEW.work_intent_ref <> OLD.work_intent_ref
  OR NEW.role_contract_ref <> OLD.role_contract_ref
  OR NEW.role_contract_digest <> OLD.role_contract_digest
BEGIN
  SELECT RAISE (ABORT, 'EK_CAS_REVISION_FENCE_ATTEMPT_PIN_IMMUTABLE');
END;

CREATE TRIGGER trg_activity_attempt_no_delete
BEFORE DELETE ON activity_attempt
BEGIN
  SELECT RAISE (ABORT, 'EK_AGGREGATE_HEAD_NOT_DELETABLE');
END;

CREATE TRIGGER trg_work_item_no_update
BEFORE UPDATE ON work_item
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_ITEM_IMMUTABLE_PLANNING_FACT');
END;

CREATE TRIGGER trg_work_item_no_delete
BEFORE DELETE ON work_item
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_ITEM_IMMUTABLE_PLANNING_FACT');
END;

CREATE TRIGGER trg_work_item_dependency_no_update
BEFORE UPDATE ON work_item_dependency
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_ITEM_DEPENDENCY_IMMUTABLE');
END;

CREATE TRIGGER trg_work_item_dependency_no_delete
BEFORE DELETE ON work_item_dependency
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_ITEM_DEPENDENCY_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_work_intent_no_update
BEFORE UPDATE ON workplace_work_intent
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_INTENT_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_work_intent_no_delete
BEFORE DELETE ON workplace_work_intent
BEGIN
  SELECT RAISE (ABORT, 'EK_WORK_INTENT_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_production_revision_no_update
BEFORE UPDATE ON workplace_production_revision
BEGIN
  SELECT RAISE (ABORT, 'EK_PRODUCTION_REVISION_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_production_revision_no_delete
BEFORE DELETE ON workplace_production_revision
BEGIN
  SELECT RAISE (ABORT, 'EK_PRODUCTION_REVISION_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_candidate_set_no_update
BEFORE UPDATE ON workplace_candidate_set
BEGIN
  SELECT RAISE (ABORT, 'EK_CANDIDATE_SET_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_candidate_set_no_delete
BEFORE DELETE ON workplace_candidate_set
BEGIN
  SELECT RAISE (ABORT, 'EK_CANDIDATE_SET_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_gate_decision_no_update
BEFORE UPDATE ON workplace_gate_decision
BEGIN
  SELECT RAISE (ABORT, 'EK_GATE_DECISION_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_gate_decision_no_delete
BEFORE DELETE ON workplace_gate_decision
BEGIN
  SELECT RAISE (ABORT, 'EK_GATE_DECISION_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_effect_receipt_no_update
BEFORE UPDATE ON workplace_effect_receipt
BEGIN
  SELECT RAISE (ABORT, 'EK_EFFECT_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_effect_receipt_no_delete
BEFORE DELETE ON workplace_effect_receipt
BEGIN
  SELECT RAISE (ABORT, 'EK_EFFECT_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_cell_final_acceptance_no_update
BEFORE UPDATE ON workplace_cell_final_acceptance
BEGIN
  SELECT RAISE (ABORT, 'EK_CELL_FINAL_ACCEPTANCE_IMMUTABLE');
END;

CREATE TRIGGER trg_workplace_cell_final_acceptance_no_delete
BEFORE DELETE ON workplace_cell_final_acceptance
BEGIN
  SELECT RAISE (ABORT, 'EK_CELL_FINAL_ACCEPTANCE_IMMUTABLE');
END;

CREATE TRIGGER trg_activity_attempt_prompt_assembly_receipt_no_update
BEFORE UPDATE ON activity_attempt_prompt_assembly_receipt
BEGIN
  SELECT RAISE (ABORT, 'EK_PROMPT_ASSEMBLY_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_activity_attempt_prompt_assembly_receipt_no_delete
BEFORE DELETE ON activity_attempt_prompt_assembly_receipt
BEGIN
  SELECT RAISE (ABORT, 'EK_PROMPT_ASSEMBLY_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_workflow_event_no_update
BEFORE UPDATE ON workflow_event
BEGIN
  SELECT RAISE (ABORT, 'EK_WORKFLOW_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER trg_workflow_event_no_delete
BEFORE DELETE ON workflow_event
BEGIN
  SELECT RAISE (ABORT, 'EK_WORKFLOW_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER trg_transition_obligation_no_mutation
BEFORE UPDATE ON transition_obligation
WHEN NOT (OLD.state = 'open' AND NEW.state = 'completed'
  AND NEW.kind = OLD.kind
  AND NEW.source = OLD.source
  AND NEW.source_instance_id = OLD.source_instance_id
  AND NEW.target = OLD.target
  AND NEW.target_aggregate = OLD.target_aggregate
  AND NEW.target_instance_id IS OLD.target_instance_id
  AND NEW.evidence_refs_json = OLD.evidence_refs_json
  AND NEW.idempotency_key = OLD.idempotency_key)
BEGIN
  SELECT RAISE (ABORT, 'EK_OBLIGATION_OPEN_TO_COMPLETED_ONLY');
END;

CREATE TRIGGER trg_transition_obligation_no_delete
BEFORE DELETE ON transition_obligation
BEGIN
  SELECT RAISE (ABORT, 'EK_OBLIGATION_NOT_DELETABLE');
END;

CREATE TRIGGER trg_typed_wait_no_mutation
BEFORE UPDATE ON typed_wait
WHEN NOT (OLD.state = 'pending' AND NEW.state IN ('discharged', 'converted')
  AND NEW.kind = OLD.kind
  AND NEW.owner_aggregate = OLD.owner_aggregate
  AND NEW.owner_instance_id = OLD.owner_instance_id
  AND NEW.wake_commands_json = OLD.wake_commands_json
  AND NEW.wake_obligation_kinds_json = OLD.wake_obligation_kinds_json
  AND NEW.dead_wake_conversion IS OLD.dead_wake_conversion)
BEGIN
  SELECT RAISE (ABORT, 'EK_WAIT_PENDING_TO_DISCHARGED_ONLY');
END;

CREATE TRIGGER trg_typed_wait_no_delete
BEFORE DELETE ON typed_wait
BEGIN
  SELECT RAISE (ABORT, 'EK_WAIT_NOT_DELETABLE');
END;

CREATE TRIGGER trg_terminal_proof_no_update
BEFORE UPDATE ON terminal_proof
BEGIN
  SELECT RAISE (ABORT, 'EK_TERMINAL_PROOF_APPEND_ONLY');
END;

CREATE TRIGGER trg_terminal_proof_no_delete
BEFORE DELETE ON terminal_proof
BEGIN
  SELECT RAISE (ABORT, 'EK_TERMINAL_PROOF_APPEND_ONLY');
END;
`;

/** Deterministic fingerprint input: normalized DDL bytes + protocol identity. */
function normalizedSchemaDdl(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/**
 * The schema fingerprint: sha256 over the canonical JSON of the protocol
 * identity and the normalized declarative DDL. Recorded at creation in
 * protocol_metadata and required byte-exact by every subsequent open.
 */
export const SCHEMA_FINGERPRINT: string = createHash('sha256')
  .update(
    JSON.stringify({
      ddl: normalizedSchemaDdl(SCHEMA_SQL),
      protocolId: PROTOCOL_ID,
      schemaVersion: SCHEMA_VERSION,
      universeVersion: UNIVERSE_SCHEMA_VERSION,
    }),
    'utf8',
  )
  .digest('hex');

/* ------------------------------------------------------------------ */
/* Aggregate/table ownership (frozen budget lawfulRepositoryConvention) */
/* ------------------------------------------------------------------ */

/** The frozen aggregate -> table prefix map (complexity-budget.json). */
export const AGGREGATE_TABLE_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  FactoryRun: 'factory_run',
  LifecycleRun: 'lifecycle_run',
  StageRun: 'stage_run',
  ProcessRun: 'process_run',
  NodeRun: 'node_run',
  Workplace: 'workplace',
  ActivityAttempt: 'activity_attempt',
  WorkItem: 'work_item',
  CognitionTransport: 'cognition_transport',
});

/** The 22 approved physical tables of the fresh protocol (sorted). */
export const SCHEMA_TABLES: readonly string[] = Object.freeze([
  'activity_attempt',
  'activity_attempt_prompt_assembly_receipt',
  'factory_run',
  'kanban_card',
  'lifecycle_run',
  'node_run',
  'process_run',
  'protocol_metadata',
  'stage_run',
  'terminal_proof',
  'transition_obligation',
  'typed_wait',
  'work_item',
  'work_item_dependency',
  'workplace',
  'workplace_candidate_set',
  'workplace_cell_final_acceptance',
  'workplace_effect_receipt',
  'workplace_gate_decision',
  'workplace_production_revision',
  'workplace_work_intent',
  'workflow_event',
].sort());

/** Every explicit schema object (tables, triggers, indices) in creation order. */
export const SCHEMA_OBJECT_NAMES: readonly string[] = Object.freeze(
  (SCHEMA_SQL.match(/CREATE (?:TABLE|TRIGGER|UNIQUE INDEX|INDEX)\s+(?:IF NOT EXISTS\s+)?([a-z_0-9]+)/g) ?? []).map(
    (statement) => statement.replace(/^CREATE\s+(?:TABLE|TRIGGER|UNIQUE INDEX|INDEX)\s+(?:IF NOT EXISTS\s+)?/, ''),
  ),
);

/** The shared ledger tables (owned by no aggregate; lawful for every repository). */
export const SHARED_LEDGER_TABLES: readonly string[] = Object.freeze([
  'workflow_event',
  'transition_obligation',
  'typed_wait',
  'terminal_proof',
]);

/** The disposable projection table (never read by the kernel as authority). */
export const PROJECTION_TABLES: readonly string[] = Object.freeze(['kanban_card']);

/** Owning aggregate of a table per the frozen prefix rule, or undefined. */
export function owningAggregateOfTable(table: string): string | undefined {
  for (const [aggregate, prefix] of Object.entries(AGGREGATE_TABLE_PREFIXES)) {
    if (table === prefix || table === `${prefix}s` || table.startsWith(`${prefix}_`)) return aggregate;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Fresh bootstrap + exact verification                                */
/* ------------------------------------------------------------------ */

export interface ProtocolIdentity {
  readonly protocol_id: string;
  readonly schema_version: number;
  readonly schema_fingerprint: string;
  readonly universe_version: string;
}

export interface ProtocolVerification {
  readonly supported: boolean;
  readonly reason?: 'EMPTY' | 'EXACT_MATCH' | 'PROTOCOL_MISMATCH' | 'FINGERPRINT_MISMATCH' | 'PARTIAL_SCHEMA' | 'FOREIGN_SCHEMA';
  readonly detail?: string;
  readonly identity?: ProtocolIdentity;
}

/**
 * Bootstrap the fresh protocol on a database that has been verified EMPTY.
 * One transaction: DDL + the immutable protocol identity row + user_version.
 * This is the ONLY code path that creates schema; nothing ever alters it.
 */
export function bootstrapFreshDatabase(db: Database.Database): void {
  const txn = db.transaction((): void => {
    db.exec(SCHEMA_SQL);
    db.prepare(
      "INSERT INTO protocol_metadata (singleton, protocol_id, schema_version, schema_fingerprint, universe_version) VALUES (1, ?, ?, ?, ?)",
    ).run(PROTOCOL_ID, SCHEMA_VERSION, SCHEMA_FINGERPRINT, UNIVERSE_SCHEMA_VERSION);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  txn();
}

/** True when the database file holds no user schema objects at all. */
export function databaseIsEmpty(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT (*) AS n FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number };
  return row.n === 0;
}

/** Inventory of user schema objects: { tables, triggers, indices, views }. */
export function schemaObjectInventory(db: Database.Database): {
  readonly tables: readonly string[];
  readonly triggers: readonly string[];
  readonly indices: readonly string[];
  readonly views: readonly string[];
} {
  const rows = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string }>;
  const pick = (type: string): readonly string[] => rows.filter((row) => row.type === type).map((row) => row.name);
  return { tables: pick('table'), triggers: pick('trigger'), indices: pick('index'), views: pick('view') };
}

/** The recorded protocol identity row, if the table exists and holds one. */
export function readProtocolIdentity(db: Database.Database): ProtocolIdentity | undefined {
  const hasTable = db
    .prepare("SELECT COUNT (*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'protocol_metadata'")
    .get() as { n: number };
  if (hasTable.n === 0) return undefined;
  const row = db.prepare('SELECT protocol_id, schema_version, schema_fingerprint, universe_version FROM protocol_metadata WHERE singleton = 1').get() as
    | ProtocolIdentity
    | undefined;
  return row;
}

/**
 * Verify a non-empty database against the exact fresh protocol. NEVER writes.
 * supported=true only on an EXACT identity + exact object inventory match.
 */
export function verifyProtocol(db: Database.Database): ProtocolVerification {
  const inventory = schemaObjectInventory(db);
  if (inventory.tables.length === 0 && inventory.triggers.length === 0 && inventory.indices.length === 0 && inventory.views.length === 0) {
    return { supported: false, reason: 'EMPTY', detail: 'no user schema objects' };
  }
  const identity = readProtocolIdentity(db);
  if (!identity) {
    const partial = inventory.tables.some((table) => (SCHEMA_TABLES as readonly string[]).includes(table));
    return {
      supported: false,
      reason: partial ? 'PARTIAL_SCHEMA' : 'FOREIGN_SCHEMA',
      detail: partial
        ? 'kernel tables exist without the protocol identity row (partially created schema)'
        : `non-empty database holds no kernel schema (tables: ${inventory.tables.slice(0, 5).join(', ')})`,
    };
  }
  if (identity.protocol_id !== PROTOCOL_ID || identity.schema_version !== SCHEMA_VERSION || identity.universe_version !== UNIVERSE_SCHEMA_VERSION) {
    return {
      supported: false,
      reason: 'PROTOCOL_MISMATCH',
      detail: `protocol ${identity.protocol_id} v${identity.schema_version} (universe ${identity.universe_version}) is not ${PROTOCOL_ID} v${SCHEMA_VERSION}`,
      identity,
    };
  }
  if (identity.schema_fingerprint !== SCHEMA_FINGERPRINT) {
    return {
      supported: false,
      reason: 'FINGERPRINT_MISMATCH',
      detail: `schema fingerprint ${identity.schema_fingerprint} is not the exact ${PROTOCOL_ID} v${SCHEMA_VERSION} fingerprint`,
      identity,
    };
  }
  const inventoryNames = [...inventory.tables, ...inventory.triggers, ...inventory.indices, ...inventory.views].sort();
  const expected = [...SCHEMA_OBJECT_NAMES].sort();
  const missing = expected.filter((name) => !inventoryNames.includes(name));
  const extra = inventoryNames.filter((name) => !expected.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    return {
      supported: false,
      reason: 'FINGERPRINT_MISMATCH',
      detail: `schema object inventory differs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
      identity,
    };
  }
  const userVersionRows = db.pragma('user_version') as Array<{ user_version: number }>;
  const userVersion = userVersionRows.length === 1 ? userVersionRows[0].user_version : 0;
  if (userVersion !== SCHEMA_VERSION) {
    return {
      supported: false,
      reason: 'PROTOCOL_MISMATCH',
      detail: `user_version ${userVersion} is not ${SCHEMA_VERSION}`,
      identity,
    };
  }
  return { supported: true, reason: 'EXACT_MATCH', identity };
}
