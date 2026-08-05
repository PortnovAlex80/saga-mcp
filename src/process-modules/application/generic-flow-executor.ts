/**
 * GenericFlowExecutor — Universal ProcessModuleRuntime.
 *
 * Один executor на все модули. Читает ProcessModuleDefinition как данные,
 * исполняет FlowDefinition, двигает ProcessRun через статусную машину, валидирует
 * результат и возвращает local outcome. Ни одной строки не знает слова
 * "discovery" — предметное содержание поставляется через:
 *   - ProcessModuleDefinition (descriptor: flow, outcomes, profiles, policies);
 *   - KernelHandlerRegistry (handler'ы регистрируются модулем);
 *   - NodeExecutor registry (lm/kernel/…).
 *
 * Walk-алгоритм:
 *   1. process_run: created → preparing → running;
 *   2. от entryNodeId, по transitions, диспатчу каждый узел через NodeExecutor
 *      по node.kind, выбираю следующий переход по эмитированному event;
 *   3. каждый шаг пишет NodeRun (checkpoint для restart);
 *   4. на terminal node — settlement: validateProcessModuleRunResult →
 *      certificateRepo.issue → process_run running → settling → completed.
 *
 * Это и есть "Discovery как данные": Discovery Pack подключается через
 * регистрацию handlers/профилей в шаге 4, а этот executor остаётся неизменным.
 */

import { randomUUID } from 'node:crypto';
import { type ProcessModuleDefinition, processModuleKey } from '../domain/process-module.js';
import type {
  FlowNodeDefinition,
  FlowRecoveryDefinition,
  FlowTransitionDefinition,
} from '../domain/process-module.js';
import {
  RECOVERY_FEEDBACK_SCHEMA,
  RECOVERY_ISSUE_SCHEMA,
  type RecoveryFeedback,
  type RecoveryIssue,
} from '../domain/recovery.js';
import type {
  ProcessRunRepository,
} from '../persistence/process-run-repository.js';
import type {
  NodeRunRepository,
} from '../persistence/node-run.js';
import type {
  NodeRunRecord,
} from '../persistence/node-run.js';
import type {
  RecoveryCaseRepository,
} from '../persistence/recovery-case-repository.js';
import type {
  ProcessOutcomeCertificateRepository,
} from '../persistence/process-outcome-certificate-repository.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
} from '../persistence/process-run.js';
import type {
  NodeExecutionContext,
  NodeExecutionFrame,
  NodeExecutionReceipt,
  NodeExecutor,
  NodeExecutionResult,
  NodeProducts,
  NodeProduction,
} from './node-executor.js';
import type {
  ProcessModuleExecutionContext,
  ProcessModuleExecutor,
  ProcessModuleRunResult,
} from './process-module-executor.js';
import { validateProcessModuleRunResult } from './validate-process-module-run-result.js';
import { NodeExecutionLeaseLostError, nodeEventForTransition } from './node-executor.js';
import type {
  ExecutionContextEnvelope,
  ModuleCompletion,
  NodeProductionEnvelope,
  ProductRef,
} from '../domain/spi/index.js';
import type {
  AssembledExecutionContext,
  AssembleExecutionContextOptions,
  ProcessProductRepository as A5ProcessProductRepository,
} from './execution-context-assembler.js';
import { assembleExecutionContext } from './execution-context-assembler.js';
import type {
  NodeRunRecordV2,
  NodeRunRepositoryV2,
} from '../persistence/node-run-v2.js';

export interface GenericFlowExecutorOptions {
  moduleRef: ProcessModuleDefinition['identity'];
  processRunRepo: ProcessRunRepository;
  nodeRunRepo: NodeRunRepository;
  certificateRepo: ProcessOutcomeCertificateRepository;
  /** Node executors keyed by FlowNodeKind. Required: 'kernel'. */
  nodeExecutors: ReadonlyMap<string, NodeExecutor>;
  /** Durable, module-agnostic issue/repair state. Required by recovery flows. */
  recoveryCaseRepo?: RecoveryCaseRepository;
  /**
   * Optional hook producing the module's output artifact (ProcessModuleOutput)
   * from the terminal node's result. If absent, output is null. Modules that
   * emit a separate output artifact (Formalization: SolutionContract) register
   * this; modules whose certificate IS the output (Discovery) leave it null.
   */
  resolveOutput?: (
    module: ProcessModuleDefinition,
    terminalOutcome: string,
    terminalResult: NodeExecutionResult,
    context: ProcessModuleExecutionContext,
  ) => ProcessModuleOutput | null;
  /**
   * MANDATORY v2 driver-neutral envelope wiring. The walker activates the v2
   * path unconditionally: it calls `assembleExecutionContext` (driver-neutral
   * envelope), reads an explicit `ModuleCompletion` at settlement, and
   * dual-writes `NodeProductionEnvelope` via `nodeRunRepo.completeV2`. The
   * legacy `restoreFrame()` + legacy `complete` path has been deleted — the v2
   * path is the ONLY frame/completion path now.
   *
   * `nodeRunRepo` here MUST also implement {@link NodeRunRepositoryV2} (the
   * SqliteNodeRunRepository adapter does). {@link resolveV2Channel} throws
   * `NODE_RUN_REPO_V2_REQUIRED` when the repo lacks the v2 methods rather than
   * silently falling back.
   */
  v2: GenericFlowExecutorV2Options;
  /**
   * CGAD P18 — OPTIONAL centralized resolver that reads the workplace's (node's)
   * durable worker products (artifacts/traces/submission) scoped by
   * processRunId + moduleRef + nodeId, NEVER by task. When present, the executor
   * populates `ctx.nodeProducts` for every kernel node, so handlers read the
   * centralized products instead of querying the ledger themselves — every
   * module inherits P18 automatically. Absent ⇒ legacy run (handlers that still
   * query themselves keep working; formalization already does node-scope).
   */
  resolveNodeProducts?: (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ) => NodeProducts | null;
  /**
   * Kernel-gate callback: called when a recovery case is resolved (the
   * kernel verifier accepted the work). This is the single point where a
   * task in 'removed-legacy-status' is promoted to 'done' — NOT the review
   * approval (which sets removed-legacy-status). Absent ⇒ no auto-promotion
   * (the task stays in removed-legacy-status; only for modules without
   * recovery policies or where the module handles promotion itself).
   */
  onWorkplaceVerified?: (
    processRunId: number,
    repairNodeId: string,
  ) => void;
}

/**
 * Optional v2 wiring for {@link GenericFlowExecutorOptions}.
 *
 * `productRepo` is the exact-by-ProductRef port (consumed by the assembler).
 * `packageIdentity`/`flowIdentity`/`installedDigest` are forwarded to
 * `assembleExecutionContext` as the manifest pinning context. Callers without
 * an installation pin pass null and the assembler emits the
 * `'legacy:unpinned'` sentinel.
 */
export interface GenericFlowExecutorV2Options {
  productRepo: A5ProcessProductRepository;
  /**
   * Optional manifest-pin overrides forwarded to the assembler. May be omitted;
   * the assembler falls back to the run's moduleRef.
   */
  packageIdentity?: AssembleExecutionContextOptions['packageIdentity'];
  flowIdentity?: AssembleExecutionContextOptions['flowIdentity'];
  installedDigest?: AssembleExecutionContextOptions['installedDigest'];
}

/**
 * The resolved v2 channel the walker uses to run the driver-neutral envelope
 * path. Materialized by {@link GenericFlowExecutor.resolveV2Channel} from
 * {@link GenericFlowExecutorV2Options} plus a down-cast handle to the
 * {@link NodeRunRepositoryV2} side of the node-run repo (the SQLite adapter
 * implements both interfaces).
 */
