import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { processModuleKey } from '../../domain/process-module.js';
import type {
  ExternalAdapter,
  ExternalAdapterContext,
} from '../../application/external-adapter-registry.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../application/kernel-handler-registry.js';
import type {
  NodeExecutionReceipt,
  NodeExecutionResult,
} from '../../application/node-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../application/process-output-payload-registry.js';
import type {
  ProcessModuleExecutionContext,
} from '../../application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../persistence/process-run.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  DEVELOPMENT_EXTERNAL_ADAPTER_IDS,
  DEVELOPMENT_KERNEL_HANDLER_IDS,
  type DevelopmentExternalActionKind,
  type DevelopmentExternalActionReceipt,
  type DevelopmentModuleInstallationDependencies,
  type DevelopmentOutputRecord,
  type DevelopmentOutputRepository,
} from './development-kernel-ports.js';
import {
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentImplementationWorkset,
  type DevelopmentSettlementInput,
  type DevelopmentTaskGraphSnapshot,
  type IntegratedReleaseCandidate,
} from './development-schemas.js';
import {
  buildDevelopmentCertificatePayload,
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
  hashVerifiedIntegrationBundle,
  hashDevelopmentTaskGraph,
  type DevelopmentSettlementResult,
} from './development-settlement-policy.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from './development-process-module.js';
import {
  buildCanonicalDevelopmentTaskGraph,
  decodeDevelopmentTaskGraphProposal,
} from './development-task-graph.js';

export const DEVELOPMENT_NODE_IDS = {
  planner: 'plan-task-graph',
  resolveTaskGraph: 'resolve-task-graph',
  implementation: 'execute-implementation-workset',
  integration: 'integrate-release-candidate',
  verification: 'verify-acceptance-workset',
  settlement: 'settle-development',
} as const;

export function createDevelopmentKernelHandlers(
  deps: DevelopmentModuleInstallationDependencies,
): Record<string, KernelHandler> {
  return {
    [DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph]:
      createTaskGraphResolver(deps),
    [DEVELOPMENT_KERNEL_HANDLER_IDS.settle]:
      createDevelopmentSettlementHandler(deps),
  };
}

export function createDevelopmentExternalAdapters(
  deps: DevelopmentModuleInstallationDependencies,
): Record<string, ExternalAdapter> {
  return {
    [DEVELOPMENT_EXTERNAL_ADAPTER_IDS.executeImplementationWorkset]:
      createImplementationAdapter(deps),
    [DEVELOPMENT_EXTERNAL_ADAPTER_IDS.integrateReleaseCandidate]:
      createIntegrationAdapter(deps),
    [DEVELOPMENT_EXTERNAL_ADAPTER_IDS.verifyAcceptanceWorkset]:
      createVerificationAdapter(deps),
  };
}

/**
 * GenericFlow output hook. It exposes only the exact durable bundle persisted
 * by this ProcessRun's settlement handler.
 */
export function createDevelopmentOutputResolver(
  repository: DevelopmentOutputRepository,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (module, terminalOutcome, terminalResult, context) => {
    if (terminalOutcome !== 'verified') return null;
    assertDevelopmentModule(module);
    const bindings = terminalResult.production?.bindings ?? {};
    const artifactRef = stringBinding(bindings, 'verifiedBundleRef');
    const contentHash = stringBinding(bindings, 'verifiedBundleContentHash');
    const schema = stringBinding(bindings, 'verifiedBundleSchema');
    const record = requireExactDevelopmentOutput(
      repository,
      context.processRunId,
      context.projectId,
      context.epicId,
      { schema, artifactRef, contentHash },
    );
    return {
      schema: record.payload.schemaVersion,
      artifactRef: record.artifactRef,
      contentHash: record.contentHash,
    };
  };
}

/**
 * Lifecycle handoff resolver registered under VERIFIED_INTEGRATION_BUNDLE_SCHEMA.
 * The generic registry performs a second canonical payload-hash check.
 */
