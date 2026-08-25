/**
 * workflow-kernel/projection/fences.ts - the EK-7 structural fence
 * scanners (WP-10).
 *
 * Hard laws (plan EK-7), enforced as reusable pure scanners so both the
 * projection test suite and any later ratchet can run them:
 *
 *   F1  no core read of `tasks`, `tasks.status`, assigned worker or any
 *       projection-derived dependency state (the kernel core decides over
 *       canonical facts only);
 *   F2  tools and hooks receive exact context from authoritative commands,
 *       never by reverse-reading the board (the context/adapter modules
 *       must not touch the projection table);
 *   F3  stale-card acceptance: no kernel-core or adapter/context module may
 *       read the kanban_card table AT ALL (the sole reader/writer of that
 *       table is the projection store; cards are never workflow inputs).
 *
 * The forbidden vocabulary lives in register-like constant tables below -
 * data tables, not name-literal branching.
 */

/* ------------------------------------------------------------------ */
/* Register-like forbidden-vocabulary tables (fence data, not logic)     */
/* ------------------------------------------------------------------ */

/** The projection-owned table (the only legal kanban_card data surface is store.ts). */
export const PROJECTION_TABLE: string = 'kanban_card';

/**
 * F1 register: substrings whose occurrence in KERNEL-CORE sources (the
 * workflow-kernel OUTSIDE projection/) marks a forbidden decision input
 * (legacy task-board reads, assigned-worker reads, projection-table data
 * reads). The kanban_card forms are SQL DATA verbs only - the frozen schema
 * (persistence/schema.ts) legitimately DECLARES the disposable table.
 * (The table name is assembled from PROJECTION_TABLE, not spelled out, so
 * this register carrier itself cannot be mistaken for a data statement.)
 */
export const FORBIDDEN_CORE_READ_PATTERNS: readonly string[] = Object.freeze([
  'FROM tasks',
  'FROM task',
  'tasks.status',
  'task_status',
  'assigned_worker',
  'assigned-worker',
  'assignedWorker',
  `FROM ${PROJECTION_TABLE}`,
  `INTO ${PROJECTION_TABLE}`,
  `UPDATE ${PROJECTION_TABLE}`,
  'laneOfCard',
  'card.lane',
]);

/**
 * F2/F3 register: kernel files that must never reference the projection
 * table AT ALL (exact module basenames). The context/adapters/cards modules
 * build tool/hook context and UI actions from commands only - the table
 * name itself may not appear in them.
 */
export const COMMAND_ONLY_MODULES: readonly string[] = Object.freeze(['adapters.ts', 'context.ts', 'cards.ts']);

/** The one module that may contain projection-table data SQL. */
export const PROJECTION_STORE_MODULE: string = 'store.ts';

/** The module set that may import the store (projector writes, store is the surface). */
export const STORE_IMPORTER_MODULES: readonly string[] = Object.freeze(['store.ts', 'projector.ts', 'index.ts']);

/** Strip block and line comments so prose that CITES a law cannot hide or fake a violation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

/* ------------------------------------------------------------------ */
/* F1: forbidden decision inputs in kernel-core sources                 */
/* ------------------------------------------------------------------ */

export interface FenceViolation {
  readonly fence: 'F1_CORE_DECISION_INPUT' | 'F2_REVERSE_BOARD_CONTEXT' | 'F3_STORE_READ_OUTSIDE_PROJECTION_STORE';
  readonly source: string;
  readonly pattern: string;
  readonly excerpt: string;
}

/**
 * Scan one kernel-core source text for forbidden decision inputs (F1).
 * Pure: returns the exact violations (empty = green). Comments are ignored
 * (prose that cites the law is not a read of it).
 */
export function scanCoreSourceForDecisionInputs(sourceName: string, text: string): readonly FenceViolation[] {
  const code = stripComments(text);
  const violations: FenceViolation[] = [];
  for (const pattern of FORBIDDEN_CORE_READ_PATTERNS) {
    const index = code.indexOf(pattern);
    if (index >= 0) {
      violations.push({
        fence: 'F1_CORE_DECISION_INPUT',
        source: sourceName,
        pattern,
        excerpt: code.slice(Math.max(0, index - 40), index + pattern.length + 40).replace(/\r?\n/g, ' '),
      });
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* F2: reverse-board tool/hook context                                 */
/* ------------------------------------------------------------------ */

/**
 * Scan one command-only module's source text for board reads (F2): the
 * tool/hook context path must never touch the projection table or import
 * the card store. Comments are ignored.
 */
export function scanCommandOnlyModuleForBoardReads(sourceName: string, text: string): readonly FenceViolation[] {
  const code = stripComments(text);
  const violations: FenceViolation[] = [];
  for (const pattern of [PROJECTION_TABLE, './store.js', "from './store"]) {
    const index = code.indexOf(pattern);
    if (index >= 0) {
      violations.push({
        fence: 'F2_REVERSE_BOARD_CONTEXT',
        source: sourceName,
        pattern,
        excerpt: code.slice(Math.max(0, index - 40), index + pattern.length + 40).replace(/\r?\n/g, ' '),
      });
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* F3: card rows as workflow inputs (stale-card acceptance)             */
/* ------------------------------------------------------------------ */

/**
 * The SQL data-verb forms against the projection table (F3's vocabulary):
 * any of these outside the projection store module is a card used as
 * something other than a disposable projection (a stale/forged row could
 * then become an input).
 */
const PROJECTION_DATA_VERBS: readonly string[] = Object.freeze([
  `FROM ${PROJECTION_TABLE}`,
  `INTO ${PROJECTION_TABLE}`,
  `UPDATE ${PROJECTION_TABLE}`,
]);

/**
 * Scan one source text for projection-table DATA statements outside the
 * projection store module (F3). The frozen schema's DDL declaration is
 * exempt; a SELECT/INSERT/UPDATE/DELETE against the table is not.
 */
export function scanSourceForProjectionTableUse(sourceName: string, text: string, isProjectionStoreModule: boolean): readonly FenceViolation[] {
  if (isProjectionStoreModule) return [];
  const code = stripComments(text);
  const violations: FenceViolation[] = [];
  for (const pattern of PROJECTION_DATA_VERBS) {
    const index = code.indexOf(pattern);
    if (index >= 0) {
      violations.push({
        fence: 'F3_STORE_READ_OUTSIDE_PROJECTION_STORE',
        source: sourceName,
        pattern,
        excerpt: code.slice(Math.max(0, index - 40), index + pattern.length + 40).replace(/\r?\n/g, ' '),
      });
    }
  }
  return violations;
}
