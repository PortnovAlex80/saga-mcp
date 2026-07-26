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
 *   - 'discovery-settlement-policy' → `discoverySettlementPolicyV1.evaluate()`
 *     поверх собранного snapshot (content: manifest, reason codes, thresholds).
 *
 * 'process-outcome-emitter' НЕ регистрируется здесь — это generic handler,
 * который сам runtime регистрирует (он не знает про go/clarify/...).
 *
 * LM-узлы (produce-proposal, normalize-semantic, assess-readiness, diagnose)
 * тоже не здесь — они исполняются LmNodeExecutor'ом по executionProfile из
 * descriptor'а. Discovery Pack только объявляет профили (content).
 */

import type { KernelHandler } from '../../application/kernel-handler-registry.js';
import type { LmNodeExecutionPersistence } from '../../application/node-executors/lm-node-executor.js';
import type { Saga3DiscoveryRuntimePersistence } from '../../../saga3/persistence/saga3-discovery-runtime-port.js';
import { discoverySettlementPolicyV1 } from '../../../saga3/domain/discovery-settlement-policy.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  buildSettlementInputHash,
  type DiscoverySettlementInputSnapshot,
  type SettlementProposalInput,
  type SettlementReadinessInput,
  type SettlementPolicyInput,
  type SettlementReadinessStatus,
} from '../../../saga3/domain/discovery-settlement-input.js';
import { normalizeDiscoveryProposalInput } from '../../../saga3/domain/discovery-normalization.js';
import { NO_READINESS_HASH } from '../../../saga3/domain/discovery-settlement-input.js';

/**
 * Deps, которые модуль поставляет из composition-root. Settle handler читает
 * канонические Proposal + Readiness из saga3 persistence (worker'ы уже
 * сохранили их через proposal_submit / readiness_submit) — это и есть
 * «machine-known data must be machine-filled». Snapshot строится из БД, не из
 * цепочки node outputs.
 */
export interface DiscoveryInstallationDeps {
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
}

/**
 * Сборка handlers для Discovery. Composition-root вызывает это и регистрирует
 * результат в KernelHandlerRegistry до установки модуля.
 */
export function createDiscoveryKernelHandlers(
  deps: DiscoveryInstallationDeps,
): Record<string, KernelHandler> {
  return {
    'discovery-normalization-kernel': discoveryNormalizationKernelHandler,
    'discovery-settlement-policy': createDiscoverySettlementHandler(deps.runtimePersistence),
  };
}

// ---------------------------------------------------------------------------
// discovery-normalization-kernel
// ---------------------------------------------------------------------------

const discoveryNormalizationKernelHandler: KernelHandler = (ctx) => {
  // ctx.input — сырой worker submission (saga3.discovery-raw-submission.v1).
  // Делегируем в чистый детерминированный нормализатор — никаких LM, никакого I/O.
  const result = normalizeDiscoveryProposalInput(ctx.input);
  // disposition → event (должно совпадать с FlowTransitionDefinition.on):
  //   accepted        → assess-readiness
  //   needs_lm        → normalize-semantic
  //   rejected_syntax → complete-failed
  const eventByDisposition: Record<string, string> = {
    accepted: 'accepted',
    needs_lm: 'semantic-ambiguity',
    rejected_syntax: 'invalid-json',
  };
  const event = eventByDisposition[result.disposition] ?? 'invalid-json';
  return {
    event,
    output: result,
    // Не terminal — у normalization-kernel нет emitsOutcome.
  };
};

// ---------------------------------------------------------------------------
// discovery-settlement-policy
// ---------------------------------------------------------------------------

/**
 * Settlement handler: строит DiscoverySettlementInputSnapshot из КАНОНИЧЕСКИХ
 * данных в БД (proposal + readiness, сохранённые worker'ами), вызывает
 * детерминированную политику discoverySettlementPolicyV1. Возвращает decision.
 *
 * GenericFlowExecutor issue'ит сертификат в generic-таблицу по return value;
 * saga3-таблица остаётся для legacy engine. Это разделение mechanics/content:
 * handler = content (policy, snapshot shape, reason codes), executor = mechanics
 * (cert issue, ProcessRun transitions).
 */