export function createDevelopmentOutputPayloadResolver(
  repository: DevelopmentOutputRepository,
): ProcessOutputPayloadResolver {
  return context => {
    if (
      context.moduleRef.name !== DEVELOPMENT_PROCESS_MODULE_REF.name
      || context.moduleRef.version !== DEVELOPMENT_PROCESS_MODULE_REF.version
    ) {
      throw new Error('development output payload: module reference mismatch');
    }
    return requireExactDevelopmentOutput(
      repository,
      context.processRunId,
      context.projectId,
      context.epicId,
      context.output,
    ).payload;
  };
}

/**
 * Cross-run idempotency key for one immutable Development side effect.
 * ProcessRun id is deliberately excluded.
 */
export function developmentExternalActionKey(
  kind: DevelopmentExternalActionKind,
  developmentCase: DevelopmentCase,
  payloadHash: string,
): string {
  return `development:${kind}:${sha256Hex({
    kind,
    payloadHash,
    formalizationCertificateHash:
      developmentCase.formalizationCertificate.hash,
    solutionContractHash: developmentCase.solutionContract.hash,
    acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
    policyHash: developmentCase.policy.contentHash,
  })}`;
}

function createTaskGraphResolver(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    const receipt = requireTaskReceipt(ctx.input, ctx.node.id);
    try {
      if (receipt.executionId === null) {
        return taskGraphResolutionManifest(
          ctx,
          'clarification-required',
          'missing',
          {
            plannerIntentId: receipt.intentId,
            plannerTaskId: receipt.taskId,
            plannerExecutionId: null,
          },
        );
      }
      const submission = deps.plannerSubmissions.readExact({
        processRunId: ctx.processRunId,
        moduleRef: processModuleKey(DEVELOPMENT_PROCESS_MODULE_REF),
        nodeId: DEVELOPMENT_NODE_IDS.planner,
        intentId: receipt.intentId,
        taskId: receipt.taskId,
        executionId: receipt.executionId,
      });
      if (submission === null) {
        return taskGraphResolutionManifest(
          ctx,
          'clarification-required',
          'missing',
          {
            plannerIntentId: receipt.intentId,
            plannerTaskId: receipt.taskId,
            plannerExecutionId: receipt.executionId,
          },
        );
      }
      if (submission.schema !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA) {
        return taskGraphResolutionManifest(
          ctx,
          'clarification-required',
          'schema-rejected',
          {
            plannerSubmissionRef: submission.artifactRef,
            plannerSubmissionHash: submission.contentHash,
            proposalSchema: submission.schema,
          },
        );
      }
      const decoded = decodeDevelopmentTaskGraphProposal(submission.payload);
      if (!decoded.ok) {
        return taskGraphResolutionManifest(
          ctx,
          'clarification-required',
          'schema-rejected',
          {
            plannerSubmissionRef: submission.artifactRef,
            plannerSubmissionHash: submission.contentHash,
            errors: decoded.errors,
          },
        );
      }
      const graph = buildCanonicalDevelopmentTaskGraph(
        developmentCase,
        decoded.value,
        {
          schema: submission.schema,
          ref: submission.artifactRef,
          hash: submission.contentHash,
        },
      );
      const validation = deps.taskGraphPolicy.validate(
        developmentCase,
        graph,
      );
      const integrityFailure = validation.reasonCodes.some(reason =>
        reason === 'invalid-input-contract'
        || reason === 'task-graph-hash-invalid'
        || reason === 'task-graph-lineage-mismatch');
      if (!validation.valid) {
        const rejectedEvent: 'failed' | 'clarification-required' =
          integrityFailure ? 'failed' : 'clarification-required';
        return taskGraphResolutionManifest(
          ctx,
          rejectedEvent,
          'rejected',
          {
            plannerSubmissionRef: submission.artifactRef,
            plannerSubmissionHash: submission.contentHash,
            proposedGraphHash: graph.graphHash,
            reasonCodes: validation.reasonCodes,
            errors: validation.errors,
          },
        );
      }

      // Authorization boundary: this is the first call allowed to create task
      // projections. Invalid LM output returned above without touching the
      // materializer.
      const materialized = deps.taskGraph.materializeValidatedTaskGraph({
        processRunId: ctx.processRunId,
        developmentCase,
        graph,
      });
      assertReference(
        materialized.reference,
        DEVELOPMENT_TASK_GRAPH_SCHEMA,
        graph.graphHash,
        'materialized task graph',
      );
      if (
        hashDevelopmentTaskGraph(materialized.graph)
          !== materialized.graph.graphHash
        || materialized.graph.graphHash !== graph.graphHash
        || sha256Hex(materialized.graph) !== sha256Hex(graph)
      ) {
        throw new Error(
          'development task graph materializer changed the authorized graph',
        );
      }
      return {
        event: 'valid',
        production: {
          schema: materialized.reference.schema,
          artifactRef: materialized.reference.ref,
          contentHash: materialized.reference.hash,
          bindings: {
            graphHash: materialized.graph.graphHash,
            plannerSubmissionRef:
              materialized.graph.plannerSubmission.ref,
            plannerSubmissionHash:
              materialized.graph.plannerSubmission.hash,
            resolutionStatus: 'valid',
            reasonCodes: validation.reasonCodes,
            errors: validation.errors,
          },
        },
      };
    } catch (error) {
      return taskGraphResolutionManifest(
        ctx,
        'failed',
        'failed',
        { error: errorMessage(error) },
      );
    }
  };
}

