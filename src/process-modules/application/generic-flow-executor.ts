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
import { type ProcessModuleDefinition } from '../domain/process-module.js';
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
  ProcessOutcomeCertificatePayload,
  IssueProcessOutcomeCertificateCommand,
} from '../persistence/process-outcome-certificate.js';
// ProcessOutcomeCertificatePayload is used in the bindings cast inside execute().
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
  NodeProduction,
} from './node-executor.js';
import type {
  ProcessModuleExecutionContext,
  ProcessModuleExecutor,
  ProcessModuleRunResult,
} from './process-module-executor.js';
import { validateProcessModuleRunResult } from './validate-process-module-run-result.js';
import { NodeExecutionLeaseLostError, nodeEventForTransition } from './node-executor.js';
import { sha256Hex } from '../shared/canonical-json.js';

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
    const { processRunRepo, nodeRunRepo, certificateRepo, nodeExecutors } = this.opts;
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

      // The settlement production owns the certificate envelope. A separate
      // outcome-emitter preserves those bindings, and terminal replay rebuilds
      // the same production from the durable NodeRun checkpoint.
      const terminalBindings = (terminal.result.production?.bindings ?? {}) as Record<string, unknown>;
      const certPayload = terminalBindings.certificatePayload as ProcessOutcomeCertificatePayload | undefined;
      const certHash = terminalBindings.certificateHash as string | undefined;
      const certSchema = terminalBindings.certificateSchema as string | undefined;
      const existingCertificateRef = terminalBindings.certificateRef as string | undefined;
      const certificateArtifactPayload = terminalBindings.certificateArtifactPayload;
      const certificateDecision = terminalBindings.certificateDecision as string | undefined;
      const authority = (terminalBindings.authority as string | undefined) ?? null;

      const output = this.opts.resolveOutput
        ? this.opts.resolveOutput(module, terminal.outcome, terminal.result, context)
        : null;

      // No certificate envelope in the terminal production → the module did not
      // produce an authoritative certificate (e.g. a failed outcome). RunResult
      // certificate is null; ProcessRun still completes with the outcome.
      processRunRepo.update(context.processRunId, { status: 'settling' });

      let certificate: ProcessModuleCertificateRef | null = null;
      const hasReferencedEnvelopeField = existingCertificateRef !== undefined
        || certificateArtifactPayload !== undefined
        || certificateDecision !== undefined;
      const hasGenericEnvelopeField = certPayload !== undefined;
      if (hasReferencedEnvelopeField && hasGenericEnvelopeField) {
        throw new Error(
          'GenericFlowExecutor: certificate envelope is ambiguous (both referenced and generic)',
        );
      }
      if (hasReferencedEnvelopeField) {
        if (
          !existingCertificateRef
          || certificateArtifactPayload === undefined
          || !certHash
          || !certSchema
          || !certificateDecision
        ) {
          throw new Error('GenericFlowExecutor: referenced certificate envelope is incomplete');
        }
        assertReferencedCertificateEnvelope({
          payload: certificateArtifactPayload,
          certificateHash: certHash,
          certificateSchema: certSchema,
          certificateDecision,
          terminalOutcome: terminal.outcome,
        });
        certificate = {
          schema: certSchema,
          certificateRef: existingCertificateRef,
          certificateHash: certHash,
        };
      } else if (hasGenericEnvelopeField) {
        if (!certPayload || !certHash || !certSchema) {
          throw new Error('GenericFlowExecutor: generic certificate envelope is incomplete');
        }
        assertGenericCertificateEnvelope(
          certPayload,
          certHash,
          certSchema,
          terminal.outcome,
        );
        // Д7: issue the certificate FIRST (so its ref is non-empty), then
        // validate the complete RunResult, then flip ProcessRun to completed.
        // If validation fails after issue, the certificate is orphaned but
        // immutable — the failure is a contract bug to fix, not data corruption.
        const certResult = certificateRepo.issue({
          processRunId: context.processRunId,
          moduleRef: module.identity,
          projectId: context.projectId,
          epicId: context.epicId,
          payload: certPayload,
          certificateHash: certHash,
          authority: authority ?? 'unknown',
        } satisfies IssueProcessOutcomeCertificateCommand);
        certificate = {
          schema: certSchema,
          certificateRef: `certificate:${certResult.record.id}`,
          certificateHash: certResult.record.certificateHash,
        };
      } else if (certHash !== undefined || certSchema !== undefined) {
        throw new Error('GenericFlowExecutor: certificate hash/schema has no payload');
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
  ): Promise<{ outcome: string; result: NodeExecutionResult }> {
    const flow = module.flow;
    const allRuns = nodeRunRepo.list(context.processRunId);
    const frame = restoreFrame(context.inputPayload, allRuns);

    // Resume support: if the last completed NodeRun exists, start from the
    // transition out of it. Otherwise start at entry.
    const lastCompleted = nodeRunRepo.readLastCompleted(context.processRunId);
    let currentNodeId: string;
    let resumedRecoveryInput: NodeProduction | null = null;
    let pausedVerifierInput: unknown;
    let recheckPausedVerifier = false;
    if (lastCompleted) {
      const restoredResult = restoreNodeResult(lastCompleted);
      recheckPausedVerifier = this.shouldRecheckPausedVerifier(
        context,
        lastCompleted,
      );
      if (recheckPausedVerifier) {
        currentNodeId = lastCompleted.nodeId;
        pausedVerifierInput = inputBeforeNodeRun(
          context.inputPayload,
          allRuns,
          lastCompleted.id,
        );
      } else {
        resumedRecoveryInput = this.reconcileRecoveryCheckpoint(
          module,
          context,
          lastCompleted,
          restoredResult,
        ).feedbackProduction;
      }
      const resumed = recheckPausedVerifier
        ? lastCompleted.nodeId
        : this.nextNode(flow, lastCompleted.nodeId, lastCompleted.event ?? '');
      if (resumed === null) {
        // The resumed node was terminal — re-emit its outcome.
        const terminalNode = this.findNode(flow, lastCompleted.nodeId);
        if (terminalNode?.emitsOutcome) {
          // Д8: rebuild production from durable NodeRun output_ref + bindings.
          // The bindings carry the certificate envelope (Д6) the previous run
          // produced, so settlement/certificate replay works on restart.
          return {
            outcome: terminalNode.emitsOutcome,
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

    // The first node receives the module input payload. Each subsequent node
    // receives the PREVIOUS node's output — this is the data chain that lets a
    // settlement kernel handler read the proposal produced by the LM node
    // upstream, without the executor knowing the module vocabulary.
    //
    // Д8: on restart, if a NodeRun already completed in this ProcessRun, the
    // chainInput is RESTORED from that NodeRun's durable output_bindings — not
    // re-initialised from the module input. This preserves the exact lineage
    // (proposalId, controlIntentId, certificatePayload, …) the previous run
    // produced, so resuming the next node sees the same upstream context.
    let chainInput: unknown = context.inputPayload;
    const lastCompletedForChain = nodeRunRepo.readLastCompleted(context.processRunId);
    if (recheckPausedVerifier) {
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

      const nodeRun = nodeRunRepo.start({
        processRunId: context.processRunId,
        nodeId: node.id,
        nodeKind: node.kind,
      });

      const ctx: NodeExecutionContext = {
        projectId: context.projectId,
        epicId: context.epicId,
        processRunId: context.processRunId,
        module,
        node,
        input: chainInput,
        frame,
        heartbeat,
        initiatedBy: context.initiatedBy,
      };

      let result: NodeExecutionResult;
      try {
        result = await executor.execute(ctx);
        assertNodeExecutionResult(node, result);
        heartbeat();
      } catch (err) {
        nodeRunRepo.fail({
          id: nodeRun.id,
          errorMessage: (err as Error).message ?? String(err),
        });
        throw err;
      }

      const outputRef = result.production?.artifactRef ?? null;
      const outputSchema = result.production?.schema ?? null;
      const outputHash = result.production?.contentHash ?? null;
      const outputBindings = result.production?.bindings ?? null;
      const completedNodeRun = nodeRunRepo.complete({
        id: nodeRun.id,
        event: nodeEventForTransition(result),
        outputRef,
        outputSchema,
        outputHash,
        outputBindings,
        executionReceipt: result.receipt as unknown as Record<string, unknown> | undefined,
        acceptanceReceipt: result.acceptanceReceipt as unknown as
          Record<string, unknown> | undefined,
        recoveryIssue: result.recoveryIssue,
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

      // Terminal node — emit its outcome.
      if (node.emitsOutcome) {
        return { outcome: node.emitsOutcome, result };
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

function restoreNodeResult(run: NodeRunRecord): NodeExecutionResult {
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
  };
}

function inputBeforeNodeRun(
  runInput: unknown,
  allRuns: readonly NodeRunRecord[],
  nodeRunId: number,
): unknown {
  const prior = [...allRuns]
    .filter(run => run.id < nodeRunId && run.status === 'completed')
    .sort((left, right) => right.id - left.id)[0];
  if (!prior) return runInput;
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

function restoreFrame(
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

function assertGenericCertificateEnvelope(
  payload: ProcessOutcomeCertificatePayload,
  certificateHash: string,
  certificateSchema: string,
  terminalOutcome: string,
): void {
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.schemaVersion !== 'string'
    || typeof payload.decision !== 'string'
    || !Array.isArray(payload.reasonCodes)
    || typeof payload.rationale !== 'string'
    || typeof payload.inputHash !== 'string'
  ) {
    throw new Error('GenericFlowExecutor: malformed generic certificate envelope');
  }
  if (payload.schemaVersion !== certificateSchema) {
    throw new Error('GenericFlowExecutor: certificate schema does not match its payload');
  }
  if (payload.decision !== terminalOutcome) {
    throw new Error('GenericFlowExecutor: certificate decision does not match terminal outcome');
  }
  if (sha256Hex(payload) !== certificateHash) {
    throw new Error('GenericFlowExecutor: certificate hash does not match its payload');
  }
}

function assertReferencedCertificateEnvelope(input: {
  payload: unknown;
  certificateHash: string;
  certificateSchema: string;
  certificateDecision: string;
  terminalOutcome: string;
}): void {
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new Error('GenericFlowExecutor: malformed referenced certificate payload');
  }
  const record = input.payload as Record<string, unknown>;
  const payloadSchema = String(record.schema_version ?? record.schemaVersion ?? '');
  const payloadDecision = String(record.decision ?? '');
  if (
    input.certificateDecision !== input.terminalOutcome
    || payloadDecision !== input.terminalOutcome
  ) {
    throw new Error('GenericFlowExecutor: referenced certificate decision does not match terminal outcome');
  }
  if (payloadSchema !== input.certificateSchema) {
    throw new Error('GenericFlowExecutor: referenced certificate schema does not match its payload');
  }
  if (sha256Hex(input.payload) !== input.certificateHash) {
    throw new Error('GenericFlowExecutor: referenced certificate hash does not match its payload');
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
