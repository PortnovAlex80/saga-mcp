/**
 * workflow-kernel/persistence/session.ts - the focused-composition session
 * of the workflow-kernel persistence layer (WP-06, plan phase EK-3).
 *
 * Composes the nine sole-writer repositories over ONE database connection
 * with the shared head-reader registry (cross-aggregate guard contexts are
 * served by the OWNING repository's reader - never by foreign SQL). This
 * session is constructed explicitly by focused tests at fresh temporary
 * paths; it stays unreachable from the production entrypoint until the EK-8
 * hard cutover (the production composition is wired in that same change).
 *
 * This module holds NO aggregate-owned SQL: every direct statement against
 * an aggregate's tables lives in that aggregate's repository file.
 */

import type Database from 'better-sqlite3';
import type { EvidenceFact } from '../domain/types.js';
import { ActivityAttemptRepository, type ActivityAttemptApplyOptions } from './activity-attempt-repository.js';
import { CognitionTransportRepository } from './cognition-transport-repository.js';
import { FactoryRunRepository } from './factory-run-repository.js';
import { HeadReaderRegistry, hydrateLedgerWorld, ledgerCounts, type HydratedLedger } from './kernel-ledger.js';
import { LifecycleRunRepository } from './lifecycle-run-repository.js';
import { NodeRunRepository } from './node-run-repository.js';
import { ProcessRunRepository } from './process-run-repository.js';
import { StageRunRepository } from './stage-run-repository.js';
import { WorkItemRepository, type WorkItemApplyOptions } from './work-item-repository.js';
import { WorkplaceRepository } from './workplace-repository.js';

export class KernelPersistenceSession {
  readonly factoryRun: FactoryRunRepository;
  readonly lifecycleRun: LifecycleRunRepository;
  readonly stageRun: StageRunRepository;
  readonly processRun: ProcessRunRepository;
  readonly nodeRun: NodeRunRepository;
  readonly workplace: WorkplaceRepository;
  readonly activityAttempt: ActivityAttemptRepository;
  readonly workItem: WorkItemRepository;
  readonly cognitionTransport: CognitionTransportRepository;

  constructor(readonly db: Database.Database) {
    const registry = new HeadReaderRegistry();
    this.factoryRun = new FactoryRunRepository(db, registry);
    this.lifecycleRun = new LifecycleRunRepository(db, registry);
    this.stageRun = new StageRunRepository(db, registry);
    this.processRun = new ProcessRunRepository(db, registry);
    this.nodeRun = new NodeRunRepository(db, registry);
    this.workplace = new WorkplaceRepository(db, registry);
    this.activityAttempt = new ActivityAttemptRepository(db, registry);
    this.workItem = new WorkItemRepository(db, registry);
    this.cognitionTransport = new CognitionTransportRepository(db, registry);
  }

  /** Close the underlying connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Hydrate the pure KernelWorld from the durable rows (all aggregates'
   * heads via the owning repositories + the shared ledger). Read-only.
   */
  hydrateWorld(options?: { externalEvidence?: readonly EvidenceFact[] }): HydratedLedger {
    return hydrateLedgerWorld(this.db, {
      heads: [
        ...this.factoryRun.loadHeads(),
        ...this.lifecycleRun.loadHeads(),
        ...this.stageRun.loadHeads(),
        ...this.processRun.loadHeads(),
        ...this.nodeRun.loadHeads(),
        ...this.workplace.loadHeads(),
        ...this.activityAttempt.loadHeads(),
        ...this.workItem.loadHeads(),
      ],
      ...(options?.externalEvidence ? { externalEvidence: options.externalEvidence } : {}),
    });
  }

  /** Shared-ledger counts (diagnostics and focused tests). */
  counts(): ReturnType<typeof ledgerCounts> {
    return ledgerCounts(this.db);
  }
}

export type { ActivityAttemptApplyOptions, WorkItemApplyOptions };
