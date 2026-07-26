/**
 * LMNodeExecutor — NodeExecutor для LM-узлов (исполняется через worker).
 *
 * Это универсальная LM Execution Cell. Для каждого LM-узла:
 *   1. читает ExecutionProfileDefinition (по node.executionProfile);
 *   2. создаёт WorkIntent с kind/output_schema/authority_scope из профиля;
 *   3. проецирует task с workflow_stage/task_kind/execution_skill из профиля
 *      (параметризованный ensureProjectedTask из P6c шага 2);
 *   4. запускает worker через WorkerExecutor с claimScope на одну задачу;
 *   5. poll-loop'ом ждёт worker_done (task='done') или отказ;
 *   6. возвращает node event из task result.
 *
 * Executor НЕ знает ни слова "discovery", ни слова "formalization" — все
 * предметные строки приходят из executionProfile. Граница Pack/Core: Pack
 * описывает профиль (skill id, allowed tools, intent kind), Core исполняет.
 *
 * WorkIntent projection port (LmNodeExecutionPersistence) — module-agnostic
 * проекция тех самых функций, что исторически жили в
 * SqliteSaga3DiscoveryRuntime. Реализация в шаге 4 оборачивает тот же адаптер.
 */

import type {
  ExecutionProfileDefinition,
  LmFlowNodeDefinition,
  ProcessModuleDefinition,
} from '../../domain/process-module.js';
import type { WorkerExecutor, WorkerExecutorFactory, WorkerExecutorFactoryContext } from '../../../application/ports/worker-executor.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';

/**
 * Subset of the saga3 runtime persistence the LM executor needs. Mirrors the
 * discovery projection surface but is generic (no discovery-specific
 * parameters). The runtime wires a concrete implementation (discovery today,
 * via the existing saga3 adapter — same code path, parameterised).
 */
export interface LmNodeExecutionPersistence {
  createIntent(input: {
    epicId: number;
    kind: string;
    objective: string;
    authorityScope: {
      snapshot_ref: string;
      scope: string;
      allowed_tools: string[];
      enforcement: 'advisory' | 'runtime';
    };
    outputSchema: string;
    tokenBudget: number;
    retryBudget: number;
  }): { id: number };

  ensureProjectedTask(input: {
    epicId: number;
    projectId: number;
    intentId: number;
    objective: string;
    taskKind: string;
    executionSkill: string;
    generationKey: string;
    workflowStage?: string;
    executionMode?: string;
    titlePrefix?: string;
    metadata?: Record<string, unknown>;
  }): number;

  setProjectedTask(intentId: number, taskId: number): void;

  setIntentStatus(
    intentId: number,
    expected: string,
    next: string,
  ): boolean;

  prepareIntentForExecution(
    intentId: number,
    taskId: number,
  ): { status: 'ready' | 'active' | 'blocked' | 'done'; intentStatus: string };

  readTaskState(taskId: number): string | null;
}

export interface LmNodeExecutorOptions {
  persistence: LmNodeExecutionPersistence;
  workerExecutorFactory: WorkerExecutorFactory;
  /** Build the factory context for one node's worker spawn. */
  resolveWorkerContext: (ctx: NodeExecutionContext) => WorkerExecutorFactoryContext;
  /** Polling interval for worker status. Default 2000ms. */
  pollMs?: number;
  /** Hard wall-clock cap on one LM-node execution. Default 30min. */
  maxRunMs?: number;
  /** Sleep helper (overridable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Now helper (overridable for tests). */
  now?: () => Date;
}

export class LmNodeExecutor implements NodeExecutor {
  readonly kind = 'lm' as const;

