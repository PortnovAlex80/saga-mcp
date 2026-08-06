/**
 * KernelNodeExecutor — NodeExecutor для kernel-узлов.
 *
 * Dispatcher: ищет handler по `node.handler` в KernelHandlerRegistry и вызывает
 * его. Сам executor не знает ни одного handler'а — все они регистрируются
 * модулем при установке (кроме `process-outcome-emitter`, который регистрирует
 * сам runtime). Это и есть граница: kernel content = модуль, kernel mechanics =
 * этот executor + registry.
 */

import type {
  KernelFlowNodeDefinition,
} from '../../domain/process-module.js';
import { processModuleKey } from '../../domain/process-module.js';
import {
  RECOVERY_ISSUE_SCHEMA,
  type RecoveryIssue,
} from '../../domain/recovery.js';
import {
  ExactCandidateAcceptanceRejected,
  type ExactCandidateAcceptance,
  type ExactCandidateAcceptanceDirective,
  type ExactCandidateAcceptanceReceipt,
} from '../exact-candidate-acceptance.js';
import type { KernelHandlerRegistry, KernelHandlerResult } from '../kernel-handler-registry.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';

export class KernelNodeExecutor implements NodeExecutor {
  readonly kind = 'kernel' as const;

  constructor(
    private readonly handlerRegistry: KernelHandlerRegistry,
    private readonly candidateAcceptance?: ExactCandidateAcceptance,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = ctx.node as KernelFlowNodeDefinition;
    const handler = this.handlerRegistry.require(node.handler);
    try {
      let result: KernelHandlerResult = await handler({
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        processRunId: ctx.processRunId,
        node,
        input: ctx.input,
        frame: ctx.frame,
        heartbeat: ctx.heartbeat,
        initiatedBy: ctx.initiatedBy,
        nodeProducts: ctx.nodeProducts,
      });
      let acceptanceReceipt: ExactCandidateAcceptanceReceipt | undefined;
      if (result.exactCandidateAcceptance) {
        const applied = this.applyExactCandidateAcceptance(
          ctx,
          result,
          result.exactCandidateAcceptance,
        );
        result = applied.result;
        acceptanceReceipt = applied.receipt;
      }
      // Kernel handlers emit DOMAIN events (accepted / go / clarify / ...).
      // runtimeEvent is 'completed' for a kernel node that returned normally; a
      // handler that wants to signal failure throws. A handler MAY override
      // runtimeEvent to 'paused' to release the run to the conveyor without
      // finishing (e.g. Development settle-development while projected impl
      // tasks are still being drained by the shared worker_next queue): the
      // executor surfaces runtime.paused, ProcessRun pauses, and on resume the
      // generic-flow-executor re-executes the SAME node so the handler can
      // re-check and proceed.
      return {
        runtimeEvent: result.runtimeEvent ?? 'completed',
        domainEvent: result.runtimeEvent === 'paused' ? undefined : result.event,
        production: result.production,
        recoveryIssue: result.recoveryIssue,
        acceptanceReceipt,
        outcome: result.outcome,
        // FU-A Wave 3: forward the explicit ModuleCompletion (W3-A1 spec §3/§4)
        // from the kernel handler onto the NodeExecutionResult. This is the
        // linchpin that lets a terminal settlement kernel emit `completion` and
        // have it reach persistence + settlement without touching magic bindings.
        // Additive: handlers that do not set `completion` forward `undefined`,
        completion: result.completion,
      };
    } catch (err) {
      throw new NodeExecutionError('kernel', node.id, (err as Error).message, err);
    }
  }

  private applyExactCandidateAcceptance(
    ctx: NodeExecutionContext,
    result: KernelHandlerResult,
    directive: ExactCandidateAcceptanceDirective,
  ): {
    result: KernelHandlerResult;
    receipt?: ExactCandidateAcceptanceReceipt;
  } {
    if (!this.candidateAcceptance) {
      throw new Error(
        'kernel handler requested exact candidate acceptance, but no '
        + 'ExactCandidateAcceptance port is configured',
      );
    }
    const command = bindAcceptanceToCurrentExecution(
      ctx,
      result,
      directive,
    );
    try {
      const decision = this.candidateAcceptance.accept(command);
      return {
        result,
        receipt: {
          schemaVersion: decision.schemaVersion,
          decisionRef: `exact-acceptance:${decision.decisionId}`,
          decisionHash: decision.decisionHash,
          candidateSetHash: decision.candidateSetHash,
          idempotencyKey: decision.idempotencyKey,
          replayed: decision.replayed,
        },
      };
    } catch (error) {
      if (!(error instanceof ExactCandidateAcceptanceRejected)) throw error;
      // Diagnostic: surface the exact rejection reason so the operator can see
      // WHY the gate blocked (instead of a silent 'acceptance-blocked' event).
      process.stderr.write(
        `[exact-acceptance] REJECTED node=${ctx.node?.id} code=${error.code} details=${JSON.stringify(error.details ?? {})}\n`,
      );
      if (!isRepairableAcceptanceRejection(error)) throw error;
      return {
        result: {
          ...result,
          event: directive.rejection.event,
          recoveryIssue: acceptanceRecoveryIssue(directive, error),
        },
      };
    }
  }
}