interface V2Channel {
  repo: NodeRunRepositoryV2;
  productRepo: A5ProcessProductRepository;
  packageIdentity: AssembleExecutionContextOptions['packageIdentity'];
  flowIdentity: AssembleExecutionContextOptions['flowIdentity'];
  installedDigest: AssembleExecutionContextOptions['installedDigest'];
}

const PROCESS_RUN_LEASE_MS = 120_000;

export class ProcessRunBusyError extends Error {
  constructor(readonly processRunId: number) {
    super(`ProcessRun ${processRunId} is already owned by another executor`);
    this.name = 'ProcessRunBusyError';
  }
}

export class ProcessRunPausedError extends Error {
  constructor(
    readonly processRunId: number,
    readonly nodeId: string,
    readonly recoveryCaseId: number | null = null,
  ) {
    super(`ProcessRun ${processRunId} paused at node '${nodeId}' and can be resumed`);
    this.name = 'ProcessRunPausedError';
  }
}

export class RecoveryExhaustedError extends Error {
  constructor(
    readonly processRunId: number,
    readonly policyId: string,
    readonly recoveryCaseId: number,
  ) {
    super(
      `ProcessRun ${processRunId} exhausted recovery policy '${policyId}' `
        + `(case ${recoveryCaseId})`,
    );
    this.name = 'RecoveryExhaustedError';
  }
}

export class RecoveryFatalError extends Error {
  constructor(
    readonly processRunId: number,
    readonly nodeId: string,
    readonly reasonCode: string,
  ) {
    super(
      `ProcessRun ${processRunId} failed at recovery verifier '${nodeId}': ${reasonCode}`,
    );
    this.name = 'RecoveryFatalError';
  }
}

export class GenericFlowExecutor implements ProcessModuleExecutor {
  readonly moduleRef;
  readonly kind = 'generic-flow' as const;

  // (constructor parameters resolved via closure below)
  private readonly opts: GenericFlowExecutorOptions;

  constructor(options: GenericFlowExecutorOptions) {
    this.opts = options;
    this.moduleRef = options.moduleRef;
  }

  async execute(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
  ): Promise<ProcessModuleRunResult> {
    const { processRunRepo, nodeRunRepo, nodeExecutors } = this.opts;
    const run = processRunRepo.read(context.processRunId);
    if (!run) {
      throw new Error(`GenericFlowExecutor: process_run ${context.processRunId} not found`);
    }

    const leaseOwner = randomUUID();
    const renewLease = (): void => {
      const expiresAt = new Date(Date.now() + PROCESS_RUN_LEASE_MS).toISOString();
      if (!processRunRepo.renewExecutionLease(context.processRunId, leaseOwner, expiresAt)) {
        throw new NodeExecutionLeaseLostError(context.processRunId);
      }
    };
    const acquired = processRunRepo.acquireExecutionLease(
      context.processRunId,
      leaseOwner,
      new Date().toISOString(),
      new Date(Date.now() + PROCESS_RUN_LEASE_MS).toISOString(),
    );
    if (!acquired) {
      throw new ProcessRunBusyError(context.processRunId);
    }

    try {

    // Drive created → preparing → running.
    if (run.status === 'created') {
      processRunRepo.update(context.processRunId, { status: 'preparing' });
    }
    const prepared = processRunRepo.read(context.processRunId);
    if (prepared && prepared.status !== 'running' && prepared.status !== 'settling') {
      processRunRepo.update(context.processRunId, { status: 'running' });
    }
    renewLease();

    try {
      // Walk the flow from entry (or last completed NodeRun — restart support).
      const terminal = await this.walk(
        module,
        context,
        nodeRunRepo,
        nodeExecutors,
        renewLease,
      );

      // The settlement production carries the authority binding and, for
      // non-terminal kernels, the durable productions the data chain needs.
      // The certificate envelope is resolved from the MANDATORY terminal
      // `ModuleCompletion` (see below), NOT from `production.bindings`.
      const terminalBindings = (terminal.result.production?.bindings ?? {}) as Record<string, unknown>;
      const authority = (terminalBindings.authority as string | undefined) ?? null;

      const output = this.opts.resolveOutput
        ? this.opts.resolveOutput(module, terminal.outcome, terminal.result, context)
        : null;

      // Drive settling → completed transition. The certificate (if any) is
      // resolved below from the mandatory completion's certificateRef; a
      // completion without certificateRef yields `certificate = null` — the
      // clean contract for a non-certified terminal outcome (e.g. a
      // deterministic failure that legitimately produced no certificate).
      processRunRepo.update(context.processRunId, { status: 'settling' });

      // The certificate resolution has a SINGLE path: a terminal run MUST
      // produce an explicit ModuleCompletion. A terminal node that reaches
      // settlement WITHOUT a completion is a CONTRACT VIOLATION — the kernel
      // forgot to emit completion (a bug), or the failure-path swallowed a
      // Wave 8.5 made completion MANDATORY for settled outcomes — but a
      // terminal node like 'complete-failed' routes to a non-settlement outcome
      // (the run failed before settlement, or the outcome was rejected before
      // a certificate was issued). process-outcome-emitter forwards upstream
      // bindings but completion only arrives from settlement kernels. For
      // non-settled terminal nodes, certificate=null is legitimate (no
      // settlement ran, no certificate was issued). The throw is reserved for
      // settled outcomes where completion is genuinely missing (a kernel bug).
      const isFailedOutcome = terminal.outcome === 'failed' || terminal.outcome === 'inconclusive';
      const explicitCompletion = terminal.result.completion;
      if (!explicitCompletion && !isFailedOutcome) {
        throw new Error(
          `SETTLEMENT_COMPLETION_MISSING: terminal node '${terminal.nodeId}' `
          + `produced no ModuleCompletion; certificate cannot be resolved`,
        );
      }
      if (explicitCompletion) {
        assertExplicitModuleCompletion(explicitCompletion, terminal.outcome);
      }
      const explicitCertificateRef = explicitCompletion?.outputEnvelope.certificateRef ?? null;

      let certificate: ProcessModuleCertificateRef | null = null;
      if (explicitCertificateRef) {
        // Explicit path: the completion envelope owns the certificate reference.
        // The completion was already validated by assertExplicitModuleCompletion
        // (terminal flag + certificateRef shape). Surface the ref. The
        // certificate itself was issued by the module's settlement kernel and
        // recorded in the durable product store; the ref points at it by
        // content-address.
        certificate = {
          schema: explicitCertificateRef.schemaId,
          certificateRef: explicitCertificateRef.ref,
          certificateHash: explicitCertificateRef.digest,
        };
      }

      const runResult: ProcessModuleRunResult = {
        outcome: terminal.outcome,
        output,
        certificate,
        authority,
      };

      // Д7: validate the complete RunResult AFTER certificate issue but BEFORE
      // ProcessRun completion. On failure, ProcessRun flips to failed.
      const validation = validateProcessModuleRunResult(module, runResult);
      if (!validation.valid) {
        throw new Error(
          `GenericFlowExecutor: run result failed universal validation: ${validation.errors.join('; ')}`,
        );
      }

      // Drive settling → completed, writing terminal fields once.
      processRunRepo.update(context.processRunId, {
        status: 'completed',
        localOutcome: terminal.outcome,
        authority,
        output,
        certificate,
        activeIssue: null,
      });

      return runResult;
    } catch (err) {
      if (err instanceof ProcessRunPausedError) {
        const current = processRunRepo.read(context.processRunId);
        if (current && (current.status === 'running' || current.status === 'preparing')) {
          processRunRepo.update(context.processRunId, {
            status: 'paused',
            error: err.message,
          });
        }
        throw err;
      }
      if (err instanceof NodeExecutionLeaseLostError) {
        throw err;
      }
      // Best-effort transition to failed; record the reason.
      const message = (err as Error).message ?? String(err);
      try {
        const current = processRunRepo.read(context.processRunId);
        if (current && !isTerminal(current.status)) {
          processRunRepo.update(context.processRunId, {
            status: 'failed',
            error: message,
          });
        }
      } catch {
        /* terminal write-once may throw if already terminal; ignore */
      }
      throw err;
    }
    } finally {
      processRunRepo.releaseExecutionLease(context.processRunId, leaseOwner);
    }
  }