function createImplementationAdapter(
  deps: DevelopmentModuleInstallationDependencies,
): ExternalAdapter {
  return async ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    const settlementInput = readExactSettlementState(deps, ctx, developmentCase);
    const graph = requireExactProduct(
      ctx,
      settlementInput.taskGraph,
      settlementInput.productReferences.taskGraph,
      DEVELOPMENT_NODE_IDS.resolveTaskGraph,
      DEVELOPMENT_TASK_GRAPH_SCHEMA,
      'task graph',
    );
    assertExecutableTaskGraph(deps, developmentCase, graph);
    const payloadHash = sha256Hex({
      action: 'implementation-workset',
      developmentCaseHash: sha256Hex(developmentCase),
      taskGraphHash: graph.graphHash,
    });
    const actionKey = developmentExternalActionKey(
      'implementation-workset',
      developmentCase,
      payloadHash,
    );
    const result = await deps.implementationWorkset.execute({
      processRunId: ctx.processRunId,
      actionKey,
      payloadHash,
      developmentCase,
      taskGraph: graph,
      heartbeat: ctx.heartbeat,
    });
    assertExternalReceipt(
      result.receipt,
      'implementation-workset',
      actionKey,
      payloadHash,
    );
    if (result.workset !== null) {
      if (
        result.workset.schemaVersion
          !== DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA
        || result.workset.taskGraphHash !== graph.graphHash
        || hashImplementationWorkset(result.workset)
          !== result.workset.worksetHash
        || result.receipt.resultHash !== result.workset.worksetHash
      ) {
        throw new Error(
          'development implementation adapter returned a workset with invalid lineage',
        );
      }
    } else if (result.receipt.status === 'succeeded') {
      throw new Error(
        'development implementation adapter succeeded without a durable workset',
      );
    }
    return externalProductionResult(
      result.receipt,
      DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      { worksetHash: result.workset?.worksetHash ?? null },
    );
  };
}

