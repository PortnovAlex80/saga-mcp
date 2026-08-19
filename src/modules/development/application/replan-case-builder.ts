/**
 * RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §2-3) — the cycle-2
 * case-builder.
 *
 * When a scope-impossible trajectory mints a re-plan mandate, the cycle-2
 * planner must see ALL of cycle-1's reality (the operator's principle: the
 * re-planner sees the whole integrated code, so it can carve genuinely
 * parallel tasks). This builder reads the durable cycle-1 facts from the
 * factory DB — the closed workplaces, the accepted implementation
 * submissions, the kernel-authoritative task boundaries — and enriches the
 * UNCHANGED cycle-1 DevelopmentCase with `replanContext`.
 *
 * Standard case fields (formalizationCertificate, solutionContract, srs,
 * acceptanceCriteria) are inherited byte-for-byte: the re-plan re-carves the
 * WORK, never the contract. The enriched case flows to the cycle-2 planner
 * node through the existing run-input / inputBeforeNodeRun channel
 * (generic-flow-executor inputBeforeNodeRun).
 */

import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type {
  DevelopmentCase,
} from '../domain/development-schemas.js';
import type { WorkplaceRef } from '../../../process-modules/domain/workplace/workplace-ref.js';
import {
  isPathOutsideAuthorityKey,
} from '../../../process-modules/domain/workplace/finding-trajectory.js';
import { repositoryScopesOverlap } from '../../../shared/repository-scope.js';

/** A cross-seam burn: WHICH paths sat outside WHICH frozen scopes. */
export interface PathScopePair {
  readonly findingKey: string;
  readonly paths: readonly string[];
  readonly scopes: readonly string[];
}

/** A module boundary: one frozen scope and the cycle-1 items that own it. */
export interface InterfacePair {
  readonly module: string;
  readonly exports: readonly string[];
}

export interface ReplanContext {
  readonly cycleNumber: number;
  /** The cycle-1 process run (task supersede target, REPLAN-CYCLE-TZ §5). */
  readonly cycle1ProcessRunId: number;
  readonly cycle1Diagnosis: {
    readonly survivingKeys: readonly string[];
    readonly completedItems: readonly string[];
    readonly scopeViolations: readonly PathScopePair[];
  };
  readonly integratedRepoState: {
    readonly headCommit: string;
    readonly fileTree: readonly string[];
    readonly moduleBoundaries: readonly InterfacePair[];
  };
  readonly parallelismHint: {
    readonly maxConcurrency: number;
    readonly nonOverlappingGroups: readonly (readonly string[])[];
  };
}

/** The cycle-1 DevelopmentCase plus the cycle-2 replanContext. */
export interface ReplanDevelopmentCase extends DevelopmentCase {
  readonly replanContext: ReplanContext;
}

export interface ReplanCaseInput {
  /** The UNCHANGED cycle-1 case — standard fields are inherited verbatim. */
  readonly developmentCase: DevelopmentCase;
  /** The workplace whose scope-impossible trajectory minted the mandate. */
  readonly workplaceRef: WorkplaceRef;
  readonly role: 'author' | 'reviewer';
  /** Surviving path-outside-authority keys (from the finding-set chain). */
  readonly survivingKeys: readonly string[];
  /** From the model profile; the factory default parallelism is 2. */
  readonly maxConcurrency?: number;
}

interface CellItemRow {
  readonly itemKey: string;
  readonly scopes: readonly string[];
  readonly accepted: boolean;
}

interface SubmissionRow {
  readonly payloadSnapshot: string;
}

/**
 * Parse the REAL path-outside-authority message grammar
 * (development-check-providers.ts):
 *   `Git paths [p1, p2] are outside frozen changeScopes [s1, s2].`
 */
function parseScopeViolation(key: string): PathScopePair | null {
  if (!isPathOutsideAuthorityKey(key)) return null;
  const message = key.slice(key.indexOf('::') + 2);
  const match = /^Git paths \[(.*?)\] are outside frozen changeScopes \[(.*?)\]\.$/
    .exec(message);
  if (!match) return { findingKey: key, paths: [], scopes: [] };
  return {
    findingKey: key,
    paths: match[1]!.split(',').map(part => part.trim()).filter(Boolean),
    scopes: match[2]!.split(',').map(part => part.trim()).filter(Boolean),
  };
}

/**
 * Read the cycle-1 cell facts: item keys, kernel-authoritative changeScopes
 * (tasks.metadata.cell_input_item) and acceptance state per workplace.
 */
