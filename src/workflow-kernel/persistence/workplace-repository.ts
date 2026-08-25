/**
 * Workplace sole-writer repository (WP-06, plan phase EK-3).
 *
 * The ONLY module with direct SQL against the workplace-owned tables:
 * workplace (head), workplace_work_intent, workplace_production_revision,
 * workplace_candidate_set, workplace_gate_decision, workplace_effect_receipt
 * and workplace_cell_final_acceptance (the ADR-053 accepted-material chain).
 *
 * workplace.admitWorkIntent pins the EXACT CanonicalRoleContract reference
 * and digest on the immutable WorkIntent at creation (role_contract_ref +
 * role_contract_digest columns; the append-only trigger forbids any later
 * rewrite) and serializes the intent onto the shared ledger so downstream
 * guards (activityAttempt.create) verify the pin without touching this
 * aggregate's tables.
 *
 * Each commit persists atomically: the CAS head row, the WorkIntent row (if
 * any), the material-chain rows of the commit's recorded evidence (immutable
 * production revisions, candidate sets, gate decisions, effect receipts and
 * cell final acceptances), the exact WorkflowEvent, obligations, waits and
 * proofs.
 */

import type Database from 'better-sqlite3';
import type { AggregateHead, CommandInput, CommandOutcome, WorkIntent } from '../domain/types.js';
import { WorkplaceReducer } from '../domain/reducers/workplace.js';
import {
  applyCommandInOwnTransaction,
  CasStaleRevisionError,
  HeadReaderRegistry,
  type LedgerWriteContext,
  type RepositoryApplyOptions,
} from './kernel-ledger.js';

const SELECT_HEADS = 'SELECT instance_id, revision, status, terminal FROM workplace';
const INSERT_HEAD =
  'INSERT INTO workplace (instance_id, aggregate, revision, status, terminal, last_sequence) VALUES (?, ?, ?, ?, ?, ?)';
const UPDATE_HEAD_CAS =
  'UPDATE workplace SET revision = ?, status = ?, terminal = ?, last_sequence = ? WHERE instance_id = ? AND revision = ?';

const INSERT_WORK_INTENT =
  'INSERT INTO workplace_work_intent (intent_ref, work_item_ref, workplace_instance_id, workplace_expected_revision, completion_command, protocol_role, role_contract_ref, role_contract_digest, input_evidence_refs_json, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_PRODUCTION_REVISION =
  'INSERT INTO workplace_production_revision (revision_ref, workplace_instance_id, payload_digest, created_sequence) VALUES (?, ?, ?, ?)';
const INSERT_CANDIDATE_SET =
  'INSERT INTO workplace_candidate_set (candidate_ref, workplace_instance_id, presentation, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)';
const INSERT_GATE_DECISION =
  'INSERT INTO workplace_gate_decision (decision_ref, workplace_instance_id, verdict, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)';
const INSERT_EFFECT_RECEIPT =
  'INSERT INTO workplace_effect_receipt (receipt_ref, workplace_instance_id, outcome, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)';
const INSERT_CELL_FINAL_ACCEPTANCE =
  'INSERT INTO workplace_cell_final_acceptance (acceptance_ref, workplace_instance_id, acceptance_digest, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)';

interface HeadRow {
  readonly instance_id: string;
  readonly revision: number;
  readonly status: string;
  readonly terminal: string | null;
}

export class WorkplaceRepository {
  readonly aggregate = WorkplaceReducer.aggregate;

  constructor(private readonly db: Database.Database, private readonly registry?: HeadReaderRegistry) {
    this.registry?.register(this.aggregate, () => this.loadHeads());
  }

  /** All Workplace heads (sole lawful reader surface for other aggregates). */
  loadHeads(): readonly AggregateHead[] {
    const rows = this.db.prepare(SELECT_HEADS).all() as unknown as HeadRow[];
    return rows.map((row) => ({
      aggregate: this.aggregate,
      instanceId: row.instance_id,
      revision: row.revision,
      status: row.status,
      ...(row.terminal !== null ? { terminal: row.terminal as AggregateHead['terminal'] } : {}),
    }));
  }

  loadHead(instanceId: string): AggregateHead | undefined {
    return this.loadHeads().find((head) => head.instanceId === instanceId);
  }

