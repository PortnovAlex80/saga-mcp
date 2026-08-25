/**
 * WorkItem sole-writer repository (WP-06, plan phase EK-3).
 *
 * The ONLY module with direct SQL against work_item and
 * work_item_dependency. WorkItem definitions and dependency edges are
 * IMMUTABLE planning facts: creation (workItem.planGraph, the single
 * authority:Planning command) is the only transition, the trigger forbids
 * any UPDATE or DELETE, and there is no mutable board status on a WorkItem
 * (plan law "Projection-only Kanban").
 *
 * The dependency-edge payload of the planning graph commits in the SAME
 * transaction as the work item; a foreign or circular (self) edge aborts
 * the whole transaction via FK/CHECK, leaving neither fact nor orphan
 * obligation.
 */

import type Database from 'better-sqlite3';
import type { AggregateHead, CommandInput, CommandOutcome } from '../domain/types.js';
import { WorkItemReducer } from '../domain/reducers/work-item.js';
import {
  applyCommandInOwnTransaction,
  HeadReaderRegistry,
  type DependencyEdgeInput,
  type LedgerWriteContext,
  type RepositoryApplyOptions,
} from './kernel-ledger.js';

const SELECT_HEADS = 'SELECT instance_id, revision, status, terminal FROM work_item';
const INSERT_HEAD =
  'INSERT INTO work_item (instance_id, aggregate, revision, status, terminal, last_sequence, planning_input_refs_json) VALUES (?, ?, ?, ?, ?, ?, ?)';
const INSERT_DEPENDENCY =
  'INSERT INTO work_item_dependency (work_item_ref, depends_on_ref, created_sequence) VALUES (?, ?, ?)';
const SELECT_DEPENDENCIES =
  'SELECT work_item_ref, depends_on_ref, created_sequence FROM work_item_dependency ORDER BY work_item_ref, depends_on_ref';

interface HeadRow {
  readonly instance_id: string;
  readonly revision: number;
  readonly status: string;
  readonly terminal: string | null;
}

export interface WorkItemApplyOptions extends RepositoryApplyOptions {
  /** The immutable dependency edges committing with workItem.planGraph. */
  readonly dependencyEdges?: readonly DependencyEdgeInput[];
}

export interface WorkItemDependencyRow {
  readonly workItemRef: string;
  readonly dependsOnRef: string;
  readonly createdSequence: number;
}

export class WorkItemRepository {
  readonly aggregate = WorkItemReducer.aggregate;

  constructor(private readonly db: Database.Database, private readonly registry?: HeadReaderRegistry) {
    this.registry?.register(this.aggregate, () => this.loadHeads());
  }

  /** All WorkItem heads (immutable planning instances; sole reader surface). */
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

  /** The immutable dependency edges (planning facts; read-only here). */
  loadDependencies(): readonly WorkItemDependencyRow[] {
    const rows = this.db.prepare(SELECT_DEPENDENCIES).all() as unknown as Array<{
      readonly work_item_ref: string;
      readonly depends_on_ref: string;
      readonly created_sequence: number;
    }>;
    return rows.map((row) => ({ workItemRef: row.work_item_ref, dependsOnRef: row.depends_on_ref, createdSequence: row.created_sequence }));
  }

  /**
   * All registered aggregates' heads for guard-context hydration
   * (each SELECT executes inside its owning repository file).
   */
  private headsForHydration() {
    return this.registry ? this.registry.allHeads() : this.loadHeads();
  }

  applyCommand(input: CommandInput, options?: WorkItemApplyOptions): CommandOutcome {
    return applyCommandInOwnTransaction(
      this.db,
      WorkItemReducer.ownedCommands,
      this.aggregate,
      input,
      {
        loadHeads: () => this.headsForHydration(),
        writeHead: (head, _existed, sequence) => this.writeHead(input, head, sequence),
        writeRelations: (context) => this.writeRelations(context, options?.dependencyEdges ?? []),
      },
      options,
    );
  }

  private writeHead(input: CommandInput, head: AggregateHead, sequence: number): void {
    // Creation is the only transition: INSERT only, never UPDATE.
    this.db
      .prepare(INSERT_HEAD)
      .run(
        head.instanceId,
        this.aggregate,
        head.revision,
        head.status,
        head.terminal ?? null,
        sequence,
        JSON.stringify([...(input.evidenceRefs ?? [])]),
      );
  }

  private writeRelations(context: LedgerWriteContext, edges: readonly DependencyEdgeInput[]): void {
    if (context.input.command !== 'workItem.planGraph') return;
    for (const edge of edges) {
      this.db.prepare(INSERT_DEPENDENCY).run(edge.workItemRef, edge.dependsOnRef, context.meta.sequence);
    }
  }
}