function bindAcceptanceToCurrentExecution(
  ctx: NodeExecutionContext,
  result: KernelHandlerResult,
  directive: ExactCandidateAcceptanceDirective,
): ExactCandidateAcceptanceDirective['command'] {
  const lineage = directive.command.lineage;
  const expectedModuleRef = processModuleKey(ctx.module.identity);
  if (
    lineage.processRunId !== ctx.processRunId
    || lineage.projectId !== ctx.projectId
    || lineage.epicId !== ctx.epicId
    || lineage.moduleRef !== expectedModuleRef
  ) {
    throw new Error(
      'exact candidate acceptance lineage is not bound to the current '
        + `execution (expected run=${ctx.processRunId}, module=${expectedModuleRef}, `
        + `project=${ctx.projectId}, epic=${String(ctx.epicId)})`,
    );
  }
  return {
    ...directive.command,
    context: {
      ...(directive.command.context ?? {}),
      // These fields are kernel-owned evidence. A module handler may add
      // semantic context but cannot make this executor attest another gate or
      // another production.
      gateNodeId: ctx.node.id,
      semanticProductionRef: result.production.artifactRef,
      semanticProductionHash: result.production.contentHash,
    },
  };
}

function acceptanceRecoveryIssue(
  directive: ExactCandidateAcceptanceDirective,
  rejection: ExactCandidateAcceptanceRejected,
): RecoveryIssue {
  return {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId: directive.rejection.policyId,
    disposition: acceptanceRejectionDisposition(directive, rejection),
    reasonCode: rejection.code,
    summary: `${directive.rejection.summary}: ${rejection.message}`,
    findings: [{
      code: rejection.code,
      severity: 'error',
      message: rejection.message,
      subjectRef: directive.rejection.subjectRefs[0]?.ref ?? null,
      expected: directive.rejection.acceptanceCriteria,
      actual: rejection.details,
      evidenceRefs: directive.rejection.subjectRefs.map(subject => subject.ref),
    }],
    subjectRefs: directive.rejection.subjectRefs,
    acceptanceCriteria: directive.rejection.acceptanceCriteria,
    allowedChanges: directive.rejection.allowedChanges,
    context: {
      ...(directive.rejection.context ?? {}),
      acceptanceIdempotencyKey: directive.command.idempotencyKey,
      candidateSet: directive.command.candidates,
    },
  };
}

function acceptanceRejectionDisposition(
  directive: ExactCandidateAcceptanceDirective,
  rejection: ExactCandidateAcceptanceRejected,
): RecoveryIssue['disposition'] {
  // A module may deliberately demand a stronger disposition. Otherwise,
  // governance failures are not sent to an author who cannot manufacture an
  // approved review or retroactively attest an out-of-band acceptance.
  if (
    directive.rejection.disposition === 'fatal'
    || directive.rejection.disposition === 'human'
  ) {
    return directive.rejection.disposition;
  }
  if (
    rejection.code === 'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED'
    || rejection.code
      === 'EXACT_ACCEPTANCE_PREEXISTING_ACCEPTANCE_UNATTESTED'
  ) {
    return 'human';
  }
  return directive.rejection.disposition;
}

function isRepairableAcceptanceRejection(
  error: ExactCandidateAcceptanceRejected,
): boolean {
  return new Set([
    'EXACT_ACCEPTANCE_CANDIDATE_NOT_PRODUCED',
    'EXACT_ACCEPTANCE_ARTIFACT_NOT_FOUND',
    'EXACT_ACCEPTANCE_ARTIFACT_SCOPE_DRIFT',
    'EXACT_ACCEPTANCE_ARTIFACT_TYPE_DRIFT',
    'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
    'EXACT_ACCEPTANCE_ARTIFACT_STATE_INVALID',
    'EXACT_ACCEPTANCE_PREEXISTING_ACCEPTANCE_UNATTESTED',
    'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
    'EXACT_ACCEPTANCE_CAS_FAILED',
  ]).has(error.code);
}
