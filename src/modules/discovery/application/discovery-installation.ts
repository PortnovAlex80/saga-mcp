/**
 * discovery-installation — Discovery Pack как registrant.
 *
 * Это точка, где Discovery Pack подключает своё ПРЕДМЕТНОЕ содержание к
 * универсальному runtime ЧЕРЕЗ РЕГИСТРАЦИЮ (а не через новые ветки в ядре).
 *
 * Граница Pack/Core (инвариант P6c):
 *   - runtime core (generic-flow-executor, node-executor, kernel-handler-registry)
 *     не содержит ни одной ссылки на discovery-символы;
 *   - discovery-installation регистрирует handlers под id'ами из descriptor'а
 *     и поставляет deps (saga3 persistence) — content остаётся в `src/saga3/`.
 *
 * Регистрируются:
 *   - 'discovery-normalization-kernel' → pure `normalizeDiscoveryProposalInput`
 *     (детерминированная нормализация, без LM);
 *   - 'discovery-prepare-readiness' → D5 preparation: создаёт readiness
 *     ControlIntent + authority WorkIntent + projected advisor task, возвращает
 *     machine-filled bindings для downstream LM-узла assess-readiness;
 *   - 'discovery-settlement-policy' → `discoverySettlementPolicyV1.evaluate()`
 *     поверх собранного snapshot (content: manifest, reason codes, thresholds).
 *
 * 'process-outcome-emitter' НЕ регистрируется здесь — это generic handler,
 * который сам runtime регистрирует (он не знает про go/clarify/...).
 *
 * LM-узлы (produce-proposal, normalize-semantic, assess-readiness) тоже не
 * Discovery Pack только объявляет профили (content).
 */

import type { KernelHandler } from '../../../process-modules/application/kernel-handler-registry.js';
import type { NodeExecutionReceipt } from '../../../process-modules/application/node-executor.js';
import type { WorkplaceExecutionPersistence } from '../../../process-modules/application/workplace-execution-persistence.js';
// Uncle Bob Wave 4 / FU-A: explicit ModuleCompletion envelope emitted alongside
// `import type` keeps this a domain→domain edge (Rule 5 permits it); the SPI
// types are pure data, erased at compile time.
import type { ModuleCompletion } from '../../../process-modules/domain/spi/module-completion.js';
// CONVEYOR Wave 7 — saga3 cross-tree leak elimination: every schema-id
// constant, intent-kind constant, record type, and the runtime-persistence
// port is now declared locally in discovery-domain-contracts.ts (byte-identical
// to the saga3 originals). This module no longer imports anything from
// src/saga3/** statically.
import type {
  ControlIntentStatus,
  DiscoveryRuntimePersistencePort,
  DiscoverySettlementPort,
  RawDiscoverySubmissionRecord,
  ReadinessControlStatus,
  ReadinessShadowResult,
} from '../domain/discovery-domain-contracts.js';
import {
  DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
  NO_READINESS_HASH,
} from '../domain/discovery-domain-contracts.js';
// CONVEYOR Wave 7 — Isolate modules behind ports: brief provisioning is
// delegated to an injected DiscoveryBriefProvisioningPort (wired by the
// composition root), so this module imports no getDb / db.ts.

// ---------------------------------------------------------------------------
// Brief provisioning port (Wave 7 — Isolate modules behind ports).
//
// The discovery proposal resolver auto-provisions a synthetic `brief` artifact
// (derived from the accepted proposal) so downstream Formalization has a
// PRD->brief `derived_from` lineage. This used to be done via a direct
// `getDb()` call inside `ensureDiscoveryBriefArtifact` — a Rule 2 violation.
//
// This port lifts that side-effect behind a module-local capability. The
// composition root injects a concrete (SQLite-backed) implementation; tests
// inject fakes. The module never imports `db.ts`.
//
// `briefProvisioning` on `DiscoveryInstallationDeps` is optional and defaults
// to a `getDb()`-backed adapter to keep the build green while the orchestrator
// wires the real port. Once wired, the default is removed and the `getDb()`
// import leaves the module.
// ---------------------------------------------------------------------------

export interface DiscoveryBriefProvisioningContext {
  projectId: number;
  epicId: number;
  proposalPayload: {
    problem_statement?: unknown;
    candidate_scope?: unknown;
    recommended_outcome?: unknown;
  } | null;
}

export interface DiscoveryBriefProvisioningPort {
  /** Idempotently ensure an accepted `brief` artifact exists for the epic. */
  ensureDiscoveryBrief(ctx: DiscoveryBriefProvisioningContext): void;
}

/**
 * Deps, которые модуль поставляет из composition-root. Settle handler читает
 * канонические Proposal + Readiness из saga3 persistence (worker'ы уже
 * сохранили их через proposal_submit / readiness_submit) — это и есть
 * «machine-known data must be machine-filled». Snapshot строится из БД, не из
 * цепочки node outputs.
 */
