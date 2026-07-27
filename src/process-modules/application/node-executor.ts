/**
 * NodeExecutor — порт исполнителя одного типа flow-узлов.
 *
 * Universal ProcessModuleRuntime диспатчит каждый узел по `node.kind` через
 * соответствующий NodeExecutor. Один NodeExecutor на kind: lm / kernel /
 * human / external / composite.
 *
 * NodeExecutor НЕ знает, какой модуль исполняется, — только тип узла.
 * Предметное содержание (schemas, policies, skills, intent-kind строки)
 * поставляется через `module` (ProcessModuleDefinition) и payload узла.
 *
 * Это и есть граница «Runtime = физика»: NodeExecutor читает descriptor, но
 * не содержит ни одной ссылки на module-specific символы. Discovery Pack
 * подключает своё содержание через KernelHandlerRegistry (для kernel-узлов)
 * и через ExecutionProfileDefinition (для lm-узлов), а не через новые ветки
 * здесь.
 */

import type {
  FlowNodeDefinition,
  FlowNodeKind,
  ProcessModuleDefinition,
} from '../domain/process-module.js';
import type { RecoveryIssue } from '../domain/recovery.js';

/**
 * Контекст исполнения одного узла.
 *
 * `input` уже декодирован и провалидирован上层 (GenericFlowExecutor) против
 * `node.inputSchema` — NodeExecutor получает готовый payload.
 */
export interface NodeExecutionContext {
  projectId: number;
  epicId: number | null;
  processRunId: number;
  /** Полный descriptor модуля — для доступа к executionProfiles, policies, … */
  module: ProcessModuleDefinition;
  /** Исполняемый узел (lm/kernel/human/external/composite). */
  node: FlowNodeDefinition;
  /** Декодированный вход узла. */
  input: unknown;
  /**
   * Durable data frame reconstructed from every completed NodeRun. Consumers
   * address products by producer node id instead of relying on a mutable bag
   * copied through every intermediate node.
   */
  frame: NodeExecutionFrame;
  /** Renew the ProcessRun single-driver lease during long node execution. */
  heartbeat: () => void;
  /** Идентификатор инициатора для аудита. */
  initiatedBy: string;
}

/**
 * Результат исполнения узла.
 *
 * Разделяем ФИЗИЧЕСКИЙ результат исполнения (runtime) и ПРЕДМЕТНОЕ событие
 * (domain). Это критично для authoritative settlement (см. корректировку
 * архитектора от 2026-07-26):
 *
 *   runtimeEvent — физический статус исполнения узла. Всегда присутствует.
 *                  LM executor задаёт только его ('completed'|'failed'|'paused').
 *                  Kernel handler тоже может его задать (обычно 'completed').
 *
 *   domainEvent  — предметное событие (только для kernel-узлов и terminal
 *                  outcome-emitter'ов). LM executor НЕ задаёт domainEvent —
 *                  он не знает предметной семантики. Примеры:
 *                  'accepted', 'semantic-ambiguity', 'go', 'clarify', 'reject'.
 *
 *   production   — durable типизированная ссылка на продукцию узла (см. Д3).
 *                  Никаких сырых объектов или {taskId, intentId}.
 *
 * Flow transitions явно различают префиксы:
 *   'runtime.completed' / 'runtime.failed'
 *   'domain.accepted'   / 'domain.go' / 'domain.clarify'
 *   '*' — wildcard default-edge.
 *
 * Для terminal outcome-emitter'а outcome код берётся из `node.emitsOutcome`
 * (это уже так) — domainEvent = `outcome:<code>`, runtimeEvent = 'completed'.
 */
