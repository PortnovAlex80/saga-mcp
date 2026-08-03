import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
import type {
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/production-envelope.js';
import type {
  ModuleCompletion,
} from '../../../process-modules/domain/spi/module-completion.js';
import type {
  HumanInteractionAdapter,
  HumanInteractionContext,
} from '../../../process-modules/application/human-interaction-registry.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../../process-modules/application/kernel-handler-registry.js';
import type { NodeExecutionResult } from '../../../process-modules/application/node-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../../process-modules/application/lifecycle-orchestrator.js';
import type {
  ProcessModuleExecutionContext,
} from '../../../process-modules/application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DELIVERY_HUMAN_ADAPTER_IDS,
  DELIVERY_KERNEL_HANDLER_IDS,
  type DeliveryModuleInstallationDependencies,
  type DeliveryOutputRecord,
  type DeliveryOutputRepository,
} from '../domain/delivery-kernel-ports.js';
import { DELIVERY_PROCESS_MODULE_REF } from '../../../process-modules/modules/delivery/delivery-process-module.js';
import {
  DELIVERY_APPROVAL_SCHEMA,
  DELIVERY_CERTIFICATE_SCHEMA,
  DELIVERY_OBSERVATION_SCHEMA,
  DELIVERY_PREFLIGHT_SCHEMA,
  DELIVERY_PUBLICATION_SCHEMA,
  DELIVERY_RELEASE_CASE_SCHEMA,
  DELIVERY_SETTLEMENT_INPUT_SCHEMA,
  RELEASE_RECORD_SCHEMA,
  type AuthorizedDeliveryReleaseCase,
  type DeliveryApprovalDecision,
  type DeliveryContentAddressedReference,
  type DeliveryPreflightSnapshot,
  type DeliveryPublicationSnapshot,
  type DeliveryReleaseCase,
  type DeliverySettlementInput,
} from '../domain/delivery-schemas.js';
import {
  buildDeliveryCertificatePayload,
  deliveryActionKey,
  hashDeliveryApproval,
  hashDeliveryObservation,
  hashDeliveryPreflight,
  hashDeliveryPublication,
  hashReleaseRecord,
  type DeliverySettlementResult,
} from '../domain/delivery-settlement-policy.js';

export const DELIVERY_NODE_IDS = {
  preflight: 'preflight-release',
  approval: 'approve-release',
  publication: 'publish-deploy',
  observation: 'observe-release',
  settlement: 'settle-delivery',
} as const;

export function createDeliveryKernelHandlers(
  deps: DeliveryModuleInstallationDependencies,
): Record<string, KernelHandler> {
  return {
    [DELIVERY_KERNEL_HANDLER_IDS.preflight]:
      createDeliveryPreflightHandler(deps),
    [DELIVERY_KERNEL_HANDLER_IDS.publishDeploy]:
      createPublicationHandler(deps),
    [DELIVERY_KERNEL_HANDLER_IDS.observeRelease]:
      createObservationHandler(deps),
    [DELIVERY_KERNEL_HANDLER_IDS.settle]:
      createDeliverySettlementHandler(deps),
  };
}

export function createDeliveryHumanInteractions(
  deps: DeliveryModuleInstallationDependencies,
): Record<string, HumanInteractionAdapter> {
  return {
    [DELIVERY_HUMAN_ADAPTER_IDS.approval]:
      createApprovalInteraction(deps),
  };
}

