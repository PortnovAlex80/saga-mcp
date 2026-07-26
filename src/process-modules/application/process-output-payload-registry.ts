import type { ProcessModuleReference } from '../domain/process-module.js';
import type { ProcessModuleOutput } from '../persistence/process-run.js';
import { sha256Hex } from '../shared/canonical-json.js';

export interface ProcessOutputPayloadResolutionContext {
  processRunId: number;
  moduleRef: ProcessModuleReference;
  projectId: number;
  epicId: number | null;
  output: ProcessModuleOutput;
}

export type ProcessOutputPayloadResolver = (
  context: ProcessOutputPayloadResolutionContext,
) => Promise<unknown> | unknown;

/**
 * Schema-keyed, module-supplied dereferencers for lifecycle handoffs.
 *
 * The lifecycle core never knows how a SolutionContract or release bundle is
 * stored. It asks the registered resolver for the exact ref, then independently
 * checks the canonical hash before mappings may read the payload.
 */
export class ProcessOutputPayloadRegistry {
  private readonly resolvers = new Map<string, ProcessOutputPayloadResolver>();

  register(schema: string, resolver: ProcessOutputPayloadResolver): void {
    if (!schema.trim()) throw new Error('process output schema must be non-empty');
    const existing = this.resolvers.get(schema);
    if (existing && existing !== resolver) {
      throw new Error(`process output resolver for '${schema}' is already registered`);
    }
    this.resolvers.set(schema, resolver);
  }

  has(schema: string): boolean {
    return this.resolvers.has(schema);
  }

  async resolve(
    context: ProcessOutputPayloadResolutionContext,
  ): Promise<unknown> {
    const resolver = this.resolvers.get(context.output.schema);
    if (!resolver) {
      throw new Error(
        `process output resolver for schema '${context.output.schema}' is not registered`,
      );
    }
    const payload = await resolver(context);
    const actualHash = sha256Hex(payload);
    if (actualHash !== context.output.contentHash) {
      throw new Error(
        `PROCESS_OUTPUT_PAYLOAD_HASH_MISMATCH: '${context.output.artifactRef}' `
        + `resolved to '${actualHash}', expected '${context.output.contentHash}'`,
      );
    }
    return payload;
  }

  listSchemas(): readonly string[] {
    return [...this.resolvers.keys()];
  }
}
