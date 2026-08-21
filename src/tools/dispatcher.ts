import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import {
  assertExecutionFence,
  assertExecutionNotVoided,
  updateExecutionPhase,
  isProcessAlive,
  ACTIVE_EXECUTION_STATES,
} from '../worker-executions.js';
import { reevaluateDownstream } from './tasks.js';
import type { Task, ToolHandler } from '../types.js';
import { releaseExecutionAtomically } from '../lifecycle/atomic-release.js';
import { reserveTaskExecution, releaseTaskExecution, parkTaskExecutionForHuman } from './conveyor-runtime-helper.js';
import { SqliteScopeWideningLedger } from '../infrastructure/workplace/sqlite-scope-widening-ledger.js';
import { getSubmissionPolicyRegistry, getSubmissionValidatorRegistry } from '../process-modules/application/submission-registries.js';
import { SubmissionValidationError } from '../process-modules/application/node-submission-policy.js';
import { readFrozenProductionIngressIfBound } from '../process-modules/application/production-ingress-contract.js';
import { freezeManagedCompletionProduct } from '../infrastructure/workplace/sqlite-managed-completion-product.js';
import {
  clearSubmissionValidationFeedback,
  DEFAULT_SUBMISSION_STASIS_THRESHOLD,
  persistSubmissionValidationRejection,
  readAcceptedRepairStasis,
  readSubmissionRejectionStasis,
} from '../lifecycle/submission-validation-rejections.js';
// CONVEYOR #7: the atomic assignment core lives in lifecycle/work-assignment-core.ts.
// This module imports it for internal use AND re-exports it (below) so existing
// consumers (tasks.ts, factory-* tools) keep their './dispatcher.js' imports.
import {
  withImmediateTransaction,
  skillForTask,
  findNextClaimable,
  type WorkerSkill,
} from '../lifecycle/work-assignment-core.js';
import {
  checkReceipt,
  storeReceipt,
  workerDoneCommandId,
  workerDonePayload,
  hashPayload,
} from '../lifecycle/idempotency.js';
import { journalEvent } from '../observability/run-journal.js';
import type { WorkerExecutionRoute } from '../application/routing/worker-execution-route.js';

/**
 * Optional route resolver injected by the factory host (composition root).
 * When set, the MCP `worker_next` claim path resolves the execution route at
 * claim and freezes it into the execution_context — same as the engine
 * dispatch path. The dispatcher falls back to the legacy model-route read when
 * this is unset (e.g. MCP-only sessions without a factory host).
 */
let injectedRouteResolver: ((key: {
  module: string | null;
  cell: string | null;
  role: 'author' | 'reviewer' | null;
  executionProfile: string | null;
}) => WorkerExecutionRoute) | null = null;

export function setWorkerRouteResolver(
  resolver: ((key: {
    module: string | null;
    cell: string | null;
    role: 'author' | 'reviewer' | null;
    executionProfile: string | null;
  }) => WorkerExecutionRoute) | null,
): void {
  injectedRouteResolver = resolver;
}

// ============================================================================
// Dispatcher: saga раздаёт задачи агентам.
//
// Две ручки поверх существующих 31 тулз saga (старые НЕ трогаем):
//   worker_next({worker_id})          — взять следующую свободную задачу
//   worker_done({task_id,worker_id,result}) — завершить текущую + получить следующую
//
// Принцип: assigned_to (нативное поле saga) = флаг занятости задачи.
// Очередь = status IN ('todo','review') AND assigned_to IS NULL.
// Ревью-цикл не заходит в in_progress: статус остаётся review, назначается
// только assigned_to. Так worker_done отличает циклы по ТЕКУЩЕМУ статусу задачи.
// ============================================================================

// CONVEYOR #7: the atomic assignment core lives in lifecycle/work-assignment-core.ts
// (infrastructure-side, away from the MCP/tool layer — see CONVEYOR-MENTAL-MODEL
// §"Adapter rules"). This module re-exports it so existing consumers
// (tasks.ts, factory-* tools, the adapter) keep importing from './dispatcher.js'
// without churn; the canonical home is the lifecycle module.
export {
  withImmediateTransaction,
  skillForTask,
  findNextClaimable,
  buildAssignedWorkFromClaim,
  readModelRouteAtClaim,
  readWorkIntentForTaskClaim,
  strictAuthorityScope,
  claimRowToIntent,
  WORKER_LEASE_TTL_MS,
  MAX_CLAIM_ATTEMPTS,
  PRIORITY_ORDER,
  type WorkIntentClaimRow,
} from '../lifecycle/work-assignment-core.js';

// ============================================================================
// Worktree-изоляция: каждый воркер работает в своём git worktree на ветке
// task/<id>. Имя ветки и путь детерминированы из ID задачи (конвенция), поэтому
// active_tasks вычисляет их на лету — отдельное хранилище не нужно. В metadata
// хранится ТОЛЬКО исход интеграции (written worker_merge_release): pending /
// dev / conflict. Так worker_health отличает «done но не слито» от «слито».
// ============================================================================

const WORKTREE_META_KEY = 'worktree';
export const INTEGRATION_BRANCH_DEFAULT = 'dev';
// Merge-lock считается протухшим и может быть отнят — страховка от zombie-воркера,
// который acquire'нул и умер не успев release. 10 минут = больше любого реального
// merge; меньше — риск отобрать живому воркеру.
const MERGE_LOCK_STALE_MIN = 10;
const MERGE_LOCK_RETRY_MS = 3000;

/** Ветвь и путь worktree задачи — по конвенции из ID. */
export function worktreeBranch(taskId: number): string {
  return `task/${taskId}`;
}
export function worktreePath(taskId: number): string {
  return `.worktrees/task-${taskId}`;
}

/** Распарсить metadata задачи в объект (защита от мусора/null). */
function readMetadata(db: Database.Database, taskId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId) as
    | { metadata?: string }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Записать патч в metadata.worktree (merge поверх существующих полей). */
