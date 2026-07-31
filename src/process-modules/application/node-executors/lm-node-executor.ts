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
import {
  RECOVERY_FEEDBACK_SCHEMA,
  type RecoveryFeedback,
} from '../../domain/recovery.js';
import type { WorkerExecutor, WorkerExecutorFactory, WorkerExecutorFactoryContext } from '../../../application/ports/worker-executor.js';
import {
  NodeExecutionError,
  NodeExecutionLeaseLostError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';
// W3-A2 (spec §5): board-driver adapter-data builder isolates the snake_case
// saga3 lineage/receipt stamping behind a named port. The LM executor body
// stays driver-neutral; this file is the only place that knows the board vocab.
// sha256Hex moved into the builder (the only consumer of the lineage hashes).
import {
  buildSagaBoardLineageBag,
  buildSagaBoardDriverNeutralReceipt,
} from './saga-board-adapter-data-builder.js';
// Type-only import of the Wave 1 driver-neutral receipt shape — pure data type
// under domain/spi/ (Rule 5 pure). application→domain is ratchet-allowed.
import type { DriverNeutralExecutionReceipt } from '../../domain/spi/index.js';

/**
 * Subset of the saga3 runtime persistence the LM executor needs. Mirrors the
 * discovery projection surface but is generic (no discovery-specific
 * parameters). The runtime wires a concrete implementation (discovery today,
 * via the existing saga3 adapter — same code path, parameterised).
 */
export interface LmNodeExecutionPersistence {
  ensureExecutionPlan(input: {
    intent: {
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
    };
    task: {
      epicId: number;
      projectId: number;
      objective: string;
      taskKind: string;
      executionSkill: string;
      reviewSkill?: string | null;
      generationKey: string;
      workflowStage?: string;
      executionMode?: string;
      titlePrefix?: string;
      metadata?: Record<string, unknown>;
    };
  }): { intentId: number; taskId: number; replayed: boolean };

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
    reviewSkill?: string | null;
    generationKey: string;
    workflowStage?: string;
    executionMode?: string;
    titlePrefix?: string;
    metadata?: Record<string, unknown>;
  }): number;

  setProjectedTask(intentId: number, taskId: number): void;

  /** Stamp server-owned ProcessRun/node lineage onto an exact projected task. */
  bindProjectedTaskProcessContext?(input: {
    taskId: number;
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    processInputHash: string;
    nodeInput: unknown;
    nodeInputHash: string;
    /** Optional project_repository_id to stamp alongside the lineage. */
    projectRepositoryId?: number | null;
    /** Optional generic reviewer-correction budget. */
    managedReviewBudget?: number | null;
  }): void;

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

  /** Current execution fence while the task is claimed. */
  readCurrentExecutionId(taskId: number): string | null;

  /** Latest physical execution for the exact projected task. */
  readLatestExecutionId(taskId: number): string | null;

  /**
   * Exact execution that last persisted a managed product for this ProcessRun
   * node. On a completed task this differs from readLatestExecutionId because
   * the latest physical execution is normally the reviewer.
   */
  readLatestManagedProductionExecutionId?(
    taskId: number,
    processRunId: number,
    nodeId: string,
  ): string | null;

  /**
   * project_repository_id bound to the projected task. Workers need this to
   * resolve artifact file paths and to pass to artifact_create /
   * artifact_update. Without it, artifacts end up with a NULL
   * project_repository_id and the formalization resolvers (which validate
   * content_hash via artifactDiskHash) fail closed.
   */
  readTaskProjectRepositoryId(taskId: number): number | null;
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

  /**
   * W3-A2 (spec §5): build the driver-neutral receipt that travels ALONGSIDE
   * the legacy `NodeExecutionReceipt`. The LM executor does NOT own the NodeRun
   * row (the GenericFlowExecutor opens/completes it), so when the v2 envelope
   * is present we borrow `nodeRunId`/`attempt` from it; otherwise we emit the
   * 0/1 placeholder that `toV2Result` in `node-executor.ts` also uses, and let
   * the GenericFlowExecutor's v2 dual-write path stamp the real NodeRun id.
   *
   * Pure with respect to inputs: same (envelope, lineage, ids) → same receipt.
   */
  private buildDriverNeutralReceipt(args: {
    intentId: number;
    taskId: number;
    executionId: string | null;
    runtimeStatus: 'completed' | 'failed' | 'paused';
    replayed: boolean;
    lineage: ReturnType<typeof buildSagaBoardLineageBag>;
    envelope: NodeExecutionContext['envelope'];
  }): DriverNeutralExecutionReceipt {
    return buildSagaBoardDriverNeutralReceipt({
      nodeRunId: args.envelope?.nodeRunId ?? 0,
      attempt: args.envelope?.attempt ?? 1,
      intentId: args.intentId,
      taskId: args.taskId,
      executionId: args.executionId,
      runtimeStatus: args.runtimeStatus,
      replayed: args.replayed,
      lineage: args.lineage,
    });
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
      // W3-A2 (spec §5): detect A1's v2 driver-neutral context. The
      // GenericFlowExecutor sets `ctx.envelope` ONLY when the v2 wiring is
      // active (the run was started with v2 NodeRun columns + an
      // ExecutionContextAssembler). Legacy runs leave `envelope` undefined and
      // the executor reads the mutable `ctx.frame` exactly as before (plan
      // §16.9 — dual-write + fallback paths; no behaviour change for legacy).
      const envelope = ctx.envelope;
      const isV2Context = envelope !== undefined;
      // The lineage bag's process_input_hash must be stable across v1/v2. The
      // envelope's immutableRunInput IS the same run input, exposed
      // driver-neutrally; fall back to the legacy frame view when absent.
      const runInput = isV2Context ? envelope.immutableRunInput : ctx.frame.runInput;

      // The worker's product objective comes from the module input payload
      // (the epic's product brief), NOT from the node's technical description.
      // node.description/label describe the node's ROLE in the flow; the worker
      // needs to know WHAT to investigate. Fall back to node description only
      // when the input carries no objective (e.g. synthetic test modules).
      const inputObj = (ctx.input ?? {}) as { objective?: string };
      const runInputObj = (runInput ?? {}) as { objective?: string };
      const baseObjective = inputObj.objective && inputObj.objective.trim().length > 0
        ? inputObj.objective
        : runInputObj.objective && runInputObj.objective.trim().length > 0
          ? runInputObj.objective
          : (node.description || node.label);
      const recoveryFeedback = readRecoveryFeedback(ctx.input);
      const effectiveAllowedTools = [
        ...new Set([
          ...profile.allowedTools,
          ...(recoveryFeedback?.issue.requiredTools ?? []),
        ]),
      ];
      const objective = recoveryFeedback
        ? `${baseObjective}\n\nRecovery attempt ${recoveryFeedback.attempt}/`
          + `${recoveryFeedback.maxAttempts}: ${recoveryFeedback.issue.summary}. `
          + 'Read recovery_feedback and recovery-feedback.json, inspect the exact '
          + 'sourceProduction and subjectRefs, change only allowedChanges, then '
          + 'complete the ordinary node protocol so the kernel can verify again.'
        : baseObjective;

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
      // Resolve the project_repository_id ahead of task projection so the
      // worker receives it in task.metadata alongside the process lineage.
      // Without it the worker cannot pass project_repository_id to
      // artifact_create / artifact_update, artifacts end up with NULL
      // project_repository_id, artifactDiskHash cannot resolve their file
      // paths, and the formalization resolver fails closed on NULL
      // content_hash. This is a project-level constant, not a per-stage
      // decision, so it belongs in task metadata — not in certificate handoff.
      const resolvedRepositoryId = (() => {
        // Prefer the pre-projected task's binding (preparation node already
        // projected the task and stamped project_repository_id on its row).
        if (preProjectedTaskId) {
          const fromTask = this.persistence.readTaskProjectRepositoryId(preProjectedTaskId);
          if (fromTask) return fromTask;
        }
        // Fall back to reading it after ensureExecutionPlan below; resolved
        // there once the task row exists with project_repository_id set by
        // ensureProjectedTask.
        return null as number | null;
      })();
      // W3-A2 (spec §5): the snake_case saga-board lineage bag is now built
      // behind SagaBoardAdapterDataBuilder so the LM executor body stays
      // driver-neutral. The produced bag is byte-identical to the pre-Wave-3
      // inline literal — the saga3 adapter reads the exact same task metadata.
      const moduleRef = `${ctx.module.identity.name}@${ctx.module.identity.version}`;
      const processBinding = buildSagaBoardLineageBag({
        processRunId: ctx.processRunId,
        nodeId: node.id,
        moduleRef,
        runInput,
        nodeInput: ctx.input,
        artifactAcceptanceAuthority:
          profile.artifactAcceptanceAuthority ?? 'worker',
        recoveryFeedback,
        projectRepositoryId: resolvedRepositoryId,
        managedReviewBudget: profile.reviewSkill
          ? profile.retryPolicy.maxAttempts
          : null,
      });

      let intent: { id: number };
      let taskId: number;
      if (preProjectedTaskId && preProjectedIntentId) {
        // Preparation node already projected the task — reuse it. The worker
        // spawned below claims this exact task; its metadata carries the
        // control_intent_id the module's submit handlers verify.
        intent = { id: preProjectedIntentId };
        taskId = preProjectedTaskId;
      } else {
        // Atomically ensure the WorkIntent + projected task pair. A restart
        // must never create a new intent and then reuse a task whose metadata
        // is still bound to an older intent.
        // CGAD P18 — Node-Durable Identity: the workplace (node) is the primary
        // durable entity; the card (projected task) belongs to the workplace,
        // not the worker. A repair round therefore reuses the SAME generationKey
        // as the original producer (no `:recovery:caseId:attempt:N` suffix), so
        // ensureNodeExecutionPlan reclaims the workplace's existing card and the
        // verifying gate sees the prior work. This converges semantic recovery
        // with the proven physical-resume path (generic-flow-executor
        // restoreFrame), which already reuses this exact key. Each repair
        // attempt still records its own NodeRun (keyed on process_run + node +
        // attempt), preserving per-attempt audit orthogonally to task identity.
        const generationKey =
          `process-run:${ctx.processRunId}:node:${node.id}`;
        const snapshotRef =
          `process-run:${ctx.processRunId}:node:${node.id}`;
        const plan = this.persistence.ensureExecutionPlan({
          intent: {
            epicId: ctx.epicId,
            kind: profile.workIntentKind,
            objective,
            authorityScope: {
              snapshot_ref: snapshotRef,
              scope: profile.semanticSkill,
              allowed_tools: effectiveAllowedTools,
              enforcement: 'runtime',
            },
            // outputSchema here is the WorkIntent's OWN output contract
            // (workIntentSchema, e.g. saga3.work-intent.discovery.v1). It is
            // what proposal_submit / readiness_submit / etc. compare against
            // in saga3_work_intents.output_schema. Using profile.outputSchema
            // (the proposal payload schema, e.g. saga3.discovery-proposal.v1)
            // here produced "intent output_schema mismatch" at proposal_submit:
            // intent.output_schema ended up as the PROPOSAL schema while the
            // submit handler compared it against the INTENT schema.
            outputSchema: profile.workIntentSchema.id,
            tokenBudget: 0,
            retryBudget: profile.retryPolicy.maxAttempts,
          },
          task: {
            epicId: ctx.epicId,
            projectId: ctx.projectId,
            objective,
            taskKind: profile.taskKind,
            executionSkill: profile.executionSkill,
            reviewSkill: profile.reviewSkill,
            generationKey,
            workflowStage: ctx.module.identity.kind,
            executionMode: profile.executionMode,
            titlePrefix: `${ctx.module.identity.displayName}: `,
            metadata: processBinding,
          },
        });
        intent = { id: plan.intentId };
        taskId = plan.taskId;
      }

      // Preparation nodes may project the task before this generic LM cell is
      // entered. Stamp the same reserved lineage in both paths; the persistence
      // adapter rejects attempts to rebind an existing task to another run.
      // Also resolve project_repository_id from the freshly projected task row
      // (ensureProjectedTask sets it from project_repositories) when the
      // pre-projected path did not supply one, then stamp it alongside the
      // lineage so the worker can pass it to artifact_create / artifact_update.
      const finalRepositoryId = resolvedRepositoryId
        ?? this.persistence.readTaskProjectRepositoryId(taskId);
      const finalBinding = finalRepositoryId !== null
        ? { ...processBinding, project_repository_id: finalRepositoryId }
        : processBinding;
      this.persistence.bindProjectedTaskProcessContext?.({
        taskId,
        processRunId: ctx.processRunId,
        nodeId: node.id,
        moduleRef: finalBinding.process_module_ref,
        processInputHash: finalBinding.process_input_hash,
        nodeInput: finalBinding.process_node_input,
        nodeInputHash: finalBinding.process_node_input_hash,
        // bindProjectedTaskProcessContext already accepts arbitrary metadata
        // keys; project_repository_id is one such reserved key it merges in.
        projectRepositoryId: finalRepositoryId,
        managedReviewBudget: profile.reviewSkill
          ? profile.retryPolicy.maxAttempts
          : null,
      });

      // 3. Prepare (CAS open→executing guard) — handles resume of a stale fence.
      const preparation = this.persistence.prepareIntentForExecution(intent.id, taskId);
      if (preparation.status === 'done') {
        // Already concluded by a prior run (replay).
        this.persistence.setIntentStatus(intent.id, preparation.intentStatus, 'concluded');
        const replayedExecutionId =
          this.persistence.readLatestManagedProductionExecutionId?.(
            taskId,
            ctx.processRunId,
            node.id,
          )
          ?? this.persistence.readLatestExecutionId(taskId);
        return {
          runtimeEvent: 'completed',
          receipt: {
            kind: 'task-execution',
            executorKind: 'lm',
            intentId: intent.id,
            taskId,
            executionId: replayedExecutionId,
            runtimeStatus: 'completed',
            replayed: true,
          },
          // W3-A2 (spec §5): dual-emit the driver-neutral receipt. Board/task/
          // WorkIntent IDs travel inside adapterData; the legacy receipt is
          // retained for backward compatibility (dual-write, plan §16.9).
          driverReceipt: this.buildDriverNeutralReceipt({
            intentId: intent.id,
            taskId,
            executionId: replayedExecutionId,
            runtimeStatus: 'completed',
            replayed: true,
            lineage: finalBinding,
            envelope,
          }),
        };
      }
      if (preparation.status === 'active') {
        const activeExecutionId = this.persistence.readCurrentExecutionId(taskId)
          ?? this.persistence.readLatestExecutionId(taskId);
        return {
          runtimeEvent: 'paused',
          receipt: {
            kind: 'task-execution',
            executorKind: 'lm',
            intentId: intent.id,
            taskId,
            executionId: activeExecutionId,
            runtimeStatus: 'paused',
            replayed: true,
          },
          driverReceipt: this.buildDriverNeutralReceipt({
            intentId: intent.id,
            taskId,
            executionId: activeExecutionId,
            runtimeStatus: 'paused',
            replayed: true,
            lineage: finalBinding,
            envelope,
          }),
        };
      }
      if (preparation.status === 'blocked') {
        throw new NodeExecutionError('lm', node.id, `projected task ${taskId} is blocked`);
      }

      // 4. Claim the WorkIntent before even constructing a worker executor.
      // A concurrent driver that loses this CAS must not allocate or start a
      // second worker for the same projected task.
      if (!this.persistence.setIntentStatus(intent.id, preparation.intentStatus, 'executing')) {
        const lostExecutionId = this.persistence.readCurrentExecutionId(taskId)
          ?? this.persistence.readLatestExecutionId(taskId);
        return {
          runtimeEvent: 'paused',
          receipt: {
            kind: 'task-execution',
            executorKind: 'lm',
            intentId: intent.id,
            taskId,
            executionId: lostExecutionId,
            runtimeStatus: 'paused',
            replayed: true,
          },
          driverReceipt: this.buildDriverNeutralReceipt({
            intentId: intent.id,
            taskId,
            executionId: lostExecutionId,
            runtimeStatus: 'paused',
            replayed: true,
            lineage: finalBinding,
            envelope,
          }),
        };
      }
      let workerExecutor: WorkerExecutor | null = null;
      try {
        const workerCtx = this.resolveWorkerContext(ctx);
        workerExecutor = this.workerExecutorFactory(workerCtx);
        ctx.heartbeat();
        workerExecutor.start({
          projectId: ctx.projectId,
          epicId: ctx.epicId,
          concurrency: 1,
          claimScope: { taskIds: [taskId] },
        });
      } catch (error) {
        this.persistence.setIntentStatus(intent.id, 'executing', 'paused');
        try { workerExecutor?.dispose(); } catch { /* best effort */ }
        throw error;
      }
      const executor = workerExecutor;

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
      let executionId = this.persistence.readCurrentExecutionId(taskId);
      try {
        while (true) {
          ctx.heartbeat();
          executionId ??= this.persistence.readCurrentExecutionId(taskId);
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
      } catch (error) {
        this.persistence.setIntentStatus(intent.id, 'executing', 'paused');
        throw error;
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
        const cleanExecutionId = executionId ?? this.persistence.readLatestExecutionId(taskId);
        return {
          runtimeEvent: 'completed',
          receipt: {
            kind: 'task-execution',
            executorKind: 'lm',
            intentId: intent.id,
            taskId,
            executionId: cleanExecutionId,
            runtimeStatus: 'completed',
            replayed: false,
          },
          driverReceipt: this.buildDriverNeutralReceipt({
            intentId: intent.id,
            taskId,
            executionId: cleanExecutionId,
            runtimeStatus: 'completed',
            replayed: false,
            lineage: finalBinding,
            envelope,
          }),
        };
      }
      this.persistence.setIntentStatus(intent.id, 'executing', 'paused');
      const runtimeEvent =
        terminal === 'stopped'
        || terminal === 'timeout'
        || terminal === 'task_blocked'
        ? 'paused'
        : 'failed';
      const finalExecutionId = executionId ?? this.persistence.readLatestExecutionId(taskId);
      return {
        runtimeEvent,
        receipt: {
          kind: 'task-execution',
          executorKind: 'lm',
          intentId: intent.id,
          taskId,
          executionId: finalExecutionId,
          runtimeStatus: runtimeEvent,
          replayed: false,
        },
        driverReceipt: this.buildDriverNeutralReceipt({
          intentId: intent.id,
          taskId,
          executionId: finalExecutionId,
          runtimeStatus: runtimeEvent,
          replayed: false,
          lineage: finalBinding,
          envelope,
        }),
      };
    } catch (err) {
      if (err instanceof NodeExecutionError || err instanceof NodeExecutionLeaseLostError) throw err;
      throw new NodeExecutionError('lm', node.id, (err as Error).message, err);
    }
  }
}

function readRecoveryFeedback(input: unknown): RecoveryFeedback | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.schema !== RECOVERY_FEEDBACK_SCHEMA) return null;
  const bindings = record.bindings;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const feedback = (bindings as Record<string, unknown>).recoveryFeedback;
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) return null;
  const candidate = feedback as Partial<RecoveryFeedback>;
  if (
    candidate.schemaVersion !== RECOVERY_FEEDBACK_SCHEMA
    || !Number.isInteger(candidate.caseId)
    || !Number.isInteger(candidate.attempt)
    || typeof candidate.issueRef !== 'string'
    || typeof candidate.issueHash !== 'string'
    || !candidate.issue
  ) {
    throw new Error('LM_RECOVERY_FEEDBACK_INVALID: malformed recovery feedback input');
  }
  return candidate as RecoveryFeedback;
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