export interface DiscoveryInstallationDeps {
  runtimePersistence: DiscoveryRuntimePersistencePort;
  /**
   * Wave 7 — Isolate modules behind ports. Provisions the discovery brief
   * artifact without the module touching `db.ts`. Required: the composition
   * root wires a concrete SQLite-backed adapter.
   */
  briefProvisioning: DiscoveryBriefProvisioningPort;
  /**
   * CONVEYOR Wave 7 — saga3 cross-tree leak elimination. The deterministic D4
   * settlement service (policy + certificate issuance). REQUIRED since Wave 8
   * MEDIUM 7: the composition root constructs the concrete service and injects
   * it through this declared port. The module declares the port; the adapter
   * (today the saga3 `FactoryDiscoverySettlementService`, built in the
   * composition root) implements it. The dynamic-import bridge that used to
   * self-provision this service was removed because it hid a runtime dependency
   * from the static dependency graph (Wave 8 MEDIUM 7).
   */
  settlementService: DiscoverySettlementPort;
}

/**
 * Сборка handlers для Discovery. Composition-root вызывает это и регистрирует
 * результат в KernelHandlerRegistry до установки модуля.
 */
export function createDiscoveryKernelHandlers(
  deps: DiscoveryInstallationDeps,
): Record<string, KernelHandler> {
  // CONVEYOR Wave 7 — brief provisioning is injected by the composition root.
  const briefProvisioning = deps.briefProvisioning;
  // Wave 8 MEDIUM 7 — the settlement service is an EXPLICIT injected port. The
  // composition root constructs the concrete service (today the saga3
  // FactoryDiscoverySettlementService) and passes it in. No dynamic import, no
  // self-provisioning: the bounded-context coupling is visible in the static
  // dependency graph (the composition root, not this module, owns it).
  const settlementService = deps.settlementService;
  return {
    'discovery-resolve-proposal-submission': createResolveProposalSubmissionHandler(deps.runtimePersistence, briefProvisioning),
    'discovery-prepare-normalization': createPrepareNormalizationHandler(deps.runtimePersistence),
    'discovery-resolve-normalized-proposal': createResolveNormalizedProposalHandler(deps.runtimePersistence),
    'discovery-prepare-readiness': createPrepareReadinessHandler(deps.runtimePersistence),
    'discovery-resolve-readiness': createResolveReadinessHandler(deps.runtimePersistence),
    'discovery-settlement-policy': createDiscoverySettlementHandler(deps.runtimePersistence, settlementService),
  };
}

// ---------------------------------------------------------------------------
// LM receipt -> canonical Discovery products
// ---------------------------------------------------------------------------

function requireTaskReceipt(input: unknown, handlerId: string): NodeExecutionReceipt {
  const receipt = input as Partial<NodeExecutionReceipt> | null;
  if (
    !receipt
    || receipt.kind !== 'task-execution'
    || receipt.executorKind !== 'lm'
    || !Number.isInteger(receipt.intentId)
    || !Number.isInteger(receipt.taskId)
  ) {
    throw new Error(`${handlerId}: expected an LM task execution receipt`);
  }
  return receipt as NodeExecutionReceipt;
}

function finishNormalizationControl(
  runtime: DiscoveryRuntimePersistencePort,
  controlIntentId: number,
  runtimeStatus: NodeExecutionReceipt['runtimeStatus'],
): void {
  const next: ControlIntentStatus = runtimeStatus === 'completed' ? 'concluded' : 'paused';
  for (const expected of ['open', 'executing', 'paused'] as const) {
    if (expected !== next) runtime.setControlIntentStatus(controlIntentId, expected, next);
  }
}

function finishReadinessControl(
  runtime: DiscoveryRuntimePersistencePort,
  controlIntentId: number,
  runtimeStatus: NodeExecutionReceipt['runtimeStatus'],
): void {
  const next: ReadinessControlStatus = runtimeStatus === 'completed' ? 'concluded' : 'paused';
  for (const expected of ['open', 'executing', 'paused'] as const) {
    if (expected !== next) runtime.setReadinessControlStatus(controlIntentId, expected, next);
  }
}

function concludeAuthorityIntent(
  runtime: DiscoveryRuntimePersistencePort,
  intentId: number,
): void {
  for (const expected of ['open', 'executing', 'paused'] as const) {
    runtime.setIntentStatus(intentId, expected, 'concluded');
  }
}

/**
 * Materialize D1. The worker task is only execution evidence; proposal_submit
 * is the authority that persisted either a raw submission or a canonical
 * Proposal. Resolve that exact result by WorkIntent/task and emit a domain
 * production. No "latest by epic" lookup is allowed.
 */