  private async walk(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
    nodeRunRepo: NodeRunRepository,
    nodeExecutors: ReadonlyMap<string, NodeExecutor>,
    heartbeat: () => void,
  ): Promise<{ outcome: string; nodeId: string; result: NodeExecutionResult }> {
    const flow = module.flow;
    const allRuns = nodeRunRepo.list(context.processRunId);
    // The v2 channel is mandatory (the legacy path is deleted). resolveV2Channel
    // throws V2_WIRING_REQUIRED / NODE_RUN_REPO_V2_REQUIRED on misconfiguration
    // instead of silently degrading to the v1 path.
    const v2 = this.resolveV2Channel(nodeRunRepo);
    // The frame every node executor reads (legacy `ctx.frame`) is built
    // DIRECTLY by the boundary adapter `assembleFrameFromDurableNodeRuns`,
    // which reads the durable NodeRun columns (outputRef/outputSchema/
    // outputHash/outputBindings/executionReceipt).
    const frame = assembleFrameFromDurableNodeRuns(context.inputPayload, allRuns);

    // Side-channel for the LAST non-terminal ModuleCompletion seen across the
    // node chain. Declared here (before the resume block) so the resume path
    // can seed it from durable rows. See the comment above the walk loop for
    // the full rationale.
    let pendingCompletion: ModuleCompletion | undefined;

    // Resume support: if the last completed NodeRun exists, start from the
    // transition out of it. Otherwise start at entry. The v2-shaped read
    // surfaces the persisted `completion` column (explicit ModuleCompletion)
    // so restoreNodeResult sees it — without it, crash-resume after a
    // terminal node would lose the certificate. The legacy fallback
    // (readLastCompleted) covers a row written before the v2 cutover; a v2
    // row is a superset of NodeRunRecord.
    const lastCompleted: NodeRunRecord | NodeRunRecordV2 | null =
      v2.repo.readLastCompletedV2(context.processRunId)
      ?? nodeRunRepo.readLastCompleted(context.processRunId);
    let currentNodeId: string;
    let resumedRecoveryInput: NodeProduction | null = null;
    let pausedVerifierInput: unknown;
    let recheckPausedVerifier = false;
    let reexecutePausedNode = false;
    if (lastCompleted) {
      const restoredResult = restoreNodeResult(lastCompleted);
      recheckPausedVerifier = this.shouldRecheckPausedVerifier(
        context,
        lastCompleted,
      );
      reexecutePausedNode =
        recheckPausedVerifier
        || lastCompleted.event === 'runtime.paused';
      // Seed pendingCompletion for the resume paths. When a crash happens
      // AFTER a settlement kernel wrote its completion but BEFORE the terminal
      // emitter ran (or AFTER the emitter ran but before ProcessRun reached
      // 'completed'), the resume must still surface the upstream completion as
      // terminal.result.completion so settlement reads the explicit certificate
      // ref. We scan the durable rows for the LAST non-terminal completion,
      // which converges crash-resume and fresh runs on the same
      // terminal.result.completion. The reexecutePausedNode branch (verifier/
      // paused re-run) is excluded: a re-executed node may emit a fresh
      // completion the loop captures instead.
      if (!reexecutePausedNode) {
        pendingCompletion = restoreLastNonTerminalCompletion(
            flow, allRuns, v2, context.processRunId)
          ?? restoredResult.completion;
      }
      if (reexecutePausedNode) {
        currentNodeId = lastCompleted.nodeId;
        // Rehydrate the recovery feedback for the repair LM-node. When the
        // verifier re-executes on resume with a persisted recoveryIssue, the
        // NEXT node (the repair LM-node) needs the feedbackProduction as its
        // chainInput — otherwise the worker runs blind and the loop exhausts.
        // The feedback is rehydrated from the durable recovery_case attempts
        // (feedback_snapshot is persisted), keyed by the verifier's policy.
        let resumedFeedback: RecoveryFeedback | null = null;
        if (lastCompleted.recoveryIssue && this.opts.recoveryCaseRepo) {
          // The case may be 'active' OR already 'exhausted' (the verifier
          // re-runs on resume after exhaustion). readActive filters by
          // status='active', so fall back to the process_run's pinned
          // activeIssue.recoveryCaseId, then to the latest case for the
          // policy regardless of status.
          const resumeRun = this.opts.processRunRepo.read(context.processRunId);
          const caseId = resumeRun?.activeIssue?.recoveryCaseId ?? null;
          const policy = (module.flow.recovery ?? [])
            .find(p => p.verifyNodeId === lastCompleted.nodeId);
          let recoveryCase = caseId
            ? this.opts.recoveryCaseRepo.readCase(caseId)
            : null;
          if (!recoveryCase && policy) {
            recoveryCase = this.opts.recoveryCaseRepo.readActiveForVerifier(
              context.processRunId,
              lastCompleted.nodeId,
            ) ?? this.opts.recoveryCaseRepo.readActive(
              context.processRunId,
              policy.id,
            );
          }
          if (!recoveryCase && policy) {
            // Last resort: newest case for this policy, any status.
            const all = this.opts.recoveryCaseRepo.listForProcessRun(context.processRunId);
            recoveryCase = all.find(c => c.policyId === policy.id) ?? null;
          }
          if (recoveryCase) {
            const attempts = this.opts.recoveryCaseRepo.listAttempts(recoveryCase.id);
            resumedFeedback = attempts.length > 0
              ? attempts[attempts.length - 1].feedback
              : null;
          }
        }
        pausedVerifierInput = inputBeforeNodeRun(
          context.inputPayload,
          allRuns,
          lastCompleted.id,
          resumedFeedback,
        );
        // An exhausted recovery case is terminal — it must not be mutated by a
        // re-run of the verifier. Resolve it (and clear activeIssue) so that if
        // the verifier still rejects on this resume, recordIssue opens a
        // brand-new case with a fresh attempt budget instead of colliding with
        // the exhausted one (RECOVERY_SOURCE_NODE_RUN_REUSED_WITH_DIFFERENT_ISSUE).
        if (recheckPausedVerifier) {
          const resumeRun = this.opts.processRunRepo.read(context.processRunId);
          const caseId = resumeRun?.activeIssue?.recoveryCaseId ?? null;
          const policy = (module.flow.recovery ?? [])
            .find(p => p.verifyNodeId === lastCompleted.nodeId);
          if (
            caseId
            && this.opts.recoveryCaseRepo
            && policy
            && this.opts.recoveryCaseRepo.readCase(caseId)?.status === 'exhausted'
          ) {
            this.opts.recoveryCaseRepo.resolveActive(
              context.processRunId,
              policy.id,
              lastCompleted.id,
            );
            this.opts.processRunRepo.update(context.processRunId, { activeIssue: null });
          }
        }
      } else {
        resumedRecoveryInput = this.reconcileRecoveryCheckpoint(
          module,
          context,
          lastCompleted,
          restoredResult,
        ).feedbackProduction;
      }
      const resumed = reexecutePausedNode
        ? lastCompleted.nodeId
        : this.nextNode(flow, lastCompleted.nodeId, lastCompleted.event ?? '');
      if (resumed === null) {
        // The resumed node was terminal — re-emit its outcome.
        const terminalNode = this.findNode(flow, lastCompleted.nodeId);
        if (terminalNode?.emitsOutcome) {
          // Rebuild production from durable NodeRun output_ref + bindings.
          // The bindings carry the certificate envelope the previous run
          // produced, so settlement/certificate replay works on restart.
          // restoreNodeResult already surfaces completion from the durable v2
          // column, so the resume terminal path inherits the same explicit
          // completion the fresh terminal path does — no merge needed.
          return {
            outcome: terminalNode.emitsOutcome,
            nodeId: lastCompleted.nodeId,
            result: restoredResult,
          };
        }
        throw new Error(`GenericFlowExecutor: cannot resume — node ${lastCompleted.nodeId} has no outgoing transition and is not terminal`);
      }
      currentNodeId = resumed;
    } else {
      currentNodeId = flow.entryNodeId;
    }

    // Bound malformed cycles independently from each recovery policy's own
    // semantic budget. Valid repair paths may revisit several ordinary nodes.
    const totalRepairBudget = (flow.recovery ?? [])
      .reduce((total, policy) => total + policy.maxAttempts, 0);
    const maxSteps = flow.nodes.length * 4
      + totalRepairBudget * (flow.nodes.length + 2)
      + 10;

    // Executor-side completion tracking (side-channel). The module settlement
    // kernels emit `completion: ModuleCompletion` in their KernelHandlerResult,
    // and it is persisted to the NodeRun + restored on crash-resume. BUT the
    // terminal node (complete-<code>) is served by the runtime-owned
    // `process-outcome-emitter`, which does NOT emit a completion (it is
    // generic — it forwards upstream bindings, not the typed completion
    // envelope). Without this side-channel merge, the executor would read
    // `terminal.result.completion` as undefined and could not resolve the
    // explicit certificate ref.
    //
    // The fix tracks the LAST non-terminal `completion` seen across the node
    // chain as a side-channel (it does NOT pollute chainInput — completion is a
    // settlement-time concern, not a data-chain value). When the terminal step
    // completes without its own completion, the executor merges the tracked
    // completion onto `terminal.result.completion` so execute()'s explicit
    // path engages. (`pendingCompletion` is declared above, before the resume
    // block, so the resume path can seed it too.)

    // The first node receives the module input payload. Each subsequent node
    // receives the PREVIOUS node's output — this is the data chain that lets a
    // settlement kernel handler read the proposal produced by the LM node
    // upstream, without the executor knowing the module vocabulary.
    //
    // On restart, if a NodeRun already completed in this ProcessRun, the
    // chainInput is RESTORED from that NodeRun's durable output_bindings — not
    // re-initialised from the module input. This preserves the exact lineage
    // (proposalId, controlIntentId, certificatePayload, …) the previous run
    // produced, so resuming the next node sees the same upstream context.
    let chainInput: unknown = context.inputPayload;
    const lastCompletedForChain = nodeRunRepo.readLastCompleted(context.processRunId);
    if (reexecutePausedNode) {
      chainInput = pausedVerifierInput;
    } else if (resumedRecoveryInput) {
      chainInput = resumedRecoveryInput;
    } else if (lastCompletedForChain?.executionReceipt) {
      chainInput = lastCompletedForChain.executionReceipt;
    } else if (lastCompletedForChain?.outputBindings || lastCompletedForChain?.outputRef) {
      chainInput = restoreProduction(lastCompletedForChain);
    }

    for (let step = 0; step < maxSteps; step += 1) {
      heartbeat();
      const node = this.findNode(flow, currentNodeId);
      if (!node) {
        throw new Error(`GenericFlowExecutor: node '${currentNodeId}' not in flow`);
      }

      const executor = nodeExecutors.get(node.kind);
      if (!executor) {
        throw new Error(
          `GenericFlowExecutor: no NodeExecutor registered for kind '${node.kind}' `
            + `(node '${node.id}')`,
        );
      }

      // Start the NodeRun via `startV2` (which writes the legacy columns AND
      // the v2 envelope-marker columns). The v2 path also assembles the
      // ExecutionContextEnvelope and dual-populates the context (`envelope` for
      // v2-aware executors, `frame` computed via mergeLegacyFrame for legacy
      // executors).
      const upstreamRefs = declareUpstreamRefs(chainInput, frame, node.id);
      const v2Row = v2.repo.startV2({
        processRunId: context.processRunId,
        nodeId: node.id,
        nodeKind: node.kind,
        inputEnvelopeHash: null, // stamped after assembly so it covers the
        // exact envelope the node sees; completeV2 persists the production
        // envelope + cursor. The marker is the row's presence + non-null
        // production_envelope on completion.
        predecessorNodeRunIds: predecessorIdsFor(allRuns, node.id),
      });
      const nodeRunId = v2Row.id;
      const nodeRunAttempt = v2Row.attempt;
      let assembled: AssembledExecutionContext;
      try {
        assembled = await assembleExecutionContext(
          context.processRunId,
          node.id,
          nodeRunAttempt,
          upstreamRefs,
          {
            productRepo: v2.productRepo,
            processRunRepo: this.opts.processRunRepo,
            nodeRunRepo,
          },
          {
            packageIdentity: v2.packageIdentity,
            flowIdentity: v2.flowIdentity,
            installedDigest: v2.installedDigest,
          },
        );
      } catch (err) {
        nodeRunRepo.fail({
          id: nodeRunId,
          errorMessage: (err as Error).message ?? String(err),
        });
        throw err;
      }

      // Build the context. The legacy `frame` is ALWAYS populated (legacy
      // executors read it) and refreshed from the assembled envelope via
      // mergeLegacyFrame so the legacy and v2 views agree. `envelope` +
      // `upstreamProductBodies` are always present so v2-aware executors can
      // read the driver-neutral envelope.
      const ctx: NodeExecutionContext = {
        projectId: context.projectId,
        epicId: context.epicId,
        processRunId: context.processRunId,
        module,
        node,
        input: chainInput,
        frame: mergeLegacyFrame(frame, assembled.envelope),
        heartbeat,
        initiatedBy: context.initiatedBy,
        envelope: assembled.envelope,
        upstreamProductBodies: assembled.upstreamProductBodies.map(
          (r) => (r as { payload?: unknown }).payload ?? r,
        ),
        // CGAD P18 — centralized node-scoped worker products. Resolved once per
        // node execution by the executor, so kernel handlers read ctx.nodeProducts
        // instead of querying the ledger by transient task identity.
        ...(this.opts.resolveNodeProducts && node.kind === 'kernel'
          ? {
              nodeProducts: this.opts.resolveNodeProducts(
                context.processRunId,
                processModuleKey(module.identity),
                node.id,
              ) ?? undefined,
            }
          : {}),
      };

      let result: NodeExecutionResult;
      try {
        result = await executor.execute(ctx);
        assertNodeExecutionResult(node, result);
        heartbeat();
      } catch (err) {
        nodeRunRepo.fail({
          id: nodeRunId,
          errorMessage: (err as Error).message ?? String(err),
        });
        throw err;
      }

      const outputRef = result.production?.artifactRef ?? null;
      const outputSchema = result.production?.schema ?? null;
      const outputHash = result.production?.contentHash ?? null;
      const outputBindings = result.production?.bindings ?? null;
      // Dual-write. `completeV2` writes BOTH the legacy output_* columns AND
      // the v2 production_envelope + transition_cursor. The production
      // envelope is sourced from the result's explicit `productionEnvelope`
      // (v2 producers) or derived from the legacy flat `production` when only
      // the legacy field is present (all current producers — they emit v1).
      const transitionEvent = nodeEventForTransition(result);
      const productionEnvelope: NodeProductionEnvelope | null =
        result.productionEnvelope ?? deriveEnvelope(result.production) ?? null;
      const completedNodeRun: NodeRunRecordV2 | NodeRunRecord = v2.repo.completeV2({
        id: nodeRunId,
        event: transitionEvent,
        outputRef,
        outputSchema,
        outputHash,
        outputBindings,
        executionReceipt: result.receipt as unknown as Record<string, unknown> | undefined,
        acceptanceReceipt: result.acceptanceReceipt as unknown as
          | Record<string, unknown>
          | undefined,
        recoveryIssue: result.recoveryIssue,
        productionEnvelope,
        transitionCursor: assembled.envelope.nodeRef.nodeId,
        // Persist the explicit ModuleCompletion so crash-resume can rebuild
        // NodeExecutionResult.completion and settlement reads the explicit
        // certificate ref. Undefined when the node did not emit a completion
        // — persisted as NULL.
        completion: result.completion,
      });

      if (result.runtimeEvent === 'paused') {
        throw new ProcessRunPausedError(context.processRunId, node.id);
      }

      if (result.production) frame.productions[node.id] = result.production;
      if (result.receipt) frame.receipts[node.id] = result.receipt;

      const recovery = this.reconcileRecoveryCheckpoint(
        module,
        context,
        completedNodeRun,
        result,
      );

      // Forward the node's production (durable ref) to the next node in the
      // chain. Downstream kernel nodes (settlement) read exact bindings from
      // production.bindings and re-read canonical rows from durable storage —
      // never from "latest by epic" and never from raw runtime objects.
      chainInput = recovery.feedbackProduction
        ?? result.production
        ?? result.receipt
        ?? chainInput;

      // Track the LAST non-terminal completion as a side-channel. Settlement
      // kernels emit `completion`; the terminal outcome-emitter does not. By
      // capturing it here (before the terminal check), the merge below can
      // surface it as terminal.result.completion. This does NOT pollute
      // chainInput — completion is a settlement concern, not a data-chain
      // value. The terminal-emitter node is excluded by the `node.emitsOutcome`
      // guard below: terminal nodes never reach this branch (they return
      // early), so only settlement/intermediate kernel completions are tracked.
      if (!node.emitsOutcome && result.completion) {
        pendingCompletion = result.completion;
      }

      // Terminal node — emit its outcome.
      if (node.emitsOutcome) {
        // Merge the tracked upstream completion onto the terminal result when
        // the terminal emitter produced none. The process-outcome-emitter is
        // generic and forwards bindings, not the typed completion envelope, so
        // terminal.result.completion is otherwise undefined. Merging here makes
        // execute()'s explicitCertificateRef branch engage. We do NOT overwrite
        // a completion the terminal emitter itself may one day emit
        // (defensive: a future terminal handler that sets its own completion
        // wins over the tracked upstream one).
        if (!result.completion && pendingCompletion) {
          result = { ...result, completion: pendingCompletion };
        }
        return { outcome: node.emitsOutcome, nodeId: node.id, result };
      }

      // Otherwise advance via the transition whose `on` matches the event.
      const nextId = this.nextNode(flow, node.id, nodeEventForTransition(result));
      if (!nextId) {
        throw new Error(
          `GenericFlowExecutor: node '${node.id}' emitted event '${nodeEventForTransition(result)}' `
            + `but no transition matches and the node is not terminal`,
        );
      }
      currentNodeId = nextId;
    }

    throw new Error(
      `GenericFlowExecutor: flow walk exceeded ${maxSteps} steps — possible transition cycle`,
    );
  }