function createIntegrationAdapter(
  deps: DevelopmentModuleInstallationDependencies,
): ExternalAdapter {
  return async ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    const settlementInput = readExactSettlementState(deps, ctx, developmentCase);
    const graph = requireExactProduct(
      ctx,
      settlementInput.taskGraph,
      settlementInput.productReferences.taskGraph,
      DEVELOPMENT_NODE_IDS.resolveTaskGraph,
      DEVELOPMENT_TASK_GRAPH_SCHEMA,
      'task graph',
    );
    const workset = requireExactProduct(
      ctx,
      settlementInput.implementationWorkset,
      settlementInput.productReferences.implementationWorkset,
      DEVELOPMENT_NODE_IDS.implementation,
      DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      'implementation workset',
    );
    assertExecutableTaskGraph(deps, developmentCase, graph);
    assertImplementationReady(graph, workset);
    const payloadHash = sha256Hex({
      action: 'candidate-integration',
      developmentCaseHash: sha256Hex(developmentCase),
      taskGraphHash: graph.graphHash,
      implementationWorksetHash: workset.worksetHash,
    });
    const actionKey = developmentExternalActionKey(
      'candidate-integration',
      developmentCase,
      payloadHash,
    );
    const result = await deps.candidateIntegration.integrateAndFreeze({
      processRunId: ctx.processRunId,
      actionKey,
      payloadHash,
      developmentCase,
      taskGraph: graph,
      implementationWorkset: workset,
      heartbeat: ctx.heartbeat,
    });
    assertExternalReceipt(
      result.receipt,
      'candidate-integration',
      actionKey,
      payloadHash,
    );
    if (result.candidate !== null) {
      if (
        result.candidate.schemaVersion !== INTEGRATED_CANDIDATE_SCHEMA
        || result.candidate.taskGraphHash !== graph.graphHash
        || result.candidate.implementationWorksetHash !== workset.worksetHash
        || hashIntegratedCandidate(result.candidate)
          !== result.candidate.candidateHash
        || result.receipt.resultHash !== result.candidate.candidateHash
      ) {
        throw new Error(
          'development integration adapter returned a candidate with invalid lineage',
        );
      }
    } else if (result.receipt.status === 'succeeded') {
      throw new Error(
        'development integration adapter succeeded without a frozen candidate',
      );
    }
    return externalProductionResult(
      result.receipt,
      INTEGRATED_CANDIDATE_SCHEMA,
      { candidateHash: result.candidate?.candidateHash ?? null },
    );
  };
}

function createVerificationAdapter(
  deps: DevelopmentModuleInstallationDependencies,
): ExternalAdapter {
  return async ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    const settlementInput = readExactSettlementState(deps, ctx, developmentCase);
    const graph = requireExactProduct(
      ctx,
      settlementInput.taskGraph,
      settlementInput.productReferences.taskGraph,
      DEVELOPMENT_NODE_IDS.resolveTaskGraph,
      DEVELOPMENT_TASK_GRAPH_SCHEMA,
      'task graph',
    );
    const workset = requireExactProduct(
      ctx,
      settlementInput.implementationWorkset,
      settlementInput.productReferences.implementationWorkset,
      DEVELOPMENT_NODE_IDS.implementation,
      DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      'implementation workset',
    );
    const candidate = requireExactProduct(
      ctx,
      settlementInput.integratedCandidate,
      settlementInput.productReferences.integratedCandidate,
      DEVELOPMENT_NODE_IDS.integration,
      INTEGRATED_CANDIDATE_SCHEMA,
      'integrated candidate',
    );
    assertExecutableTaskGraph(deps, developmentCase, graph);
    assertImplementationReady(graph, workset);
    assertFrozenCandidate(
      graph,
      workset,
      candidate,
      settlementInput.observedCandidateHash,
    );
    const payloadHash = sha256Hex({
      action: 'acceptance-verification',
      developmentCaseHash: sha256Hex(developmentCase),
      taskGraphHash: graph.graphHash,
      candidateHash: candidate.candidateHash,
    });
    const actionKey = developmentExternalActionKey(
      'acceptance-verification',
      developmentCase,
      payloadHash,
    );
    const result = await deps.acceptanceVerification.verify({
      processRunId: ctx.processRunId,
      actionKey,
      payloadHash,
      developmentCase,
      taskGraph: graph,
      candidate,
      heartbeat: ctx.heartbeat,
    });
    assertExternalReceipt(
      result.receipt,
      'acceptance-verification',
      actionKey,
      payloadHash,
    );
    if (result.verification !== null) {
      if (
        result.verification.schemaVersion !== ACCEPTANCE_VERIFICATION_SCHEMA
        || result.verification.acceptanceBaselineHash
          !== developmentCase.acceptanceBaselineHash
        || result.verification.candidateHash !== candidate.candidateHash
        || hashAcceptanceVerification(result.verification)
          !== result.verification.verificationHash
        || result.receipt.resultHash
          !== result.verification.verificationHash
      ) {
        throw new Error(
          'development verification adapter returned evidence with invalid lineage',
        );
      }
    } else if (result.receipt.status === 'succeeded') {
      throw new Error(
        'development verification adapter succeeded without durable evidence',
      );
    }
    return externalProductionResult(
      result.receipt,
      ACCEPTANCE_VERIFICATION_SCHEMA,
      {
        candidateHash: candidate.candidateHash,
        verificationHash:
          result.verification?.verificationHash ?? null,
      },
    );
  };
}