function patchWorktreeMeta(
  db: Database.Database,
  taskId: number,
  patch: Record<string, unknown>,
): void {
  const meta = readMetadata(db, taskId);
  const wt = (meta[WORKTREE_META_KEY] as Record<string, unknown> | undefined) ?? {};
  meta[WORKTREE_META_KEY] = { ...wt, ...patch };
  db.prepare('UPDATE tasks SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(JSON.stringify(meta), taskId);
}

/**
 * Снапшот активной параллельной работы — read-only. Соседние воркеры видят, кто
 * над чем в каком worktree прямо сейчас. НЕ под write-локом: это обзор, minor
 * staleness приемлем; гонок не создаёт (чистый SELECT).
 */
function getActiveTasks(db: Database.Database, projectId: number): Array<{
  task_id: number;
  title: string;
  assigned_to: string;
  status: string;
  branch: string;
  epic_name: string;
}> {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.assigned_to, t.status, e.name AS epic_name
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id=? AND t.status IN ('in_progress','review_in_progress')
         AND t.assigned_to IS NOT NULL
       ORDER BY t.id`,
    )
    .all(projectId) as Array<{
      id: number;
      title: string;
      assigned_to: string;
      status: string;
      epic_name: string;
    }>;
  return rows.map((r) => ({
    task_id: r.id,
    title: r.title,
    assigned_to: r.assigned_to,
    status: r.status,
    branch: worktreeBranch(r.id),
    epic_name: r.epic_name,
  }));
}

/** Добавить тег задаче (merge в существующий JSON-массив тегов). */
function addTag(db: Database.Database, taskId: number, tag: string): void {
  const row = db.prepare('SELECT tags FROM tasks WHERE id=?').get(taskId) as
    | { tags: string }
    | undefined;
  const tags = parseTags(row?.tags);
  if (!tags.has(tag)) {
    tags.add(tag);
    db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify([...tags]), taskId);
  }
}



// ============================================================================
// findNextClaimable — общий helper для worker_next (раздача задач).
// Находит свободную задачу и атомарно занимает её за workerId.
// Внутри транзакции BEGIN IMMEDIATE (вызывается из claim() в handler'ах).
//
// Две ветви conditional-UPDATE по исходному статусу найденной задачи:
//   todo    → status='in_progress', assigned_to=workerId   (цикл разработки)
//   review  → только assigned_to=workerId, статус НЕ трогаем (цикл ревью)
//
// excludeTaskId — чтобы worker_done не отдал тому же агенту только что
// закрытую задачу на ревью (anti-self-review).
// ============================================================================
// D1.1 claim-time snapshot helpers. Both read inside the claim IMMEDIATE
// transaction so the snapshot is internally consistent with the atomic claim.
// ============================================================================

// D1.1 claim-time snapshot helpers (readModelRouteAtClaim, strictAuthorityScope,
// readWorkIntentForTaskClaim, claimRowToIntent, WorkIntentClaimRow) now live in
// lifecycle/work-assignment-core.ts and are re-exported above. Kept out of this
// MCP/tool module so the outbound SQLite adapter depends only on the lifecycle
// core, not on the tool layer (CONVEYOR-MENTAL-MODEL §"Adapter rules").

// ============================================================================
// findNextClaimable + buildAssignedWorkFromClaim now live in
// lifecycle/work-assignment-core.ts and are re-exported above. This module
// keeps only the MCP handlers (handleWorkerNext etc.); the atomic assignment
// transaction is infrastructure-side, not an MCP/tool concern.


// ============================================================================
// Handlers
// ============================================================================

function handleWorkerNext(args: Record<string, unknown>): {
  task: Task | null;
  skill: WorkerSkill | null;
  repository?: {
    id: number;
    repository_id: number;
    name: string;
    local_path: string | null;
    role: string;
    integration_branch: string;
    default_branch: string;
  } | null;
  active_tasks?: Array<{
    task_id: number;
    title: string;
    assigned_to: string;
    status: string;
    branch: string;
    epic_name: string;
  }>;
  reason?: string;
  execution_id?: string;
  /**
   * D1.1: the frozen execution-context snapshot (model route + authority)
   * captured at claim. The board runner consumes `model_route` to spawn the
   * worker (single source of truth, no re-read) and the saga MCP child receives
   * `SAGA_EXECUTION_ID` so the gateway can authorize calls against `authority`.
   * Absent for the empty-queue path.
   */
  execution_context?: unknown;
} {
  const db = getDb();
  const workerId = args.worker_id as string;
  const machineId = args.machine_id == null ? null : String(args.machine_id);

  // WAVE-3 server-side fence rejection (conveyor-wave-review
  // ПОВТОРНАЯ ПРОВЕРКА 2026-08-02). "One launch = one card": if this calling
  // execution ALREADY holds an active assignment, worker_next must be REJECTED
  // BEFORE the queue is read, regardless of which client or launcher issued the
  // call. The per-launcher --disallowedTools flag only constrains ONE launcher;
  // this check is the single server-side chokepoint covering MCP-direct, every
  // launcher, and tests.
  //
  // Detection: when execution_id is present AND either (a) an active
  // worker_executions row exists for it, or (b) some task row carries it as
  // current_execution_id, the execution already holds a card. We probe BOTH
  // signals because the assignment writes them atomically in one transaction
  // (findNextClaimable): a half-written state should still reject rather than
  // hand out a second card. The probe is a read-only SELECT — it runs BEFORE
  // findNextClaimable, so no claim SQL executes for a fenced execution.
  const fenceExecutionId = args.execution_id as string | undefined;
  if (typeof fenceExecutionId === 'string' && fenceExecutionId !== '') {
    // Operator SOFT-STOP tool fence: a voided execution was recalled by the
    // operator and its hire rewound. It must not claim NEW work either —
    // refuse with the typed error before the queue is read.
    assertExecutionNotVoided(db, fenceExecutionId);
    const placeholders = ACTIVE_EXECUTION_STATES.map(() => '?').join(',');
    const holdsActiveExecution = db.prepare(
      `SELECT 1 FROM worker_executions
        WHERE execution_id=? AND state IN (${placeholders})
        LIMIT 1`,
    ).get(fenceExecutionId, ...ACTIVE_EXECUTION_STATES);
    const holdsFencedTask = holdsActiveExecution
      ? undefined
      : db.prepare(
          'SELECT 1 FROM tasks WHERE current_execution_id=? LIMIT 1',
        ).get(fenceExecutionId);
    if (holdsActiveExecution || holdsFencedTask) {
      throw new Error(
        `AUTHORITY_DENIED: execution '${fenceExecutionId}' already holds an active card; ` +
        `one launch = one card. worker_next is forbidden for an execution that already has ` +
        `an assignment — finish the current card via worker_done/worker_ask_need and let the ` +
        `controller launch a fresh execution for the next card. This rejection is enforced ` +
        `server-side before the queue is read, independent of any client --disallowedTools flag.`,
      );
    }
  }

  // project_id REQUIRED — иначе в общей БД агенту подсовывается чужая задача.
  // Бросаем actionable-ошибку (НЕ через required inputSchema): так агент
  // получает полное решение, что делать, а не generic "validation failed".
  const projectId = args.project_id as number | undefined;
  if (projectId == null) {
    throw new Error(
      [
        'project_id is missing — cannot dispatch work without knowing the project.',
        'HOW TO GET project_id (do this ONCE, then retry worker_next):',
        '1. Read the runner-supplied project binding or .saga/project.json.',
        '2. If neither exists, stop and use the canonical saga-start gateway.',
        'Then retry: worker_next({ worker_id, project_id }).',
      ].join('\n'),
    );
  }
  const exists = db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId);
  if (!exists) {
    throw new Error(`project_id ${projectId} not found. Run project_list to see valid IDs, or use saga-start to create a new product order.`);
  }
  // saga4 cutover (Phase 4): worker_next is a PURE claim — it must not advance
  // lifecycle stages. The previous advanceReadyEpisodes(projectId) call let a
  // worker tool mutate episode_workflows.stage as a side-effect of claiming
  // work. Stage advancement is now a module-owned settlement decision routed
  // through the lifecycle orchestrator, never a worker side-effect.

  // role (опционально): фильтрует очередь по тегу `role:<name>` на задаче.
  // Применение: проект требований, где задачи тегированы role:product / role:analyst
  // / role:architect — каждый агент получает только свои задачи. Без role — любое.
  const role = args.role as string | undefined;
  const epicId = args.epic_id as number | undefined;
  // Claim scope (Saga 3 engine): optional explicit task-id allowlist forwarded
  // from the board runner's run.claimTaskIds. When present, only these task ids
  // are eligible, regardless of priority — the engine dispatches exactly its
  const rawTaskIds = args.task_ids;
  const taskIds = Array.isArray(rawTaskIds)
    ? rawTaskIds.filter((id): id is number => Number.isInteger(id))
    : undefined;
  if (epicId !== undefined) {
    const epic = db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId) as
      | { project_id: number }
      | undefined;
    if (!epic || epic.project_id !== projectId) {
      throw new Error(`epic_id ${epicId} does not belong to project ${projectId}`);
    }
  }
  const executionId = args.execution_id as string | undefined;
  const runId = args.run_id as string | undefined;
  if (executionId && !machineId) {
    throw new Error('machine_id is required when execution_id is provided');
  }
  const reservation = executionId
    ? {
        executionId,
        runId: runId ?? executionId,
        machineId: machineId ?? 'unknown',
      }
    : undefined;

  // BEGIN IMMEDIATE — write-lock всей БД с старта транзакции
  // (аналог SELECT FOR UPDATE, которого нет в SQLite). busy_timeout=5000 в db.ts.
  // db.transaction(fn) тут только DEFERRED, поэтому оборачиваем явно.
  const task = withImmediateTransaction(db, () => {
    const claimed = findNextClaimable(
      db, workerId, projectId, undefined, 0, role, epicId, reservation, taskIds,
      injectedRouteResolver ?? undefined,
    );
    if (claimed) {
      reserveTaskExecution(db, {
        taskId: claimed.id,
        epicId: claimed.epic_id,
        projectId,
        taskKind: claimed.task_kind,
        metadata: claimed.metadata,
        executionId: executionId ?? workerId,
        preClaimStatus: claimed.status === 'in_progress' ? 'todo' : 'review',
      });
    }
    return claimed;
  });

  // active_tasks — read-only снапшот параллельной работы. Берём ПОСЛЕ транзакции,
  // чтобы не держать write-lock дольше необходимого: видимость — best-effort,
  // minor staleness приемлем.
  const active_tasks = getActiveTasks(db, projectId);

  if (!task) return { task: null, skill: null, repository: null, active_tasks, reason: 'очередь пуста' };

  // The Factory workplace is the unconditional claim authority.
  // Conveyor v4: ConveyorRuntime is the authority — bind the task to its
  // workplace, lease the loop channel, reverse-project tasks.status.
  const repository = task.project_repository_id == null ? null : db.prepare(`
    SELECT pr.id, pr.repository_id, r.name,
           COALESCE(rc.local_path,pr.local_path) AS local_path, pr.role,
           pr.integration_branch, r.default_branch
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
      LEFT JOIN repository_checkouts rc
        ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
     WHERE pr.id=? AND pr.project_id=?
  `).get(machineId, task.project_repository_id, projectId) as {
    id: number; repository_id: number; name: string; local_path: string | null;
    role: string; integration_branch: string; default_branch: string;
  } | undefined;
  if (task.project_repository_id != null && !repository) {
    throw new Error(`Task ${task.id} targets missing or foreign project_repository_id=${task.project_repository_id}`);
  }
  // D1.1: read the frozen execution_context back from the row the claim just
  // wrote, and surface it to the runner so spawn + provenance read the SAME
  // frozen model route (no re-read). Absent when no reservation was supplied.
  let executionContext: unknown = undefined;
  if (executionId) {
    const execRow = db.prepare(
      'SELECT metadata FROM worker_executions WHERE execution_id=?',
    ).get(executionId) as { metadata: string } | undefined;
    if (execRow?.metadata) {
      try {
        const parsed = JSON.parse(execRow.metadata) as { execution_context?: unknown };
        executionContext = parsed.execution_context;
      } catch {
        executionContext = undefined;
      }
    }
  }
  return {
    task,
    skill: skillForTask(task, task.status),
    repository: repository ?? null,
    active_tasks,
    execution_id: executionId,
    execution_context: executionContext,
  };
}

function parseTaskMetadataRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

type WorkerDoneReply = {
  completed: number;
  completed_new_status: 'review' | 'done' | 'todo' | 'blocked';
  active_tasks?: Array<{
    task_id: number;
    title: string;
    assigned_to: string;
    status: string;
    branch: string;
    epic_name: string;
  }>;
  // Сигнал воркеру: задача закрыта, цикл окончен — завершайся. worker_done больше
  // не раздаёт следующую задачу (см. протокол 09-...), а чтобы воркер не гадал,
  // что делать дальше — saga явно говорит ему остановиться.
  stop: true;
  stop_reason: string;
  workflow_generation?: unknown;
  workflow_generation_error?: string;
};

type WorkerDoneTransactionResult =
  | { readonly kind: 'completed'; readonly reply: WorkerDoneReply }
  | { readonly kind: 'submission-rejected'; readonly error: SubmissionValidationError }
  | { readonly kind: 'submission-stasis-blocked'; readonly error: SubmissionValidationError }
  | { readonly kind: 'repair-stasis-blocked'; readonly error: SubmissionValidationError };

interface KernelPresentationCloseAuthority {
  readonly commitmentRef: string;
  readonly productRef: string;
  readonly productDigest: string;
}

function handleWorkerDone(
  args: Record<string, unknown>,
  kernelClose?: KernelPresentationCloseAuthority,
): WorkerDoneReply {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const result = args.result as string;
  // Defensive: canonicalJson crashes on undefined. Catch missing fields early
  // with an actionable error instead of an opaque serialization crash.
  if (!Number.isInteger(taskId)) {
    throw new Error(`worker_done: 'task_id' must be an integer. Call shape: worker_done({ task_id: <integer>, worker_id: "<string>", result: "<string>", execution_id: "<string>" }). Got: ${JSON.stringify(args.task_id)}`);
  }
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new Error(`worker_done: 'worker_id' must be a non-empty string (your worker_id from the system prompt). Call shape: worker_done({ task_id: <integer>, worker_id: "<string>", result: "<string>", execution_id: "<string>" }). Got: ${JSON.stringify(args.worker_id)}`);
  }
  if (typeof result !== 'string' || result.trim() === '') {
    throw new Error(`worker_done: 'result' must be a non-empty string describing what you did. Call shape: worker_done({ task_id: <integer>, worker_id: "<string>", result: "<string>", execution_id: "<string>" }). Got: ${JSON.stringify(args.result)}`);
  }
  // verdict — только для задач в review. По умолчанию 'approved' (обратная
  // совместимость: старые вызовы без verdict ведут себя как раньше — review→done).
  // 'changes_requested' возвращает задачу в in_progress: ветка task/<id> и её
  // worktree НЕ трогаются (переживают re-work loop), assigned_to возвращается
  // этому же воркеру.
  const verdict = (args.verdict as 'approved' | 'changes_requested' | undefined) ?? 'approved';
  if (verdict !== 'approved' && verdict !== 'changes_requested') {
    throw new Error(`verdict must be 'approved' or 'changes_requested', got '${verdict}'`);
  }
  // STAGE-13 — the typed scope-insufficiency conclusion. The attempt stops
  // honestly and names what it needs; it does not grant itself anything.
  const scopeOutcome = args.outcome === 'scope-insufficient' ? 'scope-insufficient' : null;
  if (args.outcome !== undefined && !scopeOutcome) {
    throw new Error(
      `worker_done: 'outcome' must be 'scope-insufficient' when present (got ${JSON.stringify(args.outcome)}). `
      + `The typed conclusion shape: worker_done({ task_id, worker_id, execution_id, result, `
      + `outcome: 'scope-insufficient', requested_scopes: ['<path-or-dir>', ...] }).`,
    );
  }
  if (scopeOutcome) {
    if (verdict !== 'approved') {
      throw new Error("worker_done: outcome 'scope-insufficient' cannot carry a review verdict");
    }
    if (!Array.isArray(args.requested_scopes) || args.requested_scopes.length === 0
      || args.requested_scopes.some(s => typeof s !== 'string' || !s.trim())) {
      throw new Error(
        "worker_done: outcome 'scope-insufficient' requires requested_scopes: a non-empty "
          + 'array of repository paths/directories the work honestly needs and the frozen '
          + 'changeScopes do not contain.',
      );
    }
  }

  const completeTask = (): WorkerDoneTransactionResult => {
    // Operator SOFT-STOP tool fence (schema v13): FIRST check, before the
    // receipt replay short-circuits. A voided execution's accepted receipts
    // are audit history (its hire was rewound); a retry must surface the typed
    // refusal, not the stored reply. Runs inside this BEGIN IMMEDIATE so the
    // refusal and any write commit atomically.
    assertExecutionNotVoided(db, args.execution_id);
    // A typed product_submit may already have committed and closed this exact
    // presentation through ADR-072. An LM that follows the legacy hint and
    // calls worker_done afterwards receives the durable close reply; it does
    // not create a second completion authority.
    if (!kernelClose && typeof args.execution_id === 'string') {
      const closed = db.prepare(
        `SELECT reply_json FROM command_receipts
          WHERE execution_id=? AND command_kind='presentation_close'
            AND accepted=1 LIMIT 1`,
      ).get(args.execution_id) as { reply_json: string } | undefined;
      if (closed) {
        return { kind: 'completed', reply: JSON.parse(closed.reply_json) as WorkerDoneReply };
      }
    }
    // Slice 4 (blueprint §10, §16:894-898): idempotency FIRST. A retry of a
    // previously-accepted worker_done (same command_id + payload) must return
    // the stored reply WITHOUT touching the task row. We check this BEFORE
    // the owner-check, because a previous successful call already released
    // the assignment — the owner-check would otherwise reject the retry as
    // "not assigned to you", masking the replay.
    //
    // unfenced tasks, from task+worker+verdict+result-identity). We use the
    // CALLER-SUPPLIED execution_id, not task.current_execution_id (which may
    // already be null after the first call cleared the fence).
    const commandId = kernelClose
      ? `${String(args.execution_id)}:presentation-close:${kernelClose.commitmentRef}`
      : workerDoneCommandId(args.execution_id as string | undefined, scopeOutcome ?? verdict, taskId, workerId, result);
    const payload = kernelClose
      ? {
          task_id: taskId,
          execution_id: args.execution_id,
          commitment_ref: kernelClose.commitmentRef,
          product_ref: kernelClose.productRef,
          product_digest: kernelClose.productDigest,
        }
      : scopeOutcome
        ? {
            ...workerDonePayload(taskId, workerId, result, scopeOutcome),
            requested_scopes: (args.requested_scopes as string[]).slice(),
          }
        : workerDonePayload(taskId, workerId, result, verdict);
    const payloadHash = hashPayload(payload);
    const prior = checkReceipt(db, commandId, payloadHash);
    if (prior.kind === 'replay') {
      return {
        kind: 'completed',
        reply: JSON.parse(prior.receipt.reply_json) as WorkerDoneReply,
      };
    }
    if (prior.kind === 'idempotency_key_reused') {
      throw new Error(
        `IDEMPOTENCY_KEY_REUSED: command_id ${commandId} was already used with a different ` +
        `payload. The same execution+verdict pair cannot be reused for a different result. ` +
        `Stored hash ${prior.receipt.payload_hash} ≠ this hash ${payloadHash}.`,
      );
    }

    // Чья задача закрывается — зависит от фазы:
    //  - in_progress: замок владельца. Только assigned_to = worker_id может закрыть
    //    активную разработку (защита от кражи часов чужого кодинга).
    //  - review_in_progress: вердикт от ЛЮБОГО воркера. assigned_to в
    //    review_in_progress — это запись «ревьюер взял», не замок от чужого
    //    вердикта. Любой воркер, доставивший APPROVED/CHANGES REQUESTED в result,
    //    продвигает задачу. APPROVED → done, CHANGES REQUESTED → обратно в
    //    in_progress (та же ветка/worktree живут дальше).
    //  - review (без assigned_to, буфер): НЕТ — сначала claim через worker_next.
    const task = db
      .prepare('SELECT * FROM tasks WHERE id=? AND assigned_to=?')
      .get(taskId, workerId) as Task | undefined;
    if (!task) {
      throw new Error(`Task ${taskId} not assigned to ${workerId}`);
    }
    assertExecutionFence(
      db,
      task as Task & { current_execution_id?: string | null },
      args.execution_id,
    );

    // STAGE-13 — the typed scope-insufficient conclusion of an AUTHOR
    // attempt. This is a SUCCESSFUL conclusion, not a failed check and not a
    // recovery trigger: no typed product is required or sealed. The request
    // is recorded append-only and routed to the carve authority (the kernel
    // decides it on contention before any budget arithmetic on its next
    // drive). The worker is released honestly.
    if (scopeOutcome) {
      if (task.status !== 'in_progress') {
        throw new Error(
          `worker_done: outcome 'scope-insufficient' concludes an ACTIVE author attempt `
            + `(task status 'in_progress', got '${task.status}')`,
        );
      }
      if (!task.workplace_ref) {
        throw new Error(
          "worker_done: outcome 'scope-insufficient' requires a conveyor workplace card "
            + '(task.workplace_ref missing — plain tracker tasks cannot widen scopes)',
        );
      }
      const ledger = new SqliteScopeWideningLedger(db);
      const wideningRequestId = ledger.recordRequest({
        workplaceRef: task.workplace_ref,
        taskId,
        role: 'author',
        source: 'worker-declared',
        requestedScopes: args.requested_scopes as string[],
        requestedByExecution: (args.execution_id as string) ?? task.current_execution_id ?? null,
      });
      // STAGE-15 TASK 1 — every widening declaration is journalled with its
      // correlation keys so a run with zero widenings is distinguishable
      // from a run that never reached the fence. Observation only.
      journalEvent('scope_widening.declared', {
        epic_id: task.epic_id,
        workplace_ref: task.workplace_ref,
        execution_id: (args.execution_id as string) ?? task.current_execution_id ?? undefined,
      }, {
        request_id: wideningRequestId,
        task_id: taskId,
        role: 'author',
        source: 'worker-declared',
        requested_scopes: [...(args.requested_scopes as string[])],
      });
      // Release the card back to the claimable queue; the workplace itself
      // moves running → repair_wait via the 'declared' release outcome and
      // the kernel's widening decision re-staffs (grant) or terminates
      // (refusal) it on the next drive.
      db.prepare(
        `UPDATE tasks
            SET status='todo', assigned_to=NULL, current_execution_id=NULL,
                updated_at=datetime('now')
          WHERE id=? AND assigned_to=?`,
      ).run(taskId, workerId);
      const projectIdRow = db
        .prepare('SELECT project_id FROM epics WHERE id=?')
        .get(task.epic_id) as { project_id?: number } | undefined;
      releaseTaskExecution(db, {
        taskId,
        epicId: task.epic_id,
        projectId: projectIdRow?.project_id ?? 0,
        taskKind: task.task_kind,
        metadata: task.metadata,
        executionId: (args.execution_id as string) ?? task.current_execution_id ?? workerId,
        outcome: 'declared',
        taskStatus: 'todo',
        executionMode: task.execution_mode,
        integrationState: task.integration_state,
      });
      db.prepare(
        'INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)',
      ).run(taskId, workerId, result);
      logActivity(
        db,
        'task',
        taskId,
        'status_changed',
        'status',
        task.status,
        'todo',
        `Task '${task.title}' concluded scope-insufficient by ${workerId}: `
          + `requested [${(args.requested_scopes as string[]).join(', ')}] — widening request recorded, carve authority will decide`,
      );
      const reply: WorkerDoneReply = {
        completed: taskId,
        completed_new_status: 'todo',
        active_tasks: [],
        stop: true,
        stop_reason:
          'scope-insufficiency declaration accepted — the carve authority decides the widening; stop now and return your summary',
      };
      storeReceipt(db, {
        commandId,
        commandKind: 'worker_done',
        actorKind: 'managed_execution',
        actorId: workerId,
        executionId: task.current_execution_id,
        taskId,
        payload,
        reply,
      });
      return { kind: 'completed', reply };
    }

    // A Production Cell completion is never authoritative prose. The exact
    // fenced execution must first persist at least one typed managed product;
    // otherwise running -> verifying creates a state that cannot seal a
    // CandidateSet and the conveyor has no lawful next transition. Keep the
    // worker and its fence alive so it can repair the product_submit call.
    requireProductionCellSubmission(
      db,
      taskId,
      task.current_execution_id,
      args.execution_id as string | undefined,
    );

    // Submission validation gate (shift-left). For author completion only
    // (in_progress → review/done), NOT for reviewer verdicts. Resolves the
    // authoritative execution binding, looks up the node's declared submission
    // policy, and — if `required` — runs the module-owned validator BEFORE the
    // task transitions. Rejection leaves the worker as execution owner and
    // throws SubmissionValidationError with structured gaps so the LM sees
    // exactly what to fix without burning a recovery epoch.
    if (task.status === 'in_progress') {
      const validationError = validateSubmissionIfRequired(
        db,
        task,
        workerId,
        args.execution_id as string | undefined,
      );
      if (validationError) {
        // BLINDSIGHT F5 — the rejection row was persisted in THIS transaction;
        // now read the durable CHAIN at the decision point. N consecutive
        // rejections with the byte-identical observed set (across repair
        // rounds) prove zero repair work — the loop ends with a typed
        // fail-closed block instead of waiting for a mechanical budget this
        // path does not have. A CHANGED observed set (real repair) never
        // reaches this branch: the retrospective counter resets on new bytes.
        const stasis = readSubmissionRejectionStasis(db, taskId);
        if (
          stasis
          && stasis.consecutiveIdenticalBytes >= DEFAULT_SUBMISSION_STASIS_THRESHOLD
        ) {
          const N = stasis.consecutiveIdenticalBytes;
          // Conveyor-bound task: the park is the conveyor's own PROC-13 use
          // case (atomic workplace park + reservation release + append-only
          // typed park reason + reverse projection of tasks.status).
          // Non-conveyor task: the direct typed block below stands alone.
          const parkedWithConveyor = parkTaskExecutionForHuman(db, {
            taskId,
            taskKind: task.task_kind,
            metadata: task.metadata,
            reason: {
              code: 'SUBMISSION_STASIS_IDENTICAL_BYTES',
              message: `Submission preflight ${stasis.rejectionCode} rejected ${N} `
                + 'consecutive byte-identical submissions — no repair work happened '
                + 'between attempts. Task blocked for operator review; every '
                + 'rejection remains durable as evidence.',
              evidenceRefs: [
                `submission-stasis:task-${taskId}`,
                `observed-set:${stasis.observedSetDigest}`,
              ],
            },
          });
          db.prepare(
            `UPDATE tasks
                SET status=COALESCE(?, status), assigned_to=NULL,
                    metadata=json_set(
                      CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                      '$.managed_submission_stasis', json(?)
                    ),
                    updated_at=datetime('now')
              WHERE id=? AND assigned_to=?`,
          ).run(
            parkedWithConveyor ? null : 'blocked',
            JSON.stringify({
              rejectionCode: stasis.rejectionCode,
              observedSetDigest: stasis.observedSetDigest,
              consecutiveRejections: N,
              blockedAt: new Date().toISOString(),
            }),
            taskId,
            workerId,
          );
          logActivity(
            db,
            'task',
            taskId,
            'status_changed',
            'status',
            'in_progress',
            parkedWithConveyor ? 'blocked' : 'blocked',
            `Task '${task.title}' submission stasis: ${stasis.rejectionCode} rejected `
              + `${N} consecutive byte-identical submissions — blocked for operator review`,
          );
          return {
            kind: 'submission-stasis-blocked',
            error: new SubmissionValidationError(
              'SUBMISSION_STASIS_IDENTICAL_BYTES',
              [{
                artifactId: -1,
                artifactCode: null,
                artifactType: 'SUBMISSION_STASIS',
                existingTargets: [],
                missing: {
                  relation: 'submission_progress',
                  requiredTargetTypes: ['artifact_update'],
                  minimum: 1,
                },
                message: `${N} consecutive rejections observed byte-identical observed `
                  + `material (rejection ${stasis.rejectionCode}) — no repair work happened `
                  + `between attempts. The task is blocked; operator review is required. `
                  + `Every rejection remains durable as evidence.`,
              }],
              {
                submissionStasis: {
                  consecutiveRejections: N,
                  rejectionCode: stasis.rejectionCode,
                  observedSetDigest: stasis.observedSetDigest,
                },
              },
            ),
          };
        }
        // The rejection row + feedback pointer have been written in this SAME
        // transaction. Return a sentinel so BEGIN IMMEDIATE commits; only then
        // does the outer handler throw the actionable MCP error.
        return { kind: 'submission-rejected', error: validationError };
      }

      // BLINDSIGHT F5 sibling — identical ACCEPTED material in a repair
      // round. The rejection stasis above proves non-progress for identical
      // REJECTED bytes; the mirror case escaped: the final gate returned
      // repair_required (review changes_requested) and the author's next
      // round seals byte-identical material. Content addressing then sees
      // "the same thing again" and the review round never re-materializes —
      // the workplace stalls in review/queued with no owner until an
      // external failure (2026-08-21 conformance finding,
      // reviewer-feedback-absent: ANONYMOUS-STALL, process failed at 13
      // cycles underneath a queued workplace). Identical bytes across a
      // repair_required verdict prove zero repair work: park typed instead
      // of re-entering a review that cannot re-arm.
      const repairStasis = task.workplace_ref
        ? readAcceptedRepairStasis(db, taskId, task.workplace_ref)
        : null;
      if (repairStasis) {
        const parkedWithConveyor = parkTaskExecutionForHuman(db, {
          taskId,
          taskKind: task.task_kind,
          metadata: task.metadata,
          reason: {
            code: 'REPAIR_ROUND_IDENTICAL_MATERIAL',
            message: 'Repair round sealed byte-identical accepted material '
              + `(observed set ${repairStasis.observedSetDigest.slice(0, 12)}…) after a `
              + 'repair_required review verdict — no repair work happened between '
              + 'rounds. Task blocked for operator review; both validated receipts '
              + 'remain durable as evidence.',
            evidenceRefs: [
              `repair-stasis:task-${taskId}`,
              `observed-set:${repairStasis.observedSetDigest}`,
            ],
          },
        });
        db.prepare(
          `UPDATE tasks
              SET status=COALESCE(?, status), assigned_to=NULL,
                  metadata=json_set(
                    CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                    '$.managed_repair_stasis', json(?)
                  ),
                  updated_at=datetime('now')
            WHERE id=?`,
        ).run(
          parkedWithConveyor ? null : 'blocked',
          JSON.stringify({
            observedSetDigest: repairStasis.observedSetDigest,
            blockedAt: new Date().toISOString(),
          }),
          taskId,
        );
        logActivity(
          db,
          'task',
          taskId,
          'status_changed',
          'status',
          'in_progress',
          'blocked',
          `Task '${task.title}' repair-round stasis: byte-identical accepted `
            + 'material after repair_required — blocked for operator review',
        );
        return {
          kind: 'repair-stasis-blocked',
          error: new SubmissionValidationError(
            'REPAIR_ROUND_IDENTICAL_MATERIAL',
            [{
              artifactId: -1,
              artifactCode: null,
              artifactType: 'REPAIR_STASIS',
              existingTargets: [],
              missing: {
                relation: 'repair_progress',
                requiredTargetTypes: ['artifact_update'],
                minimum: 1,
              },
              message: 'The repair round sealed byte-identical accepted material '
                + 'after a repair_required review verdict — no repair work happened. '
                + 'The task is blocked; operator review is required. Both validated '
                + 'receipts remain durable as evidence.',
            }],
            {
              repairStasis: {
                observedSetDigest: repairStasis.observedSetDigest,
              },
            },
          ),
        };
      }
    }

    // Accepted worker_done is the material close boundary. Managed Workplace
    // material becomes an immutable exact ProductRef inside this transaction,
    // before the task transition and command receipt. Typed ingress is already
    // frozen by product_submit and is a no-op here.
    freezeManagedCompletionProduct(db, {
      executionId: (args.execution_id as string) ?? task.current_execution_id ?? workerId,
      workerDoneCommandId: commandId,
    });

    // 2. Следующий статус по ТЕКУЩЕМУ статусу (он сам = флаг цикла) + verdict.
    //    T-013: для verification.ac — review-loop escape. Если verifier уже
    //    записал ≥2 failed evidence records, changes_requested НЕ возвращают
    //    задачу в todo (это создаёт бесконечный цикл — verifier не может
    //    фиксить product bugs). Вместо этого задача закрывается как done с
    //    пометкой verification_outcome=failed в metadata.
    let newStatus: 'review' | 'done' | 'todo' | 'blocked';
    let newAssignedTo: string | null; // кому уходит задача после перевода
    if (task.status === 'in_progress') {
      // UNIVERSAL CONVEYOR (CONVEYOR-MENTAL-MODEL §"One queue"):
      // Runtime core does NOT switch on module names (line 254 of the model
      // doc). Instead, the task's DECLARED review_skill determines the path:
      //   - review_skill IS NULL → no reviewer needed → done immediately
      //     (tracker_only tasks: discovery.work, discovery.assess, etc.)
      //   - review_skill IS SET → needs review → goes to 'review' buffer.
      //     The LM-executor detects 'review' and pauses the run; orchestrate-cli
      //     drains the review queue through dispatch-loop; the reviewer worker
      //     approves; the run resumes and re-reads the settled task.
      // This replaces the old isDiscoveryOnly hardcode (task_kind.startsWith).
      const hasReviewSkill = !!task.review_skill;
      if (!hasReviewSkill) {
        newStatus = 'done';            // no reviewer declared: close immediately
        newAssignedTo = null;
      } else {
        newStatus = 'review';          // review declared: buffer for reviewer
        newAssignedTo = null;
      }
    } else if (task.status === 'review_in_progress') {
      if (verdict === 'changes_requested') {
        // T-013: verification review-loop escape.
        // Если это verification.ac и уже есть ≥ VERIFICATION_MAX_RETRIES (2)
        // evidence records с outcome='failed' — не возвращаем в todo.
        // Verifier нашёл реальные product bugs — он сделал свою работу.
        // Закрываем как done (metadata verification_outcome=failed).
        if (task.task_kind === 'verification.ac') {
          const failedCount = db.prepare(
            `SELECT COUNT(*) AS n FROM verification_evidence
             WHERE task_id=? AND outcome='failed'`,
          ).get(taskId) as { n: number } | undefined;
          const VERIFICATION_MAX_RETRIES = 2;
          if ((failedCount?.n ?? 0) >= VERIFICATION_MAX_RETRIES) {
            // Loop detected — close as done (verifier did its job: found bugs).
            newStatus = 'done';
            newAssignedTo = null;
            // Tag for follow-up: product bugs need dev fixes, not verifier retries.
            db.prepare(
              `UPDATE tasks SET metadata=json_set(COALESCE(metadata,'{}'),
                '$.verification_outcome', 'failed',
                '$.verification_loop_escaped', datetime('now'),
                '$.verification_failed_count', ?)
                WHERE id=?`,
            ).run(failedCount?.n ?? 0, taskId);
          } else {
            newStatus = 'todo';        // first/second failure — retry allowed
            newAssignedTo = null;
          }
        } else {
          const metadata = parseTaskMetadataRecord(task.metadata);
          const reviewBudget = positiveIntegerOrNull(
            metadata.managed_review_budget,
          );
          const historical = db.prepare(
            `SELECT COUNT(*) AS count
               FROM command_receipts
              WHERE task_id=?
                AND command_kind='worker_done'
                AND accepted=1
                AND command_id LIKE '%:worker-done:changes_requested'`,
          ).get(taskId) as { count: number };
          const rejectionCount =
            Math.max(
              nonNegativeInteger(metadata.managed_review_rejections),
              historical.count,
            ) + 1;
          const exhausted =
            reviewBudget !== null && rejectionCount >= reviewBudget;
          newStatus = exhausted ? 'blocked' : 'todo';
          newAssignedTo = null;
          db.prepare(
            `UPDATE tasks
                SET metadata=json_set(
                  CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                  '$.managed_review_rejections', ?,
                  '$.managed_review_last_feedback', ?,
                  '$.managed_review_last_execution_id', ?,
                  '$.managed_review_exhausted', ?
                )
              WHERE id=?`,
          ).run(
            rejectionCount,
            result,
            args.execution_id ?? null,
            exhausted ? 1 : 0,
            taskId,
          );
        }
      } else {
        // Ревью пройдено (APPROVED) — done. Kernel gate внутри lifecycle
        // (runEpisode → resolve-node) примет артефакты. Не нужен промежуточный
        // awaiting_verification — конвейерная модель: author → review → done.
        // Kernel gate работает внутри lifecycle, не блокирует tasks.status.
        newStatus = 'done';
        newAssignedTo = null;
      }
    } else {
      throw new Error(
        `Task ${taskId} status '${task.status}' — nothing to complete. ` +
        `If it's in 'review', claim it via worker_next first (it will move to 'review_in_progress').`,
      );
    }

    // 3. Перевод статуса + assigned_to — атомарно, одной командой.
    //    - in_progress→review:           замок владельца (assigned_to=?),    assigned→NULL.
    //    - review_in_progress→done:      любой воркер (status='review_in_progress'), assigned→NULL.
    //    - review_in_progress→in_progress: любой воркер (status='review_in_progress'), assigned→workerId.
    //    Гонок нет: BEGIN IMMEDIATE + info.changes===1.
    //
    //    T-013: verification.ac может закрываться как done в двух случаях:
    //      (a) есть passed evidence (APPROVED — нормальный путь)
    //      (b) loop_escaped (≥2 failed evidence — verifier нашёл product bugs,
    //          retrying бессмысленно, pipeline должен идти дальше с degraded verification)
    const workplaceManagedVerification = task.workplace_ref !== null
      && db.prepare(
        `SELECT 1 FROM factory_workplaces
          WHERE workplace_ref=? AND production_cell_id IS NOT NULL`,
      ).get(task.workplace_ref) !== undefined;
    if (
      newStatus === 'done'
      && task.task_kind === 'verification.ac'
      && !workplaceManagedVerification
    ) {
      const target = db.prepare(
        `SELECT a.id, a.accepted_hash
         FROM tasks t JOIN artifacts a ON a.id=t.verification_target_artifact_id
         WHERE t.id=? AND a.type='AC' AND a.status='accepted'`,
      ).get(taskId) as { id: number; accepted_hash: string | null } | undefined;
      const passed = target && db.prepare(
        `SELECT 1 FROM verification_evidence
         WHERE task_id=? AND artifact_id=? AND outcome='passed' AND content_hash=?`,
      ).get(taskId, target.id, target.accepted_hash);
      // T-013: check if this is a loop-escape close (metadata.verification_loop_escaped)
      const loopEscaped = db.prepare(
        `SELECT json_extract(metadata, '$.verification_loop_escaped') AS escaped
         FROM tasks WHERE id=?`,
      ).get(taskId) as { escaped: string | null } | undefined;
      if (!target || (!passed && !loopEscaped?.escaped)) {
        throw new Error(
          `Verification task ${taskId} cannot be approved without passing evidence for its canonical AC`,
        );
      }
    }

    const completeInfo = db
      .prepare(
        `UPDATE tasks SET status=?, assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND assigned_to=? AND
               (current_execution_id IS NULL OR current_execution_id=?)`,
      )
      .run(newStatus, newAssignedTo, taskId, workerId, args.execution_id ?? null);

    // Если ни одна строка не обновлена — assigned_to изменился между SELECT и
    // UPDATE. Не продолжать: иначе вставим comment для чужой задачи и вернём
    // completed_new_status, хотя статус не сдвинулся (wrong result).
    if (completeInfo.changes !== 1) {
      throw new Error(
        `Task ${taskId} assignment changed before completion (expected owner ${workerId})`,
      );
    }

    // Conveyor v4: ConveyorRuntime releases the execution (loop advances).
    releaseTaskExecution(db, {
      taskId,
      epicId: task.epic_id,
      projectId: (db.prepare('SELECT e.project_id AS project_id FROM epics e WHERE e.id=?').get(task.epic_id) as { project_id?: number } | undefined)?.project_id ?? 0,
      taskKind: task.task_kind,
      metadata: task.metadata,
      executionId: (args.execution_id as string) ?? task.current_execution_id ?? workerId,
      outcome: 'completed',
      taskStatus: newStatus,
      executionMode: task.execution_mode,
      integrationState: task.integration_state,
    });

    if (newStatus === 'done') {
      let taskTags: string[] = [];
      try { taskTags = JSON.parse(task.tags || '[]') as string[]; } catch { taskTags = []; }
      if (taskTags.includes('needs-human')) {
        db.prepare('UPDATE tasks SET tags=? WHERE id=?')
          .run(JSON.stringify(taskTags.filter(tag => tag !== 'needs-human')), taskId);
      }
    }
    updateExecutionPhase(
      db,
      taskId,
      workerId,
      args.execution_id,
      // awaiting_verification ждёт проверки ядром — ещё не 'integrating'
      newStatus === 'done'
        && task.task_kind
        && task.execution_mode === 'git_change'
        && task.integration_state === 'pending'
        ? 'integrating'
        : 'finishing',
    );

    // 4. Comment с результатом воркера (author = worker_id).
    //    created_at авто из DEFAULT в schema (как в comments.ts:47).
    db.prepare(
      'INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)',
    ).run(taskId, workerId, result);

    // 5. Разблокировка downstream ТОЛЬКО при done (нативная механика saga).
    if (newStatus === 'done') {
      // Worktree-интеграция: APPROVED → задача done, НО код ещё не слит в dev.
      // Ставим merged_into:"pending" — значит «принят, ждёт интеграции».
      // Интеграцию выполняет огороженный эффект git-integration фабрики
      // (stage-8: воркерам больше не выдаются merge-инструменты) — он мержит
      // точный reviewed source commit и резолвит pending→merged (или
      // →conflict). worker_health отличит «done но не слито» по этому полю.
      // Для изменений цикла CHANGES_REQUESTED (review→in_progress) НЕ трогаем —
      // worktree живёт, метка не нужна.
      if (task.task_kind && task.execution_mode === 'git_change') {
        const repository = task.project_repository_id == null ? undefined : db.prepare(
          'SELECT integration_branch FROM project_repositories WHERE id=?',
        ).get(task.project_repository_id) as { integration_branch: string } | undefined;
        const mergeTarget = repository?.integration_branch ?? INTEGRATION_BRANCH_DEFAULT;
        db.prepare(
          `UPDATE tasks
           SET integration_state='pending', integrated_at=NULL, integrated_commit=NULL,
               updated_at=datetime('now')
           WHERE id=?`,
        ).run(taskId);
        patchWorktreeMeta(db, taskId, {
          branch: worktreeBranch(taskId),
          path: worktreePath(taskId),
          merge_target: mergeTarget,
          merged_into: 'pending',
          merged_commit: null,
          merge_conflict: false,
        });
      } else {
        db.prepare(
          `UPDATE tasks SET integration_state='not_required', updated_at=datetime('now') WHERE id=?`,
        ).run(taskId);
      }
      reevaluateDownstream(db, taskId); // tasks.ts:167
    }

    // 6. logActivity на переход статуса.
    logActivity(
      db,
      'task',
      taskId,
      'status_changed',
      'status',
      task.status,
      newStatus,
      `Task '${task.title}' completed by ${workerId}: ${task.status} -> ${newStatus}${verdict !== 'approved' ? ` (verdict=${verdict})` : ''}`,
    );

    // 7. active_tasks — read-only снапшот параллельной работы, для осведомлённости
    //    воркера о соседях. projectId выводим из epic_id текущей задачи
    //    (worker_done не принимает project_id параметром — он знает task_id,
    //    и проект тот же).
    //
    //    NOTE: worker_done больше НЕ делает авто-claim следующей задачи.
    //    Раньше тут вызывался findNextClaimable(...) и возвращался next_task —
    //    это создавало zombies в модели «одна задача = один запуск»: воркер
    //    умирал, а следующая задача уже была назначена на его мёртвый id.
    //    Теперь за следующей задачей воркер явно идёт через worker_next.
    const projectIdRow = db
      .prepare('SELECT project_id FROM epics WHERE id=?')
      .get(task.epic_id) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    const active_tasks = projectId != null ? getActiveTasks(db, projectId) : [];

    const reply: WorkerDoneReply = {
      completed: taskId,
      completed_new_status: newStatus,
      active_tasks,
      // Явный сигнал воркеру: работа завершена, завершайся. worker_done не
      // отдаёт следующую задачу — без этого сигнала воркер мог бы попытаться
      // продолжить цикл. Сага говорит чётко: стоп.
      stop: true,
      stop_reason: newStatus === 'blocked'
        ? 'review correction budget exhausted — task blocked; stop now'
        : 'task completed — stop now and return your summary',
    };

    // Slice 4: record the receipt inside this transaction so the side effects
    // and the receipt commit together. A future retry with the same command_id
    // + payload will short-circuit above and return this reply verbatim.
    storeReceipt(db, {
      commandId,
      commandKind: kernelClose ? 'presentation_close' : 'worker_done',
      actorKind: kernelClose ? 'controller' : 'managed_execution',
      actorId: kernelClose ? 'presentation-closure' : workerId,
      executionId: task.current_execution_id,
      taskId,
      payload,
      reply,
    });

    return { kind: 'completed', reply };
  }; // end completeTask

  // BEGIN IMMEDIATE — сериализация писателей (db.transaction тут DEFERRED,
  // поэтому оборачиваем явно).
  const completed = withImmediateTransaction(db, completeTask);
  if (completed.kind === 'submission-rejected') {
    throw completed.error;
  }
  if (completed.kind === 'submission-stasis-blocked') {
    // BLINDSIGHT F5 — the typed stasis refusal surfaces AFTER the blocking
    // transaction commits, so the durable block and the worker-visible
    // refusal are atomic in intent: the task is already blocked when the
    // worker reads this error.
    throw completed.error;
  }
  if (completed.kind === 'repair-stasis-blocked') {
    // Same atomic-intent contract for the accepted-material mirror: the
    // park + block committed; the worker now reads the typed refusal.
    throw completed.error;
  }
  journalEvent('worker.done', {
    execution_id: typeof args.execution_id === 'string' ? args.execution_id : undefined,
  }, {
    task_id: taskId,
    worker_id: workerId,
    verdict,
    kernel_close: kernelClose ? { commitment_ref: kernelClose.commitmentRef } : null,
    result_chars: result.length,
    stop: completed.reply.stop === true,
  });
  // saga4 cutover (Phase 4): worker_done no longer auto-generates downstream
  // escape hatch where generic task status produced new work. After the
  // cutover only a module-owned node/settlement may generate work; a completed
  // task is evidence consumed by its owning Process Module node.
  return completed.reply;
}

