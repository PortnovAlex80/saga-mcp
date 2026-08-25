/**
 * workflow-kernel/persistence/kernel-ledger.ts - the shared durable ledger
 * of the workflow kernel (WP-06, plan phase EK-3).
 *
 * Holds ALL direct SQL for the four SHARED ledger relations, which belong to
 * no aggregate under the frozen prefix rule (complexity-budget.json,
 * lawfulRepositoryConvention): workflow_event, transition_obligation,
 * typed_wait, terminal_proof. Aggregate-owned tables are never touched here:
 * their sole lawful writer is the owning repository file.
 *
 * Responsibilities inside each owning repository's ONE transaction:
 *   - hydrate the shared parts of the pure KernelWorld (events, obligations,
 *     waits, proofs, recorded evidence, work intents, idempotency keys and
 *     the global sequence);
 *   - persist the exact ledger delta of one committed command application
 *     (new WorkflowEvent, new obligations, open->completed transitions,
 *     pending->discharged/converted waits, new terminal proofs).
 *
 * The stateless CognitionTransport boundary instance is virtual: it holds no
 * mutable row (its reducer owns no state); its well-known singleton head is
 * derived from completed obligation:providerSend rows, and the eventless
 * transport command (cognition.sendProviderRequest, which declares no
 * WorkflowEvent) persists its idempotency key and recorded evidence on the
 * obligation row it completes in the same transaction.
 */

import type Database from 'better-sqlite3';
import type {
  AggregateHead,
  CommandInput,
  CommandOutcome,
  EvidenceFact,
  InstanceId,
  ObligationRecord,
  ProofRecord,
  TypedRefusal,
  WaitRecord,
  WorkIntent,
  WorkflowEventRecord,
} from '../domain/types.js';
import type { KernelWorld } from '../domain/explorer.js';
import { applyCommand } from '../domain/explorer.js';

/** The well-known singleton instance of the stateless transport boundary. */
export const COGNITION_TRANSPORT_INSTANCE_ID = 'cognition:transport' as const;

/** Sentinel: the SQL-level CAS fence refused the expected revision. */
export class CasStaleRevisionError extends Error {
  constructor(instanceId: string, expected: number) {
    super(`EK_CAS_REVISION_FENCE: ${instanceId} is no longer at expected revision ${expected}`);
    this.name = 'CasStaleRevisionError';
  }
}

/** Build a typed refusal (never a silent result). */
export function typedRefusal(reason: TypedRefusal['reason'], detail: string): TypedRefusal {
  return { refused: true, reason, detail };
}

/** Per-aggregate head loader registration (own-table SQL stays in owners). */
export class HeadReaderRegistry {
  private readonly readers = new Map<string, () => readonly AggregateHead[]>();

  register(aggregate: string, reader: () => readonly AggregateHead[]): void {
    this.readers.set(aggregate, reader);
  }

  /** All registered aggregates' heads (SQL executes inside owning files). */
  allHeads(): readonly AggregateHead[] {
    const heads: AggregateHead[] = [];
    for (const reader of this.readers.values()) heads.push(...reader());
    return heads;
  }
}

/** The only evidence kinds that enter the world as external inputs (Input authority). */
export const EXTERNAL_INPUT_EVIDENCE_KINDS: readonly string[] = ['CheckPlan', 'ProductVerificationEvidence', 'ProductVerificationFailure'];

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface EventRow {
  readonly sequence: number;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly source_owner: string;
  readonly source_instance_id: string;
  readonly source_revision: number;
  readonly source_status: string;
  readonly transition: string;
  readonly evidence_refs_json: string;
  readonly recorded_evidence_json: string;
  readonly work_intent_json: string | null;
}

interface ObligationRow {
  readonly id: number;
  readonly kind: string;
  readonly source: string;
  readonly source_instance_id: string;
  readonly target: string;
  readonly target_aggregate: string;
  readonly target_instance_id: string | null;
  readonly evidence_refs_json: string;
  readonly state: 'open' | 'completed';
  readonly idempotency_key: string;
  readonly completion_evidence_ref: string | null;
  readonly completed_by_key: string | null;
  readonly completed_at_sequence: number | null;
  readonly completion_evidence_json: string | null;
}