function createDiscoverySettlementHandler(
  runtime: Saga3DiscoveryRuntimePersistence,
): KernelHandler {
  const policy = discoverySettlementPolicyV1;
  return (ctx) => {
    if (ctx.epicId === null) {
      throw new Error('discovery-settlement-policy: epicId is required');
    }

    // 1. Найти канонический Proposal для эпика. Воркер produce-proposal уже
    //    сохранил его через proposal_submit; settlement читает из БД, не из chain.
    const proposalSummary = runtime.readLatestProposalByEpic(ctx.epicId);
    if (!proposalSummary) {
      throw new Error(`discovery-settlement-policy: no proposal found for epic ${ctx.epicId}`);
    }
    // readProposalForSettlement returns the full lineage (source_intent_id,
    // source_submission_id, normalization_proposal_id) the snapshot needs.
    const proposalRow = runtime.readProposalForSettlement(proposalSummary.id);
    if (!proposalRow) {
      throw new Error(`discovery-settlement-policy: proposal ${proposalSummary.id} vanished before settlement`);
    }

    const proposal: SettlementProposalInput = {
      id: proposalRow.id,
      content_hash: proposalRow.content_hash,
      payload: proposalRow.payload as never,
      source_intent_id: proposalRow.intent_id,
      source_submission_id: proposalRow.source_submission_id,
      normalization_proposal_id: proposalRow.normalization_proposal_id,
    };

    // 2. Найти принятую readiness assessment для proposal (если есть).
    const readinessSlice = findReadinessSlice(runtime, proposalRow.id);

    // 3. Собрать snapshot и вызвать политику.
    const capturedAt = new Date().toISOString();
    const snapshot: DiscoverySettlementInputSnapshot = {
      schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
      epic_id: ctx.epicId,
      proposal,
      readiness: readinessSlice,
      policy: {
        version: policy.version,
        content_hash: policy.contentHash,
      } satisfies SettlementPolicyInput,
      captured_at: capturedAt,
    };

    const inputHash = buildSettlementInputHash(snapshot);
    const evaluation = policy.evaluate(snapshot);
    const decision = evaluation.decision;

    return {
      event: decision.decision,
      output: {
        snapshot,
        inputHash,
        decision,
        trace: evaluation.trace,
      },
    };
  };
}

/** Build the readiness slice from the latest accepted assessment for the proposal. */
function findReadinessSlice(
  runtime: Saga3DiscoveryRuntimePersistence,
  proposalId: number,
): SettlementReadinessInput {
  // The settlement policy treats missing/failed/paused identically (fail-closed
  // to clarify); the distinction only matters for the idempotency key + audit.
  // readLatestAcceptedReadinessForEpic returns the latest accepted assessment
  // for the epic; null means no assessment exists yet.
  const hit = runtime.readLatestAcceptedReadinessForEpic(proposalId);
  if (hit) {
    return {
      status: 'accepted_by_kernel' satisfies SettlementReadinessStatus,
      assessment_id: hit.assessment_id,
      content_hash: hit.content_hash,
      payload: hit.payload as never,
    };
  }
  return {
    status: 'missing',
    assessment_id: null,
    content_hash: NO_READINESS_HASH,
    payload: null,
  };
}

// ---------------------------------------------------------------------------
// LmNodeExecutionPersistence adapter over the saga3 runtime
// ---------------------------------------------------------------------------

/**
 * Adapter: проецирует generic `LmNodeExecutionPersistence` (camelCase, module-
 * agnostic) поверх saga3 `Saga3DiscoveryRuntimePersistence` (snake_case, уже
 * generic по форме после параметризации в шаге 2). Composition-root передаёт
 * результат в LmNodeExecutor.
 *
 * Это Module content: знает физическое расположение saga3 persistence. Runtime
 * core видит только generic интерфейс.
 */
export function createDiscoveryLmNodePersistence(
  runtime: Saga3DiscoveryRuntimePersistence,
): LmNodeExecutionPersistence {
  return {
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
    setIntentStatus(intentId, expected, next) {
      return runtime.setIntentStatus(intentId, expected as never, next as never);
    },
    prepareIntentForExecution(intentId, taskId) {
      const r = runtime.prepareIntentForExecution(intentId, taskId);
      return { status: r.state, intentStatus: r.intentStatus };
    },
    readTaskState(taskId) {
      return runtime.readTaskState(taskId);
    },
  };
}
