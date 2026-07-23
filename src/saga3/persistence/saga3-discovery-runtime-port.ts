import type { CreateWorkIntent, WorkIntent, WorkIntentStatus } from '../domain/work-intent.js';
import type { ProposalRecord } from '../domain/proposal.js';

/**
 * Runtime-persistence boundary for the Saga 3 Discovery Edition engine.
 *
 * The engine must NOT call `getDb()` or `.prepare(...)` directly — Phase B
 * isolated Saga 2's pump the same way, and the D1 correction restores that
 * boundary for Saga 3. Every read/write the engine needs (epic objective,
 * WorkIntent lifecycle, projected board task, task status, latest proposal)
 * is expressed here as a narrow method. The SQLite adapter
 * (sqlite-saga3-discovery-runtime.ts) is the only implementation; the engine
 * depends on this interface so it stays pure orchestration logic and is
 * replaceable / testable with a fake.
 *
 * CAS semantics: setIntentStatus(expected, next) performs
 * `UPDATE ... WHERE status=expected` and returns whether it applied. This
 * makes the open → executing → concluded transition race-free across engine
 * restarts.
 */
export interface Saga3DiscoveryRuntimePersistence {
  /** Read the epic's name + description (the discovery objective source). */
  readEpicObjective(epicId: number): { name: string; description: string | null } | null;

  /** Open WorkIntent of the given kind for the episode, if any. */
  readOpenIntent(epicId: number, kind: string): WorkIntent | null;

  /** Create a new WorkIntent (status starts 'open'). */
  createIntent(command: CreateWorkIntent): WorkIntent;

  /** Link the projected board task id onto the intent (idempotent). */
  setProjectedTask(intentId: number, taskId: number): void;

  /**
   * Compare-and-set intent status. Returns true iff a row was updated
   * (i.e. the prior status matched `expected`). Use this for the
   * open → executing → concluded transitions so a stale/restarted engine
   * cannot overwrite a concurrent transition.
   */
  setIntentStatus(intentId: number, expected: WorkIntentStatus, next: WorkIntentStatus): boolean;

  /**
   * Idempotently ensure the projected discovery board task exists and return
   * its id. If a task with the generation_key already exists, return that id
   * without re-inserting. Otherwise create it (todo, discovery.work,
   * saga-discovery-worker, tracker_only) and return the new id.
   */
  ensureProjectedTask(input: EnsureProjectedTask): number;

  /** Current task status ('todo' | 'in_progress' | 'done' | ...), or null if gone. */
  readTaskState(taskId: number): string | null;

  /**
   * Read the WorkIntent bound to a board task via `tasks.metadata.work_intent_id`,
   * or null if the task has no work_intent_id (legacy Saga 2 task) or the
   * referenced intent no longer exists. Used at claim time to freeze the
   * immutable execution authority snapshot (D1.1).
   */
  readWorkIntentForTask(taskId: number): WorkIntent | null;

  /** Latest submitted proposal answering the intent, or null if none. */
  readLatestProposal(intentId: number): ProposalRecord | null;
}

export interface EnsureProjectedTask {
  epicId: number;
  projectId: number;
  intentId: number;
  objective: string;
  taskKind: string;
  executionSkill: string;
  /** generation_key (UNIQUE per epic) for idempotency. */
  generationKey: string;
}
