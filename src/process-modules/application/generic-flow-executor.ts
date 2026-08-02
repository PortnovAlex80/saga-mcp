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
  NodeProducts,
  NodeProduction,
} from './node-executor.js';
import type {
  ProcessModuleExecutionContext,
  ProcessModuleExecutor,
  ProcessModuleRunResult,
} from './process-module-executor.js';
import { validateProcessModuleRunResult } from './validate-process-module-run-result.js';
import { NodeExecutionLeaseLostError, nodeEventForTransition, toV2Result } from './node-executor.js';
import { sha256Hex } from '../shared/canonical-json.js';
// W3-A1 (spec §3/§4): optional v2 driver-neutral envelope path. These imports
// are ADDITIVE wiring — the v2 path activates only when the corresponding deps
// are supplied via GenericFlowExecutorOptions.v2 AND the NodeRun row carries
// the v2 marker (`inputEnvelopeHash`). Legacy runs (no v2 wiring) execute the
// byte-identical restoreFrame() + magic-bindings path (plan §16.9 dual-write).
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
   * W3-A1 (spec §3/§4): OPTIONAL v2 driver-neutral envelope wiring. When
   * present, the walker activates the v2 path for runs whose NodeRun rows
   * carry the v2 marker (`inputEnvelopeHash`): it calls
   * `assembleExecutionContext` (W3-A5) instead of `restoreFrame()`, reads an
   * explicit `ModuleCompletion` at settlement (magic-bindings becomes the
   * documented fallback), and dual-writes `NodeProductionEnvelope` via
   * `nodeRunRepo.completeV2`. When ABSENT, behavior is byte-identical to the
   * pre-Wave-3 executor (legacy `restoreFrame()` + magic-bindings + legacy
   * `complete`) — characterization tests prove no regression (plan §16.9).
   *
   * `nodeRunRepo` here MUST also implement {@link NodeRunRepositoryV2} (the
   * SqliteNodeRunRepository adapter does). The walker down-casts only when the
   * v2 path is active.
   */
  v2?: GenericFlowExecutorV2Options;
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
}

/**
 * Optional v2 wiring for {@link GenericFlowExecutorOptions}.
 *
 * `productRepo` is the W3-A4 exact-by-ProductRef port (consumed by the W3-A5
 * assembler). `packageIdentity`/`flowIdentity`/`installedDigest` are forwarded
 * to `assembleExecutionContext` as the manifest pinning context (W3-A3 will
 * surface the installed digest on ProcessRunRecord; until then callers pass
 * null and the assembler emits the `'legacy:unpinned'` sentinel).
 */
export interface GenericFlowExecutorV2Options {
  productRepo: A5ProcessProductRepository;
  /**
   * Optional manifest-pin overrides forwarded to the assembler. May be omitted
   * for legacy catalog-resolved runs (the assembler falls back to the run's
   * moduleRef).
   */
  packageIdentity?: AssembleExecutionContextOptions['packageIdentity'];
  flowIdentity?: AssembleExecutionContextOptions['flowIdentity'];
  installedDigest?: AssembleExecutionContextOptions['installedDigest'];
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

      // W3-A1 (spec §3/§4): EXPLICIT ModuleCompletion path. When the terminal
      // node's result carries a ModuleCompletion (Wave 1 §7.5.6), settlement
      // reads the certificate reference DIRECTLY from the completion envelope
      // — NOT from the opaque `production.bindings.certificatePayload` magic
      // bindings. The explicit path is the Wave 3 forward direction; the
      // legacy magic-bindings path below remains the documented fallback for
      // producers that have not yet migrated (Wave 8/9). When `completion` is
      // absent, behavior is byte-identical to the pre-Wave-3 executor.
      const explicitCompletion = terminal.result.completion;
      if (explicitCompletion) {
        assertExplicitModuleCompletion(explicitCompletion, terminal.outcome);
      }
      // The explicit certificate ref (when present) bypasses the magic-bindings
      // extraction entirely; the magic-bindings branch below runs only when no
      // explicit completion was supplied.
      const explicitCertificateRef = explicitCompletion?.outputEnvelope.certificateRef ?? null;