interface WaitRow {
  readonly id: number;
  readonly kind: string;
  readonly owner_aggregate: string;
  readonly owner_instance_id: string;
  readonly wake_commands_json: string;
  readonly wake_obligation_kinds_json: string;
  readonly dead_wake_conversion: string | null;
  readonly state: 'pending' | 'discharged' | 'converted';
  readonly discharge_evidence_ref: string | null;
}

interface ProofRow {
  readonly id: number;
  readonly proof_kind: string;
  readonly scope: string;
  readonly owner_aggregate: string;
  readonly owner_instance_id: string;
  readonly evidence_closure_json: string;
  readonly member_dispositions_json: string | null;
  readonly created_sequence: number;
}

/** The hydrated shared ledger + the row ids needed for exact delta updates. */
export interface HydratedLedger {
  readonly world: KernelWorld;
  readonly obligationRowIds: readonly number[];
  readonly waitRowIds: readonly number[];
}

export interface LedgerWorldOptions {
  /** All registered aggregates' heads (own-table SQL executes in owners). */
  readonly heads: readonly AggregateHead[];
  /** Call-scoped external input evidence (Input authority; kinds are closed). */
  readonly externalEvidence?: readonly EvidenceFact[];
}

/* ------------------------------------------------------------------ */
/* Hydration (shared tables only; no aggregate-owned reads)            */
/* ------------------------------------------------------------------ */

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

function obligationOf(row: ObligationRow): ObligationRecord {
  return {
    kind: row.kind as ObligationRecord['kind'],
    source: row.source as ObligationRecord['source'],
    sourceInstanceId: row.source_instance_id,
    target: row.target as ObligationRecord['target'],
    targetAggregate: row.target_aggregate as ObligationRecord['targetAggregate'],
    targetInstanceId: row.target_instance_id,
    evidenceRefs: parseJsonArray(row.evidence_refs_json),
    state: row.state,
    idempotencyKey: row.idempotency_key,
    ...(row.completion_evidence_ref !== null ? { completionEvidenceRef: row.completion_evidence_ref } : {}),
  };
}

function waitOf(row: WaitRow): WaitRecord {
  return {
    kind: row.kind as WaitRecord['kind'],
    ownerAggregate: row.owner_aggregate as WaitRecord['ownerAggregate'],
    ownerInstanceId: row.owner_instance_id,
    wakeCommands: parseJsonArray(row.wake_commands_json) as WaitRecord['wakeCommands'],
    wakeObligationKinds: parseJsonArray(row.wake_obligation_kinds_json) as WaitRecord['wakeObligationKinds'],
    ...(row.dead_wake_conversion !== null ? { deadWakeConversion: row.dead_wake_conversion as WaitRecord['deadWakeConversion'] } : {}),
    state: row.state,
    ...(row.discharge_evidence_ref !== null ? { dischargeEvidenceRef: row.discharge_evidence_ref } : {}),
  };
}

function proofOf(row: ProofRow): ProofRecord {
  const dispositions = row.member_dispositions_json === null ? undefined : (JSON.parse(row.member_dispositions_json) as ProofRecord['memberDispositions']);
  return {
    id: row.proof_kind as ProofRecord['id'],
    scope: row.scope,
    ownerAggregate: row.owner_aggregate as ProofRecord['ownerAggregate'],
    ownerInstanceId: row.owner_instance_id,
    evidenceClosure: parseJsonArray(row.evidence_closure_json) as ProofRecord['evidenceClosure'],
    ...(dispositions !== undefined ? { memberDispositions: dispositions } : {}),
  };
}

function eventOf(row: EventRow): WorkflowEventRecord {
  return {
    kind: row.kind as WorkflowEventRecord['kind'],
    sourceOwner: row.source_owner as WorkflowEventRecord['sourceOwner'],
    sourceInstanceId: row.source_instance_id,
    sourceRevision: row.source_revision,
    transition: row.transition as WorkflowEventRecord['transition'],
    evidenceRefs: parseJsonArray(row.evidence_refs_json) as WorkflowEventRecord['evidenceRefs'],
    sequence: row.sequence,
  };
}

