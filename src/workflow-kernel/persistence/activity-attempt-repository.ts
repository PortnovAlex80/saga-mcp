/**
 * ActivityAttempt sole-writer repository (WP-06, plan phase EK-3).
 *
 * The ONLY module with direct SQL against activity_attempt (the attempt
 * head with its CAS-fenced context-admission counters) and
 * activity_attempt_prompt_assembly_receipt (immutable per-provider-request
 * admission evidence). An attempt is NEVER accepted-material authority.
 *
 * Creation pins the CanonicalRoleContract reference/digest copied from the
 * EXACT WorkIntent (the pure guard verifies equality atomically before any
 * lease exists; the columns are immutable after insert by trigger) together
 * with the originating work_intent_ref.
 *
 * activityAttempt.admitProviderRequest persists its PromptAssemblyReceipt as
 * immutable evidence in the SAME transaction as the CAS counter advance:
 * admission is 'admitted' or 'refused' - never 'sent' (schema CHECK), and
 * the request ordinal is the idempotency dimension (UNIQUE per attempt).
 */

import type Database from 'better-sqlite3';
import type { AggregateHead, CommandInput, CommandOutcome } from '../domain/types.js';
import { ActivityAttemptReducer } from '../domain/reducers/activity-attempt.js';
import {
  applyCommandInOwnTransaction,
  CasStaleRevisionError,
  HeadReaderRegistry,
  typedRefusal,
  type LedgerWriteContext,
  type PromptAssemblyReceiptInput,
  type RepositoryApplyOptions,
} from './kernel-ledger.js';

const SELECT_HEADS =
  'SELECT instance_id, revision, status, terminal, work_intent_ref, role_contract_ref, role_contract_digest, context_revision, next_request_ordinal, cumulative_input_tokens FROM activity_attempt';
const INSERT_HEAD =
  'INSERT INTO activity_attempt (instance_id, aggregate, revision, status, terminal, last_sequence, work_intent_ref, role_contract_ref, role_contract_digest, context_revision, next_request_ordinal, cumulative_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const UPDATE_HEAD_CAS =
  'UPDATE activity_attempt SET revision = ?, status = ?, terminal = ?, last_sequence = ?, context_revision = ?, next_request_ordinal = ?, cumulative_input_tokens = ? WHERE instance_id = ? AND revision = ?';
const SELECT_COUNTERS = 'SELECT context_revision, next_request_ordinal, cumulative_input_tokens FROM activity_attempt WHERE instance_id = ?';
const INSERT_RECEIPT =
  'INSERT INTO activity_attempt_prompt_assembly_receipt (receipt_ref, activity_attempt_instance_id, admission, request_ordinal, expected_context_revision, digest, payload_json, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

interface HeadRow {
  readonly instance_id: string;
  readonly revision: number;
  readonly status: string;
  readonly terminal: string | null;
  readonly work_intent_ref: string;
  readonly role_contract_ref: string;
  readonly role_contract_digest: string;
  readonly context_revision: number;
  readonly next_request_ordinal: number;
  readonly cumulative_input_tokens: number;
}

interface CounterRow {
  readonly context_revision: number;
  readonly next_request_ordinal: number;
  readonly cumulative_input_tokens: number;
}

export interface ActivityAttemptApplyOptions extends RepositoryApplyOptions {
  /** The immutable admission receipt committing with admitProviderRequest. */
  readonly promptReceipt?: PromptAssemblyReceiptInput;
}

export class ActivityAttemptRepository {
  readonly aggregate = ActivityAttemptReducer.aggregate;

  constructor(private readonly db: Database.Database, private readonly registry?: HeadReaderRegistry) {
    this.registry?.register(this.aggregate, () => this.loadHeads());
  }

  /** All ActivityAttempt heads (sole lawful reader surface). */
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

  /**
   * The CAS-fenced context-admission counters of one attempt (WP-07 seam:
   * the application-layer admission command reads its oracle through the
   * OWNING repository - never by summing receipt rows). Read-only.
   */
  loadContextCounters(instanceId: string): { contextRevision: number; nextRequestOrdinal: number; cumulativeInputTokens: number } | undefined {
    const row = this.db.prepare(SELECT_COUNTERS).get(instanceId) as CounterRow | undefined;
    return row === undefined
      ? undefined
      : { contextRevision: row.context_revision, nextRequestOrdinal: row.next_request_ordinal, cumulativeInputTokens: row.cumulative_input_tokens };
  }

  /** The pinned role-contract reference/digest of one attempt (immutable). */
  loadRoleContractPin(instanceId: string): { roleContractRef: string; roleContractDigest: string; workIntentRef: string } | undefined {
    const row = this.db
      .prepare('SELECT work_intent_ref, role_contract_ref, role_contract_digest FROM activity_attempt WHERE instance_id = ?')
      .get(instanceId) as
      | { readonly work_intent_ref: string; readonly role_contract_ref: string; readonly role_contract_digest: string }
      | undefined;
    if (!row) return undefined;
    return { workIntentRef: row.work_intent_ref, roleContractRef: row.role_contract_ref, roleContractDigest: row.role_contract_digest };
  }

