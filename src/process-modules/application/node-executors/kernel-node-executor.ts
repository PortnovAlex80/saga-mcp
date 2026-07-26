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
import type { KernelHandlerRegistry } from '../kernel-handler-registry.js';
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
      const result = await handler({
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        processRunId: ctx.processRunId,
        node,
        input: ctx.input,
        initiatedBy: ctx.initiatedBy,
      });
      return {
        event: result.event,
        output: result.output,
        outcome: result.outcome,
      };
    } catch (err) {
      throw new NodeExecutionError('kernel', node.id, (err as Error).message, err);
    }
  }
}