/** Validate call-scoped external input evidence against the closed kind set. */
export function validateExternalEvidence(facts: readonly EvidenceFact[]): void {
  for (const fact of facts) {
    if (!(EXTERNAL_INPUT_EVIDENCE_KINDS as readonly string[]).includes(fact.kind)) {
      throw new TypeError(`external input evidence kind "${fact.kind}" is not one of the closed Input authority kinds`);
    }
    if (fact.producer !== 'external-input') {
      throw new TypeError(`external input evidence "${fact.ref}" must have producer "external-input"`);
    }
  }
}

/**
 * Hydrate the shared ledger + the applying aggregate's heads into a pure
 * KernelWorld. Own-aggregate heads and instance count are supplied by the
 * OWNING repository (their SQL lives only there); every other aggregate's
 * head is irrelevant to command application legality (the pure engine reads
 * only the applying instance's head, and guards read evidence, proofs,
 * obligations, waits, work intents and heads - the nodeRun.create guard's
 * ProcessRun heads are provided through the owning repository's public
 * reader wired by session.ts, never by foreign SQL).
 */
export function hydrateLedgerWorld(db: Database.Database, options: LedgerWorldOptions): HydratedLedger {
  if (options.externalEvidence) {
    validateExternalEvidence(options.externalEvidence);
  }

  const eventRows = db.prepare('SELECT * FROM workflow_event ORDER BY sequence').all() as unknown as EventRow[];
  const obligationRows = db.prepare('SELECT * FROM transition_obligation ORDER BY id').all() as unknown as ObligationRow[];
  const waitRows = db.prepare('SELECT * FROM typed_wait ORDER BY id').all() as unknown as WaitRow[];
  const proofRows = db.prepare('SELECT * FROM terminal_proof ORDER BY id').all() as unknown as ProofRow[];

  const events = eventRows.map(eventOf);
  const obligations = obligationRows.map(obligationOf);
  const waits = waitRows.map(waitOf);
  const proofs = proofRows.map(proofOf);

  const evidence: EvidenceFact[] = [];
  const workIntents = new Map<string, WorkIntent>();
  const idempotency = new Map<string, { readonly eventSequence: number }>();
  for (const row of eventRows) {
    for (const fact of JSON.parse(row.recorded_evidence_json) as EvidenceFact[]) {
      evidence.push(fact);
    }
    if (row.work_intent_json !== null) {
      const intent = JSON.parse(row.work_intent_json) as WorkIntent;
      workIntents.set(intent.intentRef, intent);
    }
    idempotency.set(row.idempotency_key, { eventSequence: row.sequence });
  }
  const completions = obligationRows
    .filter((row) => row.completed_by_key !== null && row.completed_at_sequence !== null)
    .sort((a, b) => (a.completed_at_sequence as number) - (b.completed_at_sequence as number));
  for (const row of completions) {
    idempotency.set(row.completed_by_key as string, { eventSequence: row.completed_at_sequence as number });
    if (row.completion_evidence_json !== null) {
      for (const fact of JSON.parse(row.completion_evidence_json) as EvidenceFact[]) {
        evidence.push(fact);
      }
    }
  }

  // Global sequence: every committed command either wrote a WorkflowEvent or
  // completed an obligation (the eventless transport boundary).
  let sequence = 0;
  for (const row of eventRows) sequence = Math.max(sequence, row.sequence);
  for (const row of completions) sequence = Math.max(sequence, row.completed_at_sequence as number);

  // Virtual stateless transport singleton: revision = committed sends.
  const transportSends = obligationRows.filter((row) => row.kind === 'obligation:providerSend' && row.state === 'completed').length;
  const heads = new Map<InstanceId, AggregateHead>(options.heads.map((head) => [head.instanceId, head]));
  heads.set(COGNITION_TRANSPORT_INSTANCE_ID, {
    aggregate: 'CognitionTransport',
    instanceId: COGNITION_TRANSPORT_INSTANCE_ID,
    revision: transportSends,
    status: 'stateless',
  });

  const instanceCounters: Record<string, number> = { CognitionTransport: 1 };
  for (const head of options.heads) {
    instanceCounters[head.aggregate] = (instanceCounters[head.aggregate] ?? 0) + 1;
  }

  if (options.externalEvidence) {
    evidence.push(...options.externalEvidence);
  }

  const world: KernelWorld = {
    seed: 0,
    heads,
    events,
    obligations,
    waits,
    proofs,
    evidence,
    workIntents,
    idempotency,
    instanceCounters,
    sequence,
  };
  return { world, obligationRowIds: obligationRows.map((row) => row.id), waitRowIds: waitRows.map((row) => row.id) };
}