function createDevelopmentSettlementHandler(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    try {
      const developmentCase = requireDevelopmentCase(ctx);
      const resolution = ctx.frame.productions[
        DEVELOPMENT_NODE_IDS.resolveTaskGraph
      ];
      let settled: DevelopmentSettlementResult;
      if (resolution?.bindings.resolutionStatus === 'failed') {
        settled = {
          decision: 'failed',
          reasonCodes: ['infrastructure-error'],
          rationale: stringBinding(resolution.bindings, 'error'),
          inputHash: sha256Hex(developmentCase),
          bundle: null,
        };
      } else {
        const settlementInput = readExactSettlementState(
          deps,
          ctx,
          developmentCase,
        );
        settled = deps.settlementPolicy.settle(settlementInput);
        return developmentSettlementProduction(
          deps,
          ctx,
          settlementInput,
          settled,
        );
      }
      const fallbackInput = emptySettlementInput(developmentCase);
      return developmentSettlementProduction(
        deps,
        ctx,
        fallbackInput,
        settled,
      );
    } catch (error) {
      return developmentSettlementFailure(ctx, errorMessage(error));
    }
  };
}

function developmentSettlementProduction(
  deps: DevelopmentModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  input: DevelopmentSettlementInput,
  settled: DevelopmentSettlementResult,
): KernelHandlerResult {
  let outputBindings: Record<string, unknown> = {};
  if (settled.decision === 'verified') {
    if (settled.bundle === null) {
      throw new Error('verified Development settlement has no bundle');
    }
    const persisted = deps.outputRepository.persist({
      processRunId: ctx.processRunId,
      projectId: ctx.projectId,
      epicId: input.developmentCase.epicId,
      payload: settled.bundle,
    });
    assertDevelopmentOutputRecord(
      persisted.record,
      ctx.processRunId,
      ctx.projectId,
      input.developmentCase.epicId,
    );
    if (
      persisted.record.payload.bundleHash !== settled.bundle.bundleHash
      || sha256Hex(persisted.record.payload) !== sha256Hex(settled.bundle)
    ) {
      throw new Error(
        'Development output repository returned a different verified bundle',
      );
    }
    outputBindings = {
      verifiedBundleRef: persisted.record.artifactRef,
      verifiedBundleContentHash: persisted.record.contentHash,
      verifiedBundleSchema: persisted.record.payload.schemaVersion,
      verifiedBundleHash: persisted.record.payload.bundleHash,
      verifiedBundleReplayed: persisted.replayed,
    };
  } else if (settled.bundle !== null) {
    throw new Error(
      `Development decision '${settled.decision}' must not expose a verified bundle`,
    );
  }

  const developmentPayload = buildDevelopmentCertificatePayload(
    settled,
    input,
  );
  const certificatePayload = {
    schemaVersion: DEVELOPMENT_CERTIFICATE_SCHEMA,
    decision: settled.decision,
    reasonCodes: settled.reasonCodes,
    rationale: settled.rationale,
    inputHash: settled.inputHash,
    payload: developmentPayload,
  };
  const certificateHash = sha256Hex(certificatePayload);
  return {
    event: settled.decision,
    production: {
      schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
      artifactRef:
        `development-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      bindings: {
        ...outputBindings,
        certificatePayload,
        certificateHash,
        certificateSchema: DEVELOPMENT_CERTIFICATE_SCHEMA,
        authority: 'development_settlement_policy',
      },
    },
  };
}

function developmentSettlementFailure(
  ctx: KernelHandlerContext,
  reason: string,
): KernelHandlerResult {
  const runInput = isRecord(ctx.frame.runInput) ? ctx.frame.runInput : {};
  const formalization = isRecord(runInput.formalizationCertificate)
    ? runInput.formalizationCertificate
    : {};
  const solution = isRecord(runInput.solutionContract)
    ? runInput.solutionContract
    : {};
  const policy = isRecord(runInput.policy)
    ? runInput.policy
    : {};
  const developmentPayload = {
    schemaVersion: DEVELOPMENT_CERTIFICATE_SCHEMA,
    decision: 'failed',
    reasonCodes: ['infrastructure-error'],
    rationale: reason,
    inputHash: sha256Hex(ctx.frame.runInput),
    formalizationCertificateHash: stringValue(formalization.hash),
    solutionContractHash: stringValue(solution.hash),
    acceptanceBaselineHash: stringValue(runInput.acceptanceBaselineHash),
    taskGraphHash: null,
    implementationWorksetHash: null,
    candidateHash: null,
    verificationHash: null,
    bundleHash: null,
    policy: {
      id: stringValue(policy.id),
      version: stringValue(policy.version),
      contentHash: stringValue(policy.contentHash),
    },
  };
  const certificatePayload = {
    schemaVersion: DEVELOPMENT_CERTIFICATE_SCHEMA,
    decision: 'failed',
    reasonCodes: ['infrastructure-error'],
    rationale: reason,
    inputHash: developmentPayload.inputHash,
    payload: developmentPayload,
  };
  const certificateHash = sha256Hex(certificatePayload);
  return {
    event: 'failed',
    production: {
      schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
      artifactRef:
        `development-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      bindings: {
        certificatePayload,
        certificateHash,
        certificateSchema: DEVELOPMENT_CERTIFICATE_SCHEMA,
        authority: 'development_settlement_policy',
        settlementError: reason,
      },
    },
  };
}