/**
 * ADR-072 kernel adapter. The immutable commitment authenticates the exact
 * ProductRef; this invokes the same close transaction as worker_done while
 * recording an honest controller-owned `presentation_close` receipt.
 */
export function closeFinalPresentationFromKernel(input: {
  readonly taskId: number;
  readonly executionId: string;
  readonly workerId: string;
  readonly commitmentRef: string;
  readonly productRef: string;
  readonly productDigest: string;
}): WorkerDoneReply {
  return handleWorkerDone({
    task_id: input.taskId,
    worker_id: input.workerId,
    execution_id: input.executionId,
    result: `Factory closed immutable final presentation ${input.commitmentRef}`,
    verdict: 'approved',
  }, {
    commitmentRef: input.commitmentRef,
    productRef: input.productRef,
    productDigest: input.productDigest,
  });
}

// ============================================================================
// worker_ask_need / worker_ask_done — terminal ASK protocol.
//
// Slice 3 (ADR-011, blueprint §12.3 line 565-578, §16 line 871-883):
// ASK is now TERMINAL. The audit identified a dead-assignment trap in the
// previous design: worker_ask_need set a tag but kept assigned_to and the
// execution fence live, expecting the same managed `claude -p` process to
// receive the answer inline. With stdin disabled that is impossible — the
// worker exits, the tag survives, the reconciler either refuses to release
// (dead assignment) or silently re-dispatches without the question context.
//
// New contract (blueprint §12.3):
//   1. worker_ask_need persists the question + context + resume_phase.
//   2. Inserts a human_requests row with state='open'.
//   3. Releases the execution and clears the task fence via the atomic
//      release primitive (so the task returns to a claimable queue once
//      answered). The requesting execution is terminalized.
//   4. Adds the needs-human tag for the kanban visual.
//   5. Returns stop:true — the worker process exits cleanly.
//
//   Later, the human's answer is recorded (via the UI or any caller):
//   worker_ask_done looks up the OPEN request by task_id, records the answer,
//   flips state to 'answered', and clears the needs-human tag. The task is
//   now claimable; a fresh worker picks it up and reads the question and
//   answer from human_requests.
//
// worker_ask_done no longer requires the same execution_id — the requesting
// execution is gone. It matches on (task_id, state='open'). This kills the
// "resurrection of an old execution" failure mode the audit named.
// ============================================================================