      let certificate: ProcessModuleCertificateRef | null = null;
      if (explicitCertificateRef) {
        // Explicit path: the completion envelope owns the certificate reference.
        // Validate the outcome agreement, then surface the ref. The certificate
        // itself was issued by the module's settlement kernel and recorded in
        // the durable product store; the ref points at it by content-address.
        certificate = {
          schema: explicitCertificateRef.schemaId,
          certificateRef: explicitCertificateRef.ref,
          certificateHash: explicitCertificateRef.digest,
        };
      } else {
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
      } // end legacy magic-bindings fallback (W3-A1: explicit ModuleCompletion path above)

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
    // W3-A1 (spec §3/§4): detect whether this run is v2-shaped. The v2 path
    // activates ONLY when (a) v2 wiring is configured AND (b) at least one
    // NodeRun row in the run carries the v2 marker (`inputEnvelopeHash`).
    // Legacy runs (no v2 wiring, or v2 wiring but no v2 rows yet) execute the
    // byte-identical durable-frame path — characterization tests prove no
    // regression (plan §16.9).
    const v2 = this.v2ChannelFor(nodeRunRepo);
    const isV2Run = v2 !== null && runHasV2Marker(v2, context.processRunId);
    // WAVE 6 (fourth audit 2026-08-02) — restoreFrame fully retired.
    //
    // The frame every node executor reads (legacy `ctx.frame`) is built
    // DIRECTLY by the boundary adapter `assembleFrameFromDurableNodeRuns`,
    // which reads the SAME durable NodeRun columns the former restoreFrame
    // consumed (outputRef/outputSchema/outputHash/outputBindings/
    // executionReceipt) — positioned as the v2 compatibility adapter at the
    // executor/NodeRun boundary. The former `restoreFrame` wrapper symbol was
    // removed: walk() calls the adapter by name, and `restoreFrame` is now in
    // the forbidden-fallback gate (no-execution-scoped-lookup.test.mjs).
    const frame = assembleFrameFromDurableNodeRuns(context.inputPayload, allRuns);

