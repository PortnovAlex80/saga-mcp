/**
 * KernelHandlerRegistry — runtime реестр kernel-обработчиков flow-узлов.
 *
 * Конвенция совпадает с ProcessModuleRegistry / ProcessModuleInstallationRegistry:
 * Map<key, value>, register/get/require/list, throw на дубль.
 *
 * Граница: реестр — это Runtime-механика (физика). Сами handler-реализации —
 * Module content. Discovery Pack РЕГИСТРИРУЕТ свой `discoverySettlementPolicyV1`
 * под id `'discovery-settlement-policy'` при установке модуля; Runtime не
 * импортирует Discovery-символы напрямую.
 *
 * Handler id — это строка, объявленная в `KernelFlowNodeDefinition.handler`.
 * Совпадает по конвенции (но не по типу) с `PolicyDefinition.handler` —
 * это документируемое пересечение namespace, одно и то же строковое id.
 *
 * В registry нет ни одного знания о слове "discovery". Он умеет только:
 *   register(handlerId, handler)   — модуль подключает свой handler
 *   require(handlerId)             — GenericFlowExecutor находит handler при dispatch
 *   has(handlerId)                 — валидация coverage при установке модуля
 */

import type { KernelFlowNodeDefinition } from '../domain/process-module.js';
import type { RecoveryIssue } from '../domain/recovery.js';
import type { ModuleCompletion } from '../domain/spi/module-completion.js';
import type { ExactCandidateAcceptanceDirective } from './exact-candidate-acceptance.js';
import type { NodeExecutionFrame, NodeProducts, NodeProduction } from './node-executor.js';

/**
 * Контекст, передаваемый в kernel handler при исполнении соответствующего узла.
 *
 * Повторяет NodeExecutionContext, но сужает `node` до `KernelFlowNodeDefinition`
 * и добавляет helper для чтения хранилища артефактов (модуль-agnostic интерфейс,
 * поставляется GenericFlowExecutor'ом — реализация зависит от бэкенда).
 */
export interface KernelHandlerContext {
  projectId: number;
  epicId: number | null;
  processRunId: number;
  node: KernelFlowNodeDefinition;
  /** Декодированный вход узла (validated against node.inputSchema). */
  input: unknown;
  /** Durable products/receipts keyed by the node that produced them. */
  frame: NodeExecutionFrame;
  /** Renew the owning ProcessRun lease during long deterministic/provider work. */
  heartbeat: () => void;
  initiatedBy: string;
  /**
   * CGAD P18 — centralized node-scoped worker products for THIS node. Read by
   * the executor before invoking this handler, so the handler never queries the
   * ledger by transient task identity. Absent on legacy runs (without the seam).
   */
  nodeProducts?: NodeProducts;
}

/**
 * Результат kernel handler'а. Kernel handler эмитит DOMAIN event (предметное
 * событие — accepted / go / clarify / ...) и возвращает durable production
 * (типизированную ссылку на продукцию). runtime-event всегда 'completed' для
 * kernel-узла, вернувшего нормально.
 */