  /**
   * Resolve the MANDATORY v2 channel for this run. Returns the v2 options
   * bundle plus a down-cast handle to the {@link NodeRunRepositoryV2} side of
   * the node-run repo (the SQLite adapter implements both interfaces).
   *
   * Throws (clear failure, NOT silent v1 fallback) when:
   *   - `this.opts.v2` is absent → `V2_WIRING_REQUIRED` (the executor was
   *     constructed without v2 wiring; the v1 path is deleted so this is a
   *     wiring bug, not a recoverable legacy state).
   *   - `nodeRunRepo` lacks the v2 methods → `NODE_RUN_REPO_V2_REQUIRED`
   *     (e.g. an in-memory fake that did not implement NodeRunRepositoryV2).
   *
   * Pure with respect to the executor state — same opts + repo → same channel.
   */
  private resolveV2Channel(nodeRunRepo: NodeRunRepository): V2Channel {
    const v2Opts = this.opts.v2;
    if (!v2Opts) {
      throw new Error(
        'V2_WIRING_REQUIRED: GenericFlowExecutor was constructed without v2 '
          + 'wiring, but the v1 frame/completion path has been deleted. Pass '
          + '`v2: { productRepo }` (the pattern in '
          + 'v2-production-completion-roundtrip.test.mjs) when constructing '
          + 'the executor.',
      );
    }
    const repoV2 = nodeRunRepo as unknown as Partial<NodeRunRepositoryV2>;
    if (
      typeof repoV2.startV2 !== 'function'
      || typeof repoV2.completeV2 !== 'function'
      || typeof repoV2.readByExactCursor !== 'function'
    ) {
      throw new Error(
        'NODE_RUN_REPO_V2_REQUIRED: GenericFlowExecutor.v2 is configured but '
          + 'nodeRunRepo does not implement NodeRunRepositoryV2 '
          + '(startV2/completeV2/readByExactCursor). The SQLite adapter '
          + 'implements both; an in-memory fake must expose the v2 methods. '
          + 'The v1 frame/completion path has been deleted — there is no '
          + 'silent fallback.',
      );
    }
    return {
      repo: repoV2 as NodeRunRepositoryV2,
      productRepo: v2Opts.productRepo,
      packageIdentity: v2Opts.packageIdentity,
      flowIdentity: v2Opts.flowIdentity,
      installedDigest: v2Opts.installedDigest,
    };
  }

