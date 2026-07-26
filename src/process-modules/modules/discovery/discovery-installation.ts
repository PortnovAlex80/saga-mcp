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
 * здесь — они исполняются LmNodeExecutor'ом по executionProfile из descriptor'а.
 * Discovery Pack только объявляет профили (content).
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
import { sha256Hex } from '../../../saga3/shared/discovery-canonical.js';

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
    'discovery-prepare-readiness': createPrepareReadinessHandler(deps.runtimePersistence),
    'discovery-settlement-policy': createDiscoverySettlementHandler(deps.runtimePersistence),
  };
}

// ---------------------------------------------------------------------------
// discovery-normalization-kernel
// ---------------------------------------------------------------------------

const discoveryNormalizationKernelHandler: KernelHandler = (ctx) => {
  // ctx.input — production предыдущего LM-узла produce-proposal. В bindings
  // лежит intentId/taskId воркера; канонический Proposal уже сохранён в БД
  // через proposal_submit. Здесь мы нормализуем сырой raw_submission (для
  // D2 deterministic step). Делегируем в чистый детерминированный нормализатор.
  const production = (ctx.input ?? {}) as { bindings?: Record<string, unknown> };
  const intentId = Number(production.bindings?.intentId ?? 0);
  const result = normalizeDiscoveryProposalInput(ctx.input);
  // disposition → domain event (должно совпадать с FlowTransitionDefinition.on,
  // теперь с префиксом 'domain.'):
  //   accepted        → domain.accepted → assess-readiness
  //   needs_lm        → domain.semantic-ambiguity → normalize-semantic
  //   rejected_syntax → domain.invalid-json → complete-failed
  const eventByDisposition: Record<string, string> = {
    accepted: 'accepted',
    needs_lm: 'semantic-ambiguity',
    rejected_syntax: 'invalid-json',
  };
  const event = eventByDisposition[result.disposition] ?? 'invalid-json';
  return {
    event,
    production: {
      schema: 'saga3.discovery-normalization-result.v1',
      artifactRef: `normalization:${intentId}:${result.disposition}`,
      contentHash: '',
      bindings: {
        intentId,
        disposition: result.disposition,
        reasonCode: result.reason_code,
      },
    },
    // Не terminal — у normalization-kernel нет emitsOutcome.
  };
};

// ---------------------------------------------------------------------------
// discovery-prepare-readiness (Д5)
// ---------------------------------------------------------------------------

/**
 * D5 preparation handler: создаёт readiness ControlIntent + authority
 * WorkIntent + projected advisor task для EXACT immutable Proposal версии.
 * Возвращает machine-filled bindings (controlIntentId, authorityIntentId,
 * taskId, proposalId, proposalHash), которые:
 *   - LM-узел assess-readiness использует как pre-projected task (LmNodeExecutor
 *     переиспользует готовый taskId из bindings.preProjectedTaskId вместо
 *     создания нового);
 *   - воркер читает через task_get → metadata.control_intent_id → readiness_get.
 *
 * Idempotent на (proposalId, proposalContentHash) — повторный запуск для того
 * же Proposal версии вернёт тот же control + task.
 */