  /** The immutable WorkIntent rows admitted by this aggregate's workplaces. */
  loadWorkIntents(): readonly WorkIntent[] {
    const rows = this.db
      .prepare(
        'SELECT intent_ref, work_item_ref, workplace_instance_id, workplace_expected_revision, completion_command, protocol_role, role_contract_ref, role_contract_digest, input_evidence_refs_json FROM workplace_work_intent',
      )
      .all() as unknown as Array<{
      readonly intent_ref: string;
      readonly work_item_ref: string;
      readonly workplace_instance_id: string;
      readonly workplace_expected_revision: number;
      readonly completion_command: string;
      readonly protocol_role: WorkIntent['protocolRole'];
      readonly role_contract_ref: string;
      readonly role_contract_digest: string;
      readonly input_evidence_refs_json: string;
    }>;
    return rows.map((row) => ({
      intentRef: row.intent_ref,
      workItemRef: row.work_item_ref,
      workplaceInstanceId: row.workplace_instance_id,
      workplaceExpectedRevision: row.workplace_expected_revision,
      completionCommand: row.completion_command as WorkIntent['completionCommand'],
      protocolRole: row.protocol_role,
      roleContract: { roleContractRef: row.role_contract_ref, roleContractDigest: row.role_contract_digest },
      inputEvidenceRefs: JSON.parse(row.input_evidence_refs_json) as WorkIntent['inputEvidenceRefs'],
    }));
  }

  /**
   * All registered aggregates' heads for guard-context hydration
   * (each SELECT executes inside its owning repository file).
   */
  private headsForHydration() {
    return this.registry ? this.registry.allHeads() : this.loadHeads();
  }

  applyCommand(input: CommandInput, options?: RepositoryApplyOptions): CommandOutcome {
    return applyCommandInOwnTransaction(
      this.db,
      WorkplaceReducer.ownedCommands,
      this.aggregate,
      input,
      {
        loadHeads: () => this.headsForHydration(),
        writeHead: (head, existed, sequence) => this.writeHead(head, existed, sequence),
        writeRelations: (context) => this.writeRelations(context),
      },
      options,
    );
  }

  private writeHead(head: AggregateHead, existed: boolean, sequence: number): void {
    if (!existed) {
      this.db
        .prepare(INSERT_HEAD)
        .run(head.instanceId, this.aggregate, head.revision, head.status, head.terminal ?? null, sequence);
      return;
    }
    const changed = this.db
      .prepare(UPDATE_HEAD_CAS)
      .run(head.revision, head.status, head.terminal ?? null, sequence, head.instanceId, head.revision - 1);
    if (changed.changes !== 1) {
      throw new CasStaleRevisionError(head.instanceId, head.revision - 1);
    }
  }

  /**
   * The aggregate-owned relation rows of one commit: the immutable WorkIntent
   * with its pinned role-contract reference/digest (workplace.admitWorkIntent)
   * and the ADR-053 material-chain rows for the evidence kinds this commit
   * recorded. All inserts are immutable-by-trigger; a duplicate or foreign
   * reference aborts the WHOLE transaction.
   */
  private writeRelations(context: LedgerWriteContext): void {
    const { input, after, meta, recordedEvidence } = context;

    if (input.command === 'workplace.admitWorkIntent') {
      const intent = [...after.workIntents.values()].find((entry) => entry.intentRef === `evidence:WorkIntent#${after.sequence}`);
      if (intent) {
        this.db
          .prepare(INSERT_WORK_INTENT)
          .run(
            intent.intentRef,
            intent.workItemRef,
            intent.workplaceInstanceId,
            intent.workplaceExpectedRevision,
            intent.completionCommand,
            intent.protocolRole,
            intent.roleContract.roleContractRef,
            intent.roleContract.roleContractDigest,
            JSON.stringify([...intent.inputEvidenceRefs]),
            meta.sequence,
          );
      }
    }

    for (const fact of recordedEvidence) {
      const digest = fact.payloadDigest ?? '';
      if (fact.kind === 'WorkplaceProductionRevision') {
        this.db.prepare(INSERT_PRODUCTION_REVISION).run(fact.ref, input.instanceId, digest, meta.sequence);
      } else if (fact.kind === 'CandidateSet:author' || fact.kind === 'CandidateSet:reviewer') {
        this.db
          .prepare(INSERT_CANDIDATE_SET)
          .run(fact.ref, input.instanceId, fact.kind.slice('CandidateSet:'.length), digest, meta.sequence);
      } else if (fact.kind.startsWith('GateDecision:')) {
        this.db
          .prepare(INSERT_GATE_DECISION)
          .run(fact.ref, input.instanceId, fact.kind.slice('GateDecision:'.length), digest, meta.sequence);
      } else if (fact.kind.startsWith('EffectReceipt:')) {
        this.db
          .prepare(INSERT_EFFECT_RECEIPT)
          .run(fact.ref, input.instanceId, fact.kind.slice('EffectReceipt:'.length), digest, meta.sequence);
      } else if (fact.kind === 'CellFinalAcceptance') {
        // D11: the acceptance row embeds the acceptance digest itself.
        this.db.prepare(INSERT_CELL_FINAL_ACCEPTANCE).run(fact.ref, input.instanceId, digest, digest, meta.sequence);
      }
    }
  }
}
