import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
import type { ProcessModuleReference } from '../../../process-modules/domain/process-module.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../../process-modules/application/kernel-handler-registry.js';
// The withKernelRecoveryIssue import was removed along with the wrapper —
// see the comment at the resolveTaskGraph handler below.
import type {
  NodeExecutionReceipt,
  NodeExecutionResult,
} from '../../../process-modules/application/node-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../../process-modules/application/lifecycle-orchestrator.js';
import type {
  ProcessModuleExecutionContext,
} from '../../../process-modules/application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import type {
  IssueProcessOutcomeCertificateCommand,
} from '../../../process-modules/persistence/process-outcome-certificate.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  ModuleCompletion,
} from '../../../process-modules/domain/spi/module-completion.js';
import type {
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/production-envelope.js';
import {
  DEVELOPMENT_KERNEL_HANDLER_IDS,
  type DevelopmentModuleInstallationDependencies,
  type DevelopmentOutputRecord,
  type DevelopmentOutputRepository,
} from '../domain/development-kernel-ports.js';
import {
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentSettlementInput,
} from '../domain/development-schemas.js';
import {
  buildDevelopmentCertificatePayload,
  hashDevelopmentTaskGraph,
  hashVerifiedIntegrationBundle,
  type DevelopmentSettlementResult,
} from '../domain/development-settlement-policy.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../../../process-modules/modules/development/development-process-module.js';
import {
  buildCanonicalDevelopmentTaskGraph,
  decodeDevelopmentTaskGraphProposal,
} from '../domain/development-task-graph.js';

export const DEVELOPMENT_NODE_IDS = {
  planner: 'plan-task-graph',
  resolveTaskGraph: 'resolve-task-graph',
  settlement: 'settle-development',
  freezeIntegratedCandidate: 'freeze-integrated-candidate',
  bindRunnableCandidate: 'bind-runnable-candidate',
} as const;

/**
 * Build the kernel handlers for the Development module Flow.
 *
 * The planner proposes a graph, the resolver freezes it, universal Production
 * Cells produce implementation and verification products, and settlement
 * evaluates their sealed CandidateSets.
 */
export function createDevelopmentKernelHandlers(
  deps: DevelopmentModuleInstallationDependencies,
  moduleRef: ProcessModuleReference = DEVELOPMENT_PROCESS_MODULE_REF,
): Record<string, KernelHandler> {
  return {
    // The withKernelRecoveryIssue wrapper for resolveTaskGraph was REMOVED:
    // it referenced policyId 'repair-development-task-graph' which no module
    // ever declared in flow.recovery — a dormant mine that would crash the
    // executor on the first 'clarification-required' verdict. The wrapper
    // was dead code (never triggered in production because the policy was
    // undeclared), and declaring it (adding flow recovery + transitions)
    // changed the flow topology in ways that broke the golden-path E2E.
    // 'clarification-required' from resolve-task-graph remains a legitimate
    // terminal outcome routed to settle-development → complete-clarification-required.
    [DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph]:
      createTaskGraphResolver(deps),
    [DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate]:
      createIntegratedCandidateFreezeHandler(deps),
    [DEVELOPMENT_KERNEL_HANDLER_IDS.bindRunnableCandidate]:
      createRunnableCandidateBindingHandler(deps),
    [DEVELOPMENT_KERNEL_HANDLER_IDS.settle]:
      createDevelopmentSettlementHandler(deps, moduleRef),
  };
}

function createIntegratedCandidateFreezeHandler(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    const result = deps.settlementState.freezeIntegratedCandidate({
      processRunId: ctx.processRunId,
      developmentCase,
    });
    if (result.status === 'waiting') {
      const contentHash = sha256Hex(result);
      return {
        event: 'waiting',
        runtimeEvent: 'paused',
        production: {
          schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
          artifactRef: `development-candidate-wait:${ctx.processRunId}:${contentHash}`,
          contentHash,
          bindings: { reasonCodes: result.reasonCodes },
        },
      };
    }
    if (result.status === 'failed') {
      const contentHash = sha256Hex(result);
      return {
        event: 'failed',
        production: {
          schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
          artifactRef: `development-candidate-failed:${ctx.processRunId}:${contentHash}`,
          contentHash,
          bindings: { reasonCodes: result.reasonCodes },
        },
      };
    }
    return {
      event: 'frozen',
      production: {
        schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
        artifactRef: result.reference.ref,
        contentHash: result.reference.hash,
        semanticDigest: sha256Hex({
          schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
          frozen: result.candidate.frozen,
          repositories: result.candidate.repositories,
          buildProducts: result.candidate.buildProducts,
        }),
        bindings: {
          candidate: result.candidate,
          candidateRef: result.reference,
        },
      },
    };
  };
}