  /**
   * All registered aggregates' heads for guard-context hydration
   * (each SELECT executes inside its owning repository file).
   */
  private headsForHydration() {
    return this.registry ? this.registry.allHeads() : this.loadHeads();
  }

  applyCommand(input: CommandInput, options?: ActivityAttemptApplyOptions): CommandOutcome {
    if (input.command === 'activityAttempt.admitProviderRequest') {
      // Fail-closed: the admitted/refused receipt commits in THIS transaction,
      // paired with the counter advance - never after the provider request.
      if (!options?.promptReceipt) {
        return typedRefusal(
          'MISSING_EVIDENCE',
          'activityAttempt.admitProviderRequest requires its PromptAssemblyReceipt (admitted or refused) in the same transaction',
        );
      }
      const counters = this.db.prepare(SELECT_COUNTERS).get(input.instanceId) as CounterRow | undefined;
      if (!counters) {
        return typedRefusal('ILLEGAL_TRANSITION', `ActivityAttempt ${input.instanceId} does not exist`);
      }
      const receipt = options.promptReceipt;
      // The receipt fences the CAS context revision (a separate fence from
      // the aggregate head revision in input.expectedRevision).
      if (receipt.expectedContextRevision !== counters.context_revision) {
        return typedRefusal(
          'STALE_EXPECTED_REVISION',
          `receipt fences context revision ${receipt.expectedContextRevision}, attempt is at ${counters.context_revision}`,
        );
      }
      if (receipt.requestOrdinal !== counters.next_request_ordinal + 1) {
        return typedRefusal(
          'STALE_EXPECTED_REVISION',
          `receipt ordinal ${receipt.requestOrdinal} is not the next ordinal ${counters.next_request_ordinal + 1} (a crash before send redrives the SAME obligation+ordinal)`,
        );
      }
    }
    return applyCommandInOwnTransaction(
      this.db,
      ActivityAttemptReducer.ownedCommands,
      this.aggregate,
      input,
      {
        loadHeads: () => this.headsForHydration(),
        writeHead: (head, existed, sequence) => this.writeHead(input, head, existed, sequence, options?.promptReceipt),
        writeRelations: (context) => this.writeRelations(context, options?.promptReceipt),
      },
      options,
    );
  }

  private writeHead(
    input: CommandInput,
    head: AggregateHead,
    existed: boolean,
    sequence: number,
    receipt?: PromptAssemblyReceiptInput,
  ): void {
    if (!existed) {
      // Creation copies the pin from the exact WorkIntent (engine-verified);
      // the trigger makes the pin immutable for the attempt's lifetime.
      if (!input.rolePin || !input.workIntentRef) {
        throw new Error(`EK_ATTEMPT_PIN: ${head.instanceId} creation requires the WorkIntent ref and its role-contract pin`);
      }
      this.db
        .prepare(INSERT_HEAD)
        .run(
          head.instanceId,
          this.aggregate,
          head.revision,
          head.status,
          head.terminal ?? null,
          sequence,
          input.workIntentRef,
          input.rolePin.roleContractRef,
          input.rolePin.roleContractDigest,
          0,
          0,
          0,
        );
      return;
    }
    const current = this.db.prepare(SELECT_COUNTERS).get(head.instanceId) as CounterRow;
    const admitted = input.command === 'activityAttempt.admitProviderRequest';
    const changed = this.db
      .prepare(UPDATE_HEAD_CAS)
      .run(
        head.revision,
        head.status,
        head.terminal ?? null,
        sequence,
        admitted ? current.context_revision + 1 : current.context_revision,
        admitted ? current.next_request_ordinal + 1 : current.next_request_ordinal,
        admitted && receipt?.cumulativeInputTokens !== undefined
          ? current.cumulative_input_tokens + receipt.cumulativeInputTokens
          : current.cumulative_input_tokens,
        head.instanceId,
        head.revision - 1,
      );
    if (changed.changes !== 1) {
      throw new CasStaleRevisionError(head.instanceId, head.revision - 1);
    }
  }

  private writeRelations(context: LedgerWriteContext, receipt?: PromptAssemblyReceiptInput): void {
    const { input, meta } = context;
    if (input.command === 'activityAttempt.admitProviderRequest' && receipt) {
      this.db
        .prepare(INSERT_RECEIPT)
        .run(
          receipt.receiptRef ?? `prompt-receipt:${input.instanceId}:${receipt.requestOrdinal}`,
          input.instanceId,
          receipt.admission,
          receipt.requestOrdinal,
          receipt.expectedContextRevision,
          receipt.digest,
          receipt.payloadJson ?? '{}',
          meta.sequence,
        );
    }
  }
}
