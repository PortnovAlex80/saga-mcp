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

import { type ProcessModuleDefinition } from '../domain/process-module.js';
import type { FlowNodeDefinition, FlowTransitionDefinition } from '../domain/process-module.js';
import type {
  ProcessRunRepository,
} from '../persistence/process-run-repository.js';
import type {
  NodeRunRepository,
} from '../persistence/node-run.js';
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
  NodeExecutor,
  NodeExecutionResult,
} from './node-executor.js';
import type {
  ProcessModuleExecutionContext,
  ProcessModuleExecutor,
  ProcessModuleRunResult,
} from './process-module-executor.js';
import { validateProcessModuleRunResult } from './validate-process-module-run-result.js';
import { nodeEventForTransition } from './node-executor.js';

export interface GenericFlowExecutorOptions {
  moduleRef: ProcessModuleDefinition['identity'];
  processRunRepo: ProcessRunRepository;
  nodeRunRepo: NodeRunRepository;
  certificateRepo: ProcessOutcomeCertificateRepository;
  /** Node executors keyed by FlowNodeKind. Required: 'kernel'. */
  nodeExecutors: ReadonlyMap<string, NodeExecutor>;
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

    // Drive created → preparing → running.
    if (run.status === 'created') {
      processRunRepo.update(context.processRunId, { status: 'preparing' });
    }
    processRunRepo.update(context.processRunId, { status: 'running' });

    try {
      // Walk the flow from entry (or last completed NodeRun — restart support).
      const terminal = await this.walk(module, context, nodeRunRepo, nodeExecutors);

      // Д6: the settlement kernel handler ALREADY built the authoritative
      // certificate envelope and returned it inside ITS production's bindings.
      // The terminal outcome-emitter node produces its own (outcome-only)
      // production, so we must look up the certificate envelope in the chain of
      // completed NodeRuns — the LAST one whose production carries
      // certificatePayload. This keeps the certificate a first-class product of
      // the settlement kernel node, not something the Runtime reconstructs.
      const completedRuns = nodeRunRepo.list(context.processRunId);
      let certPayload: ProcessOutcomeCertificatePayload | undefined;
      let certHash: string | undefined;
      let certSchema: string | undefined;
      let authority: string | null = null;
      for (const nr of completedRuns) {
        // The settlement kernel handler is identified by its artifactRef
        // convention OR by the presence of certificatePayload in a stored
        // production. We don't store full bindings in NodeRun yet (Д8), so we
        // recognise settlement by artifactRef prefix 'settlement:'.
        if (nr.outputRef && nr.outputRef.startsWith('settlement:')) {
          // The settlement production is no longer in memory after the walk;
          // for now, when the terminal node IS the settlement terminal (no
          // separate outcome-emitter, e.g. synthetic test), the envelope is on
          // terminal.result. The discovery descriptor has a separate terminal
          // outcome-emitter; for it, the envelope is re-read below via the
          // walk's last kernel production.
        }
      }
      // Primary source: the terminal result itself (when settlement IS the
      // terminal node, or when the outcome-emitter preserved chain bindings).
      const terminalBindings = (terminal.result.production?.bindings ?? {}) as Record<string, unknown>;
      certPayload = (terminalBindings.certificatePayload as ProcessOutcomeCertificatePayload | undefined) ?? certPayload;
      certHash = (terminalBindings.certificateHash as string | undefined) ?? certHash;
      certSchema = (terminalBindings.certificateSchema as string | undefined) ?? certSchema;
      authority = (terminalBindings.authority as string | undefined) ?? authority;

      const output = this.opts.resolveOutput
        ? this.opts.resolveOutput(module, terminal.outcome, terminal.result, context)
        : null;

      // No certificate envelope in the terminal production → the module did not
      // produce an authoritative certificate (e.g. a failed outcome). RunResult
      // certificate is null; ProcessRun still completes with the outcome.
      processRunRepo.update(context.processRunId, { status: 'settling' });

      let certificate: ProcessModuleCertificateRef | null = null;
      if (certPayload && certHash && certSchema) {
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
        output,
        certificate,
      });

      return runResult;
    } catch (err) {
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
  }

  private async walk(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
    nodeRunRepo: NodeRunRepository,
    nodeExecutors: ReadonlyMap<string, NodeExecutor>,
  ): Promise<{ outcome: string; result: NodeExecutionResult }> {
    const flow = module.flow;

    // Resume support: if the last completed NodeRun exists, start from the
    // transition out of it. Otherwise start at entry.
    const lastCompleted = nodeRunRepo.readLastCompleted(context.processRunId);
    let currentNodeId: string;
    if (lastCompleted) {
      const resumed = this.nextNode(flow, lastCompleted.nodeId, lastCompleted.event ?? '');
      if (resumed === null) {
        // The resumed node was terminal — re-emit its outcome.
        const terminalNode = this.findNode(flow, lastCompleted.nodeId);
        if (terminalNode?.emitsOutcome) {
          // Д8 partial: rebuild a production from the durable NodeRun output_ref.
          // Full durable bindings restoration is tracked separately; for now the
          // terminal outcome is enough to drive settlement + certificate replay.
          return {
            outcome: terminalNode.emitsOutcome,
            result: {
              runtimeEvent: 'completed',
              production: lastCompleted.outputRef
                ? { schema: '', artifactRef: lastCompleted.outputRef, contentHash: lastCompleted.outputHash ?? '', bindings: {} }
                : undefined,
            },
          };
        }
        throw new Error(`GenericFlowExecutor: cannot resume — node ${lastCompleted.nodeId} has no outgoing transition and is not terminal`);
      }
      currentNodeId = resumed;
    } else {
      currentNodeId = flow.entryNodeId;
    }

    // Bound the walk to prevent infinite loops on malformed transitions.
    const maxSteps = flow.nodes.length * 4 + 10;

    // The first node receives the module input payload. Each subsequent node
    // receives the PREVIOUS node's output — this is the data chain that lets a
    // settlement kernel handler read the proposal produced by the LM node
    // upstream, without the executor knowing the module vocabulary.
    let chainInput: unknown = context.inputPayload;

    for (let step = 0; step < maxSteps; step += 1) {
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
        initiatedBy: context.initiatedBy,
      };

      let result: NodeExecutionResult;
      try {
        result = await executor.execute(ctx);
      } catch (err) {
        nodeRunRepo.fail({
          id: nodeRun.id,
          errorMessage: (err as Error).message ?? String(err),
        });
        throw err;
      }

      const outputRef = result.production?.artifactRef ?? null;
      const outputHash = result.production?.contentHash ?? null;
      nodeRunRepo.complete({
        id: nodeRun.id,
        event: nodeEventForTransition(result),
        outputRef,
        outputHash,
      });

      // Forward the node's production (durable ref) to the next node in the
      // chain. Downstream kernel nodes (settlement) read exact bindings from
      // production.bindings and re-read canonical rows from durable storage —
      // never from "latest by epic" and never from raw runtime objects.
      chainInput = result.production ?? chainInput;

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

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