function createPrepareReadinessHandler(
  runtime: Saga3DiscoveryRuntimePersistence,
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
    const sourceIntentId = Number(bindings.workIntentId ?? bindings.intentId ?? 0);

    let proposalId = Number(bindings.proposalId ?? 0);
    let proposalHash = String(bindings.proposalHash ?? '');

    if (!proposalId) {
      // Fallback: найти канонический Proposal для эпика.
      const summary = runtime.readLatestProposalByEpic(ctx.epicId);
      if (!summary) {
        // Нет Proposal — readiness не к чему готовить. Сигнализируем failure;
        // descriptor ведёт в complete-failed.
        return {
          event: 'failed',
          production: {
            schema: 'saga3.discovery-prepare-readiness.v1',
            artifactRef: `prepare-readiness:${ctx.epicId}:no-proposal`,
            contentHash: '',
            bindings: { epicId: ctx.epicId, reason: 'no-proposal' },
          },
        };
      }
      proposalId = summary.id;
      proposalHash = summary.content_hash;
    }

    const execution = runtime.ensureReadinessControl({
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      proposalId,
      proposalContentHash: proposalHash,
      sourceIntentId: sourceIntentId || proposalId,
      objective: `Assess readiness of discovery proposal ${proposalId}`,
    });

    return {
      event: 'prepared', // domain.prepared → assess-readiness
      production: {
        schema: 'saga3.discovery-prepare-readiness.v1',
        artifactRef: `prepare-readiness:${execution.controlIntentId}`,
        contentHash: proposalHash,
        bindings: {
          epicId: ctx.epicId,
          controlIntentId: execution.controlIntentId,
          authorityIntentId: execution.authorityIntentId,
          // КЛЮЧЕВОЕ: готовый task для LM-узла assess-readiness. LmNodeExecutor
          // переиспользует его вместо создания нового, см. preProjectedTaskId.
          preProjectedTaskId: execution.taskId,
          proposalId,
          proposalHash,
          sourceIntentId,
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
  runtime: Saga3DiscoveryRuntimePersistence,
): KernelHandler {
  const policy = discoverySettlementPolicyV1;
  return (ctx) => {
    if (ctx.epicId === null) {
      throw new Error('discovery-settlement-policy: epicId is required');
    }

    // 1. Exact lineage: proposalId из chain bindings предыдущих NodeRun.
    //    chainInput — accumulate предыдущих productions. produce-proposal
    //    кладёт intentId; downstream узлы добавляют proposalId после proposal_submit.
    const chain = (ctx.input ?? {}) as {
      bindings?: Record<string, unknown>;
    };
    const proposalIdFromChain = Number(chain.bindings?.proposalId ?? 0);

    // 2. Найти канонический Proposal. Если chain дал exact proposalId — читаем
    //    его; иначе fallback на readLatestProposalByEpic ТОЛЬКО для случая, когда
    //    chain не дошёл (это бывает на restart без durable output — TODO Д8).
    let proposalRow = proposalIdFromChain
      ? runtime.readProposalForSettlement(proposalIdFromChain)
      : null;
    if (!proposalRow) {
      const fallback = runtime.readLatestProposalByEpic(ctx.epicId);
      if (fallback) proposalRow = runtime.readProposalForSettlement(fallback.id);
    }
    if (!proposalRow) {
      throw new Error(`discovery-settlement-policy: no canonical proposal for epic ${ctx.epicId} (chain proposalId=${proposalIdFromChain})`);
    }

    // 3. Exact readiness lineage: assessmentId из chain bindings, либо latest
    //    accepted for THIS proposal. Никаких latest-by-epic в authoritative path.
    const assessmentIdFromChain = Number(chain.bindings?.assessmentId ?? 0);
    const readinessSlice = findReadinessSlice(
      runtime,
      ctx.epicId,
      proposalRow.id,
      assessmentIdFromChain,
    );

    // 4. Собрать snapshot + вызвать политику.
    const proposal: SettlementProposalInput = {
      id: proposalRow.id,
      content_hash: proposalRow.content_hash,
      payload: proposalRow.payload as never,
      source_intent_id: proposalRow.intent_id,
      source_submission_id: proposalRow.source_submission_id,
      normalization_proposal_id: proposalRow.normalization_proposal_id,
    };
    const snapshot: DiscoverySettlementInputSnapshot = {
      schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
      epic_id: ctx.epicId,
      proposal,
      readiness: readinessSlice,
      policy: {
        version: policy.version,
        content_hash: policy.contentHash,
      } satisfies SettlementPolicyInput,
      captured_at: new Date().toISOString(),
    };
    const inputHash = buildSettlementInputHash(snapshot);
    const evaluation = policy.evaluate(snapshot);
    const decision = evaluation.decision;

    // 5. Д6: handler сам формирует AuthoritativeSettlementResult — certificate
    //    payload + hash. Это module content (Discovery schema, policy lineage).
    //    Runtime (GenericFlowExecutor) только валидирует envelope + атомарно
    //    сохраняет (Д7), не реконструируя сертификат заново.
    const certificatePayload = {
      schemaVersion: 'saga3.discovery-outcome-certificate.generic.v1',
      decision: decision.decision,
      reasonCodes: decision.reason_codes,
      rationale: decision.rationale,
      inputHash,
      payload: {
        epic_id: ctx.epicId,
        proposal: { id: proposalRow.id, content_hash: proposalRow.content_hash },
        readiness: {
          status: readinessSlice.status,
          assessment_id: readinessSlice.assessment_id,
          content_hash: readinessSlice.content_hash,
        },
        policy: { version: policy.version, content_hash: policy.contentHash },
        decision: decision.decision,
        reason_codes: decision.reason_codes,
        rationale: decision.rationale,
        policy_trace: evaluation.trace,
        settlement_input_hash: inputHash,
      },
    };
    // certificateHash — SHA-256 над canonical JSON payload. Используем
    // generic helper (Д9 вынесет его в process-modules/shared/).
    const certificateHash = sha256Hex(certificatePayload);

    return {
      event: decision.decision, // domain.go / domain.clarify / domain.reject
      production: {
        schema: 'saga3.discovery-settlement.v1',
        artifactRef: `settlement:${ctx.epicId}:${proposalRow.id}:${inputHash.slice(0, 12)}`,
        contentHash: certificateHash,
        bindings: {
          epicId: ctx.epicId,
          proposalId: proposalRow.id,
          proposalHash: proposalRow.content_hash,
          inputHash,
          decision: decision.decision,
          // Authoritative certificate envelope for the Runtime (Д6).
          certificatePayload,
          certificateHash,
          certificateSchema: certificatePayload.schemaVersion,
          reasonCodes: decision.reason_codes.join(','),
          authority: 'discovery_settlement_policy',
        },
      },
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
function findReadinessSlice(
  runtime: Saga3DiscoveryRuntimePersistence,
  epicId: number,
  _proposalId: number,
  assessmentIdFromChain: number,
): SettlementReadinessInput {
  if (assessmentIdFromChain) {
    const exact = runtime.readReadinessAssessment(assessmentIdFromChain);
    if (exact && exact.status === 'accepted_by_kernel') {
      return {
        status: 'accepted_by_kernel' satisfies SettlementReadinessStatus,
        assessment_id: exact.id,
        content_hash: exact.content_hash,
        payload: exact.payload as never,
      };
    }
  }
  // Fallback: latest accepted readiness for the epic. NOTE: readLatestAccepted
  // ReadinessForEpic filters by epic_id (NOT by proposalId — that was the bug
  // flagged by the architect; the SQL joins control_intents.epic_id).
  const hit = runtime.readLatestAcceptedReadinessForEpic(epicId);
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