function createResolveProposalSubmissionHandler(
  runtime: DiscoveryRuntimePersistencePort,
  briefProvisioning: DiscoveryBriefProvisioningPort,
): KernelHandler {
  return (ctx) => {
    const receipt = requireTaskReceipt(ctx.input, 'discovery-resolve-proposal-submission');
    if (!receipt.executionId) {
      return failedProposalResolution(
        receipt,
        'task execution has no durable execution fence',
      );
    }
    const raw = runtime.readRawSubmissionForExecution(
      receipt.intentId,
      receipt.taskId,
      receipt.executionId,
    );
    let result;
    if (!raw || raw.task_id !== receipt.taskId || raw.execution_id !== receipt.executionId) {
      // Fallback: the worker may have run in multiple executions (engine retry,
      // recovery, lease loss). The receipt carries the FIRST execution's fence,
      // but proposal_submit may have been called in a LATER execution. Fall
      // back to the latest raw submission for this (intent, task) pair and
      // accept it if it belongs to the same task. The raw submission is
      // immutable (content-addressed by raw_hash), so accepting it from a
      // sibling execution is safe.
      const fallback = runtime.readLatestRawSubmission(receipt.intentId);
      if (fallback && fallback.task_id === receipt.taskId) {
        result = resolveAcceptedRaw(runtime, receipt, fallback);
      } else {
        return failedProposalResolution(
          receipt,
          'exact raw submission is missing',
        );
      }
    } else {
      result = resolveAcceptedRaw(runtime, receipt, raw);
    }
    // When the proposal is accepted, ensure a `brief` artifact exists for this
    // epic. The generic-flow Discovery worker does not create one (unlike the
    // Wave 7 — Isolate modules behind ports: the substrate touch is delegated
    // to the injected DiscoveryBriefProvisioningPort.
    if (result.event === 'accepted' && ctx.epicId !== null) {
      try {
        briefProvisioning.ensureDiscoveryBrief({
          projectId: ctx.projectId,
          epicId: ctx.epicId,
          proposalPayload: null,
        });
      } catch {
        // Non-fatal: the brief is a convenience projection. If it fails
        // (e.g. race condition), formalization has its own fallback.
      }
    }
    return result;
  };
}

/**
 * CONVEYOR Wave 7 — Isolate modules behind ports.
 *
 * directly inside the module. Wave 7 replaced it with the
 * `DiscoveryBriefProvisioningPort` injected by the composition root (see
 * `src/infrastructure/process-modules/brief-provisioning-ports.ts`). The module
 * now contains NO `getDb()` call and NO `db.ts` import.
 */

function resolveAcceptedRaw(
  runtime: DiscoveryRuntimePersistencePort,
  receipt: NodeExecutionReceipt,
  raw: RawDiscoverySubmissionRecord,
) {
  // The durable submission, rather than the worker process status, closes
  // the product WorkIntent. This covers a worker that dies after the tool
  // transaction commits but before worker_done.
  concludeAuthorityIntent(runtime, receipt.intentId);

  const execId = receipt.executionId ?? raw.execution_id;

  if (raw.status === 'rejected_syntax') {
    return {
      event: 'invalid-json',
      production: {
          schema: 'factory.discovery-raw-submission.v1',
          artifactRef: `raw-submission:${raw.id}`,
          contentHash: raw.raw_hash,
          bindings: {
            sourceIntentId: receipt.intentId,
            sourceTaskId: receipt.taskId,
            sourceExecutionId: execId,
            rawSubmissionId: raw.id,
            rawHash: raw.raw_hash,
          },
        },
      };
    }

    if (raw.status === 'normalization_required') {
      return {
        event: 'normalization-required',
        production: {
          schema: 'factory.discovery-raw-submission.v1',
          artifactRef: `raw-submission:${raw.id}`,
          contentHash: raw.raw_hash,
          bindings: {
            sourceIntentId: receipt.intentId,
            sourceTaskId: receipt.taskId,
            sourceExecutionId: execId,
            rawSubmissionId: raw.id,
            rawHash: raw.raw_hash,
          },
        },
      };
    }

    let proposal = runtime.readProposalForExecution(
      receipt.intentId,
      receipt.taskId,
      execId,
    );
    let sourceSubmissionId = Number(proposal?.provenance?.source_submission_id ?? 0);
    if (
      !proposal
      || proposal.task_id !== receipt.taskId
      || proposal.execution_id !== execId
      || sourceSubmissionId !== raw.id
    ) {
      // Same multi-execution fallback as above: the canonical Proposal may
      // have been written by a sibling execution of the same task. Accept
      // the latest proposal for this intent if it traces to the same raw
      // submission.
      const fallbackProposal = runtime.readLatestProposal(receipt.intentId);
      if (
        fallbackProposal
        && fallbackProposal.task_id === receipt.taskId
        && Number(fallbackProposal.provenance?.source_submission_id ?? 0) === raw.id
      ) {
        proposal = fallbackProposal;
        sourceSubmissionId = raw.id;
      }
    }
    if (
      !proposal
      || proposal.task_id !== receipt.taskId
      || sourceSubmissionId !== raw.id
    ) {
      return failedProposalResolution(
        receipt,
        `raw submission ${raw.id} has no exact canonical Proposal`,
      );
    }
    return {
      event: 'accepted',
      production: proposalProduction(
        proposal.id,
        proposal.content_hash,
        receipt.intentId,
        receipt.taskId,
        receipt.executionId ?? execId,
        raw.id,
      ),
    };
}