function taskGraphResolutionManifest(
  ctx: KernelHandlerContext,
  event: 'clarification-required' | 'failed',
  status: string,
  details: Record<string, unknown>,
): KernelHandlerResult {
  const body = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_SCHEMA,
    processRunId: ctx.processRunId,
    resolutionStatus: status,
    ...details,
  };
  const contentHash = sha256Hex(body);
  return {
    event,
    production: {
      schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
      artifactRef:
        `development-task-graph-resolution:${ctx.processRunId}:${contentHash}`,
      contentHash,
      bindings: body,
    },
  };
}

function externalProductionResult(
  receipt: DevelopmentExternalActionReceipt,
  schema: string,
  bindings: Record<string, unknown>,
): NodeExecutionResult {
  return {
    runtimeEvent: receipt.status === 'succeeded' ? 'completed' : 'failed',
    production: {
      schema,
      artifactRef: receipt.resultRef,
      contentHash: receipt.resultHash,
      bindings: {
        actionKey: receipt.actionKey,
        actionKind: receipt.actionKind,
        payloadHash: receipt.payloadHash,
        externalStatus: receipt.status,
        resultHash: receipt.resultHash,
        replayed: receipt.replayed,
        ...bindings,
      },
    },
  };
}

function assertExternalReceipt(
  receipt: DevelopmentExternalActionReceipt,
  kind: DevelopmentExternalActionKind,
  actionKey: string,
  payloadHash: string,
): void {
  if (
    receipt.actionKind !== kind
    || receipt.actionKey !== actionKey
    || receipt.payloadHash !== payloadHash
    || !['succeeded', 'failed', 'blocked', 'uncertain'].includes(
      receipt.status,
    )
    || !receipt.resultRef.trim()
    || !receipt.resultHash.trim()
    || typeof receipt.replayed !== 'boolean'
  ) {
    throw new Error(
      `development external adapter returned an invalid ${kind} receipt`,
    );
  }
}