  private shouldRecheckPausedVerifier(
    context: ProcessModuleExecutionContext,
    nodeRun: NodeRunRecord,
  ): boolean {
    const issue = nodeRun.recoveryIssue;
    if (!issue) return false;
    if (issue.disposition === 'human') return true;
    const run = this.opts.processRunRepo.read(context.processRunId);
    const caseId = run?.activeIssue?.recoveryCaseId;
    if (!caseId || !this.opts.recoveryCaseRepo) return false;
    return this.opts.recoveryCaseRepo.readCase(caseId)?.status === 'exhausted';
  }

  private reconcileRecoveryCheckpoint(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
    nodeRun: NodeRunRecord,
    result: NodeExecutionResult,
  ): { feedbackProduction: NodeProduction | null } {
    const event = nodeRun.event ?? nodeEventForTransition(result);
    const issue = nodeRun.recoveryIssue ?? result.recoveryIssue;

    if (!issue) {
      this.resolveSuccessfulRecovery(module, context, nodeRun, event);
      // Kernel-gate first-pass: the verifier accepted the work on the first
      // try (no recovery case was opened). Promote the repair node's task
      // from removed-legacy-status → done. resolveSuccessfulRecovery only
      // promotes when a case was actually resolved; this covers the case
      // where no case existed at all (first success).
      if (this.opts.onWorkplaceVerified) {
        for (const policy of module.flow.recovery ?? []) {
          if (
            policy.verifyNodeId === nodeRun.nodeId
            && policy.resolvedEvents.includes(event)
          ) {
            this.opts.onWorkplaceVerified(context.processRunId, policy.repairNodeId);
          }
        }
      }
      return { feedbackProduction: null };
    }

    assertRecoveryIssue(issue);
    if (issue.disposition === 'fatal') {
      throw new RecoveryFatalError(
        context.processRunId,
        nodeRun.nodeId,
        issue.reasonCode,
      );
    }

    const policy = (module.flow.recovery ?? [])
      .find(candidate => candidate.id === issue.policyId);
    if (!policy) {
      throw new Error(
        `GenericFlowExecutor: node '${nodeRun.nodeId}' emitted recovery policy `
          + `'${issue.policyId}' that is not declared by module`,
      );
    }
    assertRecoveryRoute(policy, nodeRun.nodeId, event);

    const recoveryCaseRepo = this.opts.recoveryCaseRepo;
    if (!recoveryCaseRepo) {
      throw new Error(
        `GenericFlowExecutor: module recovery policy '${policy.id}' requires `
          + 'a RecoveryCaseRepository',
      );
    }
    if (!result.production) {
      throw new Error(
        `GenericFlowExecutor: recovery verifier '${nodeRun.nodeId}' must emit `
          + 'a durable production together with its issue',
      );
    }

    const recorded = recoveryCaseRepo.recordIssue({
      processRunId: context.processRunId,
      moduleRef: module.identity,
      sourceNodeRunId: nodeRun.id,
      verifyNodeId: policy.verifyNodeId,
      repairNodeId: policy.repairNodeId,
      maxAttempts: policy.maxAttempts,
      issue,
      sourceProduction: result.production,
    });
    this.opts.processRunRepo.update(context.processRunId, {
      activeIssue: {
        recoveryCaseId: recorded.caseRecord.id,
        issueRef: recorded.feedback.issueRef,
        issueHash: recorded.feedback.issueHash,
      },
      error: issue.summary,
    });

    if (issue.disposition === 'human' || recorded.exhausted) {
      if (recorded.exhausted && policy.onExhausted === 'fail') {
        throw new RecoveryExhaustedError(
          context.processRunId,
          policy.id,
          recorded.caseRecord.id,
        );
      }
      throw new ProcessRunPausedError(
        context.processRunId,
        nodeRun.nodeId,
        recorded.caseRecord.id,
      );
    }

    return {
      feedbackProduction: recoveryFeedbackProduction(
        recorded.feedback,
        recorded.attemptRecord.feedbackHash,
      ),
    };
  }