export function createDeliveryOutputResolver(
  repository: DeliveryOutputRepository,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (module, terminalOutcome, terminalResult, context) => {
    if (terminalOutcome !== 'released') return null;
    assertDeliveryModule(module);
    const bindings = terminalResult.production?.bindings ?? {};
    const artifactRef = stringBinding(bindings, 'releaseRecordRef');
    const contentHash = stringBinding(bindings, 'releaseRecordContentHash');
    const schema = stringBinding(bindings, 'releaseRecordSchema');
    const record = requireExactDeliveryOutput(
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

export function createDeliveryOutputPayloadResolver(
  repository: DeliveryOutputRepository,
): ProcessOutputPayloadResolver {
  return context => {
    if (
      context.moduleRef.name !== DELIVERY_PROCESS_MODULE_REF.name
      || context.moduleRef.version !== DELIVERY_PROCESS_MODULE_REF.version
    ) {
      throw new Error('delivery output payload: module reference mismatch');
    }
    return requireExactDeliveryOutput(
      repository,
      context.processRunId,
      context.projectId,
      context.epicId,
      context.output,
    ).payload;
  };
}

function createDeliveryPreflightHandler(
  deps: DeliveryModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const deliveryCase = requireDeliveryCase(ctx);
    if (deliveryCase.deliveryMode === 'deferred') {
      return deferredDeliveryManifest(ctx, deliveryCase.deferredProfile.profileHash);
    }
    try {
      const built = deps.preflightState.buildPreflightSnapshot({
        processRunId: ctx.processRunId,
        deliveryCase,
        heartbeat: ctx.heartbeat,
      });
      assertReference(
        built.reference,
        DELIVERY_PREFLIGHT_SCHEMA,
        built.preflight.preflightHash,
        'Delivery preflight',
      );
      if (
        built.preflight.schemaVersion !== DELIVERY_PREFLIGHT_SCHEMA
        || hashDeliveryPreflight(built.preflight)
          !== built.preflight.preflightHash
      ) {
        throw new Error('Delivery preflight store returned an invalid snapshot');
      }
      const evaluated = deps.preflightPolicy.evaluate(
        deliveryCase,
        built.preflight,
      );
      return {
        event: evaluated.event,
        production: {
          schema: built.reference.schema,
          artifactRef: built.reference.ref,
          contentHash: built.reference.hash,
          bindings: {
            preflightHash: built.preflight.preflightHash,
            candidateHash: built.preflight.candidateHash,
            preflightStatus: evaluated.event,
            reasonCodes: evaluated.reasonCodes,
            rationale: evaluated.rationale,
          },
        },
      };
    } catch (error) {
      return preflightFailureManifest(ctx, errorMessage(error));
    }
  };
}

function createApprovalInteraction(
  deps: DeliveryModuleInstallationDependencies,
): HumanInteractionAdapter {
  return async ctx => {
    const deliveryCase = requireAuthorizedDeliveryCase(ctx);
    const state = readExactSettlementState(deps, ctx, deliveryCase);
    const preflight = requireExactProduct(
      ctx,
      state.preflight,
      state.productReferences.preflight,
      DELIVERY_NODE_IDS.preflight,
      DELIVERY_PREFLIGHT_SCHEMA,
      'preflight',
    );
    assertReadyPreflight(deps, deliveryCase, preflight);
    const decided = await deps.approval.decide({
      processRunId: ctx.processRunId,
      deliveryCase,
      preflightHash: preflight.preflightHash,
      heartbeat: ctx.heartbeat,
    });
    if (decided.status === 'pending') {
      // No approval yet — pause the run. The production carries the pending
      // status so the settlement node can route to approval-required.
      const production = {
        schema: DELIVERY_APPROVAL_SCHEMA,
        artifactRef: `approval-pending:${preflight.preflightHash}`,
        contentHash: preflight.preflightHash,
        bindings: {
          approvalHash: null,
          candidateHash: deliveryCase.integratedCandidate.hash,
          approvalStatus: 'pending',
        },
      };
      return {
        runtimeEvent: 'paused',
        production,
      };
    }
    // A decision exists (approved/denied/expired) — validate it.
    if (!decided.decision) {
      throw new Error(`${ctx.node.id}: approval decided but no decision reference`);
    }
    assertReference(
      decided.decision,
      DELIVERY_APPROVAL_SCHEMA,
      decided.decision.hash,
      'Delivery approval',
    );
    const production = {
      schema: decided.decision.schema,
      artifactRef: decided.decision.ref,
      contentHash: decided.decision.hash,
      bindings: {
        approvalHash: decided.decision.hash,
        candidateHash: deliveryCase.integratedCandidate.hash,
        approvalStatus: decided.status,
      },
    };
    const domainEvent = decided.status === 'expired'
      ? 'approval-required'
      : decided.status;
    return {
      runtimeEvent: 'completed',
      domainEvent,
      production,
    };
  };
}

function createPublicationHandler(
  deps: DeliveryModuleInstallationDependencies,
): KernelHandler {
  return async ctx => {
    const deliveryCase = requireAuthorizedDeliveryCase(ctx);
    const state = readExactSettlementState(deps, ctx, deliveryCase);
    const preflight = requireExactProduct(
      ctx,
      state.preflight,
      state.productReferences.preflight,
      DELIVERY_NODE_IDS.preflight,
      DELIVERY_PREFLIGHT_SCHEMA,
      'preflight',
    );
    const approval = requireExactProduct(
      ctx,
      state.approval,
      state.productReferences.approval,
      DELIVERY_NODE_IDS.approval,
      DELIVERY_APPROVAL_SCHEMA,
      'approval',
    );
    assertReadyPreflight(deps, deliveryCase, preflight);
    assertApprovalSnapshot(deliveryCase, preflight.preflightHash, approval);
    assertReleaseAuthorized(deliveryCase, approval);
    const published = await deps.publication.publishAndDeploy({
      processRunId: ctx.processRunId,
      deliveryCase,
      preflight,
      approval,
      heartbeat: ctx.heartbeat,
    });
    assertReference(
      published.reference,
      DELIVERY_PUBLICATION_SCHEMA,
      published.publication.publicationHash,
      'Delivery publication',
    );
    assertPublicationSnapshot(
      deliveryCase,
      preflight.preflightHash,
      approval.approvalHash,
      published.publication,
    );
    const receiptById = new Map(
      published.publication.receipts.map(receipt => [
        receipt.actionId,
        receipt,
      ]),
    );
    const incomplete = deliveryCase.policy.actions.some(action =>
      action.required && !receiptById.has(action.actionId));
    const uncertain = published.publication.receipts.some(receipt =>
      receipt.status !== 'succeeded');
    const event = incomplete || uncertain ? 'failed' : 'completed';
    return {
      event,
      production: {
        schema: published.reference.schema,
        artifactRef: published.reference.ref,
        contentHash: published.reference.hash,
        bindings: {
          publicationHash: published.publication.publicationHash,
          candidateHash: published.publication.candidateHash,
          publicationStatus:
            incomplete ? 'incomplete' : uncertain ? 'uncertain' : 'completed',
          actionKeys: published.publication.receipts.map(receipt =>
            receipt.actionKey),
        },
      },
    };
  };
}

function createObservationHandler(
  deps: DeliveryModuleInstallationDependencies,
): KernelHandler {
  return async ctx => {
    const deliveryCase = requireAuthorizedDeliveryCase(ctx);
    const state = readExactSettlementState(deps, ctx, deliveryCase);
    const preflight = requireExactProduct(
      ctx,
      state.preflight,
      state.productReferences.preflight,
      DELIVERY_NODE_IDS.preflight,
      DELIVERY_PREFLIGHT_SCHEMA,
      'preflight',
    );
    const approval = requireExactProduct(
      ctx,
      state.approval,
      state.productReferences.approval,
      DELIVERY_NODE_IDS.approval,
      DELIVERY_APPROVAL_SCHEMA,
      'approval',
    );
    const publication = requireExactProduct(
      ctx,
      state.publication,
      state.productReferences.publication,
      DELIVERY_NODE_IDS.publication,
      DELIVERY_PUBLICATION_SCHEMA,
      'publication',
    );
    assertReadyPreflight(deps, deliveryCase, preflight);
    assertApprovalSnapshot(deliveryCase, preflight.preflightHash, approval);
    assertReleaseAuthorized(deliveryCase, approval);
    assertPublicationSnapshot(
      deliveryCase,
      preflight.preflightHash,
      approval.approvalHash,
      publication,
    );
    const observed = await deps.observation.observe({
      processRunId: ctx.processRunId,
      deliveryCase,
      publication,
      heartbeat: ctx.heartbeat,
    });
    assertReference(
      observed.reference,
      DELIVERY_OBSERVATION_SCHEMA,
      observed.observation.observationHash,
      'Delivery observation',
    );
    if (
      observed.observation.schemaVersion !== DELIVERY_OBSERVATION_SCHEMA
      || hashDeliveryObservation(observed.observation)
        !== observed.observation.observationHash
      || observed.observation.candidateHash
        !== deliveryCase.integratedCandidate.hash
      || observed.observation.currentCandidateHash
        !== deliveryCase.integratedCandidate.hash
      || observed.observation.publicationHash
        !== publication.publicationHash
    ) {
      throw new Error(
        'Delivery observation store returned invalid publication/candidate lineage',
      );
    }
    const uncertain = !observed.observation.complete
      || observed.observation.observations.some(item =>
        item.outcome === 'unknown' || item.outcome === 'error');
    return {
      event: uncertain ? 'failed' : 'completed',
      production: {
        schema: observed.reference.schema,
        artifactRef: observed.reference.ref,
        contentHash: observed.reference.hash,
        bindings: {
          observationHash: observed.observation.observationHash,
          publicationHash: observed.observation.publicationHash,
          candidateHash: observed.observation.candidateHash,
          observationStatus: uncertain ? 'uncertain' : 'completed',
        },
      },
    };
  };
}

function createDeliverySettlementHandler(
  deps: DeliveryModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    try {
      const deliveryCase = requireDeliveryCase(ctx);
      const preflightProduction =
        ctx.frame.productions[DELIVERY_NODE_IDS.preflight];
      let settled: DeliverySettlementResult;
      let input: DeliverySettlementInput;
      if (preflightProduction?.bindings.authorizationRequired === true) {
        input = emptySettlementInput(deliveryCase);
        settled = deps.settlementPolicy.settle(input);
      } else if (preflightProduction?.bindings.preflightStatus === 'failed'
        && preflightProduction.bindings.preflightFailure === true) {
        input = emptySettlementInput(deliveryCase);
        settled = {
          decision: 'failed',
          reasonCodes: ['infrastructure-error'],
          rationale: stringBinding(
            preflightProduction.bindings,
            'preflightError',
          ),
          inputHash: sha256Hex(deliveryCase),
          releaseRecord: null,
        };
      } else {
        input = readExactSettlementState(deps, ctx, deliveryCase);
        settled = deps.settlementPolicy.settle(input);
      }
      return deliverySettlementProduction(deps, ctx, input, settled);
    } catch (error) {
      return deliverySettlementFailure(deps, ctx, errorMessage(error));
    }
  };
}

/**
 * Wave 4 (Uncle Bob) — issue the Delivery ProcessOutcomeCertificate IN THE
 * KERNEL. This mirrors what the generic-flow-executor's magic-bindings path
 * does (generic-flow-executor.ts:363-390): the kernel becomes the certificate
 * issuer so the explicit ModuleCompletion can carry a content-addressed
 * certificateRef that points at the issued row. Idempotent on certificateHash
 * (the repository returns the existing row on replay).
 *
 * Returns the issued certificate's durable id + hash, which the caller wraps
 * into a ProductRef for the completion envelope.
 */
function issueDeliveryCertificate(
  deps: DeliveryModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  certificatePayload: {
    schemaVersion: string;
    decision: string;
    reasonCodes: readonly string[];
    rationale: string;
    inputHash: string;
    payload: unknown;
  },
  certificateHash: string,
): { id: number; certificateHash: string } {
  const result = deps.certificateRepo.issue({
    processRunId: ctx.processRunId,
    moduleRef: DELIVERY_PROCESS_MODULE_REF,
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    payload: certificatePayload,
    certificateHash,
    authority: 'delivery_settlement_policy',
  });
  return {
    id: result.record.id,
    certificateHash: result.record.certificateHash,
  };
}

/**
 * Wave 4 (Uncle Bob) — build the explicit ModuleCompletion envelope that
 * replaces the legacy magic certificate bindings (plan §7.5.6). The
 * outputEnvelope.certificateRef is the content-addressed pointer settlement
 * reads to bypass the magic-bindings fallback entirely (Wave 5 deletes that
 * branch). `terminal` mirrors the Delivery outcome definitions: all four
 * (released / approval-required / blocked / failed) are terminal.
 *
 * The `productions` array is left empty here because the completion envelope's
 * contract only requires the certificateRef for settlement; the durable
 * NodeProduction is already persisted by the executor on the NodeRun row. This
 * matches the shape proven by tests/process-modules/module-completion-
 * persistence.test.mjs (sampleModuleCompletion: productions: []).
 *
 * Wave 8 BLOCKER 2: the envelope is a LEAF. The previous implementation built
 * a REAL runtime cycle (`envelope.completion = completion`) to satisfy the
 * now-removed `ProcessModuleOutputEnvelope.completion` field. That cycle made
 * `JSON.stringify(completion)` throw "Converting circular structure to JSON"
 * in the durable persist path. With the field gone, the model is a tree:
 * ModuleCompletion.outputEnvelope → envelope (one-directional), and the
 * envelope carries only outcome/productions/certificateRef.
 */
function buildDeliveryModuleCompletion(
  outcome: string,
  _certificatePayload: unknown,
  certificateHash: string,
  issuedCertificate: { id: number; certificateHash: string },
): ModuleCompletion {
  const certificateRef: ProductRef = {
    schemaId: DELIVERY_CERTIFICATE_SCHEMA,
    ref: `certificate:${issuedCertificate.id}`,
    digest: issuedCertificate.certificateHash,
  };
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  const completion: ModuleCompletion = {
    outcome,
    outputEnvelope,
    terminal: true,
  };
  void certificateHash;
  return completion;
}

function deliverySettlementProduction(
  deps: DeliveryModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  input: DeliverySettlementInput,
  settled: DeliverySettlementResult,
): KernelHandlerResult {
  let outputBindings: Record<string, unknown> = {};
  if (settled.decision === 'released') {
    if (settled.releaseRecord === null) {
      throw new Error('released Delivery settlement has no ReleaseRecord');
    }
    const persisted = deps.outputRepository.persist({
      processRunId: ctx.processRunId,
      projectId: ctx.projectId,
      epicId: ctx.epicId,
      payload: settled.releaseRecord,
    });
    assertDeliveryOutputRecord(
      persisted.record,
      ctx.processRunId,
      ctx.projectId,
      ctx.epicId,
    );
    if (
      persisted.record.payload.recordHash
        !== settled.releaseRecord.recordHash
      || sha256Hex(persisted.record.payload)
        !== sha256Hex(settled.releaseRecord)
    ) {
      throw new Error(
        'Delivery output repository returned a different ReleaseRecord',
      );
    }
    outputBindings = {
      releaseRecordRef: persisted.record.artifactRef,
      releaseRecordContentHash: persisted.record.contentHash,
      releaseRecordSchema: persisted.record.payload.schemaVersion,
      releaseRecordHash: persisted.record.payload.recordHash,
      releaseRecordReplayed: persisted.replayed,
    };
  } else if (settled.releaseRecord !== null) {
    throw new Error(
      `Delivery decision '${settled.decision}' must not expose a ReleaseRecord`,
    );
  }

  const deliveryPayload = buildDeliveryCertificatePayload(settled, input);
  const certificatePayload = {
    schemaVersion: DELIVERY_CERTIFICATE_SCHEMA,
    decision: settled.decision,
    reasonCodes: settled.reasonCodes,
    rationale: settled.rationale,
    inputHash: settled.inputHash,
    payload: deliveryPayload,
  };
  const certificateHash = sha256Hex(certificatePayload);
  // Wave 4 (Uncle Bob): issue the ProcessOutcomeCertificate IN THE KERNEL so
  // the explicit ModuleCompletion can carry a content-addressed certificateRef.
  // Mirrors what generic-flow-executor.ts:363-390 does for the generic-envelope
  // magic-bindings path. The legacy magic bindings below are KEPT (additive)
  // until Wave 5 deletes that branch.
  const issuedCertificate = issueDeliveryCertificate(
    deps,
    ctx,
    certificatePayload,
    certificateHash,
  );
  return {
    event: settled.decision,
    production: {
      schema: DELIVERY_CERTIFICATE_SCHEMA,
      artifactRef:
        `delivery-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      // WAVE 5 CUTOVER — certificate envelope removed from bindings. The kernel
      // issues its own certificate (above) and emits an explicit
      // ModuleCompletion whose certificateRef points at the issued row;
      // settlement reads it from there. `outputBindings` (releaseRecordRef
      // etc.) and `authority` are non-certificate bindings and are retained.
      bindings: {
        ...outputBindings,
        authority: 'delivery_settlement_policy',
      },
    },
    completion: buildDeliveryModuleCompletion(
      settled.decision,
      certificatePayload,
      certificateHash,
      issuedCertificate,
    ),
  };
}

function deliverySettlementFailure(
  deps: DeliveryModuleInstallationDependencies,
  ctx: KernelHandlerContext,
  reason: string,
): KernelHandlerResult {
  const runInput = isRecord(ctx.frame.runInput) ? ctx.frame.runInput : {};
  const developmentCertificate = isRecord(runInput.developmentCertificate)
    ? runInput.developmentCertificate
    : {};
  const bundle = isRecord(runInput.verifiedIntegrationBundle)
    ? runInput.verifiedIntegrationBundle
    : {};
  const candidate = isRecord(runInput.integratedCandidate)
    ? runInput.integratedCandidate
    : {};
  const policy = isRecord(runInput.policy) ? runInput.policy : {};
  const deliveryPayload = {
    schemaVersion: DELIVERY_CERTIFICATE_SCHEMA,
    decision: 'failed',
    reasonCodes: ['infrastructure-error'],
    rationale: reason,
    inputHash: sha256Hex(ctx.frame.runInput),
    developmentCertificateHash: stringValue(developmentCertificate.hash),
    verifiedIntegrationBundleHash: stringValue(bundle.hash),
    candidateHash: stringValue(candidate.hash),
    releasePolicyHash: stringValue(policy.contentHash) || null,
    deferredProfileHash: isRecord(runInput.deferredProfile)
      ? stringValue(runInput.deferredProfile.profileHash) || null
      : null,
    preflightHash: null,
    approvalHash: null,
    publicationHash: null,
    observationHash: null,
    releaseRecordHash: null,
  };
  const certificatePayload = {
    schemaVersion: DELIVERY_CERTIFICATE_SCHEMA,
    decision: 'failed',
    reasonCodes: ['infrastructure-error'],
    rationale: reason,
    inputHash: deliveryPayload.inputHash,
    payload: deliveryPayload,
  };
  const certificateHash = sha256Hex(certificatePayload);
  // WAVE 8 HIGH 3 — issue the failure certificate IN THE KERNEL. The failure
  // outcome is terminal and historically was certified via the executor's
  // magic-bindings path. Wave 4 made the kernel the issuer; Wave 5 deleted the
  // magic-bindings fallback; Wave 8 makes terminal completion MANDATORY. There
  // is NO recovery path: if `certificateRepo.issue` throws, the settlement MUST
  // FAIL LOUDLY — a swallowed error would silently produce a null certificate,
  // which is data loss (a real problem: DB issue, schema mismatch, etc.). The
  // previous try/catch swallow was deleted; the failure surfaces as a thrown
  // error and the ProcessRun flips to 'failed'.
  const issuedCertificate = issueDeliveryCertificate(
    deps,
    ctx,
    certificatePayload,
    certificateHash,
  );
  return {
    event: 'failed',
    production: {
      schema: DELIVERY_CERTIFICATE_SCHEMA,
      artifactRef:
        `delivery-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      // WAVE 5 CUTOVER — certificate envelope removed from bindings (see
      // deliverySettlementProduction). `authority` + `settlementError` are
      // non-certificate bindings and are retained.
      bindings: {
        authority: 'delivery_settlement_policy',
        settlementError: reason,
      },
    },
    completion: buildDeliveryModuleCompletion(
      'failed',
      certificatePayload,
      certificateHash,
      issuedCertificate,
    ),
  };
}

function deferredDeliveryManifest(
  ctx: KernelHandlerContext,
  deferredProfileHash: string,
): KernelHandlerResult {
  const body = {
    schemaVersion: DELIVERY_PREFLIGHT_SCHEMA,
    processRunId: ctx.processRunId,
    preflightStatus: 'authorization-required',
    authorizationRequired: true,
    deferredProfileHash,
  };
  const contentHash = sha256Hex(body);
  return {
    event: 'blocked',
    production: {
      schema: DELIVERY_PREFLIGHT_SCHEMA,
      artifactRef: `delivery-authorization-required:${ctx.processRunId}:${contentHash}`,
      contentHash,
      bindings: body,
    },
  };
}

function preflightFailureManifest(
  ctx: KernelHandlerContext,
  reason: string,
): KernelHandlerResult {
  const body = {
    schemaVersion: DELIVERY_PREFLIGHT_SCHEMA,
    processRunId: ctx.processRunId,
    preflightStatus: 'failed',
    preflightFailure: true,
    preflightError: reason,
  };
  const contentHash = sha256Hex(body);
  return {
    event: 'failed',
    production: {
      schema: DELIVERY_PREFLIGHT_SCHEMA,
      artifactRef: `delivery-preflight:${ctx.processRunId}:${contentHash}`,
      contentHash,
      bindings: body,
    },
  };
}

function assertApprovalSnapshot(
  deliveryCase: AuthorizedDeliveryReleaseCase,
  preflightHash: string,
  approval: DeliveryApprovalDecision,
): void {
  if (
    approval.schemaVersion !== DELIVERY_APPROVAL_SCHEMA
    || hashDeliveryApproval(approval) !== approval.approvalHash
    || approval.candidateHash !== deliveryCase.integratedCandidate.hash
    || approval.preflightHash !== preflightHash
    || approval.releasePolicyHash !== deliveryCase.policy.contentHash
  ) {
    throw new Error(
      'Delivery approval store returned invalid candidate/preflight lineage',
    );
  }
}

function assertReadyPreflight(
  deps: DeliveryModuleInstallationDependencies,
  deliveryCase: AuthorizedDeliveryReleaseCase,
  preflight: DeliveryPreflightSnapshot,
): void {
  const evaluated = deps.preflightPolicy.evaluate(deliveryCase, preflight);
  if (evaluated.event !== 'ready') {
    throw new Error(
      `Delivery preflight is no longer ready: ${evaluated.reasonCodes.join(', ')}`,
    );
  }
}

function assertReleaseAuthorized(
  deliveryCase: AuthorizedDeliveryReleaseCase,
  approval: DeliveryApprovalDecision,
): void {
  const admissible = deliveryCase.policy.humanApprovalRequired
    ? approval.status === 'approved'
    : approval.status === 'approved' || approval.status === 'not-required';
  if (!admissible) {
    throw new Error(
      `Delivery release effects are not authorized by approval status '${approval.status}'`,
    );
  }
  if (
    approval.status === 'approved'
    && (
      approval.decision === null
      || !approval.decision.schema.trim()
      || !approval.decision.ref.trim()
      || !approval.decision.hash.trim()
      || approval.provider === null
      || !approval.provider.trusted
      || approval.provider.category !== 'authorized_decision'
      || approval.provider.providerId <= 0
      || !approval.provider.name.trim()
    )
  ) {
    throw new Error(
      'Delivery approved status lacks a trusted authorized-decision provider',
    );
  }
}

function assertPublicationSnapshot(
  deliveryCase: AuthorizedDeliveryReleaseCase,
  preflightHash: string,
  approvalHash: string,
  publication: DeliveryPublicationSnapshot,
): void {
  if (
    publication.schemaVersion !== DELIVERY_PUBLICATION_SCHEMA
    || hashDeliveryPublication(publication) !== publication.publicationHash
    || publication.candidateHash !== deliveryCase.integratedCandidate.hash
    || publication.preflightHash !== preflightHash
    || publication.approvalHash !== approvalHash
    || sha256Hex(publication.plannedActions)
      !== sha256Hex(deliveryCase.policy.actions)
    || !unique(publication.receipts.map(receipt => receipt.actionId))
  ) {
    throw new Error(
      'Delivery publication store returned invalid action/candidate lineage',
    );
  }
  const actionById = new Map(
    deliveryCase.policy.actions.map(action => [action.actionId, action]),
  );
  for (const receipt of publication.receipts) {
    const action = actionById.get(receipt.actionId);
    if (
      !action
      || receipt.actionKey !== deliveryActionKey(deliveryCase, action)
      || receipt.kind !== action.kind
      || receipt.target !== action.target
      || receipt.payloadHash !== action.payloadHash
      || receipt.desiredStateHash !== action.desiredStateHash
      || !['succeeded', 'failed', 'blocked', 'uncertain'].includes(
        receipt.status,
      )
    ) {
      throw new Error(
        `Delivery publication receipt '${receipt.actionId}' is invalid`,
      );
    }
  }
}

function readExactSettlementState(
  deps: DeliveryModuleInstallationDependencies,
  ctx:
    | KernelHandlerContext
    | HumanInteractionContext,
  deliveryCase: DeliveryReleaseCase,
): DeliverySettlementInput {
  const state = deps.settlementState.buildSettlementInput({
    processRunId: ctx.processRunId,
    deliveryCase,
  });
  if (
    state.deliveryCase.projectId !== ctx.projectId
    || state.deliveryCase.epicId !== ctx.epicId
    || sha256Hex(state.deliveryCase) !== sha256Hex(deliveryCase)
  ) {
    throw new Error(
      `${ctx.node.id}: settlement state does not match the ProcessRun input`,
    );
  }
  return state;
}

function requireExactProduct<T>(
  ctx:
    | KernelHandlerContext
    | HumanInteractionContext,
  value: T | null,
  reference: DeliveryContentAddressedReference | null,
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

function requireDeliveryCase(
  ctx:
    | KernelHandlerContext
    | HumanInteractionContext,
): DeliveryReleaseCase {
  const value = ctx.frame.runInput;
  if (
    !isRecord(value)
    || value.schemaVersion !== DELIVERY_RELEASE_CASE_SCHEMA
    || !Number.isInteger(value.projectId)
    || value.projectId !== ctx.projectId
    || (
      value.epicId !== null
      && !Number.isInteger(value.epicId)
    )
    || value.epicId !== ctx.epicId
  ) {
    throw new Error(`${ctx.node.id}: invalid or mismatched DeliveryReleaseCase`);
  }
  return value as unknown as DeliveryReleaseCase;
}

function requireAuthorizedDeliveryCase(
  ctx:
    | KernelHandlerContext
    | HumanInteractionContext,
): AuthorizedDeliveryReleaseCase {
  const deliveryCase = requireDeliveryCase(ctx);
  if (deliveryCase.deliveryMode !== 'authorized') {
    throw new Error(`${ctx.node.id}: deferred Delivery cannot execute release effects`);
  }
  return deliveryCase;
}

function emptySettlementInput(
  deliveryCase: DeliveryReleaseCase,
): DeliverySettlementInput {
  return {
    schemaVersion: DELIVERY_SETTLEMENT_INPUT_SCHEMA,
    deliveryCase,
    preflight: null,
    approval: null,
    publication: null,
    observation: null,
    currentCandidateHash: null,
    productReferences: {
      preflight: null,
      approval: null,
      publication: null,
      observation: null,
    },
  };
}

function requireExactDeliveryOutput(
  repository: DeliveryOutputRepository,
  processRunId: number,
  projectId: number,
  epicId: number | null,
  output: ProcessModuleOutput,
): DeliveryOutputRecord {
  const record = repository.readByProcessRun(processRunId);
  if (
    record === null
    || record.processRunId !== processRunId
    || record.projectId !== projectId
    || record.epicId !== epicId
    || output.schema !== RELEASE_RECORD_SCHEMA
    || record.payload.schemaVersion !== output.schema
    || record.artifactRef !== output.artifactRef
    || record.contentHash !== output.contentHash
  ) {
    throw new Error(
      `delivery output: exact ReleaseRecord for process_run ${processRunId} is missing or mismatched`,
    );
  }
  assertDeliveryOutputRecord(record, processRunId, projectId, epicId);
  return record;
}

function assertDeliveryOutputRecord(
  record: DeliveryOutputRecord,
  processRunId: number,
  projectId: number,
  epicId: number | null,
): void {
  if (
    record.processRunId !== processRunId
    || record.projectId !== projectId
    || record.epicId !== epicId
    || !record.artifactRef.trim()
    || record.payload.schemaVersion !== RELEASE_RECORD_SCHEMA
    || hashReleaseRecord(record.payload) !== record.payload.recordHash
    || sha256Hex(record.payload) !== record.contentHash
  ) {
    throw new Error('Delivery output repository returned an invalid record');
  }
}

function assertReference(
  reference: DeliveryContentAddressedReference,
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

function assertDeliveryModule(module: ProcessModuleDefinition): void {
  if (
    module.identity.name !== DELIVERY_PROCESS_MODULE_REF.name
    || module.identity.version !== DELIVERY_PROCESS_MODULE_REF.version
  ) {
    throw new Error('delivery output resolver received another module');
  }
}

function stringBinding(
  bindings: Record<string, unknown>,
  key: string,
): string {
  const value = bindings[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`delivery output: missing '${key}' binding`);
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