function failedProposalResolution(
  receipt: NodeExecutionReceipt,
  reason: string,
) {
  return {
    event: 'failed',
    production: {
      schema: 'factory.discovery-proposal-resolution.v1',
      artifactRef: `task-execution:${receipt.taskId}:${receipt.executionId ?? 'missing'}`,
      contentHash: '',
      bindings: {
        sourceIntentId: receipt.intentId,
        sourceTaskId: receipt.taskId,
        sourceExecutionId: receipt.executionId ?? '',
        reason,
      },
    },
  };
}

/**
 * Prepare the bounded D2 normalization worker for one immutable raw submission.
 * The Discovery persistence adapter writes control_intent_id and
 * source_submission_id into the projected task metadata.
 */
function createPrepareNormalizationHandler(
  runtime: DiscoveryRuntimePersistencePort,
): KernelHandler {
  return (ctx) => {
    if (ctx.epicId === null) {
      throw new Error('discovery-prepare-normalization: epicId is required');
    }
    const bindings = ((ctx.input ?? {}) as { bindings?: Record<string, unknown> }).bindings ?? {};
    const sourceIntentId = Number(bindings.sourceIntentId ?? 0);
    const sourceTaskId = Number(bindings.sourceTaskId ?? 0);
    const sourceExecutionId = String(bindings.sourceExecutionId ?? '');
    const rawSubmissionId = Number(bindings.rawSubmissionId ?? 0);
    const rawHash = String(bindings.rawHash ?? '');
    if (!sourceIntentId || !sourceTaskId || !sourceExecutionId || !rawSubmissionId || !rawHash) {
      throw new Error('discovery-prepare-normalization: exact raw submission lineage is required');
    }
    const raw = runtime.readRawSubmission(rawSubmissionId);
    if (
      !raw
      || raw.intent_id !== sourceIntentId
      || raw.task_id !== sourceTaskId
      || raw.execution_id !== sourceExecutionId
      || raw.raw_hash !== rawHash
      || raw.status !== 'normalization_required'
    ) {
      throw new Error(`discovery-prepare-normalization: raw submission ${rawSubmissionId} lineage mismatch`);
    }
    const execution = runtime.ensureNormalizationControl({
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      sourceSubmissionId: rawSubmissionId,
      objective: `Normalize raw discovery submission ${rawSubmissionId}`,
    });
    return {
      event: 'prepared',
      production: {
        schema: 'factory.discovery-normalization-control.v1',
        artifactRef: `normalization-control:${execution.controlIntentId}`,
        contentHash: rawHash,
        bindings: {
          sourceIntentId,
          sourceTaskId,
          sourceExecutionId,
          rawSubmissionId,
          rawHash,
          controlIntentId: execution.controlIntentId,
          authorityIntentId: execution.authorityIntentId,
          preProjectedIntentId: execution.authorityIntentId,
          preProjectedTaskId: execution.taskId,
        },
      },
    };
  };
}

/**
 * Materialize the canonical Proposal created by normalization_submit. The
 * resolver follows the original product WorkIntent and raw submission, never
 * the normalizer WorkIntent and never an epic-wide "latest" row.
 */
function createResolveNormalizedProposalHandler(
  runtime: DiscoveryRuntimePersistencePort,
): KernelHandler {
  return (ctx) => {
    const receipt = requireTaskReceipt(ctx.input, 'discovery-resolve-normalized-proposal');
    const prepared = ctx.frame.productions['prepare-normalization'];
    const bindings = prepared?.bindings ?? {};
    const sourceIntentId = Number(bindings.sourceIntentId ?? 0);
    const sourceTaskId = Number(bindings.sourceTaskId ?? 0);
    const sourceExecutionId = String(bindings.sourceExecutionId ?? '');
    const rawSubmissionId = Number(bindings.rawSubmissionId ?? 0);
    const controlIntentId = Number(bindings.controlIntentId ?? 0);
    if (
      !sourceIntentId
      || !sourceTaskId
      || !sourceExecutionId
      || !rawSubmissionId
      || !controlIntentId
    ) {
      throw new Error('discovery-resolve-normalized-proposal: normalization lineage is missing');
    }
    const raw = runtime.readRawSubmission(rawSubmissionId);
    const currentNormalization = receipt.executionId
      ? runtime.readNormalizationProposalForExecution(
          controlIntentId,
          receipt.taskId,
          receipt.executionId,
        )
      : null;
    const normalization = currentNormalization
      ?? runtime.readLatestNormalizationProposal(controlIntentId);
    const proposal = runtime.readProposalForExecution(
      sourceIntentId,
      sourceTaskId,
      sourceExecutionId,
    );
    const proposalLineage = proposal
      ? runtime.readProposalForSettlement(proposal.id)
      : null;
    const accepted = Boolean(
      proposal
      && proposalLineage
      && raw
      && normalization
      && raw.intent_id === sourceIntentId
      && raw.task_id === sourceTaskId
      && raw.execution_id === sourceExecutionId
      && proposalLineage.source_submission_id === rawSubmissionId
      && proposalLineage.task_id === sourceTaskId
      && proposalLineage.execution_id === sourceExecutionId
      && receipt.intentId === Number(bindings.authorityIntentId ?? 0)
      && normalization.task_id === receipt.taskId
      && normalization.source_submission_id === rawSubmissionId
      && normalization.status === 'accepted_by_kernel'
      && proposalLineage.normalization_proposal_id === normalization.id
    );
    finishNormalizationControl(
      runtime,
      controlIntentId,
      accepted ? 'completed' : receipt.runtimeStatus,
    );
    if (accepted) concludeAuthorityIntent(runtime, receipt.intentId);
    if (!accepted || !proposal) {
      return {
        event: 'failed',
        production: {
          schema: 'factory.discovery-normalization-result.v1',
          artifactRef: `raw-submission:${rawSubmissionId}`,
          contentHash: String(bindings.rawHash ?? ''),
          bindings: { sourceIntentId, rawSubmissionId, reason: 'canonical-proposal-missing' },
        },
      };
    }
    return {
      event: 'accepted',
      production: proposalProduction(
        proposal.id,
        proposal.content_hash,
        sourceIntentId,
        sourceTaskId,
        sourceExecutionId,
        rawSubmissionId,
      ),
    };
  };
}

