/** Execute package-installed deterministic kernel handlers. */

import type { KernelFlowNodeDefinition } from '../../domain/process-module.js';
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
        frame: ctx.frame,
        heartbeat: ctx.heartbeat,
        initiatedBy: ctx.initiatedBy,
        nodeProducts: ctx.nodeProducts,
      });
      return {
        runtimeEvent: result.runtimeEvent ?? 'completed',
        domainEvent: result.runtimeEvent === 'paused' ? undefined : result.event,
        production: result.production,
        recoveryIssue: result.recoveryIssue,
        outcome: result.outcome,
        completion: result.completion,
      };
    } catch (error) {
      throw new NodeExecutionError('kernel', node.id, (error as Error).message, error);
    }
  }
}
