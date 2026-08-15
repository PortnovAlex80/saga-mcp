import type { HumanFlowNodeDefinition } from '../../domain/process-module.js';
import type { HumanInteractionRegistry } from '../human-interaction-registry.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';

/** Generic dispatch cell for module-registered durable human interactions. */
export class HumanNodeExecutor implements NodeExecutor {
  readonly kind = 'human' as const;

  constructor(private readonly registry: HumanInteractionRegistry) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = context.node as HumanFlowNodeDefinition;
    try {
      const adapter = this.registry.require(node.interactionContract.id);
      return await adapter({ ...context, node });
    } catch (error) {
      if (error instanceof NodeExecutionError) throw error;
      throw new NodeExecutionError(
        'human',
        node.id,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}