function proposalProduction(
  proposalId: number,
  proposalHash: string,
  sourceIntentId: number,
  sourceTaskId: number,
  sourceExecutionId: string,
  rawSubmissionId: number,
) {
  return {
    schema: 'factory.discovery-proposal.v1',
    artifactRef: `proposal:${proposalId}`,
    contentHash: proposalHash,
    bindings: {
      proposalId,
      proposalHash,
      sourceIntentId,
      sourceTaskId,
      sourceExecutionId,
      rawSubmissionId,
    },
  };
}

// ---------------------------------------------------------------------------
// discovery-prepare-readiness (Д5)
// ---------------------------------------------------------------------------

/**
 * D5 preparation handler: создаёт readiness ControlIntent + authority
 * WorkIntent + projected advisor task для EXACT immutable Proposal версии.
 * Возвращает machine-filled bindings (controlIntentId, authorityIntentId,
 * taskId, proposalId, proposalHash), которые:
 *     переиспользует готовый taskId из bindings.preProjectedTaskId вместо
 *     создания нового);
 *   - воркер читает через task_get → metadata.control_intent_id → readiness_get.
 *
 * Idempotent на (proposalId, proposalContentHash) — повторный запуск для того
 * же Proposal версии вернёт тот же control + task.
 */
function createPrepareReadinessHandler(
  runtime: DiscoveryRuntimePersistencePort,
): KernelHandler {
  return (ctx) => {
    if (ctx.epicId === null) {
      throw new Error('discovery-prepare-readiness: epicId is required');
    }
    // chain bindings от предыдущих узлов. produce-proposal кладёт intentId/
    // workIntentId/taskId. normalize-deterministic добавляет proposal lineage.
    // Proposal ID/Hash мы должны разрешить: либо из bindings (если предыдущий
    // узел его записал), либо из БД (readLatestProposalByEpic — fallback для
    // случая, когда chain ещё не нёс proposalId; в будущем Д8 сделает это exact).
    const chain = (ctx.input ?? {}) as { bindings?: Record<string, unknown> };
    const bindings = chain.bindings ?? {};
    const sourceIntentId = Number(bindings.sourceIntentId ?? 0);
    const sourceTaskId = Number(bindings.sourceTaskId ?? 0);
    const sourceExecutionId = String(bindings.sourceExecutionId ?? '');

    const proposalId = Number(bindings.proposalId ?? 0);
    const proposalHash = String(bindings.proposalHash ?? '');
    if (!proposalId || !proposalHash) {
      throw new Error('discovery-prepare-readiness: exact Proposal id/hash lineage is required');
    }
    const proposal = runtime.readProposalForSettlement(proposalId);
    if (
      !proposal
      || proposal.content_hash !== proposalHash
      || !sourceIntentId
      || !sourceTaskId
      || !sourceExecutionId
      || proposal.intent_id !== sourceIntentId
      || proposal.task_id !== sourceTaskId
      || proposal.execution_id !== sourceExecutionId
    ) {
      throw new Error(`discovery-prepare-readiness: Proposal ${proposalId} lineage mismatch`);
    }

    const execution = runtime.ensureReadinessControl({
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      proposalId,
      proposalContentHash: proposalHash,
      sourceIntentId,
      objective: `Assess readiness of discovery proposal ${proposalId}`,
    });

    return {
      event: 'prepared', // domain.prepared → assess-readiness
      production: {
        schema: 'factory.discovery-prepare-readiness.v1',
        artifactRef: `prepare-readiness:${execution.controlIntentId}`,
        contentHash: proposalHash,
        bindings: {
          epicId: ctx.epicId,
          controlIntentId: execution.controlIntentId,
          authorityIntentId: execution.authorityIntentId,
          // переиспользует его вместо создания нового, см. preProjectedTaskId.
          preProjectedTaskId: execution.taskId,
          preProjectedIntentId: execution.authorityIntentId,
          proposalId,
          proposalHash,
          sourceIntentId,
          sourceTaskId,
          sourceExecutionId,
        },
      },
    };
  };
}

