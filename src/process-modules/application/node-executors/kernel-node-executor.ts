/**
 * KernelNodeExecutor — NodeExecutor для kernel-узлов.
 *
 * Dispatcher: ищет handler по `node.handler` в KernelHandlerRegistry и вызывает
 * его. Сам executor не знает ни одного handler'а — все они регистрируются
 * модулем при установке (кроме `process-outcome-emitter`, который регистрирует
 * сам runtime). Это и есть граница: kernel content = модуль, kernel mechanics =
 * этот executor + registry.
 */

import type {
  KernelFlowNodeDefinition,
} from '../../domain/process-module.js';
import type { KernelHandlerRegistry, KernelHandlerResult } from '../kernel-handler-registry.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';

export class KernelNodeExecutor implements NodeExecutor {
  readonly kind = 'kernel' as const;

  constructor(private readonly handlerRegistry: KernelHandlerRegistry) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = ctx.node as KernelFlowNodeDefinition;
    const handler = this.handlerRegistry.require(node.handler);
    try {
      const result: KernelHandlerResult = await handler({
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        processRunId: ctx.processRunId,
        node,
        input: ctx.input,
        frame: ctx.frame,
        heartbeat: ctx.heartbeat,
        initiatedBy: ctx.initiatedBy,
      });
      // Kernel handlers emit DOMAIN events (accepted / go / clarify / ...).
      // runtimeEvent is always 'completed' for a kernel node that returned
      // normally; a handler that wants to signal failure throws.
      return {
        runtimeEvent: 'completed',
        domainEvent: result.event,
        production: result.production,
        outcome: result.outcome,
      };
    } catch (err) {
      throw new NodeExecutionError('kernel', node.id, (err as Error).message, err);
    }
  }
}
