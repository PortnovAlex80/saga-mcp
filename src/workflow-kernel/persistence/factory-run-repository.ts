/**
 * FactoryRun sole-writer repository (WP-06, plan phase EK-3).
 *
 * The ONLY module with direct SQL against the factory_run table (the frozen
 * budget's lawfulRepositoryConvention: src/workflow-kernel/persistence/
 * <aggregate>-repository.ts). Owns exactly the seven FactoryRun commands of
 * the frozen universe; every other command is refused with
 * COMMAND_NOT_OWNED_BY_AGGREGATE before any transaction starts.
 *
 * Each committed command application persists, in ONE transaction: the CAS
 * head row, the exact WorkflowEvent (with recorded evidence and idempotency
 * key), every obligation the durable-handoff grammar creates, the completion
 * of the leased obligation targeting this command, typed waits and terminal
 * proofs (kernel-ledger.ts shared tables).
 */

import type Database from 'better-sqlite3';
import type { AggregateHead, CommandInput, CommandOutcome } from '../domain/types.js';
import { FactoryRunReducer } from '../domain/reducers/factory-run.js';
import {
  applyCommandInOwnTransaction,
  CasStaleRevisionError,
  HeadReaderRegistry,
  type RepositoryApplyOptions,
} from './kernel-ledger.js';

const SELECT_HEADS = 'SELECT instance_id, revision, status, terminal FROM factory_run';
const INSERT_HEAD =
  'INSERT INTO factory_run (instance_id, aggregate, revision, status, terminal, last_sequence) VALUES (?, ?, ?, ?, ?, ?)';
const UPDATE_HEAD_CAS =
  'UPDATE factory_run SET revision = ?, status = ?, terminal = ?, last_sequence = ? WHERE instance_id = ? AND revision = ?';

interface HeadRow {
  readonly instance_id: string;
  readonly revision: number;
  readonly status: string;
  readonly terminal: string | null;
}

export class FactoryRunRepository {
  readonly aggregate = FactoryRunReducer.aggregate;

  constructor(private readonly db: Database.Database, private readonly registry?: HeadReaderRegistry) {
    this.registry?.register(this.aggregate, () => this.loadHeads());
  }

  /** All FactoryRun heads (sole lawful reader surface for other aggregates). */
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

  /** The exact FactoryRun head (ordinary commands read the exact owner). */
  loadHead(instanceId: string): AggregateHead | undefined {
    return this.loadHeads().find((head) => head.instanceId === instanceId);
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
      FactoryRunReducer.ownedCommands,
      this.aggregate,
      input,
      {
        loadHeads: () => this.headsForHydration(),
        writeHead: (head, existed, sequence) => this.writeHead(head, existed, sequence),
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
      .run(
        head.revision,
        head.status,
        head.terminal ?? null,
        sequence,
        head.instanceId,
        head.revision - 1,
      );
    if (changed.changes !== 1) {
      throw new CasStaleRevisionError(head.instanceId, head.revision - 1);
    }
  }
}