/**
 * Materialize D3 after the advisor task. Read the assessment only through the
 * exact readiness ControlIntent created for the Proposal version. Advisor
 * execution may finish without an accepted assessment; that is represented as
 * a durable missing/failed/paused production so settlement can fail closed.
 */
function createResolveReadinessHandler(
  runtime: DiscoveryRuntimePersistencePort,
): KernelHandler {
  return (ctx) => {
    const receipt = requireTaskReceipt(ctx.input, 'discovery-resolve-readiness');
    const prepared = ctx.frame.productions['prepare-readiness'];
    const bindings = prepared?.bindings ?? {};
    const controlIntentId = Number(bindings.controlIntentId ?? 0);
    const authorityIntentId = Number(bindings.authorityIntentId ?? 0);
    const proposalId = Number(bindings.proposalId ?? 0);
    const proposalHash = String(bindings.proposalHash ?? '');
    if (
      !controlIntentId
      || !authorityIntentId
      || receipt.intentId !== authorityIntentId
      || !proposalId
      || !proposalHash
    ) {
      throw new Error('discovery-resolve-readiness: exact readiness preparation lineage is required');
    }
    const currentAssessment = receipt.executionId
      ? runtime.readReadinessAssessmentForExecution(
          controlIntentId,
          receipt.taskId,
          receipt.executionId,
        )
      : null;
    const assessment = currentAssessment
      ?? runtime.readLatestReadinessAssessment(controlIntentId);
    const accepted = Boolean(
      assessment
      && assessment.status === 'accepted_by_kernel'
      && assessment.task_id === receipt.taskId
      && assessment.proposal_id === proposalId
      && assessment.proposal_content_hash === proposalHash
    );
    finishReadinessControl(
      runtime,
      controlIntentId,
      accepted ? 'completed' : receipt.runtimeStatus,
    );
    if (accepted) concludeAuthorityIntent(runtime, receipt.intentId);
    if (accepted && assessment) {
      return {
        event: 'accepted',
        production: {
          schema: 'factory.discovery-readiness-assessment.v1',
          artifactRef: `readiness-assessment:${assessment.id}`,
          contentHash: assessment.content_hash,
          bindings: {
            proposalId,
            proposalHash,
            sourceIntentId: Number(bindings.sourceIntentId ?? 0),
            controlIntentId,
            assessmentId: assessment.id,
            assessmentHash: assessment.content_hash,
            producerExecutionId: assessment.execution_id,
            readinessStatus: 'accepted',
          },
        },
      };
    }

    const readinessStatus = receipt.runtimeStatus === 'paused'
      ? 'paused'
      : assessment?.status === 'rejected_by_kernel'
        ? 'failed'
        : 'missing';
    return {
      event: readinessStatus,
      production: {
        schema: 'factory.discovery-readiness-result.v1',
        artifactRef: `readiness-control:${controlIntentId}:${readinessStatus}`,
        contentHash: assessment?.content_hash ?? NO_READINESS_HASH,
        bindings: {
          proposalId,
          proposalHash,
          sourceIntentId: Number(bindings.sourceIntentId ?? 0),
          controlIntentId,
          assessmentId: assessment?.id ?? 0,
          assessmentHash: assessment?.content_hash ?? '',
          readinessStatus,
        },
      },
    };
  };
}

// ---------------------------------------------------------------------------
// discovery-settlement-policy
// ---------------------------------------------------------------------------

/**
 * Settlement handler (Д4 + Д6 + Д-поправка):
 *
 *   Д4 — exact lineage. Proposal ID/Hash и (опц.) Assessment ID/Hash берутся
 *        из NodeProduction предыдущих узлов (chain), НЕ из latest-by-epic.
 *        Рестарт/параллельный запуск не может подсунуть чужой Proposal.
 *
 *   Д6 — AuthoritativeSettlementResult. Handler сам строит certificate payload
 *        + hash (модуль = content), Runtime только атомарно сохраняет (Д7).
 *        Никакого второго settle callback, реконструирующего сертификат из outcome.
 *
 *   поправка — readiness slice ищется по proposalId (через intent), не по epicId.
 */