  private resolveSuccessfulRecovery(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
    nodeRun: NodeRunRecord,
    event: string,
  ): void {
    const recoveryCaseRepo = this.opts.recoveryCaseRepo;
    if (!recoveryCaseRepo) return;
    let resolved = false;
    for (const policy of module.flow.recovery ?? []) {
      if (
        policy.verifyNodeId !== nodeRun.nodeId
        || !policy.resolvedEvents.includes(event)
      ) {
        continue;
      }
      const record = recoveryCaseRepo.resolveActive(
        context.processRunId,
        policy.id,
        nodeRun.id,
      );
      if (record) resolved = true;
    }
    if (resolved) {
      this.opts.processRunRepo.update(context.processRunId, {
        activeIssue: null,
        error: null,
      });
      // Note: onWorkplaceVerified is called by reconcileRecoveryCheckpoint
      // (the caller) for BOTH first-pass success and recovery-resolve success.
      // It iterates the recovery policies and promotes the repair node's task.
      // We do NOT call it here to avoid double-promotion.
    }
  }

  private findNode(flow: ProcessModuleDefinition['flow'], nodeId: string): FlowNodeDefinition | null {
    for (const n of flow.nodes) {
      if (n.id === nodeId) return n;
    }
    return null;
  }

  private nextNode(
    flow: ProcessModuleDefinition['flow'],
    fromNodeId: string,
    event: string,
  ): string | null {
    let fallback: string | null = null;
    for (const t of flow.transitions as readonly FlowTransitionDefinition[]) {
      if (t.from !== fromNodeId) continue;
      // Exact event match wins.
      if (t.on === event) return t.to;
      // '*' acts as a wildcard/default edge (used by terminal emitters that
      // don't key on event).
      if (t.on === '*') fallback = t.to;
    }
    return fallback;
  }
}

function restoreNodeResult(run: NodeRunRecord | NodeRunRecordV2): NodeExecutionResult {
  // Restore the explicit ModuleCompletion from the persisted v2 `completion`
  // column when present. This is the crash-resume linchpin: a crash AFTER a
  // terminal node wrote its completion MUST be resumable with the completion
  // intact, otherwise settlement loses the certificate. Legacy rows
  // (NodeRunRecord without the v2 field, or v2 row with completion=null)
  // surface completion as undefined.
  const v2Run = run as NodeRunRecordV2;
  const completion = v2Run.completion ?? undefined;
  return {
    runtimeEvent: 'completed',
    receipt: run.executionReceipt
      ? run.executionReceipt as unknown as NodeExecutionReceipt
      : undefined,
    production: run.outputRef || run.outputBindings
      ? restoreProduction(run)
      : undefined,
    recoveryIssue: run.recoveryIssue ?? undefined,
    acceptanceReceipt: run.acceptanceReceipt
      ? run.acceptanceReceipt as unknown as NodeExecutionResult['acceptanceReceipt']
      : undefined,
    completion,
  };
}

/**
 * Find the LAST non-terminal completion persisted in the durable NodeRun rows,
 * for crash-resume seeding of `pendingCompletion`.
 *
 * Scans the v2 rows (which carry the `completion` column) in descending order
 * and returns the first non-null completion whose node is NOT a terminal
 * outcome-emitter (terminal nodes never carry an authoritative completion —
 * process-outcome-emitter does not emit one). This is the same side-channel
 * the fresh-run loop tracks, so crash-resume and fresh runs converge on the
 * same `terminal.result.completion`. Returns `undefined` when there are no
 * rows or no non-terminal completion (the common case for a fresh run with no
 * prior settlement node).
 *
 * The v2 channel is mandatory (non-null) — the caller resolves it via
 * resolveV2Channel before invoking this. Pure: same (flow, v2, processRunId)
 * → same completion.
 */
function restoreLastNonTerminalCompletion(
  flow: ProcessModuleDefinition['flow'],
  _allRuns: readonly NodeRunRecord[],
  v2: V2Channel,
  processRunId: number,
): ModuleCompletion | undefined {
  // Build a quick lookup of which nodes are terminal (emitsOutcome set).
  const terminalNodeIds = new Set<string>();
  for (const n of flow.nodes) {
    if (n.emitsOutcome) terminalNodeIds.add(n.id);
  }
  let rows: readonly NodeRunRecordV2[];
  try {
    rows = v2.repo.listV2(processRunId);
  } catch {
    return undefined;
  }
  // Descending by id so the LAST persisted completion wins (matches the loop's
  // "track the latest" semantics).
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  for (const row of sorted) {
    if (row.status !== 'completed') continue;
    if (terminalNodeIds.has(row.nodeId)) continue;
    if (row.completion) return row.completion;
  }
  return undefined;
}

