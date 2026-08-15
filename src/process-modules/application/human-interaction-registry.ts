import type { HumanFlowNodeDefinition } from '../domain/process-module.js';
import type {
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.js';

export interface HumanInteractionContext
  extends Omit<NodeExecutionContext, 'node'> {
  node: HumanFlowNodeDefinition;
}

/**
 * A human interaction adapter owns the durable request/decision store. A
 * pending decision returns runtime.paused; replay re-enters the same node and
 * resolves the exact input-bound decision.
 */
export type HumanInteractionAdapter = (
  context: HumanInteractionContext,
) => Promise<NodeExecutionResult> | NodeExecutionResult;

export class HumanInteractionNotRegisteredError extends Error {
  constructor(readonly contractId: string) {
    super(
      `human interaction '${contractId}' is not registered; `
      + 'composition must inject an explicit decision provider',
    );
    this.name = 'HumanInteractionNotRegisteredError';
  }
}

export class HumanInteractionRegistry {
  private readonly adapters = new Map<string, HumanInteractionAdapter>();

  register(contractId: string, adapter: HumanInteractionAdapter): void {
    if (!contractId.trim()) throw new Error('human interaction id must be non-empty');
    const existing = this.adapters.get(contractId);
    if (existing && existing !== adapter) {
      throw new Error(`human interaction '${contractId}' is already registered`);
    }
    this.adapters.set(contractId, adapter);
  }

  registerAll(adapters: Readonly<Record<string, HumanInteractionAdapter>>): void {
    for (const [id, adapter] of Object.entries(adapters)) this.register(id, adapter);
  }

  get(contractId: string): HumanInteractionAdapter | null {
    return this.adapters.get(contractId) ?? null;
  }

  require(contractId: string): HumanInteractionAdapter {
    const adapter = this.get(contractId);
    if (!adapter) throw new HumanInteractionNotRegisteredError(contractId);
    return adapter;
  }

  has(contractId: string): boolean {
    return this.adapters.has(contractId);
  }

  list(): readonly string[] {
    return [...this.adapters.keys()];
  }
}