export interface NodeExecutionResult {
  runtimeEvent: 'completed' | 'failed' | 'paused';
  domainEvent?: string;
  /**
   * Physical execution evidence. LM/external/human executors return a receipt;
   * they MUST NOT pretend that a completed task is the module's domain product.
   * A module-owned resolver kernel consumes this receipt, reads the canonical
   * module store, and emits NodeProduction.
   */
  receipt?: NodeExecutionReceipt;
  production?: NodeProduction;
  /**
   * Standard module-authored issue. Core treats reasonCode/findings as opaque
   * and only interprets the declared recovery policy.
   */
  recoveryIssue?: RecoveryIssue;
  /** Только для terminal-узлов (outcome-emitter). */
  outcome?: string;
}

/**
 * Module-agnostic evidence that one physical node execution finished.
 *
 * `inputBindings` are an opaque snapshot supplied by the preceding module
 * preparation node. Runtime persists and forwards them, but never interprets
 * domain keys such as proposalId or controlIntentId.
 */
export interface NodeExecutionReceipt {
  kind: 'task-execution';
  executorKind: FlowNodeKind;
  intentId: number;
  taskId: number;
  /** Exact worker execution fence when the substrate exposes it. */
  executionId: string | null;
  runtimeStatus: 'completed' | 'failed' | 'paused';
  replayed: boolean;
}

export interface NodeExecutionFrame {
  runInput: unknown;
  productions: Record<string, NodeProduction>;
  receipts: Record<string, NodeExecutionReceipt>;
}

/**
 * Durable типизированная ссылка на продукцию узла.
 *
 * НЕ сырой объект, НЕ внутренние runtime-ID. Это контракт между узлами: узел A
 * возвращает production, узел B (или settlement kernel) читает из неё exact
 * bindings и перечитывает каноническую строку из БД.
 *
 *   schema       — schema id продукции (например 'saga3.discovery-proposal.v1').
 *   artifactRef  — opaque ссылка на продукцию (например 'proposal:141').
 *   contentHash  — SHA-256 над каноническим телом продукции (immutable).
 *   bindings     — machine-filled параметры для downstream-узлов:
 *                  { proposalId, proposalHash, workIntentId, assessmentId, ... }.
 *                  Discovery Pack знает, как их интерпретировать.
 */
export interface NodeProduction {
  schema: string;
  artifactRef: string;
  contentHash: string;
  /**
   * Machine-filled параметры для downstream-узлов. Значения — примитивы
   * (string/number/boolean) ИЛИ вложенные объекты (например certificatePayload
   * — полный envelope, который settlement kernel сформировал и Runtime должен
   * атомарно сохранить без реконструкции). Это не arbitrary JSON — модуль
   * обязан класть сюда только то, что downstream kernel/Runtime умеет читать.
   */
  bindings: Record<string, unknown>;
}

/**
 * Свести (runtimeEvent, domainEvent) в одну строку для Flow transition matching.
 * Приоритет: domainEvent (если есть) > runtimeEvent. Префиксы 'domain.'/'runtime.'
 * добавляются, чтобы descriptor мог различать физический статус и предметное
 * решение. '*' остаётся wildcard.
 */
export function nodeEventForTransition(result: NodeExecutionResult): string {
  if (result.domainEvent) return `domain.${result.domainEvent}`;
  return `runtime.${result.runtimeEvent}`;
}

/**
 * SPI. Реализация выбирается по `kind`. GenericFlowExecutor держит
 * `Map<FlowNodeKind, NodeExecutor>` и диспатчит по `ctx.node.kind`.
 */
export interface NodeExecutor {
  /** Дискриминатор — соответствует FlowNodeKind, который обрабатывает. */
  readonly kind: FlowNodeKind;
  execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult>;
}

/**
 * Базовая ошибка для NodeExecutor-ов.
 */
export class NodeExecutionError extends Error {
  constructor(
    readonly nodeKind: FlowNodeKind,
    readonly nodeId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`node '${nodeId}' (kind=${nodeKind}) execution failed: ${message}`);
    this.name = 'NodeExecutionError';
  }
}

export class NodeExecutionLeaseLostError extends Error {
  constructor(readonly processRunId: number) {
    super(`ProcessRun ${processRunId} execution lease was lost`);
    this.name = 'NodeExecutionLeaseLostError';
  }
}
