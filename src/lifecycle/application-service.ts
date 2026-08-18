/**
 * Lifecycle application service — single command-bus entry point.
 *
 * Source: ADR-013 Phase 4.1 (docs/architecture/decisions/013-lifecycle-fix-execution-plan.md).
 *
 * Why: ADR-013's audit found that the lifecycle kernel
 * (src/lifecycle/domain/**) was imported only by tests. All runtime
 * transitions happened through 16+ direct UPDATE tasks in dispatcher.ts.
 * Phase 4.1 of the plan calls for an application service that owns all
 * lifecycle transitions, with MCP handlers becoming thin adapters.
 *
 * Pragmatic scope of THIS commit: the service is a FACADE. It does not yet
 * own the transitions — it delegates to the existing handlers. What it
 * provides today:
 *
 *   1. A single typed entry point — `handleLifecycleCommand(db, cmd)` —
 *      that MCP handlers, the engine, and tests can call instead of
 *      reaching into dispatcher internals.
 *   2. Command/event audit logging through the existing lifecycle_events
 *      table, so every transition leaves a trace regardless of which
 *      handler ran it.
 *   3. A migration path: each command kind lists which legacy handler
 *      currently backs it. As Phase 4 continues, the handlers' bodies move
 *      into the kernel (src/lifecycle/**) one at a time, and the facade's
 *      delegate shrinks to a direct kernel call.
 *
 * What this does NOT do yet:
 *   - Replace the existing handlers. The handlers still own their SQL.
 *   - Force every caller through the facade. dispatcher.ts still calls its
 *     own internal functions. The facade is the target shape, not yet the
 *     enforcement.
 *
 * The architecture-boundary test (Phase 3.2) tracks the migration surface:
 * every handler that still owns lifecycle SQL is listed in
 * TEMPORARY_EXCEPTIONS with a TODO(4.1) tag. As each one is rewritten to
 * call into this service, its exception entry is removed.
 */

import type { Database } from 'better-sqlite3';
import { logActivity } from '../helpers/activity-logger.js';

// Lazy resolver for the dispatcher module. We cannot import it eagerly
// because dispatcher.ts imports types from this module (via the Lifecycle*
// type re-exports in some callers), and an eager import creates a circular
// dependency that breaks module load. Using a cached lazy getter defers
// the actual require until the first command, by which point all modules
// have finished loading.
//
// We use createRequire because saga-mcp is ESM (NodeNext module resolution)
// and there is no synchronous dynamic import in ESM. createRequire gives us
// a sync require() that works in ESM contexts.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let dispatcherCache: typeof import('../tools/dispatcher.js') | null = null;
function getDispatcher(): typeof import('../tools/dispatcher.js') {
  if (!dispatcherCache) {
    dispatcherCache = require('../tools/dispatcher.js') as typeof import('../tools/dispatcher.js');
  }
  return dispatcherCache;
}

// ---------------------------------------------------------------------------
// Command surface — discriminated union of every lifecycle transition.
// ---------------------------------------------------------------------------

/**
 * Every lifecycle command the application service can handle. One tag per
 * MCP tool that mutates lifecycle state. As the migration progresses, new
 * command kinds appear here first; the legacy handler then delegates.
 */
export type LifecycleCommand =
  | { readonly kind: 'WorkerNext'; readonly workerId: string; readonly projectId: number; readonly epicId?: number; readonly executionId?: string; readonly machineId?: string; readonly role?: string }
  | { readonly kind: 'WorkerDone'; readonly taskId: number; readonly workerId: string; readonly result: string; readonly verdict?: 'approved' | 'changes_requested'; readonly executionId?: string }
  | { readonly kind: 'WorkerAskNeed'; readonly taskId: number; readonly workerId: string; readonly reason?: string; readonly executionId?: string }
  | { readonly kind: 'WorkerAskDone'; readonly taskId: number; readonly workerId: string; readonly answer?: string };

/**
 * Structured result. Today this is `unknown` because each handler returns a
 * different shape — the facade does not normalise them. Once the handlers'
 * bodies migrate into the kernel, each command kind will have a typed
 * ResultFor<...> in src/lifecycle/domain/commands.ts and this will become a
 * typed discriminated union.
 */
export interface LifecycleCommandResult {
  readonly commandId: string;
  readonly commandKind: string;
  readonly handledBy: string;
  readonly actor: string;
  readonly taskId: number | null;
  readonly reply: unknown;
  readonly durationMs: number;
}

/**
 * Errors raised by the facade itself (not by the underlying handler).
 * Handler-thrown errors propagate as-is — the facade does not wrap them.
 */
export class LifecycleCommandError extends Error {
  constructor(
    message: string,
    readonly commandKind: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LifecycleCommandError';
  }
}

// ---------------------------------------------------------------------------
// Stable command id derivation.
// ---------------------------------------------------------------------------