const NEEDS_HUMAN_TAG = 'needs-human';

/** Разобрать JSON-массив тегов задачи в Set. */
function parseTags(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((t) => typeof t === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function handleWorkerAskNeed(args: Record<string, unknown>): {
  task_id: number;
  blocking: true;
  request_id: string;
  stop: true;
  released_execution: boolean;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const reason = (args.reason as string | undefined) ?? null;

  // ADR-013 Phase 1.1: the entire handler runs inside ONE BEGIN IMMEDIATE
  // transaction so that (a) comment insert, (b) human_requests insert,
  // (c) execution terminalization + task release via atomic-release, and
  // (d) needs-human tag update commit atomically. Previously these were
  // four separate writes — a crash between any two left the task in an
  // inconsistent state (e.g. needs-human tag set with no human_requests
  // row, or execution released with the tag still absent).
  //
  // Ordering note (DO NOT NAIVELY REORDER): releaseExecutionAtomically
  // reads the task's tags from the DB and REFUSES to release a task that
  // already carries the needs-human tag (atomic-release.ts:194 — "Slice 3
  // makes ASK terminal" guard). Therefore the tag UPDATE must run AFTER
  // the release call. We open the human_requests row BEFORE release so
  // that a crash between request-open and release leaves the task with
  // an open request that surfaces as a warning, rather than the reverse
  // (released task with no blocking request).
  return withImmediateTransaction(db, () => {
    // This must be my task (assigned_to = worker_id) — cannot flag a task
    // you don't hold.
    const task = db
      .prepare('SELECT id, title, tags, current_execution_id, status FROM tasks WHERE id=? AND assigned_to=?')
      .get(taskId, workerId) as
        | {
            id: number;
            title: string;
            tags: string;
            current_execution_id: string | null;
            status: string;
          }
        | undefined;
    if (!task) {
      throw new Error(`Task ${taskId} not assigned to ${workerId} (cannot flag a task you don't hold)`);
    }
    assertExecutionFence(db, task, args.execution_id);
    // Operator SOFT-STOP tool fence: a voided execution cannot park its task
    // for a human — the hire was rewound and the card already returned to its
    // queue. Same transaction as the writes below.
    assertExecutionNotVoided(db, args.execution_id ?? task.current_execution_id);

    // Compute resume_phase from the current task status. in_progress →
    // implementation, review_in_progress → review, done+pending → integration.
    const resumePhase = taskStatusToResumePhase(task.status);

    // Stable identifier for this request. Captured up-front so the row can
    // be opened before release and referenced in the reply.
    const requestId = `hr-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextJson = JSON.stringify({
      worker_id: workerId,
      execution_id: task.current_execution_id,
      task_status_at_ask: task.status,
      asked_at: new Date().toISOString(),
    });

    // Optional reason → comment (so the human sees WHAT is being asked, not
    // only that the kanban is pulsing red).
    if (reason) {
      db.prepare('INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)')
        .run(taskId, workerId, `ASK: ${reason}`);
    }

    // Open the human_requests row BEFORE releasing anything. If anything
    // below fails, the row stays 'open' and surfaces as a warning (task
    // will not be claimable until resolved — the correct conservative
    // behaviour). This closes the audit's "tag set, no request" crash window.
    db.prepare(
      `INSERT INTO human_requests
         (request_id, task_id, requesting_execution_id, resume_phase,
          question, context_json, state)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    ).run(
      requestId,
      taskId,
      task.current_execution_id,
      resumePhase,
      reason ?? '(no question text provided)',
      contextJson,
    );

    // Compute the new tag set in memory. The DB write happens AFTER release,
    // because releaseExecutionAtomically would otherwise refuse to release
    // a task already tagged needs-human (atomic-release.ts:194 guard).
    const tags = parseTags(task.tags);
    if (!tags.has(NEEDS_HUMAN_TAG)) {
      tags.add(NEEDS_HUMAN_TAG);
    }

    // Terminal release: clear assigned_to + current_execution_id and return
    // the task to its resume queue. The execution is terminalized via the
    // atomic-release primitive so terminalization + task release occur in one
    // transaction (no split-write window for the reconciler to race with).
    let releasedExecution = false;
    if (task.current_execution_id) {
      const outcome = releaseExecutionAtomically(db, {
        executionId: task.current_execution_id,
        terminalState: 'exited',
        exitCode: 0,
        reason: `worker_ask_need: ${reason ?? 'question for human'}`,
      });
      releasedExecution = outcome.taskReleased;
    } else {
      db.prepare(
        `UPDATE tasks SET assigned_to=NULL, updated_at=datetime('now') WHERE id=?`,
      ).run(taskId);
    }

    // Now that release has run (and read the old tags), persist the tag
    // update. This must follow releaseExecutionAtomically; see the ordering
    // note at the top of this function.
    db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify([...tags]), taskId);

    logActivity(db, 'task', taskId, 'updated', 'ask_need', null, NEEDS_HUMAN_TAG,
      `Task '${task.title}' parked for human (terminal ASK) by ${workerId}${reason ? `: ${reason}` : ''}`);

    return {
      task_id: taskId,
      blocking: true,
      request_id: requestId,
      stop: true as const,
      released_execution: releasedExecution,
    };
  });
}