function assertExecutableTaskGraph(
  deps: DevelopmentModuleInstallationDependencies,
  developmentCase: DevelopmentCase,
  graph: DevelopmentTaskGraphSnapshot,
): void {
  const validation = deps.taskGraphPolicy.validate(developmentCase, graph);
  if (!validation.valid) {
    throw new Error(
      `Development task graph is no longer executable: ${validation.errors.join('; ')}`,
    );
  }
}

function assertImplementationReady(
  graph: DevelopmentTaskGraphSnapshot,
  workset: DevelopmentImplementationWorkset,
): void {
  const resultByKey = new Map(
    workset.results.map(result => [result.key, result]),
  );
  const required = graph.implementationItems
    .filter(item => item.required)
    .map(item => item.key);
  if (
    workset.schemaVersion !== DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA
    || hashImplementationWorkset(workset) !== workset.worksetHash
    || workset.taskGraphHash !== graph.graphHash
    || !workset.complete
    || workset.blockingItemKeys.length > 0
    || !unique(workset.results.map(result => result.key))
    || required.some(key => resultByKey.get(key)?.status !== 'succeeded')
    || workset.results.some(result =>
      result.status === 'succeeded'
      && (
        !result.implementationExecutionId?.trim()
        || !result.reviewExecutionId?.trim()
        || !result.reviewedSourceCommit?.trim()
        || result.result === null
        || !result.result.schema.trim()
        || !result.result.ref.trim()
        || !result.result.hash.trim()
      ))
  ) {
    throw new Error(
      'Development implementation workset is not complete, reviewed and immutable',
    );
  }
}

function assertFrozenCandidate(
  graph: DevelopmentTaskGraphSnapshot,
  workset: DevelopmentImplementationWorkset,
  candidate: IntegratedReleaseCandidate,
  observedCandidateHash: string | null,
): void {
  if (
    candidate.schemaVersion !== INTEGRATED_CANDIDATE_SCHEMA
    || hashIntegratedCandidate(candidate) !== candidate.candidateHash
    || candidate.taskGraphHash !== graph.graphHash
    || candidate.implementationWorksetHash !== workset.worksetHash
    || candidate.frozen !== true
    || observedCandidateHash !== candidate.candidateHash
  ) {
    throw new Error(
      'Development candidate is not the unchanged frozen integration product',
    );
  }
}

function readExactSettlementState(
  deps: DevelopmentModuleInstallationDependencies,
  ctx: KernelHandlerContext | ExternalAdapterContext,
  developmentCase: DevelopmentCase,
): DevelopmentSettlementInput {
  const state = deps.settlementState.buildSettlementInput({
    processRunId: ctx.processRunId,
    developmentCase,
  });
  if (
    state.developmentCase.projectId !== ctx.projectId
    || state.developmentCase.epicId !== ctx.epicId
    || sha256Hex(state.developmentCase) !== sha256Hex(developmentCase)
  ) {
    throw new Error(
      `${ctx.node.id}: settlement state does not match the ProcessRun input`,
    );
  }
  return state;
}

function requireExactProduct<T>(
  ctx: KernelHandlerContext | ExternalAdapterContext,
  value: T | null,
  reference: ContentAddressedReference | null,
  producerNodeId: string,
  schema: string,
  label: string,
): T {
  const production = ctx.frame.productions[producerNodeId];
  if (value === null || reference === null || !production) {
    throw new Error(`${ctx.node.id}: exact ${label} is missing`);
  }
  assertReference(reference, schema, production.contentHash, label);
  if (
    production.schema !== reference.schema
    || production.artifactRef !== reference.ref
  ) {
    throw new Error(
      `${ctx.node.id}: ${label} durable production reference mismatch`,
    );
  }
  return value;
}

