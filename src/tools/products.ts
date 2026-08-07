import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import {
  SqliteProcessProductRepositoryV2,
} from '../process-modules/persistence/sqlite-process-product-repository-v2.js';
import { writeProduct } from './universal-desk-helper.js';

let submissions: SqliteManagedNodeSubmissionRepository | null = null;
let products: SqliteProcessProductRepositoryV2 | null = null;

function submissionRepo(): SqliteManagedNodeSubmissionRepository {
  return submissions ??= new SqliteManagedNodeSubmissionRepository(getDb());
}
function productRepo(): SqliteProcessProductRepositoryV2 {
  return products ??= new SqliteProcessProductRepositoryV2(getDb());
}

export function _resetProductToolRepositoriesForTests(): void {
  submissions = null;
  products = null;
}

const productSubmit: ToolHandler = args => {
  const schema = requiredString(args, 'schema');
  if (!Object.hasOwn(args, 'content')) throw new Error('content is required');
  let content = args.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* strings are legal products */ }
  }
  const result = submissionRepo().submitForCurrentExecution({
    schema,
    payload: content,
  });
  // Keep the universal content-addressed store populated for exact downstream
  // reads and lifecycle handoff. The execution-scoped submission row remains
  // the fence/audit index; both point at the same immutable bytes.
  const universalRef = writeProduct(getDb(), {
    schemaRef: schema,
    content,
    executionRef: result.record.executionId ?? 'system',
    productKey: `content:${result.record.contentHash}`,
  });
  return {
    accepted: true,
    replayed: result.replayed,
    product_ref: {
      schemaId: result.record.schema,
      ref: result.record.artifactRef,
      digest: result.record.contentHash,
    },
    universal_ref: universalRef,
    process_run_id: result.record.processRunId,
    module_ref: result.record.moduleRef,
    node_id: result.record.nodeId,
    execution_id: result.record.executionId,
    _workflow_hint: 'Product sealed on the desk. Call worker_done exactly once.',
  };
};

const productRead: ToolHandler = args => {
  const schemaId = requiredString(args, 'schema_id');
  const ref = requiredString(args, 'ref');
  const digest = requiredString(args, 'digest');

  if (ref.startsWith('managed-node-submission:')) {
    const id = Number(ref.slice('managed-node-submission:'.length));
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('PRODUCT_REF_INVALID');
    const row = getDb().prepare(
      `SELECT schema_version,payload_snapshot,content_hash
         FROM factory_managed_node_submissions WHERE id=?`,
    ).get(id) as {
      schema_version: string;
      payload_snapshot: string;
      content_hash: string;
    } | undefined;
    if (!row || row.schema_version !== schemaId || row.content_hash !== digest) {
      throw new Error('PRODUCT_NOT_FOUND');
    }
    return {
      product_ref: { schemaId, ref, digest },
      content: JSON.parse(row.payload_snapshot),
    };
  }

  const row = productRepo().getByProductRef({ schemaId, ref, digest });
  if (!row) throw new Error('PRODUCT_NOT_FOUND');
  return {
    product_ref: { schemaId, ref, digest },
    content: row.payload,
  };
};

export const definitions: Tool[] = [
  {
    name: 'product_submit',
    description:
      'Submit one immutable typed product for the current fenced Production Cell execution. Process/module/node/task/execution identity is derived by the server; callers provide only schema and content.',
    annotations: {
      title: 'Factory: Submit Product',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        content: {},
      },
      required: ['schema', 'content'],
    },
  },
  {
    name: 'product_read',
    description:
      'Read one immutable product by the exact ProductRef triple returned by the factory. No latest/by-task fallback is allowed.',
    annotations: {
      title: 'Factory: Read Product',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        schema_id: { type: 'string' },
        ref: { type: 'string' },
        digest: { type: 'string' },
      },
      required: ['schema_id', 'ref', 'digest'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  product_submit: productSubmit,
  product_read: productRead,
};

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}