function readCellItems(
  db: SqlDatabasePort,
  processRunId: number,
  cellId: string,
): CellItemRow[] {
  const rows = db.prepare(
    `SELECT t.metadata AS metadata,
            w.loop_state AS loopState,
            w.terminal_reason AS terminalReason
       FROM factory_workplaces w
       JOIN tasks t ON t.workplace_ref = w.workplace_ref
      WHERE w.process_run_id = ? AND w.production_cell_id = ?`,
  ).all(processRunId, cellId) as Array<{
    metadata: string;
    loopState: string;
    terminalReason: string | null;
  }>;
  return rows.flatMap(row => {
    let item: unknown;
    try { item = (JSON.parse(row.metadata) as { cell_input_item?: unknown }).cell_input_item; } catch { return []; }
    if (!item || typeof item !== 'object') return [];
    const key = (item as { key?: unknown }).key;
    const scopes = (item as { changeScopes?: unknown }).changeScopes;
    if (typeof key !== 'string' || !Array.isArray(scopes)) return [];
    return [{
      itemKey: key,
      scopes: scopes.filter((scope): scope is string => typeof scope === 'string'),
      accepted: row.loopState === 'terminal' && row.terminalReason === 'accepted',
    }];
  });
}

/**
 * The accepted implementation submissions of the cell: the submitted file sets
 * (the cycle-1 delta tree) and the item commits (the integration head).
 */
function readSubmissions(
  db: SqlDatabasePort,
  processRunId: number,
  cellId: string,
): SubmissionRow[] {
  return db.prepare(
    `SELECT s.payload_snapshot AS payloadSnapshot
       FROM factory_managed_node_submissions s
       JOIN tasks t ON t.id = s.task_id AND t.workplace_ref IS NOT NULL
       JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
      WHERE w.process_run_id = ? AND w.production_cell_id = ?
      ORDER BY s.id`,
  ).all(processRunId, cellId) as SubmissionRow[];
}

/** Greedy grouping of items whose frozen scopes do NOT overlap. */
function nonOverlappingGroups(items: readonly CellItemRow[]): readonly (readonly string[])[] {
  const groups: string[][] = [];
  for (const item of items) {
    const group = groups.find(candidates => candidates.every(candidate => {
      const other = items.find(row => row.itemKey === candidate);
      return other === undefined
        || !(item.scopes.some(left => other.scopes.some(right => repositoryScopesOverlap(left, right))));
    }));
    if (group) group.push(item.itemKey);
    else groups.push([item.itemKey]);
  }
  return groups;
}

export function buildReplanCase(db: SqlDatabasePort, input: ReplanCaseInput): ReplanDevelopmentCase {
  const { developmentCase, workplaceRef } = input;
  const items = readCellItems(db, workplaceRef.processRunId, workplaceRef.productionCellId);
  const submissions = readSubmissions(db, workplaceRef.processRunId, workplaceRef.productionCellId)
    .flatMap(row => {
      try { return [JSON.parse(row.payloadSnapshot) as { snapshot?: { commitSha?: unknown; changedFiles?: unknown } }]; } catch { return []; }
    });
  const fileTree = [...new Set(submissions.flatMap(payload =>
    Array.isArray(payload.snapshot?.changedFiles)
      ? payload.snapshot.changedFiles.filter((f): f is string => typeof f === 'string')
      : []))].sort();
  const headCommit = submissions.length > 0
    ? String(submissions[submissions.length - 1]!.snapshot?.commitSha ?? '')
    : developmentCase.repositories[0]?.expectedBaseCommit ?? '';
  const boundaries = new Map<string, string[]>();
  for (const item of items) {
    for (const scope of item.scopes) {
      boundaries.set(scope, [...(boundaries.get(scope) ?? []), item.itemKey]);
    }
  }
  return {
    ...developmentCase,
    replanContext: {
      cycleNumber: 2,
      cycle1ProcessRunId: workplaceRef.processRunId,
      cycle1Diagnosis: {
        survivingKeys: [...input.survivingKeys],
        completedItems: items.filter(item => item.accepted).map(item => item.itemKey).sort(),
        scopeViolations: input.survivingKeys
          .flatMap(key => { const parsed = parseScopeViolation(key); return parsed ? [parsed] : []; }),
      },
      integratedRepoState: {
        headCommit,
        fileTree,
        moduleBoundaries: [...boundaries.entries()]
          .map(([module, exports]) => ({ module, exports: [...new Set(exports)].sort() }))
          .sort((left, right) => left.module.localeCompare(right.module)),
      },
      parallelismHint: {
        maxConcurrency: input.maxConcurrency ?? 2,
        nonOverlappingGroups: nonOverlappingGroups(items),
      },
    },
  };
}
