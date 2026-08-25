/**
 * workflow-kernel/projection/store.ts - the disposable Kanban card store
 * (WP-10, plan phase EK-7).
 *
 * The projection table is the ONE projection table of the frozen schema
 * (persistence/schema.ts PROJECTION_TABLES; created with no immutability
 * triggers BY DESIGN - it is disposable). This module owns ALL data SQL
 * against it; no other module in the kernel reads or writes it. The table
 * name is imported from the schema's frozen register - never spelled out
 * here - so there is exactly one declaration of the physical name.
 *
 * THE WRITE LAW (plan EK-7): "a card write never reaches storage except
 * through a command". Enforced structurally: the ONLY mutating method is
 * `replaceAll(image)`, and `ProjectedImage` is an opaque branded value that
 * ONLY the projector (./projector.js projectKanban) can produce - the
 * projector derives the image exclusively from authoritative facts read
 * through the repositories' public read surfaces, and the UI command
 * adapters (./adapters.js) import NEITHER this module NOR the projector's
 * image type: they return raw kernel CommandOutcomes and never touch cards.
 *
 * Everything here is disposable: deleteAll() while work is running is a
 * legal, supported operation, and a full rebuild from canonical facts
 * (projector.rebuildProjection) reconstructs every row.
 */

import type Database from 'better-sqlite3';
import { PROJECTION_TABLES } from '../persistence/schema.js';
import type { KanbanCard, KanbanLane } from './cards.js';
import { KANBAN_LANES } from './cards.js';

/** The physical projection table, from the frozen schema register (single declaration). */
const TABLE = PROJECTION_TABLES[0];

/**
 * Opaque projected image: only projectKanban() constructs it. The brand is
 * undeclarable outside this package (the symbol is not exported), so no
 * caller can hand the store a fabricated card set.
 */
declare const imageBrand: unique symbol;

/** A fully derived, sequence-stamped set of cards (the projector's output). */
export interface ProjectedImage {
  readonly cards: readonly KanbanCard[];
  readonly sequence: number;
  readonly [imageBrand]: never;
}

/** Construct the branded image (projector-internal; exported for the projector module only). */
export function brandedImage(cards: readonly KanbanCard[], sequence: number): ProjectedImage {
  return Object.freeze({ cards, sequence }) as ProjectedImage;
}

/**
 * One row of the store as the UI reads it. `lane` is the RAW stored value
 * (verbatim, even when forged): a disposable table is reported as-is for
 * diagnosis, never silently coerced - `laneIsKnown` validates it.
 */
export interface KanbanCardRow {
  readonly cardId: string;
  readonly workItemRef: string;
  readonly lane: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectedSequence: number;
}

const INSERT_CARD = `INSERT INTO ${TABLE} (card_id, work_item_ref, lane, payload_json, projected_sequence) VALUES (?, ?, ?, ?, ?)`;
const DELETE_ALL = `DELETE FROM ${TABLE}`;
const SELECT_ALL = `SELECT card_id, work_item_ref, lane, payload_json, projected_sequence FROM ${TABLE} ORDER BY work_item_ref`;
const COUNT = `SELECT COUNT (*) AS n FROM ${TABLE}`;
const TABLE_EXISTS = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`;

export class KanbanCardStore {
  constructor(private readonly db: Database.Database) {
    // The projection table is created by the kernel schema (disposable by
    // design); assert presence so a bare database fails loudly, not silently.
    const table = this.db.prepare(TABLE_EXISTS).get(TABLE);
    if (table === undefined) {
      throw new Error('EK_PROJECTION: the projection table is missing (open the database through the kernel schema first)');
    }
  }

  /**
   * The ONLY write path: atomically replace every row with the projector's
   * derived image (full rebuild semantics - DELETE + INSERT in one
   * transaction). Returns the number of cards written.
   */
  replaceAll(image: ProjectedImage): number {
    const txn = this.db.transaction((): number => {
      this.db.prepare(DELETE_ALL).run();
      const insert = this.db.prepare(INSERT_CARD);
      for (const card of image.cards) {
        insert.run(card.cardId, card.workItemRef, card.lane, JSON.stringify(card), image.sequence);
      }
      return image.cards.length;
    });
    return txn();
  }

  /** Dispose of every card row (legal at ANY time; work never reads them). */
  deleteAll(): void {
    this.db.prepare(DELETE_ALL).run();
  }

  /** All card rows ordered by work item ref (the UI read surface). */
  all(): readonly KanbanCardRow[] {
    const rows = this.db.prepare(SELECT_ALL).all() as unknown as Array<{
      readonly card_id: string;
      readonly work_item_ref: string;
      readonly lane: string;
      readonly payload_json: string;
      readonly projected_sequence: number;
    }>;
    return rows.map((row) => ({
      cardId: row.card_id,
      workItemRef: row.work_item_ref,
      lane: row.lane,
      payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
      projectedSequence: row.projected_sequence,
    }));
  }

  /** One card row by card id (undefined when absent - absence is legal). */
  byCardId(cardId: string): KanbanCardRow | undefined {
    return this.all().find((row) => row.cardId === cardId);
  }

  count(): number {
    return (this.db.prepare(COUNT).get() as { n: number }).n;
  }

  /** True when the store holds no rows (after deleteAll or before the first projection). */
  isVacant(): boolean {
    return this.count() === 0;
  }

  /**
   * Staleness check for diagnostics: rows whose projected sequence is below
   * the given authoritative ledger sequence. Pure read; repairs nothing
   * (the projector's replaceAll is the only repair).
   */
  staleRows(authoritativeSequence: number): readonly KanbanCardRow[] {
    return this.all().filter((row) => row.projectedSequence < authoritativeSequence);
  }
}

/** True when a stored lane value belongs to the closed lane vocabulary. */
export function laneIsKnown(lane: string): lane is KanbanLane {
  return (KANBAN_LANES as readonly string[]).includes(lane);
}
