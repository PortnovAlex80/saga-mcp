import type { ExternalFlowNodeDefinition } from '../../domain/process-module.js';
import type { ExternalAdapterRegistry } from '../external-adapter-registry.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';

/** Generic dispatch cell for module-registered external providers. */
export class ExternalNodeExecutor implements NodeExecutor {
  readonly kind = 'external' as const;

  constructor(private readonly registry: ExternalAdapterRegistry) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = context.node as ExternalFlowNodeDefinition;
    try {
      const adapter = this.registry.require(node.adapter);
      return await adapter({ ...context, node });
    } catch (error) {
      if (error instanceof NodeExecutionError) throw error;
      throw new NodeExecutionError(
        'external',
        node.id,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}