function inputBeforeNodeRun(
  runInput: unknown,
  allRuns: readonly NodeRunRecord[],
  nodeRunId: number,
  recoveryFeedback?: RecoveryFeedback | null,
): unknown {
  const prior = [...allRuns]
    .filter(run => run.id < nodeRunId && run.status === 'completed')
    .sort((left, right) => right.id - left.id)[0];
  if (!prior) return runInput;
  // Recovery feedback survives engine restart. When the prior (verifier) NodeRun
  // emitted a recoveryIssue, the NEXT node (the repair LM-node) must receive the
  // feedbackProduction as its chainInput — NOT the verifier's own production.
  // Without this, the repair worker runs blind: no recovery-feedback.json on its
  // desk, so it recreates the same defect and the loop exhausts → pause.
  // The feedback is rehydrated by the caller from the durable recovery_case /
  // recovery_attempt rows (which persist feedback_snapshot), so no new
  // persistence is needed.
  if (recoveryFeedback && prior.recoveryIssue) {
    return recoveryFeedbackProduction(recoveryFeedback, recoveryFeedback.issueHash);
  }
  if (prior.executionReceipt) return prior.executionReceipt;
  if (prior.outputBindings || prior.outputRef) return restoreProduction(prior);
  return runInput;
}

function recoveryFeedbackProduction(
  feedback: RecoveryFeedback,
  feedbackHash: string,
): NodeProduction {
  return {
    schema: RECOVERY_FEEDBACK_SCHEMA,
    artifactRef: feedback.issueRef,
    contentHash: feedbackHash,
    bindings: {
      recoveryCaseId: feedback.caseId,
      recoveryAttempt: feedback.attempt,
      recoveryPolicyId: feedback.issue.policyId,
      recoveryIssueRef: feedback.issueRef,
      recoveryIssueHash: feedback.issueHash,
      recoveryFeedback: feedback,
    },
  };
}

function assertRecoveryIssue(issue: RecoveryIssue): void {
  if (
    issue.schemaVersion !== RECOVERY_ISSUE_SCHEMA
    || typeof issue.policyId !== 'string'
    || issue.policyId.trim() === ''
    || typeof issue.reasonCode !== 'string'
    || issue.reasonCode.trim() === ''
    || typeof issue.summary !== 'string'
    || issue.summary.trim() === ''
    || !['repair', 'retry', 'human', 'fatal'].includes(issue.disposition)
    || !Array.isArray(issue.findings)
    || !Array.isArray(issue.subjectRefs)
    || !Array.isArray(issue.acceptanceCriteria)
    || !Array.isArray(issue.allowedChanges)
    || (issue.requiredTools !== undefined && !Array.isArray(issue.requiredTools))
  ) {
    throw new Error('GenericFlowExecutor: malformed RecoveryIssue');
  }
}

function assertRecoveryRoute(
  policy: FlowRecoveryDefinition,
  nodeId: string,
  event: string,
): void {
  if (policy.verifyNodeId !== nodeId) {
    throw new Error(
      `GenericFlowExecutor: recovery policy '${policy.id}' belongs to verifier `
        + `'${policy.verifyNodeId}', not '${nodeId}'`,
    );
  }
  if (!policy.triggerEvents.includes(event)) {
    throw new Error(
      `GenericFlowExecutor: recovery policy '${policy.id}' does not handle event '${event}'`,
    );
  }
}

function restoreProduction(run: {
  outputRef: string | null;
  outputSchema: string | null;
  outputHash: string | null;
  outputBindings: Record<string, unknown> | null;
}): NodeProduction {
  return {
    schema: run.outputSchema ?? '',
    artifactRef: run.outputRef ?? '',
    contentHash: run.outputHash ?? '',
    bindings: run.outputBindings ?? {},
  };
}

// PRIMARY frame construction path: reads durable NodeRun rows DIRECTLY into a
// NodeExecutionFrame. `assembleFrameFromDurableNodeRuns` is the LIVE data
// source for every node executor's `ctx.frame` (legacy view) AND for
// `declareUpstreamRefs` (v2 ProductRef derivation) AND for `mergeLegacyFrame`
// (legacy+v2 frame merge).

/**
 * PRIMARY frame construction path.
 *
 * Reads durable NodeRun rows DIRECTLY into a {@link NodeExecutionFrame} — the
 * same shape the former `restoreFrame` produced — without the legacy
 * mutable-bag reconstruction. It reads the durable NodeRun columns
 * (`outputRef`/`outputSchema`/`outputHash`/`outputBindings`/
 * `executionReceipt`). The forward path is `assembleExecutionContext` + exact
 * `ProductRef` resolution via `getByProductRef`; this builder feeds both
 * `mergeLegacyFrame` (the `frame` view) and `declareUpstreamRefs` (the v2
 * ref derivation) from the same durable rows.
 *
 * Pure: same (runInput, runs) -> same frame. No side effects, no fallback to
 * epic-scope or latest-in-run search. A row contributes to the frame ONLY
 * when it is COMPLETED and not `runtime.paused`.
 */
export function assembleFrameFromDurableNodeRuns(
  runInput: unknown,
  runs: readonly {
    nodeId: string;
    status: string;
    event: string | null;
    outputRef: string | null;
    outputSchema: string | null;
    outputHash: string | null;
    outputBindings: Record<string, unknown> | null;
    executionReceipt: Record<string, unknown> | null;
  }[],
): NodeExecutionFrame {
  const frame: NodeExecutionFrame = {
    runInput,
    productions: {},
    receipts: {},
  };
  for (const run of runs) {
    if (run.status !== 'completed' || run.event === 'runtime.paused') continue;
    if (run.outputRef || run.outputBindings) {
      frame.productions[run.nodeId] = restoreProduction(run);
    }
    if (run.executionReceipt) {
      frame.receipts[run.nodeId] = run.executionReceipt as unknown as NodeExecutionReceipt;
    }
  }
  return frame;
}

// v2 path helpers. The v2 channel is always active (the v1 path is deleted,
// so resolveV2Channel always returns a channel or throws). These helpers are
// defensive: a legacy-shaped NodeRun (no v2 marker columns surfaced) makes
// them return safe empty values, so a row written before the v2 cutover does
// not break the walk.

/**
 * Declare the upstream ProductRefs the next node consumes. The v2 path hands
 * these to {@link assembleExecutionContext}, which loads each one by EXACT
 * content-address — NO epic-scope fallback.
 *
 * The executor itself does NOT know which products a node declares as its
 * inputs (that is module contract vocabulary the node's inputSchema carries).
 * The ContractBoundaryDecoder reads that declaration; until it is wired in,
 * the v2 path derives the upstream refs from the legacy `frame.productions`
 * map (every completed production in the run is a candidate predecessor)
 * PLUS the current chainInput when it is itself a production-shaped value.
 * This is the SAME data the legacy frame path would have surfaced, just
 * re-expressed as content-addressed refs — so the v2 path's upstream set is
 * a superset of what the legacy path forwarded, never a divergence.
 *
 * Returns an empty array when no productions are available (the entry node of
 * a fresh run); the assembler accepts that and returns an envelope with an
 * empty `upstreamProducts` list.
 */