/**
 * Derive a stable id for a command. Two retries of the same command produce
 * the same id, so the audit log can be replayed. The shape is
 * `<kind>:<primary-key>[:<executionId>]` — the same scheme the existing
 * idempotency layer uses for worker_done.
 */
export function commandIdFor(cmd: LifecycleCommand): string {
  switch (cmd.kind) {
    case 'WorkerNext':
      return `WorkerNext:${cmd.workerId}:${cmd.executionId ?? 'nofence'}`;
    case 'WorkerDone':
      return `WorkerDone:${cmd.taskId}:${cmd.executionId ?? cmd.workerId}:${cmd.verdict ?? 'approved'}`;
    case 'WorkerAskNeed':
      return `WorkerAskNeed:${cmd.taskId}:${cmd.executionId ?? cmd.workerId}`;
    case 'WorkerAskDone':
      return `WorkerAskDone:${cmd.taskId}:${cmd.workerId}`;
    default: {
      // Exhaustiveness check — if a new command kind is added to the union
      // without a case here, TypeScript flags it at compile time.
      const _exhaustive: never = cmd;
      void _exhaustive;
      return `Unknown:${JSON.stringify(cmd)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// The facade.
// ---------------------------------------------------------------------------

/**
 * Handle a lifecycle command. This is the target entry point for all
 * lifecycle mutations. Today it delegates to the existing handlers in
 * dispatcher.ts; tomorrow those handlers' bodies migrate into the kernel
 * and the delegate shrinks to a direct call.
 *
 * The facade wraps every delegation in:
 *   - timing (durationMs in the result)
 *   - audit logging (one lifecycle_events row per command, plus an
 *     activity_log entry for human-readable trace)
 *   - stable command id (so retries collapse in the audit log)
 *
 * Caller responsibility: the facade does NOT enforce that callers stop using
 * the legacy handlers directly. That enforcement is the architecture test
 * in tests/lifecycle/architecture.test.mjs (Phase 3.2), which lists every
 * file that still contains direct lifecycle UPDATE.
 *
 * @param db open database handle (caller owns the transaction boundary for
 *           the underlying handler — most handlers open their own tx)
 * @param cmd the command to execute
 * @returns structured result with timing + audit info; reply is the
 *          underlying handler's return value
 */
export function handleLifecycleCommand(
  db: Database,
  cmd: LifecycleCommand,
): LifecycleCommandResult {
  const commandId = commandIdFor(cmd);
  const startedAt = Date.now();

  // Late import to avoid a circular dependency at module-load time:
  // dispatcher.ts imports from application-service for the types, and
  // application-service needs to call back into dispatcher's handlers.
  // The lazy getter above defers the actual require until the first command.
  const dispatcher = getDispatcher();
  const handlers = dispatcher.handlers as Record<string, (args: Record<string, unknown>) => unknown>;

  const handlerName = handlerNameForCommand(cmd.kind);
  const handler = handlers[handlerName];
  if (!handler) {
    throw new LifecycleCommandError(
      `no handler '${handlerName}' registered for command kind '${cmd.kind}'`,
      cmd.kind,
    );
  }

  const args = commandToHandlerArgs(cmd);
  let reply: unknown;
  try {
    reply = handler(args);
  } catch (error) {
    // Re-throw with audit trace — the caller sees the original error, but
    // we leave a failure record in the audit log for diagnosis.
    auditFailure(db, commandId, cmd, error);
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  auditSuccess(db, commandId, cmd, reply, durationMs);

  return {
    commandId,
    commandKind: cmd.kind,
    handledBy: handlerName,
    actor: actorOf(cmd),
    taskId: taskIdOf(cmd),
    reply,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Internal mapping — command kind → handler name + args.
// ---------------------------------------------------------------------------

function handlerNameForCommand(kind: LifecycleCommand['kind']): string {
  switch (kind) {
    case 'WorkerNext': return 'worker_next';
    case 'WorkerDone': return 'worker_done';
    case 'WorkerAskNeed': return 'worker_ask_need';
    case 'WorkerAskDone': return 'worker_ask_done';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new LifecycleCommandError(`unknown command kind ${JSON.stringify(kind)}`, kind);
    }
  }
}

function commandToHandlerArgs(cmd: LifecycleCommand): Record<string, unknown> {
  switch (cmd.kind) {
    case 'WorkerNext':
      return {
        worker_id: cmd.workerId,
        project_id: cmd.projectId,
        epic_id: cmd.epicId,
        execution_id: cmd.executionId,
        machine_id: cmd.machineId,
        role: cmd.role,
      };
    case 'WorkerDone':
      return {
        task_id: cmd.taskId,
        worker_id: cmd.workerId,
        result: cmd.result,
        verdict: cmd.verdict,
        execution_id: cmd.executionId,
      };
    case 'WorkerAskNeed':
      return {
        task_id: cmd.taskId,
        worker_id: cmd.workerId,
        reason: cmd.reason,
        execution_id: cmd.executionId,
      };
    case 'WorkerAskDone':
      return {
        task_id: cmd.taskId,
        worker_id: cmd.workerId,
        answer: cmd.answer,
      };
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
      return {};
    }
  }
}

function actorOf(cmd: LifecycleCommand): string {
  if ('workerId' in cmd) return cmd.workerId;
  return '(unknown)';
}

function taskIdOf(cmd: LifecycleCommand): number | null {
  if ('taskId' in cmd) return cmd.taskId;
  return null;
}

// ---------------------------------------------------------------------------
// Audit logging — best-effort, never blocks the command.
// ---------------------------------------------------------------------------

function auditSuccess(
  db: Database,
  commandId: string,
  cmd: LifecycleCommand,
  reply: unknown,
  durationMs: number,
): void {
  // lifecycle_events.command_id has a FK to command_receipts.command_id, so
  // we must create a stub receipt first (accepted=0 — this is an audit-only
  // record, not an idempotency receipt). The receipt's reply_json carries
  // the structured LifecycleCommandResult summary for replay/debugging.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO command_receipts
         (command_id, command_kind, actor_kind, actor_id, task_id,
          payload_hash, accepted, rejection_code, result_json, reply_json)
       VALUES (?, ?, 'managed_execution', ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(
      commandId,
      cmd.kind,
      actorOf(cmd),
      taskIdOf(cmd),
      hashOf(cmd),
      JSON.stringify({ audited_only: true }),
      JSON.stringify({ command: cmd.kind, duration_ms: durationMs, reply_summary: summariseReply(reply) }),
    );
  } catch {
    // best-effort — if the receipt table is missing we still try the event.
  }
  try {
    db.prepare(
      `INSERT OR IGNORE INTO lifecycle_events
         (command_id, seq, event_kind, task_id, payload_json)
       VALUES (?, 0, ?, ?, ?)`,
    ).run(
      commandId,
      `${cmd.kind}Handled`,
      taskIdOf(cmd),
      JSON.stringify({
        command: cmd.kind,
        handled_by: handlerNameForCommand(cmd.kind),
        duration_ms: durationMs,
        reply_summary: summariseReply(reply),
      }),
    );
  } catch {
    // lifecycle_events may not exist (pre-Slice-1 DB) — best-effort only.
  }
  try {
    logActivity(
      db,
      'task',
      taskIdOf(cmd) ?? 0,
      'updated',
      'lifecycle_command',
      null, null,
      `${cmd.kind} handled by ${handlerNameForCommand(cmd.kind)} in ${durationMs}ms (command_id=${commandId})`,
    );
  } catch {
    // best-effort — never block the command on logging
  }
}

function auditFailure(
  db: Database,
  commandId: string,
  cmd: LifecycleCommand,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  // Same FK pattern as auditSuccess — need a stub receipt for the event FK.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO command_receipts
         (command_id, command_kind, actor_kind, actor_id, task_id,
          payload_hash, accepted, rejection_code, result_json, reply_json)
       VALUES (?, ?, 'managed_execution', ?, ?, ?, 0, 'HANDLER_ERROR', ?, ?)`,
    ).run(
      commandId,
      cmd.kind,
      actorOf(cmd),
      taskIdOf(cmd),
      hashOf(cmd),
      JSON.stringify({ error: message }),
      JSON.stringify({ command: cmd.kind, error: message }),
    );
  } catch {
    // best-effort
  }
  try {
    db.prepare(
      `INSERT OR IGNORE INTO lifecycle_events
         (command_id, seq, event_kind, task_id, payload_json)
       VALUES (?, 0, ?, ?, ?)`,
    ).run(
      commandId,
      `${cmd.kind}Failed`,
      taskIdOf(cmd),
      JSON.stringify({
        command: cmd.kind,
        handled_by: handlerNameForCommand(cmd.kind),
        error: message,
      }),
    );
  } catch {
    // best-effort
  }
  try {
    logActivity(
      db,
      'task',
      taskIdOf(cmd) ?? 0,
      'updated',
      'lifecycle_command_failed',
      null, null,
      `${cmd.kind} FAILED via ${handlerNameForCommand(cmd.kind)}: ${message} (command_id=${commandId})`,
    );
  } catch {
    // best-effort
  }
}

/**
 * Stable hash of a command's semantic identity (for the receipt payload_hash
 * column). Not security-sensitive — same scheme as idempotency.ts:shortHash.
 */
function hashOf(cmd: LifecycleCommand): string {
  const canonical = JSON.stringify({ ...cmd, kind: cmd.kind });
  let h = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    h = (h * 31 + canonical.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Reduce a reply to a short summary for the audit log. Full replies can be
 * large (e.g. worker_done returns active_tasks); we keep only the kind and
 * a few scalar fields for fast scanning.
 */
function summariseReply(reply: unknown): Record<string, unknown> {
  if (!reply || typeof reply !== 'object') return { value: reply };
  const r = reply as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Keep only scalar fields — drop arrays/nested objects to keep the audit
  // row small. activity_log carries the full event if needed.
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') out[k] = v;
  }
  return out;
}