function requireDevelopmentCase(
  ctx: KernelHandlerContext | ExternalAdapterContext,
): DevelopmentCase {
  const value = ctx.frame.runInput;
  if (
    !isRecord(value)
    || value.schemaVersion !== 'saga3.development-case.v1'
    || !Number.isInteger(value.projectId)
    || !Number.isInteger(value.epicId)
    || value.projectId !== ctx.projectId
    || value.epicId !== ctx.epicId
  ) {
    throw new Error(`${ctx.node.id}: invalid or mismatched DevelopmentCase`);
  }
  return value as unknown as DevelopmentCase;
}

function requireTaskReceipt(
  value: unknown,
  nodeId: string,
): NodeExecutionReceipt {
  if (
    !isRecord(value)
    || value.kind !== 'task-execution'
    || value.executorKind !== 'lm'
    || !Number.isInteger(value.intentId)
    || !Number.isInteger(value.taskId)
    || typeof value.runtimeStatus !== 'string'
  ) {
    throw new Error(`${nodeId}: exact planner execution receipt is required`);
  }
  return value as unknown as NodeExecutionReceipt;
}

function emptySettlementInput(
  developmentCase: DevelopmentCase,
): DevelopmentSettlementInput {
  return {
    schemaVersion: 'saga3.development-settlement-input.v1',
    developmentCase,
    taskGraph: null,
    implementationWorkset: null,
    integratedCandidate: null,
    observedCandidateHash: null,
    acceptanceVerification: null,
    productReferences: {
      taskGraph: null,
      implementationWorkset: null,
      integratedCandidate: null,
      acceptanceVerification: null,
    },
    openHumanGateIds: [],
  };
}

function requireExactDevelopmentOutput(
  repository: DevelopmentOutputRepository,
  processRunId: number,
  projectId: number,
  epicId: number | null,
  output: ProcessModuleOutput,
): DevelopmentOutputRecord {
  if (epicId === null) {
    throw new Error('development output requires a non-null epic');
  }
  const record = repository.readByProcessRun(processRunId);
  if (
    record === null
    || record.processRunId !== processRunId
    || record.projectId !== projectId
    || record.epicId !== epicId
    || output.schema !== VERIFIED_INTEGRATION_BUNDLE_SCHEMA
    || record.payload.schemaVersion !== output.schema
    || record.artifactRef !== output.artifactRef
    || record.contentHash !== output.contentHash
  ) {
    throw new Error(
      `development output: exact bundle for process_run ${processRunId} is missing or mismatched`,
    );
  }
  assertDevelopmentOutputRecord(record, processRunId, projectId, epicId);
  return record;
}

function assertDevelopmentOutputRecord(
  record: DevelopmentOutputRecord,
  processRunId: number,
  projectId: number,
  epicId: number,
): void {
  if (
    record.processRunId !== processRunId
    || record.projectId !== projectId
    || record.epicId !== epicId
    || !record.artifactRef.trim()
    || record.payload.schemaVersion !== VERIFIED_INTEGRATION_BUNDLE_SCHEMA
    || hashVerifiedIntegrationBundle(record.payload)
      !== record.payload.bundleHash
    || sha256Hex(record.payload) !== record.contentHash
  ) {
    throw new Error('Development output repository returned an invalid record');
  }
}

function assertReference(
  reference: ContentAddressedReference,
  schema: string,
  hash: string,
  label: string,
): void {
  if (
    reference.schema !== schema
    || reference.hash !== hash
    || !reference.ref.trim()
  ) {
    throw new Error(`${label} content-addressed reference is invalid`);
  }
}

function assertDevelopmentModule(module: ProcessModuleDefinition): void {
  if (
    module.identity.name !== DEVELOPMENT_PROCESS_MODULE_REF.name
    || module.identity.version !== DEVELOPMENT_PROCESS_MODULE_REF.version
  ) {
    throw new Error('development output resolver received another module');
  }
}

function stringBinding(
  bindings: Record<string, unknown>,
  key: string,
): string {
  const value = bindings[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`development output: missing '${key}' binding`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