function createRunnableCandidateBindingHandler(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const result = deps.settlementState.bindRunnableCandidate({
      processRunId: ctx.processRunId,
      developmentCase: requireDevelopmentCase(ctx),
    });
    if (result.status !== 'bound') {
      const contentHash = sha256Hex(result);
      return {
        event: result.status === 'waiting' ? 'waiting' : 'failed',
        ...(result.status === 'waiting' ? { runtimeEvent: 'paused' as const } : {}),
        production: {
          schema: INTEGRATED_CANDIDATE_SCHEMA,
          artifactRef: `development-runnable-${result.status}:${ctx.processRunId}:${contentHash}`,
          contentHash,
          bindings: { reasonCodes: result.reasonCodes },
        },
      };
    }
    return {
      event: 'bound',
      production: {
        schema: INTEGRATED_CANDIDATE_SCHEMA,
        artifactRef: result.reference.ref,
        contentHash: result.reference.hash,
        bindings: { candidate: result.candidate, candidateRef: result.reference },
      },
    };
  };
}

/**
 * GenericFlow output hook. It exposes only the exact durable bundle persisted
 * by this ProcessRun's settlement handler.
 */
export function createDevelopmentOutputResolver(
  repository: DevelopmentOutputRepository,
  expectedModuleRef: ProcessModuleReference = DEVELOPMENT_PROCESS_MODULE_REF,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (module, terminalOutcome, terminalResult, context) => {
    if (terminalOutcome !== 'verified') return null;
    assertDevelopmentModule(module, expectedModuleRef);
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
  allowedModuleRefs: readonly ProcessModuleReference[] = [DEVELOPMENT_PROCESS_MODULE_REF],
): ProcessOutputPayloadResolver {
  return context => {
    if (!allowedModuleRefs.some(reference =>
      context.moduleRef.name === reference.name
      && context.moduleRef.version === reference.version)) {
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

function createTaskGraphResolver(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const developmentCase = requireDevelopmentCase(ctx);
    // The planner is now a Production Cell. Its execution receipt arrives via
    // ctx.input on the normal path, but on cell-resume it may be restored in
    // ctx.frame.receipts or ctx.frame.productions (mirrors the Formalization
    // fallback pattern). Try ctx.input first, then frame fallbacks.
    let receipt: NodeExecutionReceipt;
    try {
      receipt = requireTaskReceipt(ctx.input, ctx.node.id);
    } catch {
      const plannerNodeId = 'plan-task-graph';
      const fromFrameReceipts = tryLmReceipt(ctx.frame?.receipts?.[plannerNodeId]);
      const fromFrameProductions = tryLmReceipt(ctx.frame?.productions?.[plannerNodeId]);
      const recovered = fromFrameReceipts ?? fromFrameProductions;
      if (!recovered) {
        throw new Error(
          `${ctx.node.id}: expected an exact completed/failed LM execution receipt `
          + `(checked ctx.input and frame.productions.${plannerNodeId})`,
        );
      }
      receipt = recovered;
    }
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
      // Read the planner product only through the centralized node-scoped seam.
      const submission = ctx.nodeProducts?.submission ?? null;
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
      // materializer. Materializing the projected kanban tasks is declarative
      // persistence — it makes work CLAIMABLE by workers through the shared
      // worker_next queue (infrastructure); the module never hires them.
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
          semanticDigest: sha256Hex({
            schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
            acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
            acceptanceCriteria: developmentCase.acceptanceCriteria,
            repositories: developmentCase.repositories,
            implementationItems: materialized.graph.implementationItems,
            verificationItems: materialized.graph.verificationItems,
            integrationTargets: materialized.graph.integrationTargets,
          }),
          bindings: {
            graphHash: materialized.graph.graphHash,
            items: materialized.graph.implementationItems,
            verificationItems: materialized.graph.verificationItems,
            integrationTargets: materialized.graph.integrationTargets,
            taskGraph: materialized.graph,
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

function createDevelopmentSettlementHandler(
  deps: DevelopmentModuleInstallationDependencies,
  moduleRef: ProcessModuleReference,
): KernelHandler {
  return ctx => {
    try {
      const developmentCase = requireDevelopmentCase(ctx);
      const resolution = ctx.frame.productions[
        DEVELOPMENT_NODE_IDS.resolveTaskGraph
      ];

      // Settlement consumes only products accepted by the preceding universal
      // cells. A failed graph resolution terminates without cell products.
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
        // Accepted CandidateSets are the authority; task cards are projections.
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
          moduleRef,
        );
      }
      const fallbackInput = emptySettlementInput(developmentCase);
      return developmentSettlementProduction(
        deps,
        ctx,
        fallbackInput,
        settled,
        moduleRef,
      );
    } catch (error) {
      return developmentSettlementFailure(deps, ctx, errorMessage(error), moduleRef);
    }
  };
}

/**
 * Uncle Bob Wave 4 — build the explicit {@link ModuleCompletion} envelope the
 * settlement kernel emits alongside its (still-present) magic-bindings writes.
 *
 * `outcome` is the development decision the kernel just settled (verified /
 * rework-required / clarification-required / blocked / failed). `certificateRef`
 * is the content-addressed pointer to the certificate the kernel just issued.
 *
 * The output envelope is minimal-but-conformant: it carries the outcome, an
 * empty productions list (the durable productions live in NodeRun rows and the
 * output artifact store; the envelope's role here is to host the certificate
 * ref the executor's explicit settlement path reads), the certificateRef, and
 * a `completion` slot. All five development outcomes are terminal, so
 * `terminal` is always true.
 *
 * SERIALIZABILITY: the ModuleCompletion → ProcessModuleOutputEnvelope
 * reference is ONE-DIRECTIONAL (completion → envelope). The envelope is a
 * LEAF with no back-reference (Wave 8 BLOCKER 2 removed the cyclic
 * `completion` field). The SQLite NodeRun repo persists `completion` via
 * `JSON.stringify` (sqlite-node-run-repository.ts ~line 414); because the
 * model is a tree, this never throws. The executor's explicit settlement path
 * reads only `outputEnvelope.certificateRef` (generic-flow-executor.ts
 * ~line 318).
 *
 * Pure: same (outcome, certificateRef) → same ModuleCompletion.
 */
function buildDevelopmentModuleCompletion(
  outcome: string,
  certificateRef: ProductRef,
): ModuleCompletion {
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  return {
    outcome,
    outputEnvelope,
    terminal: true,
  };
}

function developmentSettlementProduction(
  deps: DevelopmentModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  input: DevelopmentSettlementInput,
  settled: DevelopmentSettlementResult,
  moduleRef: ProcessModuleReference,
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

  // Uncle Bob Wave 4 — the settlement kernel is now the AUTHORITY for its own
  // certificate. Previously the generic-flow-executor's magic-bindings branch
  // called certificateRepo.issue on the kernel's behalf at settlement time
  // (generic-flow-executor.ts ~line 377). Wave 5 will delete that branch; the
  // kernel issuing its own cert now is what makes the explicit ModuleCompletion
  // path authoritative and keeps the magic-bindings writes a pure fallback.
  //
  // Mirrors the executor's generic-envelope issuance exactly:
  //   certificateRepo.issue({ processRunId, moduleRef, projectId, epicId,
  //     payload, certificateHash, authority }).
  // The repo is idempotent on certificate_hash (re-issuing the same hash returns
  // the existing row with replayed=true), so the executor's magic-bindings
  // branch re-issuing the same payload during the additive cutover is safe.
  const certResult = deps.certificateRepository.issue({
    processRunId: ctx.processRunId,
    moduleRef,
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    payload: certificatePayload,
    certificateHash,
    authority: 'development_settlement_policy',
  } satisfies IssueProcessOutcomeCertificateCommand);
  const certificateRef: ProductRef = {
    schemaId: DEVELOPMENT_CERTIFICATE_SCHEMA,
    ref: `certificate:${certResult.record.id}`,
    digest: certResult.record.certificateHash,
  };

  return {
    event: settled.decision,
    production: {
      schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
      artifactRef:
        `development-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      // The certificate is an explicit ModuleCompletion reference; bindings
      // carry only non-certificate output data and authority.
      bindings: {
        ...outputBindings,
        authority: 'development_settlement_policy',
      },
    },
    // W3-A1 / Uncle Bob Wave 4 — explicit terminal envelope. The executor
    // forwards this onto NodeExecutionResult.completion, persists it to the
    // NodeRun v2 `completion` column, and on crash-resume reads the certificate
    // reference DIRECTLY from here. The certificate was just issued above; this
    // ref points at it by content-address. `terminal: true` mirrors
    // OutcomeDefinition.terminal for all five development outcomes (verified /
    // rework-required / clarification-required / blocked / failed — every
    // declared outcome is terminal).
    completion: buildDevelopmentModuleCompletion(settled.decision, certificateRef),
  };
}

function developmentSettlementFailure(
  deps: DevelopmentModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  reason: string,
  moduleRef: ProcessModuleReference,
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
  // WAVE 8 HIGH 3 — the failure path is also authoritative for its own
  // certificate (it emits the 'failed' terminal outcome). The repo is
  // idempotent on certificateHash so re-runs converge. There is NO try/catch
  // swallow: if `certificateRepository.issue` throws, the settlement MUST FAIL
  // LOUDLY (the previous contract relied on the deleted magic-bindings
  // fallback; Wave 8 makes terminal completion mandatory and the swallow was a
  // silent-null data-loss path).
  const certResult = deps.certificateRepository.issue({
    processRunId: ctx.processRunId,
    moduleRef,
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    payload: certificatePayload,
    certificateHash,
    authority: 'development_settlement_policy',
  } satisfies IssueProcessOutcomeCertificateCommand);
  const certificateRef: ProductRef = {
    schemaId: DEVELOPMENT_CERTIFICATE_SCHEMA,
    ref: `certificate:${certResult.record.id}`,
    digest: certResult.record.certificateHash,
  };
  return {
    event: 'failed',
    production: {
      schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
      artifactRef:
        `development-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      // WAVE 5 CUTOVER — certificate envelope removed from bindings (see
      // developmentSettlementProduction). `authority` + `settlementError` are
      // non-certificate bindings and are retained.
      bindings: {
        authority: 'development_settlement_policy',
        settlementError: reason,
      },
    },
    // Uncle Bob Wave 4 — explicit terminal envelope for the failure outcome.
    completion: buildDevelopmentModuleCompletion('failed', certificateRef),
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

function readExactSettlementState(
  deps: DevelopmentModuleInstallationDependencies,
  ctx: KernelHandlerContext,
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

function requireDevelopmentCase(
  ctx: KernelHandlerContext,
): DevelopmentCase {
  const value = ctx.frame.runInput;
  if (
    !isRecord(value)
    || value.schemaVersion !== 'factory.development-case.v1'
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
    || (value.executorKind !== 'lm' && value.executorKind !== 'production-cell')
    || !Number.isInteger(value.intentId)
    || !Number.isInteger(value.taskId)
    || typeof value.runtimeStatus !== 'string'
  ) {
    throw new Error(`${nodeId}: exact planner execution receipt is required`);
  }
  return value as unknown as NodeExecutionReceipt;
}

/**
 * Soft receipt probe for cell-resume fallback. Returns null when the value is
 * not a valid LM execution receipt (instead of throwing). Mirrors the
 * Formalization tryLmReceipt pattern.
 */
function tryLmReceipt(input: unknown): NodeExecutionReceipt | null {
  const receipt = input as Partial<NodeExecutionReceipt> | null;
  if (
    !receipt
    || receipt.kind !== 'task-execution'
    || (receipt.executorKind !== 'lm' && receipt.executorKind !== 'production-cell')
    || !Number.isInteger(receipt.intentId)
    || Number(receipt.intentId) <= 0
    || !Number.isInteger(receipt.taskId)
    || Number(receipt.taskId) <= 0
    || (receipt.executionId !== null && typeof receipt.executionId !== 'string')
    || !['completed', 'failed'].includes(String(receipt.runtimeStatus))
  ) {
    return null;
  }
  return receipt as NodeExecutionReceipt;
}

function emptySettlementInput(
  developmentCase: DevelopmentCase,
): DevelopmentSettlementInput {
  return {
    schemaVersion: 'factory.development-settlement-input.v1',
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
    localReadinessReceipt: null,
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

function assertDevelopmentModule(
  module: ProcessModuleDefinition,
  expected: ProcessModuleReference,
): void {
  if (
    module.identity.name !== expected.name
    || module.identity.version !== expected.version
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