function createDiscoverySettlementHandler(
  runtime: DiscoveryRuntimePersistencePort,
  settlementService: DiscoverySettlementPort,
): KernelHandler {
  return async (ctx) => {
    if (ctx.epicId === null) {
      throw new Error('discovery-settlement-policy: epicId is required');
    }

    // 1. Exact lineage: proposalId из chain bindings предыдущих NodeRun.
    //    chainInput — accumulate предыдущих productions. produce-proposal
    //    кладёт intentId; downstream узлы добавляют proposalId после proposal_submit.
    const readinessProduction = ctx.frame.productions['resolve-readiness'];
    const lineage = readinessProduction?.bindings ?? {};
    const proposalId = Number(lineage.proposalId ?? 0);
    const proposalHash = String(lineage.proposalHash ?? '');
    const readinessStatus = String(lineage.readinessStatus ?? 'missing');
    if (!proposalId || !proposalHash) {
      throw new Error('discovery-settlement-policy: exact Proposal lineage is required');
    }

    const assessmentId = Number(lineage.assessmentId ?? 0);
    const assessment = assessmentId
      ? runtime.readReadinessAssessment(assessmentId)
      : null;
    const readiness: ReadinessShadowResult = readinessStatus === 'accepted' && assessment
      ? {
          status: 'completed',
          authority: 'shadow_advisor',
          assessmentId: assessment.id,
          assessmentHash: assessment.content_hash,
          overallReadiness: assessment.overall_readiness,
          recommendedNextAction: assessment.recommended_next_action,
          error: null,
        }
      : {
          status: readinessStatus === 'paused'
            ? 'paused'
            : readinessStatus === 'failed'
              ? 'failed'
              : 'not_run',
          authority: 'none',
          assessmentId: null,
          assessmentHash: null,
          overallReadiness: null,
          recommendedNextAction: null,
          error: readinessStatus === 'failed'
            ? 'readiness assessment was rejected'
            : null,
        };

    // 4. Собрать snapshot + вызвать политику.
    const settled = await settlementService.settle({
      projectId: ctx.projectId,
      epicId: ctx.epicId,
      proposalId,
      proposalHash,
      readiness,
    });

    // 5. Д6: handler сам формирует AuthoritativeSettlementResult — certificate
    //    payload + hash. Это module content (Discovery schema, policy lineage).
    //    Runtime (GenericFlowExecutor) только валидирует envelope + атомарно
    //    сохраняет (Д7), не реконструируя сертификат заново.
    if (settled.status !== 'issued') {
      // WAVE 8 HIGH 3 — terminal completion is MANDATORY. The failure outcome
      // reaches the terminal `complete-failed` emitter; the kernel MUST emit an
      // explicit ModuleCompletion so the executor does not throw
      // SETTLEMENT_COMPLETION_MISSING. No certificate is issued on this path
      // (the settlement policy declined to issue one), so certificateRef is
      // OMITTED — the executor resolves `certificate = null`, which is the
      // clean contract for a non-certified terminal outcome. The previous
      // return omitted `completion`, which silently produced a null certificate
      // via the deleted magic-bindings path; after Wave 5 + Wave 8 that path is
      // gone, so the completion must be explicit.
      return {
        event: 'failed',
        production: {
          schema: 'factory.discovery-settlement.v1',
          artifactRef: `settlement:failed:${ctx.epicId}:${proposalId}`,
          contentHash: '',
          bindings: { proposalId, proposalHash, reason: settled.error },
        },
        completion: {
          outcome: 'failed',
          terminal: true,
          outputEnvelope: {
            outcome: 'failed',
            productions: [],
            // No certificateRef — non-certified terminal outcome.
          },
        } satisfies ModuleCompletion,
      };
    }
    const certificate = runtime.readOutcomeCertificate(settled.certificateId);
    if (!certificate) {
      throw new Error(
        `discovery-settlement-policy: issued certificate ${settled.certificateId} is missing`,
      );
    }
    // WAVE 5 CUTOVER — the certificate envelope is no longer duplicated into
    // `production.bindings`. Discovery pre-issues its own certificate (the
    // settlement service does it), then emits an explicit ModuleCompletion
    // whose `outputEnvelope.certificateRef` points at the issued row by
    // content-address. Settlement (generic-flow-executor.ts) reads the
    // magic-bindings keys (certificateRef / certificateArtifactPayload /
    // certificateHash / certificateSchema / certificateDecision) are removed.
    // The completion is the sole certificate channel.
    const certificateRef = `discovery-certificate:${settled.certificateId}`;
    return {
      event: settled.decision,
      production: {
        schema: 'factory.discovery-settlement.v1',
        artifactRef: `settlement:${settled.settlementId}`,
        contentHash: settled.certificateHash,
        bindings: {
          epicId: ctx.epicId,
          proposalId,
          proposalHash,
          settlementId: settled.settlementId,
          decision: settled.decision,
          reasonCodes: settled.reasonCodes.join(','),
          authority: 'discovery_settlement_policy',
        },
      },
      // Uncle Bob Wave 4: explicit terminal envelope. The completion carries
      // the content-addressed certificate pointer, expressed as a typed
      // ProductRef (schemaId/ref/digest). `outcome` mirrors the settlement
      // decision so assertExplicitModuleCompletion agrees with the terminal
      // outcome; `terminal: true` because the settle kernel's decision is
      // final. Settlement reads `outputEnvelope.certificateRef` to resolve the
      // certificate (the sole path after Wave 5).
      //
      // Wave 8 BLOCKER 2: the envelope is a LEAF — it no longer carries a
      // `completion` back-reference. The model is a serializable tree
      // (ModuleCompletion.outputEnvelope → envelope, one-directional), so
      // `completeV2` → `JSON.stringify(completion)` is safe.
      completion: {
        outcome: settled.decision,
        terminal: true,
        outputEnvelope: {
          outcome: settled.decision,
          productions: [],
          certificateRef: {
            schemaId: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
            ref: certificateRef,
            digest: settled.certificateHash,
          },
        },
      } satisfies ModuleCompletion,
    };
  };
}