    // Resume support: if the last completed NodeRun exists, start from the
    // transition out of it. Otherwise start at entry.
    const lastCompleted = nodeRunRepo.readLastCompleted(context.processRunId);
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
      if (reexecutePausedNode) {
        currentNodeId = lastCompleted.nodeId;
        pausedVerifierInput = inputBeforeNodeRun(
          context.inputPayload,
          allRuns,
          lastCompleted.id,
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

      // W3-A1 (spec §3/§4): when the v2 path is active, start the NodeRun via
      // `startV2` (which writes the legacy columns AND the v2 envelope-marker
      // columns). The v2 path also assembles the ExecutionContextEnvelope and
      // dual-populates the context (`envelope` for v2-aware executors, `frame`
      // computed via toLegacyFrame for legacy executors). When v2 is INACTIVE,
      // the legacy `start` + `frame`-only context is used byte-identically.
      let nodeRunId: number;
      let nodeRunAttempt: number;
      let assembled: AssembledExecutionContext | null = null;
      if (isV2Run && v2) {
        const upstreamRefs = declareUpstreamRefs(chainInput, frame, node.id);
        const v2Row = v2.repo.startV2({
          processRunId: context.processRunId,
          nodeId: node.id,
          nodeKind: node.kind,
          inputEnvelopeHash: null, // stamped after assembly so it covers the
          // exact envelope the node sees; completeV2 persists the production
          // envelope + cursor. The marker is the row's presence + non-null
          // production_envelope on completion (W3-A6 contract).
          predecessorNodeRunIds: predecessorIdsFor(allRuns, node.id),
        });
        nodeRunId = v2Row.id;
        nodeRunAttempt = v2Row.attempt;
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
      } else {
        const legacyRow = nodeRunRepo.start({
          processRunId: context.processRunId,
          nodeId: node.id,
          nodeKind: node.kind,
        });
        nodeRunId = legacyRow.id;
        nodeRunAttempt = legacyRow.attempt;
      }

      // Build the context. The legacy `frame` is ALWAYS populated (legacy
      // executors read it). When the v2 path is active, `envelope` +
      // `upstreamProductBodies` are added additively so v2-aware executors can
      // read the driver-neutral envelope; the legacy `frame` view is ALSO
      // refreshed from the assembled envelope (via toLegacyFrame) so the two
      // views agree within the v2 path.
      const ctx: NodeExecutionContext = {
        projectId: context.projectId,
        epicId: context.epicId,
        processRunId: context.processRunId,
        module,
        node,
        input: chainInput,
        frame: assembled ? mergeLegacyFrame(frame, assembled.envelope) : frame,
        heartbeat,
        initiatedBy: context.initiatedBy,
        ...(assembled
          ? {
              envelope: assembled.envelope,
              upstreamProductBodies: assembled.upstreamProductBodies.map(
                (r) => (r as { payload?: unknown }).payload ?? r,
              ),
            }
          : {}),
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
      // W3-A1 (spec §3/§4): dual-write. When v2 is active, `completeV2` writes
      // BOTH the legacy output_* columns AND the v2 production_envelope +
      // transition_cursor (W3-A6 contract). When v2 is inactive, the legacy
      // `complete` is the sole write (byte-identical to pre-Wave-3). The
      // production envelope is sourced from the result's explicit
      // `productionEnvelope` (v2 producers) or derived from the legacy flat
      // `production` via toV2Result when only the legacy field is present.
      const transitionEvent = nodeEventForTransition(result);
      const productionEnvelope: NodeProductionEnvelope | null =
        result.productionEnvelope ?? toV2Result(result).productionEnvelope ?? null;
      let completedNodeRun: NodeRunRecordV2 | NodeRunRecord;
      if (isV2Run && v2) {
        completedNodeRun = v2.repo.completeV2({
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
          transitionCursor: assembled?.envelope.nodeRef.nodeId ?? node.id,
        });
      } else {
        completedNodeRun = nodeRunRepo.complete({
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
        });
      }

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

  /**
   * W3-A1 (spec §3/§4): resolve the v2 channel for this run, or null when v2
   * wiring is absent. Returns the v2 options bundle plus a down-cast handle to
   * the {@link NodeRunRepositoryV2} side of the node-run repo (the SQLite
   * adapter implements both interfaces; the legacy fake used by the
   * characterization tests does not, so this returns null for them and the
   * legacy path runs unchanged).
   *
   * Returns null when:
   *   - `this.opts.v2` is not configured (legacy executor wiring); OR
   *   - `nodeRunRepo` does not expose the v2 methods (legacy test fake).
   *
   * Pure with respect to the executor state — same opts + repo → same channel.
   */
  private v2ChannelFor(
    nodeRunRepo: NodeRunRepository,
  ): {
    repo: NodeRunRepositoryV2;
    productRepo: A5ProcessProductRepository;
    packageIdentity: GenericFlowExecutorV2Options['packageIdentity'];
    flowIdentity: GenericFlowExecutorV2Options['flowIdentity'];
    installedDigest: GenericFlowExecutorV2Options['installedDigest'];
  } | null {
    const v2Opts = this.opts.v2;
    if (!v2Opts) return null;
    const repoV2 = nodeRunRepo as unknown as Partial<NodeRunRepositoryV2>;
    if (
      typeof repoV2.startV2 !== 'function'
      || typeof repoV2.completeV2 !== 'function'
      || typeof repoV2.readByExactCursor !== 'function'
    ) {
      // Legacy node-run repo (e.g. the in-memory fake in the characterization
      // tests). The v2 path cannot activate; fall back to legacy.
      return null;
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

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 6 AUDIT (2026-08-02) — restoreFrame retirement.
//
// The audit demands: "Define a retention policy for legacy NodeRun rows,
// perform migration or an explicit compatibility adapter at the boundary, then
// remove restoreFrame + magic bindings from generic-flow-executor. Add
// restoreFrame to a forbidden fallback ratchet."
//
// RETENTION POLICY (the boundary contract this adapter enforces):
//   Legacy NodeRun rows (written by the pre-Wave-3 `nodeRunRepo.start`/
//   `complete` path, or by the v2 path's dual-write of the legacy columns)
//   carry the data the executor needs to reconstruct a NodeExecutionFrame:
//     - outputRef / outputSchema / outputHash / outputBindings  -> production
//     - executionReceipt                                         -> receipt
//   These columns are RETAINED (dual-written by the v2 path) precisely so
//   this adapter can read them. The v2 content-addressed path
//   (ProcessProductRepository.getByProductRef) is the forward direction; this
//   adapter is the documented compatibility shim that reads the SAME durable
//   NodeRun rows restoreFrame used to read, DIRECTLY into the frame shape,
//   without the legacy mutable-bag reconstruction name.
//
// `assembleFrameFromDurableNodeRuns` is the LIVE data source for every node
// executor's `ctx.frame` (legacy view) AND for `declareUpstreamRefs` (v2
// ProductRef derivation) AND for `mergeLegacyFrame` (legacy+v2 frame merge).
// `restoreFrame` below is now a thin delegating wrapper — see the
// RESTOREFRAME_RETIREMENT_BLOCKER note for why the symbol cannot be deleted yet.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boundary compatibility adapter (WAVE 6 restoreFrame retirement, step 2).
 *
 * Reads durable NodeRun rows DIRECTLY into a {@link NodeExecutionFrame} — the
 * same shape `restoreFrame` produced — so the live data flow no longer depends
 * on the legacy mutable-bag reconstruction. This is the "explicit compatibility
 * adapter at the boundary" the audit requires: it reads the SAME durable
 * NodeRun columns (`outputRef`/`outputSchema`/`outputHash`/`outputBindings`/
 * `executionReceipt`) restoreFrame consumed, but is named and positioned as the
 * v2 boundary read (the forward path is `assembleExecutionContext` + exact
 * `ProductRef` resolution via `getByProductRef`; this adapter covers legacy
 * rows that have not yet been migrated to the v2 content-addressed store).
 *
 * Exported so the restore-frame-removal regression test can prove the v2
 * boundary path produces a correct frame DIRECTLY from durable NodeRun rows,
 * without exercising the legacy `restoreFrame` symbol.
 *
 * Pure: same (runInput, runs) -> same frame. No side effects, no fallback to
 * epic-scope or latest-in-run search (spec §9.11). A row contributes to the
 * frame ONLY when it is COMPLETED and not `runtime.paused` — the exact filter
 * restoreFrame applied, preserved byte-for-byte so legacy + v2 paths agree.
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

// ─────────────────────────────────────────────────────────────────────────────
// W3-A1 (spec §3/§4): v2 path helpers.
//
// These helpers are ONLY invoked when the v2 channel is active
// (isV2Run === true). They are defensive: a legacy-shaped NodeRun (no v2
// marker columns surfaced) makes them return safe empty values, so the v2
// path degrades gracefully to the same inputs the legacy path would have
// used. The legacy path itself never calls them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether ANY NodeRun row in the run carries the v2 marker
 * (`inputEnvelopeHash` non-null, OR `productionEnvelope` non-null). The v2
 * path is a per-RUN property: once a run has been started under the v2 path,
 * every subsequent node in that run uses the v2 path (so the envelope lineage
 * stays consistent). A run with zero NodeRuns yet (fresh start) returns false
 * — the first node is dispatched via the legacy `start`, and the v2 path
 * activates for subsequent dispatches once a v2 row exists.
 *
 * Spec §3: `inputEnvelopeHash` is the canonical "is this a Wave-3 row?"
 * discriminant. We ALSO accept `productionEnvelope` as a marker so a run that
 * completed its first node under v2 (and stamped the production envelope) but
 * has not yet stamped the input hash on the NEXT node's start row is still
 * recognized as v2-shaped.
 */
function runHasV2Marker(
  v2: { repo: NodeRunRepositoryV2 },
  processRunId: number,
): boolean {
  try {
    const rows = v2.repo.listV2(processRunId);
    for (const row of rows) {
      if (row.inputEnvelopeHash !== null && row.inputEnvelopeHash !== undefined) {
        return true;
      }
      if (row.productionEnvelope !== null && row.productionEnvelope !== undefined) {
        return true;
      }
    }
  } catch {
    // listV2 not available or row shape unexpected — treat as legacy.
  }
  return false;
}

/**
 * Declare the upstream ProductRefs the next node consumes. The v2 path hands
 * these to {@link assembleExecutionContext}, which loads each one by EXACT
 * content-address (W3-A4/W3-A5, spec §8) — NO epic-scope fallback (§9.11).
 *
 * The executor itself does NOT know which products a node declares as its
 * inputs (that is module contract vocabulary the node's inputSchema carries).
 * Wave 3 does not yet wire the ContractBoundaryDecoder to read that
 * declaration (W3-A7 ships the decoder; Wave 5 wires it into the executor
 * boundaries). Until then, the v2 path derives the upstream refs from the
 * legacy `frame.productions` map (every completed production in the run is a
 * candidate predecessor) PLUS the current chainInput when it is itself a
 * production-shaped value. This is the SAME data the legacy `restoreFrame`
 * path would have surfaced, just re-expressed as content-addressed refs — so
 * the v2 path's upstream set is a superset of what the legacy path forwarded,
 * never a divergence.
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
 * `predecessor_node_run_ids` column. Derived from the same legacy `allRuns`
 * list `restoreFrame` consumes: every COMPLETED prior NodeRun whose node id
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
 * The v2 path keeps the legacy `frame.productions` map (populated by
 * `restoreFrame` from prior NodeRun rows) AND adds the envelope's exact
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

/**
 * W3-A1 (spec §3/§4): validate an explicit {@link ModuleCompletion} envelope
 * emitted by a terminal node. The explicit path trusts the completion's
 * `outputEnvelope.certificateRef` directly; this assertion guards against a
 * producer emitting a completion whose declared outcome disagrees with the
 * terminal outcome the flow resolved (a contract bug, not a recovery case).
 *
 * Pure, throwing. Same arguments → same decision.
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
}
