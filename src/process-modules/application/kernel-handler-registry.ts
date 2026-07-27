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
import type { NodeExecutionFrame, NodeProduction } from './node-executor.js';

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
}

/**
 * Результат kernel handler'а. Kernel handler эмитит DOMAIN event (предметное
 * событие — accepted / go / clarify / ...) и возвращает durable production
 * (типизированную ссылку на продукцию). runtime-event всегда 'completed' для
 * kernel-узла, вернувшего нормально.
 */
export interface KernelHandlerResult {
  /** Domain event — drives transition selection. */
  event: string;
  /** Durable production reference (schema + artifactRef + contentHash + bindings). */
  production: NodeProduction;
  /** Optional standardized issue used by the generic recovery interpreter. */
  recoveryIssue?: RecoveryIssue;
  /** Для terminal-узлов: локальный outcome код (один из module.outcomes). */
  outcome?: string;
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