export interface KernelHandlerResult {
  /**
   * Domain event — drives transition selection. When `runtimeEvent` is
   * 'paused', this event is ignored for transition matching (the executor
   * raises ProcessRunPausedError instead); it is kept purely for audit /
   * terminal bindings replay on resume.
   */
  event: string;
  /** Durable production reference (schema + artifactRef + contentHash + bindings). */
  production: NodeProduction;
  /**
   * Optional physical runtime event override. Kernel handlers default to
   * 'completed' (the executor sets it). A handler returns 'paused' to release
   * the run to the conveyor without finishing — used by Development's
   * settle-development node when projected impl tasks are not yet terminal:
   * the conveyor (orchestrate-cli / LifecycleOrchestrator) then drains the
   * shared worker_next queue, and once all waited tasks reach terminal it
   * resumes the run; the generic-flow-executor re-executes the SAME node
   * (see `reexecutePausedNode`), the handler re-checks, and proceeds.
   */
  runtimeEvent?: 'paused';
  /** Optional standardized issue used by the generic recovery interpreter. */
  recoveryIssue?: RecoveryIssue;
  /**
   * Semantic validation has passed and the common kernel executor must commit
   * this exact candidate set before the domain event may drive the flow.
   */
  exactCandidateAcceptance?: ExactCandidateAcceptanceDirective;
  /** Для terminal-узлов: локальный outcome код (один из module.outcomes). */
  outcome?: string;
  /**
   * W3-A1 / FU-A Wave 3 (spec §3/§4): OPTIONAL explicit terminal envelope
   * (Wave 1 §7.5.6). When a terminal kernel handler returns `completion`, the
   * executor forwards it onto the NodeExecutionResult, persists it to the
   * NodeRun v2 row, and settlement reads the certificate reference DIRECTLY
   * from `completion.outputEnvelope.certificateRef` — bypassing the legacy
   * `production.bindings.certificatePayload` magic bindings. Additive: existing
   * kernel handlers that do not set `completion` are unaffected (they continue
   * to settle via the documented magic-bindings fallback until Wave 4 migrates
   * them, then Wave 5 deletes that branch).
   */
  completion?: ModuleCompletion;
}

/**
 * Функция-handler. Может быть sync или async.
 */
export type KernelHandler = (
  ctx: KernelHandlerContext,
) => Promise<KernelHandlerResult> | KernelHandlerResult;

export class KernelHandlerRegistrationError extends Error {
  constructor(readonly handlerId: string, message: string) {
    super(`kernel handler '${handlerId}': ${message}`);
    this.name = 'KernelHandlerRegistrationError';
  }
}

export class KernelHandlerNotRegisteredError extends Error {
  constructor(readonly handlerId: string) {
    super(
      `kernel handler '${handlerId}' is not registered — the module declared `
        + `a KernelFlowNodeDefinition.handler that has no callable in the registry. `
        + `Register the handler before installing the module.`,
    );
    this.name = 'KernelHandlerNotRegisteredError';
  }
}

export class KernelHandlerRegistry {
  private readonly handlers = new Map<string, KernelHandler>();

  /**
   * Зарегистрировать handler под id, объявленным в
   * `KernelFlowNodeDefinition.handler`. Throw при попытке перезаписать
   * другим handler'ом (idempotent ре-регистрация того же экземпляра допустима
   * для горячей перезагрузки в dev).
   */
  register(handlerId: string, handler: KernelHandler): void {
    if (!handlerId || !handlerId.trim()) {
      throw new KernelHandlerRegistrationError(handlerId, 'id must be non-empty');
    }
    if (typeof handler !== 'function') {
      throw new KernelHandlerRegistrationError(handlerId, 'handler must be a function');
    }
    const existing = this.handlers.get(handlerId);
    if (existing !== undefined && existing !== handler) {
      throw new KernelHandlerRegistrationError(
        handlerId,
        'already registered with a different handler instance',
      );
    }
    this.handlers.set(handlerId, handler);
  }

  /** Зарегистрировать несколько handler'ов пачкой. */
  registerAll(entries: Record<string, KernelHandler>): void {
    for (const [id, handler] of Object.entries(entries)) {
      this.register(id, handler);
    }
  }

  /** Возвращает handler или null. */
  get(handlerId: string): KernelHandler | null {
    return this.handlers.get(handlerId) ?? null;
  }

  /** Возвращает handler, throw если не зарегистрирован. */
  require(handlerId: string): KernelHandler {
    const handler = this.handlers.get(handlerId);
    if (!handler) {
      throw new KernelHandlerNotRegisteredError(handlerId);
    }
    return handler;
  }

  /** Покрыт ли handler id регистрацией. */
  has(handlerId: string): boolean {
    return this.handlers.has(handlerId);
  }

  /** Список всех зарегистрированных id. */
  list(): readonly string[] {
    return [...this.handlers.keys()];
  }
}
