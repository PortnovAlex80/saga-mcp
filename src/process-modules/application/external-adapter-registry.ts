import type { ExternalFlowNodeDefinition } from '../domain/process-module.js';
import type {
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.js';

export interface ExternalAdapterContext
  extends Omit<NodeExecutionContext, 'node'> {
  node: ExternalFlowNodeDefinition;
}

/**
 * Module-supplied adapter for one declared external node. The adapter owns its
 * durable provider protocol and returns a content-addressed NodeProduction;
 * the generic runtime only dispatches it.
 */
export type ExternalAdapter = (
  context: ExternalAdapterContext,
) => Promise<NodeExecutionResult> | NodeExecutionResult;

export class ExternalAdapterNotRegisteredError extends Error {
  constructor(readonly adapterId: string) {
    super(
      `external adapter '${adapterId}' is not registered; `
      + 'composition must inject an explicit provider',
    );
    this.name = 'ExternalAdapterNotRegisteredError';
  }
}

export class ExternalAdapterRegistry {
  private readonly adapters = new Map<string, ExternalAdapter>();

  register(adapterId: string, adapter: ExternalAdapter): void {
    if (!adapterId.trim()) throw new Error('external adapter id must be non-empty');
    const existing = this.adapters.get(adapterId);
    if (existing && existing !== adapter) {
      throw new Error(`external adapter '${adapterId}' is already registered`);
    }
    this.adapters.set(adapterId, adapter);
  }

  registerAll(adapters: Readonly<Record<string, ExternalAdapter>>): void {
    for (const [id, adapter] of Object.entries(adapters)) this.register(id, adapter);
  }

  get(adapterId: string): ExternalAdapter | null {
    return this.adapters.get(adapterId) ?? null;
  }

  require(adapterId: string): ExternalAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) throw new ExternalAdapterNotRegisteredError(adapterId);
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  list(): readonly string[] {
    return [...this.adapters.keys()];
  }
}