  private readonly persistence: LmNodeExecutionPersistence;
  private readonly workerExecutorFactory: WorkerExecutorFactory;
  private readonly resolveWorkerContext: (ctx: NodeExecutionContext) => WorkerExecutorFactoryContext;
  private readonly pollMs: number;
  private readonly maxRunMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: LmNodeExecutorOptions) {
    this.persistence = options.persistence;
    this.workerExecutorFactory = options.workerExecutorFactory;
    this.resolveWorkerContext = options.resolveWorkerContext;
    this.pollMs = options.pollMs ?? 2000;
    this.maxRunMs = options.maxRunMs ?? 30 * 60 * 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = ctx.node as LmFlowNodeDefinition;
    const profile = resolveProfile(ctx.module, node.executionProfile);
    if (!profile) {
      throw new NodeExecutionError(
        'lm',
        node.id,
        `execution profile '${node.executionProfile}' not declared by module ${ctx.module.identity.name}`,
      );
    }

    if (ctx.epicId === null) {
      throw new NodeExecutionError(
        'lm',
        node.id,
        'LM nodes require an epic scope (epicId is null)',
      );
    }

    try {
      // The worker's product objective comes from the module input payload
      // (the epic's product brief), NOT from the node's technical description.
      // node.description/label describe the node's ROLE in the flow; the worker
      // needs to know WHAT to investigate. Fall back to node description only
      // when the input carries no objective (e.g. synthetic test modules).
      const inputObj = (ctx.input ?? {}) as { objective?: string };
      const objective = inputObj.objective && inputObj.objective.trim().length > 0
        ? inputObj.objective
        : (node.description || node.label);

      // Д5: a preparation kernel node upstream may have ALREADY created the
      // WorkIntent + projected task (e.g. discovery-prepare-readiness creates
      // the readiness ControlIntent + authority WorkIntent + advisor task). In
      // that case the chain bindings carry preProjectedTaskId +
      // preProjectedIntentId, and the executor REUSES them instead of creating
      // its own — so the worker lands on the exact task the control intent
      // bound to the immutable Proposal version, and readiness_get/
      // readiness_submit succeed via task metadata.control_intent_id.
      const prepBindings = (ctx.input as { bindings?: Record<string, unknown> } | null)?.bindings ?? {};
      const preProjectedTaskId = Number(prepBindings.preProjectedTaskId ?? 0);
      const preProjectedIntentId = Number(prepBindings.preProjectedIntentId ?? prepBindings.authorityIntentId ?? 0);

      let intent: { id: number };
      let taskId: number;
      if (preProjectedTaskId && preProjectedIntentId) {
        // Preparation node already projected the task — reuse it. The worker
        // spawned below claims this exact task; its metadata carries the
        // control_intent_id the module's submit handlers verify.
        intent = { id: preProjectedIntentId };
        taskId = preProjectedTaskId;
      } else {
        // 1. Create the WorkIntent — module content (kind/schema/tools) from the profile.
        intent = this.persistence.createIntent({
          epicId: ctx.epicId,
          kind: profile.workIntentKind,
          objective,
          authorityScope: {
            snapshot_ref: `process-run:${ctx.processRunId}:node:${node.id}`,
            scope: profile.semanticSkill,
            allowed_tools: [...profile.allowedTools],
            enforcement: 'runtime',
          },
          outputSchema: profile.outputSchema.id,
          tokenBudget: 0,
          retryBudget: profile.retryPolicy.maxAttempts,
        });

        // 2. Project the board task — module content (stage/kind/skill) from the profile.
        const generationKey = `process-run:${ctx.processRunId}:node:${node.id}`;
        taskId = this.persistence.ensureProjectedTask({
          epicId: ctx.epicId,
          projectId: ctx.projectId,
          intentId: intent.id,
          objective,
          taskKind: profile.taskKind,
          executionSkill: profile.executionSkill,
          generationKey,
          workflowStage: ctx.module.identity.kind,
          executionMode: profile.executionMode,
          titlePrefix: `${ctx.module.identity.displayName}: `,
        });
        this.persistence.setProjectedTask(intent.id, taskId);
      }

      // 3. Prepare (CAS open→executing guard) — handles resume of a stale fence.
      const preparation = this.persistence.prepareIntentForExecution(intent.id, taskId);
      if (preparation.status === 'done') {
        // Already concluded by a prior run (replay).
        this.persistence.setIntentStatus(intent.id, preparation.intentStatus, 'concluded');
        return {
          runtimeEvent: 'completed',
          production: {
            schema: profile.outputSchema.id,
            artifactRef: `lm:${node.id}:task:${taskId}`,
            contentHash: '',
            bindings: { intentId: intent.id, taskId, workIntentId: intent.id, epicId: ctx.epicId ?? 0, replayed: 1 },
          },
        };
      }
      if (preparation.status === 'blocked') {
        throw new NodeExecutionError('lm', node.id, `projected task ${taskId} is blocked`);
      }

      // 4. Spawn the worker, scoped to exactly this task.
      const workerCtx = this.resolveWorkerContext(ctx);
      const executor: WorkerExecutor = this.workerExecutorFactory(workerCtx);
      executor.start({
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        concurrency: 1,
        claimScope: { taskIds: [taskId] },
      });
      this.persistence.setIntentStatus(intent.id, preparation.intentStatus, 'executing');

      // 5. Poll loop — copied from Saga3DiscoveryEngine. The terminal verdict
      //    combines task status + worker substrate state + wall clock.
      const startedAt = this.now().getTime();
      let terminal:
        | 'clean'
        | 'task_blocked'
        | 'executor_failed'
        | 'executor_dead'
        | 'stopped'
        | 'timeout'
        | 'task_unclaimed' = 'timeout';
      try {
        while (true) {
          const taskStatus = this.persistence.readTaskState(taskId);
          const taskDone = taskStatus === 'done';
          const taskBlocked = taskStatus === 'blocked';
          const run = executor.status(ctx.projectId);
          const runIsNull = run === null;
          const runStatus = run?.status ?? null;
          const runCompleted = runStatus === 'completed';
          const runStopped = runStatus === 'stopped';
          const runFailed = runStatus === 'failed';
          const taskStillActive = run?.active?.some((w) => w.task_id === taskId) ?? false;

          if (runIsNull) { terminal = 'executor_dead'; break; }
          if (runFailed) { terminal = 'executor_failed'; break; }
          if (runStopped) { terminal = 'stopped'; break; }
          if (taskDone && !taskStillActive) { terminal = 'clean'; break; }
          if (taskBlocked && !taskStillActive) { terminal = 'task_blocked'; break; }
          if (runCompleted && !taskDone) { terminal = 'task_unclaimed'; break; }
          if (this.now().getTime() - startedAt > this.maxRunMs) { terminal = 'timeout'; break; }
          await this.sleep(this.pollMs);
        }
      } finally {
        if (terminal !== 'clean') {
          try { executor.stop(ctx.projectId); } catch { /* best effort */ }
        }
        try { executor.dispose(); } catch { /* best effort */ }
      }

      // 6. Conclude intent + translate terminal verdict.
      if (terminal === 'clean') {
        this.persistence.setIntentStatus(intent.id, 'executing', 'concluded');
        // LM nodes emit ONLY runtimeEvent ('completed'). They never emit a
        // domainEvent — domain semantics (accepted/go/clarify) belong to kernel
        // nodes. The production carries exact runtime bindings (intentId,
        // taskId, workIntentId) PLUS any upstream bindings forwarded from the
        // preparation node (proposalId/proposalHash/controlIntentId), so the
        // downstream settlement kernel can read exact lineage from the chain.
        return {
          runtimeEvent: 'completed',
          production: {
            schema: profile.outputSchema.id,
            artifactRef: `lm:${node.id}:task:${taskId}`,
            contentHash: '',
            bindings: {
              intentId: intent.id,
              taskId,
              workIntentId: intent.id,
              epicId: ctx.epicId ?? 0,
              // Forward upstream preparation bindings (proposalId, proposalHash,
              // controlIntentId, ...) so settlement kernel can read exact lineage.
              ...forwardPrepBindings(prepBindings),
            },
          },
        };
      }
      this.persistence.setIntentStatus(intent.id, 'executing', 'paused');
      return { runtimeEvent: 'paused' };
    } catch (err) {
      if (err instanceof NodeExecutionError) throw err;
      throw new NodeExecutionError('lm', node.id, (err as Error).message, err);
    }
  }
}

function resolveProfile(
  module: ProcessModuleDefinition,
  profileId: string,
): ExecutionProfileDefinition | null {
  for (const profile of module.executionProfiles) {
    if (profile.id === profileId) return profile;
  }
  return null;
}

/**
 * Forward upstream preparation bindings (from a D5 prepare-* kernel node) so the
 * downstream settlement kernel can read exact lineage (proposalId/proposalHash/
 * controlIntentId/assessmentId) from the chain. Internal runtime fields
 * (preProjectedTaskId/preProjectedIntentId) are dropped — they are consumed by
 * this executor only.
 */
function forwardPrepBindings(
  prep: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prep)) {
    if (k === 'preProjectedTaskId' || k === 'preProjectedIntentId') continue;
    out[k] = v;
  }
  return out;
}
