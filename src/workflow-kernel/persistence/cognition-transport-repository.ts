/**
 * CognitionTransport sole-writer repository (WP-06, plan phase EK-3).
 *
 * The stateless, replaceable transport boundary behind the
 * obligation:providerSend durable handoff. It owns NO physical table and NO
 * mutable workflow state (its reducer holds no statuses beyond the
 * stateless self-loop): the well-known singleton instance is virtual and
 * its send cursor is derived from completed providerSend obligations.
 *
 * The single boundary command cognition.sendProviderRequest declares NO
 * WorkflowEvent (universe-faithful). Its idempotency key, its recorded
 * evidence (ProviderSendOutcome) and its commit sequence persist on the
 * obligation row it completes, in the same transaction: a crash before send
 * redrives the SAME obligation+ordinal, never a new admission.
 */

import type Database from 'better-sqlite3';
import type { AggregateHead, CommandInput, CommandOutcome } from '../domain/types.js';
import { CognitionTransportReducer } from '../domain/reducers/cognition-transport.js';
import { applyCommandInOwnTransaction, HeadReaderRegistry, type RepositoryApplyOptions } from './kernel-ledger.js';

export class CognitionTransportRepository {
  readonly aggregate = CognitionTransportReducer.aggregate;

  constructor(
    private readonly db: Database.Database,
    _registry?: HeadReaderRegistry,
  ) {
    // Intentionally registers no head reader: the transport singleton is
    // virtual (injected by kernel-ledger hydration); it owns no table rows.
  }

  /**
   * The virtual stateless singleton head (revision = committed sends). This
   * is a derived read over the shared ledger, not a table scan.
   */
  loadHeads(): readonly AggregateHead[] {
    const sends = (
      this.db
        .prepare("SELECT COUNT (*) AS n FROM transition_obligation WHERE kind = 'obligation:providerSend' AND state = 'completed'")
        .get() as { n: number }
    ).n;
    return [
      {
        aggregate: this.aggregate,
        instanceId: 'cognition:transport',
        revision: sends,
        status: 'stateless',
      },
    ];
  }

  applyCommand(input: CommandInput, options?: RepositoryApplyOptions): CommandOutcome {
    return applyCommandInOwnTransaction(
      this.db,
      CognitionTransportReducer.ownedCommands,
      this.aggregate,
      input,
      {
        loadHeads: () => this.loadHeads(),
        writeHead: () => {
          /* no physical head: the boundary owns no mutable row */
        },
      },
      options,
    );
  }
}