/**
 * Build the readiness slice (Д4 + Д-поправка).
 *
 * Priority:
 *   1. Exact assessmentId from chain (downstream NodeRun bound the exact row).
 *   2. Latest accepted assessment for THIS epic (scoped by proposalId lineage).
 *
 * The settlement policy treats missing/failed/paused identically (fail-closed
 * to clarify); the distinction only matters for the idempotency key + audit.
 * Returns the 'missing' slice when no assessment exists.
 */
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * agnostic) поверх saga3 `DiscoveryRuntimePersistencePort` (snake_case, уже
 * generic по форме после параметризации в шаге 2). Composition-root передаёт
 *
 * Это Module content: знает физическое расположение saga3 persistence. Runtime
 * core видит только generic интерфейс.
 */
export function createDiscoveryWorkplacePersistence(
  runtime: DiscoveryRuntimePersistencePort,
): WorkplaceExecutionPersistence {
  return {
    ensureExecutionPlan(input) {
      return runtime.ensureNodeExecutionPlan({
        intent: {
          epic_id: input.intent.epicId,
          kind: input.intent.kind,
          objective: input.intent.objective,
          authority_scope: input.intent.authorityScope,
          output_schema: input.intent.outputSchema,
          token_budget: input.intent.tokenBudget,
          retry_budget: input.intent.retryBudget,
        },
        task: {
          epicId: input.task.epicId,
          projectId: input.task.projectId,
          objective: input.task.objective,
          taskKind: input.task.taskKind,
          executionSkill: input.task.executionSkill,
          reviewSkill: input.task.reviewSkill,
          generationKey: input.task.generationKey,
          workflowStage: input.task.workflowStage,
          executionMode: input.task.executionMode,
          titlePrefix: input.task.titlePrefix,
          metadata: input.task.metadata,
        },
      });
    },
    createIntent(input) {
      const intent = runtime.createIntent({
        epic_id: input.epicId,
        kind: input.kind,
        objective: input.objective,
        authority_scope: input.authorityScope,
        output_schema: input.outputSchema,
        token_budget: input.tokenBudget,
        retry_budget: input.retryBudget,
      });
      return { id: intent.id };
    },
    ensureProjectedTask(input) {
      return runtime.ensureProjectedTask({
        epicId: input.epicId,
        projectId: input.projectId,
        intentId: input.intentId,
        objective: input.objective,
        taskKind: input.taskKind,
        executionSkill: input.executionSkill,
        reviewSkill: input.reviewSkill,
        generationKey: input.generationKey,
        workflowStage: input.workflowStage,
        executionMode: input.executionMode,
        titlePrefix: input.titlePrefix,
        metadata: input.metadata,
      });
    },
    setProjectedTask(intentId, taskId) {
      runtime.setProjectedTask(intentId, taskId);
    },
    bindProjectedTaskProcessContext(input) {
      runtime.bindProjectedTaskProcessContext(input);
    },
    setIntentStatus(intentId, expected, next) {
      return runtime.setIntentStatus(intentId, expected as never, next as never);
    },
    prepareIntentForExecution(intentId, taskId) {
      const r = runtime.prepareIntentForExecution(intentId, taskId);
      return { status: r.state, intentStatus: r.intentStatus };
    },
    transitionToInRepair(taskId: number) {
      return runtime.transitionToInRepair(taskId);
    },
    readTaskState(taskId) {
      return runtime.readTaskState(taskId);
    },
    readCurrentExecutionId(taskId) {
      return runtime.readCurrentExecutionId(taskId);
    },
    readLatestExecutionId(taskId) {
      return runtime.readLatestExecutionId(taskId);
    },
    readProducerExecutionId(taskId) {
      return runtime.readProducerExecutionId(taskId);
    },
    readLatestManagedProductionExecutionId(taskId, processRunId, nodeId) {
      return runtime.readLatestManagedProductionExecutionId(
        taskId,
        processRunId,
        nodeId,
      );
    },
    readTaskProjectRepositoryId(taskId) {
      return runtime.readTaskProjectRepositoryId(taskId);
    },
    readExecutionLiveness(executionId) {
      return runtime.readExecutionLiveness(executionId);
    },
  };
}