function handleWorkerAskDone(args: Record<string, unknown>): {
  task_id: number;
  blocking: false;
  request_id: string | null;
  state: 'answered' | 'no_open_request' | 'already_answered';
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const answer = (args.answer as string | undefined) ?? null;

  // ADR-013 Phase 1.1: wrap the entire handler in BEGIN IMMEDIATE so that
  // the CAS UPDATE on human_requests and the tag clear commit atomically.
  // Without this, two concurrent worker_ask_done calls could both observe
  // state='open', both UPDATE, and both return state='answered' — the
  // UPDATE ... WHERE state='open' is row-locked only inside a tx.
  return withImmediateTransaction(db, () => {
    // Look up the most recent request for this task in ANY state. We do not
    // filter on state='open' at SELECT time — the CAS UPDATE below is the
    // single source of truth. This distinguishes three cases:
    //   (a) no request at all                              → no_open_request
    //   (b) request exists, CAS wins (open → answered)     → answered
    //   (c) request exists, CAS loses (already answered by a concurrent tx)
    //                                                        → already_answered
    // Pre-1.1 the SELECT filtered on state='open', which silently collapsed
    // case (c) into case (a) and let a concurrent caller believe its answer
    // had been recorded when in fact it had been discarded.
    const req = db
      .prepare(
        `SELECT request_id, question, resume_phase, state FROM human_requests
          WHERE task_id=?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as
        | { request_id: string; question: string; resume_phase: string; state: string }
        | undefined;

    if (!req) {
      // No request at all for this task — clear any stale needs-human tag
      // and report. (If a request exists but is already 'answered', we do
      // NOT take this branch — see the CAS below.)
      const task = db
        .prepare('SELECT id, title, tags FROM tasks WHERE id=?')
        .get(taskId) as { id: number; title: string; tags: string } | undefined;
      if (task) {
        const tags = parseTags(task.tags);
        if (tags.has(NEEDS_HUMAN_TAG)) {
          tags.delete(NEEDS_HUMAN_TAG);
          db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
            .run(JSON.stringify([...tags]), taskId);
        }
      }
      return { task_id: taskId, blocking: false, request_id: null, state: 'no_open_request' as const };
    }

    // CAS update: the WHERE clause state='open' guarantees only ONE
    // concurrent caller can flip the row. Capture info.changes and
    // short-circuit the second caller BEFORE touching the task tags.
    const info = db.prepare(
      `UPDATE human_requests
          SET state='answered',
              answer=?,
              answered_by=?,
              answered_at=datetime('now'),
              updated_at=datetime('now')
        WHERE request_id=? AND state='open'`,
    ).run(answer ?? '(answered without text)', workerId, req.request_id);

    if (info.changes !== 1) {
      // Lost the race — another caller already answered between our SELECT
      // and our UPDATE (both inside this tx, but the CAS guarantees only
      // one wins). Do NOT touch the task tags; the winner owns the reply.
      return {
        task_id: taskId,
        blocking: false,
        request_id: req.request_id,
        state: 'already_answered' as const,
      };
    }

    // We won the CAS. Clear the needs-human tag — the question has been
    // answered and the task is now claimable.
    const task = db
      .prepare('SELECT id, title, tags FROM tasks WHERE id=?')
      .get(taskId) as { id: number; title: string; tags: string } | undefined;
    if (task) {
      const tags = parseTags(task.tags);
      if (tags.has(NEEDS_HUMAN_TAG)) {
        tags.delete(NEEDS_HUMAN_TAG);
        db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify([...tags]), taskId);
      }
    }

    logActivity(db, 'task', taskId, 'updated', 'ask_done', NEEDS_HUMAN_TAG, null,
      `Task '${task?.title ?? taskId}' needs-human answered by ${workerId}: "${answer ?? ''}"`);

    return {
      task_id: taskId,
      blocking: false,
      request_id: req.request_id,
      state: 'answered' as const,
    };
  });
}

/** Map a managed-task status at ASK time to the phase a fresh worker resumes in. */
function taskStatusToResumePhase(status: string): 'implementation' | 'review' | 'integration' {
  if (status === 'review_in_progress') return 'review';
  if (status === 'done') return 'integration';
  return 'implementation';
}

// ============================================================================
// worker_merge_acquire / worker_merge_release — сериализация слияний веток
// задач (task/<id>) в интеграционную ветку (dev). ЗАЧЕМ: несколько процессов
// saga-mcp обслуживают разных воркеров параллельно; единственная общая
// поверхность координации между ними — SQLite-БД (уже сериализуется через
// BEGIN IMMEDIATE). Поэтому merge-lock хранится в metadata проекта и берётся
// под тем же write-локом. Workflow скилла: worker_done (done) → loop acquire →
// git merge → release.
// ============================================================================

function readProjectMetadata(db: Database.Database, projectId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM projects WHERE id=?').get(projectId) as
    | { metadata?: string }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readRepositoryMetadata(db: Database.Database, bindingId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM project_repositories WHERE id=?').get(bindingId) as
    | { metadata?: string }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function handleWorkerMergeAcquire(args: Record<string, unknown>): {
  granted: boolean;
  held_by?: { task_id: number; worker_id: string; age_min: number };
  retry_after_ms?: number;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;

  const grant = withImmediateTransaction(db, () => {
    const task = db.prepare(
      `SELECT t.id, t.title, t.status, t.task_kind, t.project_repository_id,
              t.current_execution_id,
              pr.integration_branch
       FROM tasks t
       LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
       WHERE t.id=?`,
    ).get(taskId) as
      | { id: number; title: string; status: string; task_kind: string | null; project_repository_id: number | null; integration_branch: string | null; current_execution_id: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'done') {
      throw new Error(
        `Task ${taskId} status is '${task.status}' — merge-lock is only for tasks that reached 'done' (APPROVED). Wait until review is complete.`,
      );
    }
    assertExecutionFence(db, task, args.execution_id);
    // Operator SOFT-STOP tool fence: a voided execution cannot take merge
    // locks. Same BEGIN IMMEDIATE as the lock write below.
    assertExecutionNotVoided(db, args.execution_id ?? task.current_execution_id);

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project (epic missing)`);

    const repositoryScoped = task.task_kind != null && task.project_repository_id != null;
    const meta = repositoryScoped
      ? readRepositoryMetadata(db, task.project_repository_id!)
      : readProjectMetadata(db, projectId);
    const lock = meta.merge_lock as
      | { task_id: number; worker_id: string; acquired_at: string }
      | null
      | undefined;

    const now = Date.now();
    // Stale-safe + liveness-checked (Slice 5 audit fix, blueprint §13.2:613-620):
    // the lock may be reclaimed after MERGE_LOCK_STALE_MIN, BUT ONLY if the
    // previous holder's process is verifiably dead. The previous design
    // reclaimed on wall-clock alone — a live executor doing a slow (but
    // legitimate) merge could lose its claim to a zombie timer, mid-merge.
    // Now we pair wall-clock staleness with `isProcessAlive`: if the holder
    // is still alive, the lock is NOT reclaimable regardless of age.
    const isStale = (() => {
      if (!lock?.acquired_at) return true;
      const ageMs = now - new Date(lock.acquired_at + 'Z').getTime();
      return ageMs > MERGE_LOCK_STALE_MIN * 60_000;
    })();
    const holderAlive = (() => {
      if (!lock) return false;
      // Look up the holder's execution to get its PID.
      if (!lock.worker_id) return false;
      const exec = db.prepare(
        `SELECT pid FROM worker_executions
          WHERE worker_id=? AND state IN ('reserved','running','cancel_requested')
          ORDER BY reserved_at DESC LIMIT 1`,
      ).get(lock.worker_id) as { pid: number | null } | undefined;
      if (!exec?.pid) return false;
      return isProcessAlive(exec.pid);
    })();

    if (!lock || (isStale && !holderAlive)) {
      const acquiredAt = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
      meta.merge_lock = { task_id: taskId, worker_id: workerId, acquired_at: acquiredAt };
      if (repositoryScoped) {
        db.prepare('UPDATE project_repositories SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(meta), task.project_repository_id);
      } else {
        db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(meta), projectId);
      }
      logActivity(db, 'task', taskId, 'updated', 'merge_lock', lock ? 'stale' : null, workerId,
        `Merge lock ${lock ? 'reclaimed from stale' : 'acquired by'} ${workerId} for task '${task.title}'`);
      return { granted: true as const };
    }

    // Занято живым воркером — отдаём who/age, пусть коллега подождёт.
    const ageMin = Math.max(
      0, Math.round((now - new Date(lock.acquired_at + 'Z').getTime()) / 60_000),
    );
    return {
      granted: false as const,
      held_by: { task_id: lock.task_id, worker_id: lock.worker_id, age_min: ageMin },
      retry_after_ms: MERGE_LOCK_RETRY_MS,
    };
  });

  return grant;
}