function declareUpstreamRefs(
  chainInput: unknown,
  frame: NodeExecutionFrame,
  _nodeId: string,
): readonly ProductRef[] {
  const refs: ProductRef[] = [];
  const seen = new Set<string>();
  const add = (schema: string, ref: string, digest: string): void => {
    const key = `${schema}|${ref}|${digest}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ schemaId: schema, ref, digest });
  };
  for (const prod of Object.values(frame.productions)) {
    if (
      prod
      && typeof prod.schema === 'string' && prod.schema.length > 0
      && typeof prod.artifactRef === 'string' && prod.artifactRef.length > 0
      && typeof prod.contentHash === 'string' && prod.contentHash.length > 0
    ) {
      add(prod.schema, prod.artifactRef, prod.contentHash);
    }
  }
  // The chainInput may itself carry the most recent production (settlement
  // kernels receive the upstream LM production as their input). Surface it as
  // a candidate predecessor ref when it is production-shaped.
  const shaped = chainInput as { schema?: unknown; artifactRef?: unknown; contentHash?: unknown };
  if (
    shaped
    && typeof shaped.schema === 'string' && shaped.schema.length > 0
    && typeof shaped.artifactRef === 'string' && shaped.artifactRef.length > 0
    && typeof shaped.contentHash === 'string' && shaped.contentHash.length > 0
  ) {
    add(shaped.schema, shaped.artifactRef, shaped.contentHash);
  }
  return refs;
}

/**
 * Best-effort predecessor NodeRun ids for the v2 row's
 * `predecessor_node_run_ids` column. Derived from the same `allRuns` list the
 * frame adapter consumes: every COMPLETED prior NodeRun whose node id
 * contributed a production to the frame is a predecessor. Empty for the entry
 * node of a fresh run.
 */
function predecessorIdsFor(
  allRuns: readonly NodeRunRecord[],
  _nodeId: string,
): number[] {
  const ids: number[] = [];
  for (const run of allRuns) {
    if (run.status === 'completed' && run.event !== 'runtime.paused') {
      if (run.outputRef || run.outputBindings) {
        ids.push(run.id);
      }
    }
  }
  return ids;
}

/**
 * Merge the legacy `frame` view with the v2 envelope's upstream products.
 *
 * The v2 path keeps the legacy `frame.productions` map (populated by the
 * frame adapter from prior NodeRun rows) AND adds the envelope's exact
 * upstream ProductRefs as additional synthetic entries (keyed by their ref
 * string). This dual view lets legacy executors that read `frame.productions`
 * by node id keep working, while v2-aware executors read the envelope's
 * `upstreamProducts` directly. The two views agree on content (the envelope's
 * refs are a content-addressed re-expression of the same productions).
 */
function mergeLegacyFrame(
  legacy: NodeExecutionFrame,
  envelope: ExecutionContextEnvelope,
): NodeExecutionFrame {
  const merged: NodeExecutionFrame = {
    runInput: envelope.immutableRunInput ?? legacy.runInput,
    productions: { ...legacy.productions },
    receipts: { ...legacy.receipts },
  };
  for (const ref of envelope.upstreamProducts) {
    // Only add entries the legacy frame does not already carry under this key,
    // so we never overwrite a richer legacy production (with bindings) with a
    // minimal synthetic shell.
    if (!Object.prototype.hasOwnProperty.call(merged.productions, ref.ref)) {
      merged.productions[ref.ref] = {
        schema: ref.schemaId,
        artifactRef: ref.ref,
        contentHash: ref.digest,
        bindings: {},
      };
    }
  }
  return merged;
}

function assertNodeExecutionResult(
  node: FlowNodeDefinition,
  result: NodeExecutionResult,
): void {
  if (result.receipt && result.production) {
    throw new Error(
      `GenericFlowExecutor: node '${node.id}' returned both a physical receipt and a domain production`,
    );
  }
  if (node.kind === 'lm' && !result.receipt) {
    throw new Error(
      `GenericFlowExecutor: LM node '${node.id}' must return an execution receipt, not a domain production`,
    );
  }
  if (!result.receipt) return;
  const receipt = result.receipt;
  if (
    receipt.kind !== 'task-execution'
    || receipt.executorKind !== node.kind
    || receipt.runtimeStatus !== result.runtimeEvent
    || !Number.isInteger(receipt.intentId)
    || receipt.intentId <= 0
    || !Number.isInteger(receipt.taskId)
    || receipt.taskId <= 0
    || (receipt.executionId !== null && typeof receipt.executionId !== 'string')
  ) {
    throw new Error(`GenericFlowExecutor: node '${node.id}' returned an invalid execution receipt`);
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Derive a `NodeProductionEnvelope` from a legacy `NodeProduction` when a node
 * result carries only the v1 flat `production` field (all current producers).
 * The envelope wraps the v1 fields verbatim and adds an empty lineage array
 * and a derived `productRef`. Returns null when `production` is absent.
 */
function deriveEnvelope(
  production: NodeProduction | undefined,
): NodeProductionEnvelope | null {
  if (!production) return null;
  const productRef: ProductRef = {
    schemaId: production.schema,
    ref: production.artifactRef,
    digest: production.contentHash,
  };
  return {
    schema: production.schema,
    artifactRef: production.artifactRef,
    contentHash: production.contentHash,
    bindings: production.bindings,
    schemaId: production.schema,
    productRef,
    lineage: [],
  };
}

/**
 * Validate an explicit {@link ModuleCompletion} envelope emitted by a terminal
 * node. The explicit path trusts the completion's
 * `outputEnvelope.certificateRef` directly; this assertion guards against:
 *   - a producer emitting a completion whose declared outcome disagrees with
 *     the terminal outcome the flow resolved (a contract bug);
 *   - a completion that is not flagged terminal (settlement reached, so the
 *     kernel is asserting this outcome is final);
 *   - a malformed certificateRef shape (when present, it MUST be a valid
 *     content-addressed ProductRef: schemaId/ref/digest all non-empty strings,
 *     since the executor resolves the certificate by these three).
 *
 * `certificateRef` is OPTIONAL — a non-certified outcome (e.g. a deterministic
 * failure that produced no certificate) emits a completion without it. When
 * present, the shape must be valid. Pure, throwing. Same arguments → same
 * decision.
 */
function assertExplicitModuleCompletion(
  completion: ModuleCompletion,
  terminalOutcome: string,
): void {
  if (completion.outcome !== terminalOutcome) {
    throw new Error(
      'GenericFlowExecutor: explicit ModuleCompletion outcome '
        + `'${completion.outcome}' does not match terminal outcome '${terminalOutcome}'`,
    );
  }
  if (
    completion.outputEnvelope
    && completion.outputEnvelope.outcome !== terminalOutcome
  ) {
    throw new Error(
      'GenericFlowExecutor: explicit ModuleCompletion.outputEnvelope outcome '
        + `'${completion.outputEnvelope.outcome}' does not match terminal outcome '${terminalOutcome}'`,
    );
  }
  // Terminal flag must be true at settlement. The executor reached a terminal
  // node; the kernel is asserting this outcome is final. A `terminal: false`
  // completion here is a contract bug.
  if (completion.terminal !== true) {
    throw new Error(
      'GenericFlowExecutor: explicit ModuleCompletion.terminal must be true at '
        + `settlement (got '${String(completion.terminal)}' for outcome '${terminalOutcome}')`,
    );
  }
  // When certificateRef is present, validate the content-addressed ProductRef
  // shape (schemaId/ref/digest all non-empty). The executor resolves the
  // certificate by exactly these three values; a malformed ref would silently
  // produce a null certificate or a wrong lookup.
  const certRef = completion.outputEnvelope?.certificateRef;
  if (certRef !== undefined && certRef !== null) {
    if (
      typeof certRef.schemaId !== 'string' || certRef.schemaId.length === 0
      || typeof certRef.ref !== 'string' || certRef.ref.length === 0
      || typeof certRef.digest !== 'string' || certRef.digest.length === 0
    ) {
      throw new Error(
        'GenericFlowExecutor: explicit ModuleCompletion.outputEnvelope.'
          + 'certificateRef must be a content-addressed ProductRef with non-empty '
          + 'schemaId/ref/digest '
          + `(got schemaId='${String(certRef.schemaId)}', ref='${String(certRef.ref)}', `
          + `digest='${String(certRef.digest)}')`,
      );
    }
  }
}
