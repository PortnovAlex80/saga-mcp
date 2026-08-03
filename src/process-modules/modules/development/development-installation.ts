import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { processModuleKey } from '../../domain/process-module.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../application/kernel-handler-registry.js';
import { withKernelRecoveryIssue } from '../../application/kernel-recovery-issue.js';
import type {
  NodeExecutionReceipt,
  NodeExecutionResult,
} from '../../application/node-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../application/lifecycle-orchestrator.js';
import type {
  ProcessModuleExecutionContext,
} from '../../application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../persistence/process-run.js';
import type {
  IssueProcessOutcomeCertificateCommand,
} from '../../persistence/process-outcome-certificate.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  ModuleCompletion,
} from '../../domain/spi/module-completion.js';
import type {
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../domain/spi/production-envelope.js';
import {
  DEVELOPMENT_KERNEL_HANDLER_IDS,
  type DevelopmentModuleInstallationDependencies,
  type DevelopmentOutputRecord,
  type DevelopmentOutputRepository,
} from './development-kernel-ports.js';
import {
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentSettlementInput,
} from './development-schemas.js';
import {
  buildDevelopmentCertificatePayload,
  hashDevelopmentTaskGraph,
  hashVerifiedIntegrationBundle,
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
  settlement: 'settle-development',
} as const;

/**
 * Build the kernel handlers for the Development module Flow.
 *
 * The Flow is lm+kernel only (mechanical pattern cloned from Formalization):
 *
 *   plan-task-graph (lm)   → resolve-task-graph (kernel) → settle-development (kernel)
 *
 * Implementation, integration and verification are NOT Flow nodes. The
 * resolver materializes the projected kanban tasks (declarative persistence);
 * workers then claim them through the shared worker_next queue
 * (infrastructure) and settle-development re-reads the resulting tracker state.
 *
 * There are no external adapters — the module never hires, merges or tests.
 */
export function createDevelopmentKernelHandlers(
  deps: DevelopmentModuleInstallationDependencies,
): Record<string, KernelHandler> {
  return {
    [DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph]:
      withKernelRecoveryIssue(
        createTaskGraphResolver(deps),
        {
          policyId: 'repair-development-task-graph',
          subject: 'development task graph proposal',
          triggerEvents: ['clarification-required'],
          reasonBindings: [
            'errors',
            'reasonCodes',
            'resolutionStatus',
          ],
          actualBindings: [
            'errors',
            'reasonCodes',
            'resolutionStatus',
            'proposalSchema',
            'plannerSubmissionRef',
            'plannerSubmissionHash',
          ],
          acceptanceCriteria: [
            'The planner submits the declared task-graph proposal schema.',
            'The graph covers the accepted decomposition and remains acyclic.',
            'Every task, repository and dependency preserves exact input lineage.',
          ],
          allowedChanges: [
            'development task graph proposal',
            'task definitions, dependencies and repository bindings in that proposal',
          ],
        },
      ),
    [DEVELOPMENT_KERNEL_HANDLER_IDS.settle]:
      createDevelopmentSettlementHandler(deps),
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
      // CGAD P18 — read the workplace's (planner node's) product via the
      // centralized node-scoped products when available, so the gate can never
      // be blinded to the planner's prior submission by a transient task
      // identity. Falls back to the task-scoped read on legacy runs without the
      // centralized seam.
      const moduleRef = processModuleKey(DEVELOPMENT_PROCESS_MODULE_REF);
      const submission = ctx.nodeProducts?.submission
        ?? deps.plannerSubmissions.readLatestForNode(
          ctx.processRunId,
          moduleRef,
          DEVELOPMENT_NODE_IDS.planner,
        )
        ?? deps.plannerSubmissions.readLatestForTask({
          processRunId: ctx.processRunId,
          moduleRef,
          nodeId: DEVELOPMENT_NODE_IDS.planner,
          taskId: receipt.taskId,
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

function createDevelopmentSettlementHandler(
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    try {
      const developmentCase = requireDevelopmentCase(ctx);
      const resolution = ctx.frame.productions[
        DEVELOPMENT_NODE_IDS.resolveTaskGraph
      ];

      // Conveyor gate (resolve-task-graph produced a valid graph and projected
      // impl/integration/verification tasks onto the kanban). When those tasks
      // are not all terminal yet, RELEASE the run to the conveyor: return
      // runtimeEvent 'paused'. The GenericFlowExecutor raises
      // ProcessRunPausedError and the run pauses; orchestrate-cli /
      // LifecycleOrchestrator then drains the shared worker_next queue
      // (workers claim the projected todo tasks, execute, review, merge, record
      // evidence), and once every projected task reaches terminal state it
      // resumes the run. The generic-flow-executor RE-EXECUTES this same node
      // (see `reexecutePausedNode`), so the gate re-checks and proceeds.
      //
      // Skipped when resolution already failed/needs-clarification — in those
      // cases there is nothing to wait for; settle records the terminal
      // outcome directly.
      if (resolution?.bindings.resolutionStatus === 'valid') {
        if (!deps.settlementState.areProjectedTasksTerminal({
          processRunId: ctx.processRunId,
          developmentCase,
        })) {
          return {
            event: 'await-implementation',
            runtimeEvent: 'paused',
            production: {
              schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
              artifactRef:
                `development-await:${ctx.processRunId}:${resolution.contentHash}`,
              contentHash: resolution.contentHash,
              bindings: {
                awaitReason: 'projected-implementation-tasks-not-terminal',
                taskGraphHash: resolution.bindings.graphHash,
              },
            },
          };
        }
      }

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
        // The implementation workset, integrated release candidate and
        // acceptance-verification workset are reconstructed INSIDE
        // settlementState.buildSettlementInput by reading exact tracker state
        // (projected tasks, integration_state, recorded evidence). They are no
        // longer produced by dedicated external Flow nodes.
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
      return developmentSettlementFailure(deps, ctx, errorMessage(error));
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
    moduleRef: DEVELOPMENT_PROCESS_MODULE_REF,
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
      // WAVE 5 CUTOVER — the certificate envelope is no longer duplicated into
      // `production.bindings`. The kernel issues its own certificate (above)
      // and emits an explicit ModuleCompletion whose certificateRef points at
      // the issued row; settlement reads it from there. The legacy magic keys
      // (certificatePayload / certificateHash / certificateSchema) are removed.
      // `outputBindings` (verifiedBundleRef etc.) and `authority` are
      // non-certificate bindings and are retained.
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
  // Uncle Bob Wave 4 — the failure path is also authoritative for its own
  // certificate (it emits the 'failed' terminal outcome). Same issuance as the
  // success path; the repo is idempotent so the executor's magic-bindings
  // re-issue during the additive cutover is safe.
  const certResult = deps.certificateRepository.issue({
    processRunId: ctx.processRunId,
    moduleRef: DEVELOPMENT_PROCESS_MODULE_REF,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