function handleWorkerMergeRelease(args: Record<string, unknown>): {
  task_id: number;
  result: 'merged' | 'conflict';
  merged_commit?: string | null;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const outcome = args.result as 'merged' | 'conflict';
  if (outcome !== 'merged' && outcome !== 'conflict') {
    throw new Error(`result must be 'merged' or 'conflict', got '${outcome}'`);
  }
  const commitSha = (args.commit_sha as string | undefined) ?? null;

  withImmediateTransaction(db, () => {
    const task = db.prepare(
      `SELECT t.id, t.title, t.status, t.tags, t.task_kind, t.project_repository_id,
              t.current_execution_id,
              pr.integration_branch
       FROM tasks t
       LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
       WHERE t.id=?`,
    ).get(taskId) as
      | { id: number; title: string; status: string; tags: string; task_kind: string | null; project_repository_id: number | null; integration_branch: string | null; current_execution_id: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    assertExecutionFence(db, task, args.execution_id);
    // Operator SOFT-STOP tool fence: a voided execution cannot record merge
    // outcomes. Same BEGIN IMMEDIATE as the writes below.
    assertExecutionNotVoided(db, args.execution_id ?? task.current_execution_id);

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project`);

    // Slice 5 audit fix (blueprint §13.2:613-620, §16 Slice 5:911): reject
    // release-without-prior-acquire. The previous design silently accepted a
    // release when no lock existed (the `lock && mismatch` check skipped the
    // null branch). That let a caller record a 'merged' result without ever
    // having held the lock — masking concurrency bugs and letting two
    // integrations race on the same repository. Now: no lock → reject.
    const repositoryScoped = task.task_kind != null && task.project_repository_id != null;
    const meta = repositoryScoped
      ? readRepositoryMetadata(db, task.project_repository_id!)
      : readProjectMetadata(db, projectId);
    const lock = meta.merge_lock as
      | { task_id: number; worker_id: string; acquired_at: string }
      | null
      | undefined;
    if (!lock) {
      throw new Error(
        `Merge lock for task ${taskId} does not exist. worker_merge_release requires a prior ` +
        `successful worker_merge_acquire for the same (task, worker). Calling release without ` +
        `acquire is a concurrency bug — two integrations would race on the same repository.`,
      );
    }
    if (lock.task_id !== taskId || lock.worker_id !== workerId) {
      throw new Error(
        `Merge lock for task ${taskId} is held by ${lock.worker_id} (task ${lock.task_id}), not by ${workerId}. Only the holder may release.`,
      );
    }
    meta.merge_lock = null;
    if (repositoryScoped) {
      db.prepare('UPDATE project_repositories SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(meta), task.project_repository_id);
    } else {
      db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(meta), projectId);
    }

    // Резолвим merged_into и (при конфликте) флагаем needs-human.
    if (outcome === 'merged') {
      const mergeTarget = task.integration_branch ?? INTEGRATION_BRANCH_DEFAULT;
      patchWorktreeMeta(db, taskId, { merged_into: mergeTarget, merged_commit: commitSha, merge_conflict: false });
      db.prepare(
        `UPDATE tasks
         SET integration_state='merged', integrated_at=datetime('now'), integrated_commit=?,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(commitSha, taskId);
      // Если раньше был conflict (тег needs-human висит) — теперь всё слито,
      // человек больше не нужен. Снимаем тег (mirror of worker_ask_done).
      const tags = parseTags(task.tags);
      if (tags.has(NEEDS_HUMAN_TAG)) {
        tags.delete(NEEDS_HUMAN_TAG);
        db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify([...tags]), taskId);
      }
    } else {
      patchWorktreeMeta(db, taskId, { merged_into: 'conflict', merged_commit: null, merge_conflict: true });
      db.prepare(
        `UPDATE tasks
         SET integration_state='conflict', integrated_at=NULL, integrated_commit=NULL,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(taskId);
      // needs-human (как в worker_ask_need): задача остаётся done, но пульсирует
      // красным на канбане — человек разруливает мерж-конфликт руками.
      addTag(db, taskId, NEEDS_HUMAN_TAG);
    }

    logActivity(db, 'task', taskId, 'updated', 'merge_release', null, outcome,
      `Merge ${outcome === 'merged' ? `completed${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}` : 'CONFLICT (flagged needs-human)'} by ${workerId} for task '${task.title}'`);
    updateExecutionPhase(db, taskId, workerId, args.execution_id, 'finishing');
    if (outcome === 'merged') {
      reevaluateDownstream(db, taskId);
    }
  });

  // saga4 cutover (Phase 4): worker_merge_release no longer auto-generates
  // downstream tasks via the task-kind ladder. The owning Process Module node
  // settles the merge result and decides whether to advance.
  return { task_id: taskId, result: outcome, merged_commit: outcome === 'merged' ? commitSha : null };
}

// ============================================================================
// worker_health — read-only поиск застрявших worktree'ов: zombie (in_progress
// давно без движения), never-merged (done, но merged_into IS NULL/pending),
// stuck-merge (merged_into='conflict'). Saga сама ничего не удаляет — в worktree
// может быть чужая незакоммиченная работа; watcher/человек решает.
// ============================================================================

function handleWorkerHealth(args: Record<string, unknown>): {
  zombies: Array<{ task_id: number; title: string; assigned_to: string; branch: string; path: string; stale_min: number }>;
  never_merged: Array<{ task_id: number; title: string; branch: string; path: string; merged_into: string | null }>;
  stuck_merges: Array<{ task_id: number; title: string; branch: string; path: string }>;
} {
  const db = getDb();
  const projectId = args.project_id as number | undefined;
  if (projectId == null) {
    throw new Error(
      'project_id is required. Use the runner binding or .saga/project.json, then pass it here.',
    );
  }

  const projClause = 'AND e.project_id=?';
  const params = [projectId];

  // Zombies: активная работа без движения > 30 мин. И in_progress (разработка),
  // и review_in_progress (ревьюер работает) — оба могут зависнуть.
  const zombieRows = db.prepare(
    `SELECT t.id, t.title, t.assigned_to, t.updated_at
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND t.status IN ('in_progress', 'review_in_progress')
       AND t.updated_at < datetime('now','-30 minutes')`,
  ).all(...params) as Array<{ id: number; title: string; assigned_to: string; updated_at: string }>;
  const zombies = zombieRows.map((r) => ({
    task_id: r.id,
    title: r.title,
    assigned_to: r.assigned_to,
    branch: worktreeBranch(r.id),
    path: worktreePath(r.id),
    stale_min: Math.max(0, Math.round((Date.now() - new Date(r.updated_at + 'Z').getTime()) / 60_000)),
  }));

  // Never-merged: done, но worktree-метка merged_into пустая или pending
  // (APPROVED, но код не слит в dev). Это главный сигнал «работа может потеряться».
  const neverRows = db.prepare(
    `SELECT t.id, t.title, t.metadata
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND t.status='done'
       AND json_extract(t.metadata,'$.worktree.merged_into') IS NULL
      OR (e.project_id=? AND t.status='done'
          AND json_extract(t.metadata,'$.worktree.merged_into')='pending')`,
  ).all(projectId, projectId) as Array<{ id: number; title: string; metadata: string }>;
  const never_merged = neverRows.map((r) => {
    let mergedInto: string | null = null;
    try {
      mergedInto = (JSON.parse(r.metadata)?.worktree?.merged_into ?? null) as string | null;
    } catch { /* ignore */ }
    return {
      task_id: r.id,
      title: r.title,
      branch: worktreeBranch(r.id),
      path: worktreePath(r.id),
      merged_into: mergedInto,
    };
  });

  // Stuck merges: merged_into='conflict' (мерж конфликтовал, ждёт человека).
  const stuckRows = db.prepare(
    `SELECT t.id, t.title
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND json_extract(t.metadata,'$.worktree.merged_into')='conflict'`,
  ).all(...params) as Array<{ id: number; title: string }>;
  const stuck_merges = stuckRows.map((r) => ({
    task_id: r.id,
    title: r.title,
    branch: worktreeBranch(r.id),
    path: worktreePath(r.id),
  }));

  return { zombies, never_merged, stuck_merges };
}

// ============================================================================
// Definitions
// ============================================================================

export const definitions: Tool[] = [
  {
    name: 'worker_next',
    description:
      'Claim the next available task for a worker WITHIN A PROJECT. Finds a free task (status todo or review, unassigned, no unmet dependencies) in the given project only, atomically assigns it to the worker, and returns the task plus the skill the agent should use. project_id is REQUIRED from the runner binding or .saga/project.json. Other projects are never touched. Returns {task: null} when the queue is empty.',
    annotations: {
      title: 'Worker: Next Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: {
          type: 'string',
          description:
            'Worker identifier (e.g. "agent-1"). Stored in task.assigned_to so the board shows who is working on what.',
        },
        project_id: {
          type: 'integer',
          description:
            'ID of the project to claim work from (REQUIRED), supplied by the runner binding or .saga/project.json.',
        },
        role: {
          type: 'string',
          description:
            'Optional role filter — only return tasks carrying the tag `role:<value>` (e.g. pass "analyst" to match tag "role:analyst"). Used in the requirements project to dispatch to specialized agents (product/analyst/architect). Omit for any-tag (builders project default).',
        },
        machine_id: {
          type: 'string',
          description: 'Optional machine identifier used to resolve a machine-specific repository checkout.',
        },
        epic_id: { type: 'integer', description: 'Optional epic scope for an orchestration engine.' },
        execution_id: { type: 'string', description: 'Managed-runner execution fencing token.' },
        run_id: { type: 'string', description: 'Managed board-run identifier.' },
      },
      required: ['worker_id'],
      // NOTE: project_id is intentionally NOT in `required`. If it were, the
      // MCP SDK would reject the call with a generic "inputSchema validation"
      // error BEFORE the handler runs, leaving the agent with no clue what to
      // do. Instead we let the call reach the handler, which throws an
      // actionable English error with the full resolution steps.
    },
  },
  {
    name: 'worker_done',
    description:
      'Complete the held task and free its assignment. Author completion enters review; approved repository work is integrated afterwards by the factory\'s git-integration effect — never by the worker (the merge tools are not granted to workers). A changes_requested verdict returns the card to the author queue with review feedback. The response carries stop:true and never assigns another card.',
    annotations: {
      title: 'Worker: Complete',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task being completed' },
        worker_id: {
          type: 'string',
          description: 'Worker identifier (must match the task.assigned_to).',
        },
        result: {
          type: 'string',
          description:
            'What the worker did — recorded as a comment on the task (author = worker_id).',
        },
        verdict: {
          type: 'string',
          enum: ['approved', 'changes_requested'],
          description:
            "Only relevant when the task is in review. 'approved' (default) advances it to done. 'changes_requested' returns it to unassigned todo for a fresh developer execution; the task/<id> branch and worktree survive the re-work loop. For an in_progress task this param is ignored.",
        },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'worker_id', 'result'],
    },
  },
  {
    name: 'worker_ask_need',
    description:
      "TERMINAL park for human input (Slice 3, ADR-011, blueprint §12.3). Use this when you are blocked on a task and need a human answer that genuinely cannot be assumed or deferred. The call persists the question and resume context, opens a human_request, releases your execution (terminalized atomically), and clears your assignment so the task returns to its queue once answered. The 'needs-human' tag pulses red (⚠) on the kanban. The response carries stop:true — your process exits cleanly; do NOT plan to continue in this session. A fresh worker later claims the answered task and reads the question and answer from human_requests. This replaces the previous in-session ASK protocol, which was incompatible with headless `claude -p` (stdin disabled). Pass 'reason' with the question text. Reserved for genuine blockers — prefer the 80% rule (assume + comment) for reversible decisions. Call shape: worker_ask_need({ task_id: <integer>, worker_id: <string>, reason: <string, the question text>, execution_id: <string> }). Required: task_id, worker_id, reason.",
    annotations: {
      title: 'Worker: Ask Human (terminal park)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task you hold and are blocked on.' },
        worker_id: { type: 'string', description: 'Your worker_id (must match task.assigned_to).' },
        reason: {
          type: 'string',
          description: 'The question you are asking the human. Recorded as a comment (prefix "ASK:") and persisted in human_requests.question so a fresh worker can re-ask it later.',
        },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'worker_id', 'reason'],
    },
  },
  {
    name: 'worker_ask_done',
    description:
      "Record the human's answer to an open needs-human request on a task. Looks up the most recent OPEN human_requests row for this task, stores the answer, flips state to 'answered', and clears the needs-human tag. The task becomes claimable again; a fresh worker will pick it up and read the persisted question and answer. Does NOT require the original execution_id — that execution was terminalized by worker_ask_need and is gone. Any authorized caller (UI, human, fresh worker) may invoke this. If there is no open request, clears any stale needs-human tag and returns state='no_open_request'. Call shape: worker_ask_done({ task_id: <integer>, worker_id: <string>, answer: <string, the human's answer> }). Required: task_id, worker_id, answer.",
    annotations: {
      title: 'Worker: Ask Human (record answer)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task whose open human request is being answered.' },
        worker_id: { type: 'string', description: 'Caller identity (recorded as answered_by). Need not be the original worker — the original execution is gone.' },
        answer: {
          type: 'string',
          description: "The human's answer text. Persisted in human_requests.answer for the fresh worker to read.",
        },
      },
      required: ['task_id', 'worker_id', 'answer'],
    },
  },
  {
    name: 'worker_merge_acquire',
    description:
      'Acquire the repository-scoped merge lock before integration. Different repositories may merge concurrently. The lock auto-expires after 10 minutes and requires the exact execution fence.',
    annotations: {
      title: 'Worker: Merge Lock (acquire)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the done task whose branch you are about to merge.' },
        worker_id: { type: 'string', description: 'Your worker_id.' },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'worker_id'],
    },
  },
  {
    name: 'worker_merge_release',
    description:
      'Release the merge-lock you hold and record the outcome of integrating task/<id> into the integration branch. Call this AFTER running git merge (success: result="merged", pass the resulting commit sha) or after a merge CONFLICT (result="conflict", abort the merge first). On "merged", sets metadata.worktree.merged_into="dev" — work is integrated. On "conflict", sets merged_into="conflict" and flags the task needs-human (it pulses red on the board); the task stays done, the worktree and branch are kept so a human can resolve. Only the lock holder may release. If you crashed mid-merge, the lock will expire after 10 minutes and another worker can reclaim it. Call shape: worker_merge_release({ task_id: <integer>, worker_id: "<string>", result: "merged|conflict", commit_sha: "<string (only when result=merged)>", execution_id: "<string>" }). Required: task_id, worker_id, result.',
    annotations: {
      title: 'Worker: Merge Lock (release)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task whose branch you merged (or failed to merge).' },
        worker_id: { type: 'string', description: 'Your worker_id (must match the merge-lock holder).' },
        result: { type: 'string', enum: ['merged', 'conflict'], description: 'Outcome of the git merge.' },
        commit_sha: { type: 'string', description: 'Optional: the merge commit sha when result="merged" (recorded for audit).' },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'worker_id', 'result'],
    },
  },
  {
    name: 'worker_health',
    description:
      "Read-only check for stuck worktrees in a project. Returns three lists: zombies (in_progress tasks idle > 30 min — a worker may have died holding them), never_merged (done tasks whose branch was never merged into dev, or is still \"pending\" — work that could be lost), and stuck_merges (done tasks whose merge conflicted and need human resolution). Use this from a watcher/orchestrator, or a worker noticing the queue stalled, to find orphaned worktrees. Saga does NOT delete anything — worktrees may hold another worker's uncommitted work; a human decides. Call shape: worker_health({ project_id: <integer> }). Required: project_id.",
    annotations: {
      title: 'Worker: Health (stuck worktrees)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project to scan, supplied by the runner binding or .saga/project.json.' },
      },
      required: ['project_id'],
    },
  },
];

/**
 * Resolve the authoritative execution binding and run the node's submission
 * validator if one is declared.
 *
 * Binding resolution (T1.5): task.metadata is a consistency read, NOT the
 * authority. Two fail-closed rules:
 *   - If the registries are not initialized → infra failure (throw), not a
 *     production. Tests that don't exercise validation initialize the DB
 *     without calling initSubmissionRegistries, but those tests also don't
 *     call handleWorkerDone for factory-managed tasks.
 *   - If task.metadata declares a process_module_ref but the binding fields
 *     are malformed/missing → FACTORY_BINDING_MISSING (throw), not a silent
 *   - If task.metadata has NO process_module_ref key at all → the task is
 *     correct here — return without validation.
 *
 * Contract ref (T1.6): if the resolved policy carries a contractRef, it is
 * passed to the validator input. A version-pinned validator compares it
 * against its own canonical contract and rejects on mismatch.
 */
function validateSubmissionIfRequired(
  db: Database.Database,
  task: Task,
  workerId: string,
  executionId: string | undefined,
): SubmissionValidationError | null {
  const policyRegistry = getSubmissionPolicyRegistry();
  const validatorRegistry = getSubmissionValidatorRegistry();

  // Parse task.metadata once. The presence of the `process_module_ref` key
  // distinguishes "factory-managed task with binding" from "non-factory task".
  let metadata: Record<string, unknown> = {};
  try {
    metadata = typeof task.metadata === 'string'
      ? JSON.parse(task.metadata)
      : (task.metadata as Record<string, unknown>) ?? {};
  } catch {
    // Malformed metadata JSON. If the raw string contains process_module_ref,
    // it's a broken factory binding → fail-closed. Otherwise non-factory.
    const rawMeta = typeof task.metadata === 'string' ? task.metadata : '';
    if (rawMeta.includes('process_module_ref')) {
      throw new Error(
        `FACTORY_BINDING_MALFORMED: task ${task.id} metadata contains `
        + `process_module_ref but JSON is unparseable`,
      );
    }
    return null; // genuinely non-factory task with malformed metadata
  }

  const hasProcessModuleRef = Object.prototype.hasOwnProperty.call(metadata, 'process_module_ref');

  if (!hasProcessModuleRef) return null;

  // Factory-managed task: registries MUST be wired (fail-closed, T1.5).
  if (!policyRegistry || !validatorRegistry) {
    throw new Error(
      `SUBMISSION_INFRASTRUCTURE_NOT_INITIALIZED: task ${task.id} is `
      + `factory-managed (has process_module_ref) but submission registries `
      + `are not wired. Call initSubmissionRegistries(db) at composition root.`,
    );
  }

  const processRunId = metadata['process_run_id'];
  const moduleRef = metadata['process_module_ref'];
  const nodeId = metadata['process_node_id'];
  if (
    typeof processRunId !== 'number'
    || typeof moduleRef !== 'string'
    || typeof nodeId !== 'string'
  ) {
    // Factory-managed task (has process_module_ref key) but binding fields
    throw new Error(
      `FACTORY_BINDING_INCOMPLETE: task ${task.id} has process_module_ref `
      + `but binding is incomplete (process_run_id=${JSON.stringify(processRunId)}, `
      + `process_module_ref=${JSON.stringify(moduleRef)}, `
      + `process_node_id=${JSON.stringify(nodeId)})`,
    );
  }

  const policy = policyRegistry.resolve(moduleRef, nodeId);
  if (!policy) {
    // Every LM-node MUST declare a policy. The absence of a declaration is a
    // configuration error, not a silent bypass.
    throw new Error(
      `SUBMISSION_VALIDATION_POLICY_MISSING: ${moduleRef}/${nodeId}`,
    );
  }

  if (policy.mode === 'none') return null; // explicitly no validation — allowed
  // mode === 'required'
  const validator = validatorRegistry.resolve(policy.validatorId);
  if (!validator) {
    throw new Error(`SUBMISSION_VALIDATOR_MISSING: ${policy.validatorId}`);
  }

  const projectId = (db.prepare('SELECT e.project_id AS project_id FROM epics e WHERE e.id=?').get(task.epic_id) as { project_id?: number } | undefined)?.project_id ?? 0;

  const currentExecutionId = executionId ?? task.current_execution_id ?? '';
  const hasManagedProduction = policy.requireManagedProduction !== true || Boolean(
    db.prepare(
      `SELECT 1 AS present
         FROM (
           SELECT execution_id FROM factory_managed_artifact_productions
           UNION ALL
           SELECT execution_id FROM factory_managed_trace_productions
         )
        WHERE execution_id=?
        LIMIT 1`,
    ).get(currentExecutionId),
  );
  const result = hasManagedProduction
    ? validator.validate({
    processRunId,
    moduleRef,
    nodeId,
    executionId: currentExecutionId,
    taskId: task.id,
    epicId: task.epic_id,
    projectId,
    // T1.6: pass the pinned contract ref from the policy declaration so the
    // validator can detect version mismatch between author and validator.
    contractRef: policy.contractRef,
      })
    : {
        accepted: false as const,
        code: 'MANAGED_PRODUCTION_REQUIRED',
        gaps: [{
          artifactId: -1,
          artifactCode: null,
          artifactType: 'MANAGED_PRODUCTION',
          existingTargets: [],
          missing: {
            relation: 'published_by_current_execution',
            requiredTargetTypes: ['artifact_create', 'artifact_update', 'trace_add'],
            minimum: 1,
          },
          message: `Execution ${currentExecutionId} changed or verified Workplace material but published no current managed contribution. After Write/Edit, call artifact_update for every changed existing artifact (or artifact_create/trace_add for new material), reread it, then retry worker_done. Prior execution ledger rows cannot satisfy current author authority.`,
        }],
        details: {
          executionId: currentExecutionId,
          requiredTools: ['artifact_create', 'artifact_update', 'trace_add'],
        },
      };

  if (!result.accepted) {
    const error = new SubmissionValidationError(
      result.code,
      result.gaps,
      result.details ?? {},
      {
        validatorId: validator.validatorId,
        validatorVersion: validator.validatorVersion,
        processRunId,
        moduleRef,
        nodeId,
        executionId: currentExecutionId,
        taskId: task.id,
        contractRef: policy.contractRef ?? null,
        inputSnapshotHash: typeof metadata.process_node_input_hash === 'string'
          ? metadata.process_node_input_hash
          : typeof metadata.process_input_hash === 'string'
            ? metadata.process_input_hash
            : '',
      },
    );
    persistSubmissionValidationRejection(db, {
      validatorId: validator.validatorId,
      validatorVersion: validator.validatorVersion,
      processRunId,
      moduleRef,
      nodeId,
      executionId: currentExecutionId,
      taskId: task.id,
      actorKind: 'managed_execution',
      workerId,
      rejectionCode: result.code,
      gaps: result.gaps,
      details: result.details,
      contractRef: policy.contractRef,
      inputSnapshotHash: typeof metadata.process_node_input_hash === 'string'
        ? metadata.process_node_input_hash
        : typeof metadata.process_input_hash === 'string'
          ? metadata.process_input_hash
          : '',
    });
    return error;
  }

  clearSubmissionValidationFeedback(db, task.id);

  // Persist the receipt — durable proof validation passed. The receipt and
  // the task transition run in the same transaction (the caller wraps
  // handleWorkerDone in withImmediateTransaction).
  const receipt = result.receipt;
  db.prepare(
    `INSERT INTO factory_submission_validation_receipts
       (validator_id, validator_version, process_run_id, module_ref, node_id,
        execution_id, task_id, input_snapshot_hash, artifact_ids, trace_ids,
        artifact_hashes, trace_digest, contract_ref, validated_set_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.validatorId,
    receipt.validatorVersion,
    receipt.processRunId,
    receipt.moduleRef,
    receipt.nodeId,
    receipt.executionId,
    receipt.taskId,
    receipt.inputSnapshotHash,
    JSON.stringify(receipt.artifactIds),
    JSON.stringify(receipt.traceIds),
    JSON.stringify(receipt.artifactHashes ?? {}),
    receipt.traceDigest ?? '',
    receipt.contractRef ? JSON.stringify(receipt.contractRef) : null,
    receipt.validatedSetDigest,
  );
  return null;
}

function requireProductionCellSubmission(
  db: Database.Database,
  taskId: number,
  currentExecutionId: string | null,
  executionId: string | undefined,
): void {
  // The Workplace aggregate is the authority. Task metadata is only a
  // projection and may be stale or incomplete after recovery; it must never
  // weaken the product boundary.
  const productionCell = db.prepare(
    `SELECT w.production_cell_id
       FROM tasks t
       JOIN factory_workplaces w ON w.workplace_ref=t.workplace_ref
      WHERE t.id=? AND w.production_cell_id IS NOT NULL`,
  ).get(taskId) as {
    production_cell_id: string;
  } | undefined;
  if (!productionCell) return;

  const exactExecutionId = executionId ?? currentExecutionId;
  if (!exactExecutionId) {
    throw new Error(`PRODUCTION_INGRESS_EXECUTION_MISSING: task ${taskId}`);
  }
  const ingress = readFrozenProductionIngressIfBound(db, exactExecutionId);
  // Compatibility tracker cards freeze an explicitly null WorkIntent. This is
  // the only lawful bypass; mutable task metadata never classifies ingress.
  if (!ingress) return;
  const intent = db.prepare(
    `SELECT output_schema FROM factory_work_intents WHERE id=?`,
  ).get(ingress.workIntentId) as { output_schema: string } | undefined;
  if (!intent) {
    throw new Error(`PRODUCTION_INGRESS_WORK_INTENT_NOT_FOUND: ${ingress.workIntentId}`);
  }

  // Managed Workplace ingress (e.g. Formalization author nodes) does not require
  // a typed product_submit — the factory assembles the product from the
  // Workplace desk (artifacts + traces) at CandidateSet seal time. Only
  // typed ingress requires an explicit product_submit before worker_done. The
  // same immutable WorkIntent capability set drives the seal-time reader.
  if (ingress.mode === 'managed-workplace') return;
  const submission = exactExecutionId
    ? db.prepare(
        `SELECT s.id,s.intent_id,s.schema_version,wi.output_schema
           FROM factory_managed_node_submissions s
           JOIN factory_work_intents wi ON wi.id=s.intent_id
          WHERE s.task_id=? AND s.execution_id=?
          ORDER BY s.id DESC LIMIT 1`,
      ).get(taskId, exactExecutionId) as {
        id: number;
        intent_id: number;
        schema_version: string;
        output_schema: string;
      } | undefined
    : undefined;
  if (submission
    && submission.intent_id === ingress.workIntentId
    && submission.schema_version === intent.output_schema
    && submission.output_schema === intent.output_schema) return;
  if (submission) {
    throw new Error(
      `PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH: task ${taskId} execution `
      + `'${exactExecutionId}' must submit '${intent.output_schema}', `
      + `received '${submission.schema_version}'. The incompatible product `
      + 'remains immutable evidence but cannot complete this WorkIntent.',
    );
  }
  throw new Error(
    `PRODUCTION_CELL_PRODUCT_REQUIRED: task ${taskId} cannot call worker_done `
    + `before its exact execution '${exactExecutionId ?? '(missing)'}' has a `
    + `typed product_submit. Submit the declared product as `
    + `product_submit({ schema: '<declared schema>', content: { ... } }) and `
    + `retry worker_done without leaving the execution.`,
  );
}

export const handlers: Record<string, ToolHandler> = {
  worker_next: handleWorkerNext,
  worker_done: handleWorkerDone,
  worker_ask_need: handleWorkerAskNeed,
  worker_ask_done: handleWorkerAskDone,
  worker_merge_acquire: handleWorkerMergeAcquire,
  worker_merge_release: handleWorkerMergeRelease,
  worker_health: handleWorkerHealth,
};
