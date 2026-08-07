import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteProcessProductRepositoryV2 } from '../process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteCandidateSetRepository } from '../infrastructure/workplace/sqlite-candidate-set-repository.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import { writeProduct } from './universal-desk-helper.js';

let submissions: SqliteManagedNodeSubmissionRepository | null = null;
let products: SqliteProcessProductRepositoryV2 | null = null;
let candidates: SqliteCandidateSetRepository | null = null;

function submissionRepo(): SqliteManagedNodeSubmissionRepository {
  return submissions ??= new SqliteManagedNodeSubmissionRepository(getDb());
}
function productRepo(): SqliteProcessProductRepositoryV2 {
  return products ??= new SqliteProcessProductRepositoryV2(getDb());
}
function candidateRepo(): SqliteCandidateSetRepository {
  return candidates ??= new SqliteCandidateSetRepository(getDb());
}

export function _resetProductToolRepositoriesForTests(): void {
  submissions = null;
  products = null;
  candidates = null;
}

const productSubmit: ToolHandler = args => {
  const schema = requiredString(args, 'schema');
  if (!Object.hasOwn(args, 'content')) throw new Error('content is required');
  let content = args.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* strings are legal products */ }
  }
  const result = submissionRepo().submitForCurrentExecution({ schema, payload: content });
  const universalRef = writeProduct(getDb(), {
    schemaRef: schema,
    content,
    executionRef: result.record.executionId,
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
    submission_id: result.record.submissionId,
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
      `SELECT process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
              schema_version,payload_snapshot,content_hash,submitted_at
         FROM factory_managed_node_submissions WHERE id=?`,
    ).get(id) as {
      process_run_id: number;
      module_ref: string;
      node_id: string;
      intent_id: number;
      task_id: number;
      execution_id: string;
      schema_version: string;
      payload_snapshot: string;
      content_hash: string;
      submitted_at: string;
    } | undefined;
    if (!row || row.schema_version !== schemaId || row.content_hash !== digest) {
      throw new Error('PRODUCT_NOT_FOUND');
    }
    return {
      product_ref: { schemaId, ref, digest },
      submission_id: id,
      process_run_id: row.process_run_id,
      module_ref: row.module_ref,
      node_id: row.node_id,
      intent_id: row.intent_id,
      task_id: row.task_id,
      execution_id: row.execution_id,
      submitted_at: row.submitted_at,
      content: JSON.parse(row.payload_snapshot),
    };
  }

  const row = productRepo().getByProductRef({ schemaId, ref, digest });
  if (!row) throw new Error('PRODUCT_NOT_FOUND');
  return { product_ref: { schemaId, ref, digest }, content: row.payload };
};

const candidateRead: ToolHandler = args => {
  const serializedRef = requiredString(args, 'workplace_ref');
  const workplaceRef = deserializeWorkplaceRef(serializedRef);
  const role = requiredString(args, 'role');
  if (role !== 'author' && role !== 'reviewer') {
    throw new Error('role must be author|reviewer');
  }
  const sets = candidateRepo().listForWorkplace(workplaceRef)
    .filter(set => set.role === role);
  if (sets.length === 0) throw new Error('CANDIDATE_SET_NOT_FOUND');
  const set = sets[0]!;
  const db = getDb();
  const artifacts = db.prepare(
    `SELECT artifact_id,artifact_type,content_hash,operation
       FROM factory_managed_artifact_productions
      WHERE process_run_id=? AND execution_id=?
      ORDER BY id`,
  ).all(workplaceRef.processRunId, set.producerExecutionRef) as Array<{
    artifact_id: number;
    artifact_type: string;
    content_hash: string | null;
    operation: string;
  }>;
  const traces = db.prepare(
    `SELECT trace_id,source_id,target_type,target_id,link_type,trace_hash
       FROM factory_managed_trace_productions
      WHERE process_run_id=? AND execution_id=?
      ORDER BY id`,
  ).all(workplaceRef.processRunId, set.producerExecutionRef) as Array<{
    trace_id: number;
    source_id: number;
    target_type: string;
    target_id: number;
    link_type: string;
    trace_hash: string;
  }>;
  return {
    candidate_set_ref: set.candidateSetRef,
    workplace_ref: serializedRef,
    role: set.role,
    producer_execution_ref: set.producerExecutionRef,
    subject_candidate_set_ref: set.subjectCandidateSetRef,
    product_refs: set.members.map(member => member.productRef),
    produced_artifacts: artifacts,
    produced_traces: traces,
    candidate_set_digest: set.candidateSetDigest,
    sealed_at: set.sealedAt,
  };
};

export const definitions: Tool[] = [
  {
    name: 'product_submit',
    description:
      'Submit one immutable typed product for the current fenced Production Cell execution. Process/module/node/task/execution identity is derived by the server; callers provide only schema and content.',
    annotations: { title: 'Factory: Submit Product', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { schema: { type: 'string' }, content: {} },
      required: ['schema', 'content'],
    },
  },
  {
    name: 'product_read',
    description:
      'Read one immutable product by the exact ProductRef triple returned by the factory. No latest/by-task fallback is allowed.',
    annotations: { title: 'Factory: Read Product', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        schema_id: { type: 'string' }, ref: { type: 'string' }, digest: { type: 'string' },
      },
      required: ['schema_id', 'ref', 'digest'],
    },
  },
  {
    name: 'candidate_read',
    description:
      'Read the immutable current CandidateSet for one exact Workplace and role, including exact artifact/trace productions of its producer execution.',
    annotations: { title: 'Factory: Read Candidate Set', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        workplace_ref: { type: 'string' },
        role: { type: 'string', enum: ['author', 'reviewer'] },
      },
      required: ['workplace_ref', 'role'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  product_submit: productSubmit,
  product_read: productRead,
  candidate_read: candidateRead,
};

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
