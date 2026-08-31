import type Database from 'better-sqlite3';
import {
  CARD_STATUSES,
  projectRun,
  recentRuns,
  type CardStatus,
  type NodeProjection,
  type RunSummary,
} from './projection.js';

// The Kanban board: a PROJECTION of the event log, never an authority.
//
// One card = one node's desk inside one run (`run_id::node_id`). Dynamic
// fan-out gives one card per spawned child, so the parallel Development
// workers appear as real cards without a single new table.
//
// Allowed board writes: exactly one — the operator decision at a human gate
// (`operator.resolved`), which is an ordinary kernel event. Everything else on
// this board is read-only by construction.

export interface Card {
  id: string;
  run_id: string;
  workflow: string;
  run_status: string;
  node_id: string;
  node_type: string;
  parent?: string;
  title: string;
  status: CardStatus;
  verdict?: string;
  reasons: string[];
  attempts: number;
  repairs: number;
  effect_outcome?: string;
  /** Gate that is holding this card (repair or human decision). */
  gate?: string;
  /** Исполнение назначено и ждёт свободного воркера. */
  queued: boolean;
  /** Ближайший отказавший узел выше по маршруту: работа не поедет, пока он
   *  не починен. Это НЕ очередь — это обрыв конвейера. */
  blocked_by?: string;
  materials: number;
  updated_at: string;
  seq: number;
  /** The only operator action a card may carry. */
  action?: 'operator_decision';
}

export interface BoardColumn {
  status: CardStatus;
  cards: Card[];
}

export interface Board {
  columns: BoardColumn[];
  runs: RunSummary[];
  totals: Record<string, number>;
  /** Сводка для оператора: что реально в работе, а что стоит и почему. */
  summary: {
    queued: number;
    ahead: number;
    stranded: number;
    /** Узлы, починка которых сдвинет весь застрявший хвост. */
    culprits: string[];
  };
}

function toCard(run: ReturnType<typeof projectRun>, node: NodeProjection): Card {
  return {
    id: `${run.run_id}::${node.node_id}`,
    run_id: run.run_id,
    workflow: run.workflow,
    run_status: run.status,
    node_id: node.node_id,
    node_type: node.type,
    parent: node.parent,
    title: node.title,
    status: node.status,
    verdict: node.verdict,
    reasons: node.reasons,
    attempts: node.attempts,
    repairs: node.repairs,
    effect_outcome: node.effect_outcome,
    gate: node.gate,
    queued: node.queued,
    blocked_by: node.blocked_by,
    materials: node.desk.length,
    updated_at: node.last_ts,
    seq: node.last_seq,
    action:
      node.type === 'gate' && node.verdict === 'human_required' && node.status === 'blocked'
        ? 'operator_decision'
        : undefined,
  };
}

export interface BoardOptions {
  /** Only this run (drill-down). */
  run_id?: string;
  /** How many recent runs to fold when no run_id is given. */
  runs?: number;
  /** Drop `done` cards of finished runs — the operator's default view. */
  active_only?: boolean;
}

export function board(db: Database.Database, opts: BoardOptions = {}): Board {
  const runs = opts.run_id
    ? (db
        .prepare(
          `SELECT r.id AS run_id, w.name AS workflow, r.status, r.created_at, r.updated_at
             FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`
        )
        .all(opts.run_id) as RunSummary[])
    : recentRuns(db, opts.runs ?? 12);

  const cards: Card[] = [];
  for (const summary of runs) {
    let projection;
    try {
      projection = projectRun(db, summary.run_id);
    } catch {
      continue; // a run whose graph no longer parses must not break the board
    }
    const finished = projection.status === 'success';
    for (const node of projection.nodes) {
      if (opts.active_only && finished && node.status === 'done') continue;
      cards.push(toCard(projection, node));
    }
  }

  cards.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.seq - a.seq));

  const totals: Record<string, number> = {};
  for (const status of CARD_STATUSES) totals[status] = 0;
  for (const card of cards) totals[card.status] += 1;

  const notStarted = cards.filter((card) => card.status === 'todo');
  const stranded = notStarted.filter((card) => card.blocked_by !== undefined);
  return {
    columns: CARD_STATUSES.map((status) => ({
      status,
      // Застрявшие карточки — в конец колонки: сверху то, что вот-вот поедет.
      cards: cards
        .filter((card) => card.status === status)
        .sort((a, b) => Number(a.blocked_by !== undefined) - Number(b.blocked_by !== undefined)),
    })),
    runs,
    totals,
    summary: {
      queued: notStarted.filter((card) => card.queued).length,
      ahead: notStarted.filter((card) => !card.queued && card.blocked_by === undefined).length,
      stranded: stranded.length,
      culprits: [...new Set(stranded.map((card) => card.blocked_by!))],
    },
  };
}

/** Every card currently waiting for a human decision, across all runs. */
export function operatorQueue(db: Database.Database, limit = 50): Card[] {
  return board(db, { runs: limit })
    .columns.find((column) => column.status === 'blocked')!
    .cards.filter((card) => card.action === 'operator_decision');
}