/* ------------------------------------------------------------------ */
/* Delta persistence (shared tables only; runs in the owner's txn)     */
/* ------------------------------------------------------------------ */

export interface LedgerCommitMeta {
  /** The idempotency key of the applied command. */
  readonly idempotencyKey: string;
  /** The global sequence the engine allocated for this commit. */
  readonly sequence: number;
  /** The applying aggregate's next status (carried on the event row). */
  readonly nextStatus: string;
  /** Serialized WorkIntent when this commit admitted one, else null. */
  readonly workIntentJson: string | null;
}

/**
 * Persist the exact shared-ledger delta of one committed command. Must run
 * INSIDE the owning repository's transaction, after the pure engine
 * committed: new WorkflowEvent (with the commit's recorded evidence and
 * idempotency key), new obligations, the open->completed transition of the
 * leased obligation (with the completing key and evidence - this is also
 * the durable idempotency record for the eventless transport command),
 * pending->discharged/converted waits and new terminal proofs.
 */
export function persistLedgerDelta(
  db: Database.Database,
  before: HydratedLedger,
  after: KernelWorld,
  meta: LedgerCommitMeta,
): void {
  const recordedEvidence = after.evidence.slice(before.world.evidence.length);

  const newEvents = after.events.slice(before.world.events.length);
  for (const event of newEvents) {
    db.prepare(
      'INSERT INTO workflow_event (sequence, idempotency_key, kind, source_owner, source_instance_id, source_revision, source_status, transition, evidence_refs_json, recorded_evidence_json, work_intent_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      event.sequence,
      meta.idempotencyKey,
      event.kind,
      event.sourceOwner,
      event.sourceInstanceId,
      event.sourceRevision,
      meta.nextStatus,
      event.transition,
      JSON.stringify([...event.evidenceRefs]),
      JSON.stringify(recordedEvidence),
      meta.workIntentJson,
    );
  }

  const completionJson = JSON.stringify(recordedEvidence);
  for (let index = 0; index < before.world.obligations.length; index += 1) {
    const beforeRecord = before.world.obligations[index];
    const afterRecord = after.obligations[index];
    if (beforeRecord.state === afterRecord.state) continue;
    if (beforeRecord.state !== 'open' || afterRecord.state !== 'completed') {
      throw new Error(`EK_LEDGER_DELTA: obligation ${beforeRecord.idempotencyKey} may only transition open -> completed`);
    }
    const changed = db
      .prepare(
        "UPDATE transition_obligation SET state = 'completed', completion_evidence_ref = ?, completed_by_key = ?, completed_at_sequence = ?, completion_evidence_json = ? WHERE id = ? AND state = 'open'",
      )
      .run(
        afterRecord.completionEvidenceRef ?? null,
        meta.idempotencyKey,
        meta.sequence,
        completionJson,
        before.obligationRowIds[index],
      );
    if (changed.changes !== 1) {
      throw new Error(`EK_LEDGER_DELTA: obligation row ${before.obligationRowIds[index]} was not open at completion`);
    }
  }
  for (let index = before.world.obligations.length; index < after.obligations.length; index += 1) {
    const record = after.obligations[index];
    db.prepare(
      'INSERT INTO transition_obligation (kind, source, source_instance_id, target, target_aggregate, target_instance_id, evidence_refs_json, state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.kind,
      record.source,
      record.sourceInstanceId,
      record.target,
      record.targetAggregate,
      record.targetInstanceId,
      JSON.stringify([...record.evidenceRefs]),
      record.state,
      record.idempotencyKey,
    );
  }

  for (let index = 0; index < before.world.waits.length; index += 1) {
    const beforeRecord = before.world.waits[index];
    const afterRecord = after.waits[index];
    if (beforeRecord.state === afterRecord.state) continue;
    if (beforeRecord.state !== 'pending' || (afterRecord.state !== 'discharged' && afterRecord.state !== 'converted')) {
      throw new Error(`EK_LEDGER_DELTA: wait ${beforeRecord.kind} may only transition pending -> discharged|converted`);
    }
    const changed = db
      .prepare("UPDATE typed_wait SET state = ?, discharge_evidence_ref = ? WHERE id = ? AND state = 'pending'")
      .run(afterRecord.state, afterRecord.dischargeEvidenceRef ?? null, before.waitRowIds[index]);
    if (changed.changes !== 1) {
      throw new Error(`EK_LEDGER_DELTA: wait row ${before.waitRowIds[index]} was not pending at discharge`);
    }
  }
  for (let index = before.world.waits.length; index < after.waits.length; index += 1) {
    const record = after.waits[index];
    db.prepare(
      'INSERT INTO typed_wait (kind, owner_aggregate, owner_instance_id, wake_commands_json, wake_obligation_kinds_json, dead_wake_conversion, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.kind,
      record.ownerAggregate,
      record.ownerInstanceId,
      JSON.stringify([...record.wakeCommands]),
      JSON.stringify([...record.wakeObligationKinds]),
      record.deadWakeConversion ?? null,
      record.state,
    );
  }

  const newProofs = after.proofs.slice(before.world.proofs.length);
  for (const proof of newProofs) {
    db.prepare(
      'INSERT INTO terminal_proof (proof_kind, scope, owner_aggregate, owner_instance_id, evidence_closure_json, member_dispositions_json, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      proof.id,
      proof.scope,
      proof.ownerAggregate,
      proof.ownerInstanceId,
      JSON.stringify([...proof.evidenceClosure]),
      proof.memberDispositions === undefined ? null : JSON.stringify([...proof.memberDispositions]),
      meta.sequence,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Shared-ledger reads for the session/diagnostics                     */
/* ------------------------------------------------------------------ */

/** Counts of the shared ledger relations (diagnostics/tests only). */
export function ledgerCounts(db: Database.Database): { events: number; obligations: number; openObligations: number; waits: number; pendingWaits: number; proofs: number } {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    events: one('SELECT COUNT (*) AS n FROM workflow_event'),
    obligations: one('SELECT COUNT (*) AS n FROM transition_obligation'),
    openObligations: one("SELECT COUNT (*) AS n FROM transition_obligation WHERE state = 'open'"),
    waits: one('SELECT COUNT (*) AS n FROM typed_wait'),
    pendingWaits: one("SELECT COUNT (*) AS n FROM typed_wait WHERE state = 'pending'"),
    proofs: one('SELECT COUNT (*) AS n FROM terminal_proof'),
  };
}

/* ------------------------------------------------------------------ */
/* Sole-writer command application orchestration                       */
/* ------------------------------------------------------------------ */

/** Call-scoped external Input-authority evidence (closed kind set). */
export interface RepositoryApplyOptions {
  readonly externalEvidence?: readonly EvidenceFact[];
}

/** Immutable per-provider-request admission receipt (WP-18's evidence shape). */
export interface PromptAssemblyReceiptInput {
  readonly receiptRef?: string;
  readonly admission: 'admitted' | 'refused';
  readonly requestOrdinal: number;
  readonly expectedContextRevision: number;
  readonly digest: string;
  readonly payloadJson?: string;
  readonly cumulativeInputTokens?: number;
}

/** One immutable dependency edge of the planning graph (WP-09 payload). */
export interface DependencyEdgeInput {
  readonly workItemRef: string;
  readonly dependsOnRef: string;
}

export interface OwnTransactionHooks {
  /** Loads the applying aggregate's head rows (own-table SQL in the owner file). */
  readonly loadHeads: () => readonly AggregateHead[];
  /**
   * Persists the applying aggregate's head row for the committed command
   * (own-table SQL in the owner file). `existed` is false for creation
   * commands; `sequence` is the commit's global sequence; the implementation
   * MUST enforce the SQL CAS fence on update (expected = head.revision - 1).
   */
  readonly writeHead: (head: AggregateHead, existed: boolean, sequence: number) => void;
  /** Aggregate-owned relation rows of this commit (default: none). */
  readonly writeRelations?: (context: LedgerWriteContext) => void;
}

export interface LedgerWriteContext {
  readonly input: CommandInput;
  readonly before: HydratedLedger;
  readonly after: KernelWorld;
  readonly meta: LedgerCommitMeta;
  /** The commit's recorded evidence facts (engine order). */
  readonly recordedEvidence: readonly EvidenceFact[];
}

/**
 * The ONE transactional command-application path shared by every sole-writer
 * repository. All aggregate-owned SQL executes in the owning file's hooks;
 * this function only orchestrates: BEGIN -> hydrate -> pure engine ->
 * own-table writes -> shared-ledger delta -> COMMIT. A refusal or replay
 * commits nothing; any thrown error (including a failed CAS fence, a
 * constraint or an FK violation) rolls back the WHOLE transaction, leaving
 * neither fact nor orphan obligation.
 */
export function applyCommandInOwnTransaction(
  db: Database.Database,
  ownedCommands: readonly string[],
  aggregate: string,
  input: CommandInput,
  hooks: OwnTransactionHooks,
  options?: RepositoryApplyOptions,
): CommandOutcome {
  if (!ownedCommands.includes(input.command)) {
    return typedRefusal(
      'COMMAND_NOT_OWNED_BY_AGGREGATE',
      `${input.command} is not owned by the ${aggregate} sole-writer repository`,
    );
  }
  const txn = db.transaction((): CommandOutcome => {
    const before = hydrateLedgerWorld(db, { heads: hooks.loadHeads(), externalEvidence: options?.externalEvidence });
    const { world: after, outcome } = applyCommand(before.world, input);
    if ('refused' in outcome || 'replayed' in outcome) {
      return outcome;
    }
    const head = after.heads.get(input.instanceId);
    if (!head) {
      throw new Error(`EK_LEDGER_DELTA: committed ${input.command} produced no head for ${input.instanceId}`);
    }
    const metaWithIntent = (workIntentJson: string | null): LedgerCommitMeta => ({
      idempotencyKey: input.idempotencyKey,
      sequence: after.sequence,
      nextStatus: outcome.plan.nextStatus,
      workIntentJson,
    });
    const workIntentJson = admittedWorkIntentJson(after);
    const writeContext: LedgerWriteContext = {
      input,
      before,
      after,
      meta: metaWithIntent(workIntentJson),
      recordedEvidence: after.evidence.slice(before.world.evidence.length),
    };
    // Own head first (relations may reference it by FK), then aggregate-owned
    // relation rows, then the shared-ledger delta - one transaction.
    hooks.writeHead(head, before.world.heads.has(input.instanceId), after.sequence);
    if (hooks.writeRelations) {
      hooks.writeRelations(writeContext);
    }
    persistLedgerDelta(db, before, after, metaWithIntent(workIntentJson));
    return outcome;
  });
  try {
    return txn();
  } catch (error) {
    if (error instanceof CasStaleRevisionError) {
      return typedRefusal('STALE_EXPECTED_REVISION', error.message);
    }
    throw error;
  }
}

/** The admitted WorkIntent of this commit, serialized for the shared ledger. */
function admittedWorkIntentJson(after: KernelWorld): string | null {
  for (const intent of after.workIntents.values()) {
    if (intent.intentRef === `evidence:WorkIntent#${after.sequence}`) {
      return JSON.stringify(intent);
    }
  }
  return null;
}
