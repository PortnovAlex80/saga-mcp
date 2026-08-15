import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteProcessProductRepositoryV2 } from '../process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteCandidateSetRepository } from '../infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import { writeProduct } from './universal-desk-helper.js';
import { projectDiscoveryProposal, requiresDiscoveryProjection } from '../modules/discovery/infrastructure/discovery-proposal-projection.js';
import { PROPOSAL_REF_SCHEMA } from '../modules/discovery/domain/proposal-ref-bridge.js';
import { isWorkplaceProductionSnapshot } from '../process-modules/shared/workplace-production-snapshot.js';
import { materializeManagedSourceChange } from '../infrastructure/source-change/managed-source-change-candidate.js';
import { materializeFormalizationSnapshot } from '../modules/formalization/application/formalization-snapshot-materializer.js';
import { withImmediateTransaction } from '../lifecycle/work-assignment-core.js';
import { recordFinalPresentationCommitment } from '../infrastructure/workplace/sqlite-final-presentation-commitment.js';
import { closeCommittedTypedPresentation } from '../application/final-presentation-closure.js';

let submissions: SqliteManagedNodeSubmissionRepository | null = null;
let products: SqliteProcessProductRepositoryV2 | null = null;
let candidates: SqliteCandidateSetRepository | null = null;
let revisions: SqliteWorkplaceProductionRevisionRepository | null = null;

function submissionRepo(): SqliteManagedNodeSubmissionRepository {
  return submissions ??= new SqliteManagedNodeSubmissionRepository(getDb());
}
function productRepo(): SqliteProcessProductRepositoryV2 {
  return products ??= new SqliteProcessProductRepositoryV2(getDb());
}
function candidateRepo(): SqliteCandidateSetRepository {
  return candidates ??= new SqliteCandidateSetRepository(getDb());
}
function revisionRepo(): SqliteWorkplaceProductionRevisionRepository {
  return revisions ??= new SqliteWorkplaceProductionRevisionRepository(getDb());
}

export function _resetProductToolRepositoriesForTests(): void {
  submissions = null;
  products = null;
  candidates = null;
  revisions = null;
}

const productSubmit: ToolHandler = args => {
  const schema = requiredString(args, 'schema');
  if (!Object.hasOwn(args, 'content')) throw new Error('content is required');
  // Validate the exact WorkIntent schema before a schema-specific materializer
  // can create a candidate commit/tree or touch any other capability target.
  // submitForCurrentExecution repeats the assertion atomically with storage.
  submissionRepo().assertSchemaForCurrentExecution(schema);
  let content = args.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* strings are legal products */ }
  }
  content = materializeManagedSourceChange(getDb(), schema, content);
  // GB-5/B: formalization bundles seal the factory-computed workplace
  // production snapshot (managed ledger), not the worker's raw payload.
  content = materializeFormalizationSnapshot(getDb(), schema, content);
  const committed = withImmediateTransaction(getDb(), () => {
    const result = submissionRepo().submitForCurrentExecution({ schema, payload: content });
    const universalRef = writeProduct(getDb(), {
      schemaRef: schema,
      content,
      executionRef: result.record.executionId,
      productKey: `content:${result.record.contentHash}`,
    });
    // Compatibility projections are part of the same source transaction as
    // the final-presentation commitment. A crash cannot expose a commitment
    // whose deterministic product projections are missing.
    let discoveryProjection: { proposalId: number; contentHash: string } | null = null;
    if (requiresDiscoveryProjection(schema)) {
      discoveryProjection = projectDiscoveryProposal(getDb(), {
        submissionId: result.record.submissionId,
      });
      if (discoveryProjection) {
        writeProduct(getDb(), {
          schemaRef: PROPOSAL_REF_SCHEMA,
          content: {
            proposalId: discoveryProjection.proposalId,
            contentHash: discoveryProjection.contentHash,
          },
          executionRef: result.record.executionId,
        });
      }
    }
    const commitment = recordFinalPresentationCommitment(getDb(), {
      taskId: result.record.taskId,
      executionId: result.record.executionId,
      productSchema: result.record.schema,
      productRef: result.record.artifactRef,
      productDigest: result.record.contentHash,
    });
    return { result, universalRef, discoveryProjection, commitment };
  });
  // Fast path. The durable obligation written above remains the crash/restart
  // owner; this synchronous attempt only avoids waiting for the next sweep.
  if (committed.commitment) {
    closeCommittedTypedPresentation(getDb(), committed.commitment.commitmentRef);
  }
  return {
    accepted: true,
    replayed: committed.result.replayed,
    product_ref: {
      schemaId: committed.result.record.schema,
      ref: committed.result.record.artifactRef,
      digest: committed.result.record.contentHash,
    },
    universal_ref: committed.universalRef,
    submission_id: committed.result.record.submissionId,
    process_run_id: committed.result.record.processRunId,
    module_ref: committed.result.record.moduleRef,
    node_id: committed.result.record.nodeId,
    execution_id: committed.result.record.executionId,
    discovery_proposal_id: committed.discoveryProjection?.proposalId ?? null,
    presentation_commitment_ref: committed.commitment?.commitmentRef ?? null,
    stop: committed.commitment !== null,
    _workflow_hint: committed.commitment
      ? 'Final presentation committed and closed by the Factory. Stop now; do not call more tools.'
      : 'Product sealed on the desk. Call worker_done exactly once.',
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
  const requestedRef = typeof args.candidate_set_ref === 'string'
    ? args.candidate_set_ref.trim()
    : '';
  let boundAuthorityRef = '';
  if (role === 'author') {
    const executionRef = process.env.SAGA_EXECUTION_ID;
    if (executionRef) {
      const row = getDb().prepare(
        `SELECT wi.authority_scope
           FROM worker_executions we
           JOIN tasks t ON t.id=we.task_id
           JOIN factory_work_intents wi
             ON wi.id=json_extract(t.metadata,'$.work_intent_id')
          WHERE we.execution_id=?`,
      ).get(executionRef) as { authority_scope: string } | undefined;
      if (row) {
        const scope = JSON.parse(row.authority_scope) as {
          payload_bindings?: Array<{ field?: unknown; equals?: unknown }>;
        };
        const binding = scope.payload_bindings?.find(item =>
          item.field === 'subject_candidate_set_ref');
        if (typeof binding?.equals === 'string') boundAuthorityRef = binding.equals;
      }
    }
  }
  if (boundAuthorityRef && requestedRef && requestedRef !== boundAuthorityRef) {
    throw new Error(
      `CANDIDATE_SET_AUTHORITY_MISMATCH: requested ${requestedRef}; `
      + `WorkIntent binds ${boundAuthorityRef}`,
    );
  }
  const authorityRef = boundAuthorityRef || requestedRef;
  const sets = candidateRepo().listForWorkplace(workplaceRef)
    .filter(set => set.role === role);
  if (sets.length === 0) throw new Error('CANDIDATE_SET_NOT_FOUND');
  const set = authorityRef
    ? sets.find(candidate => candidate.candidateSetRef === authorityRef)
    : undefined;
  if (!set) {
    throw new Error(
      authorityRef
        ? `CANDIDATE_SET_AUTHORITY_MISMATCH: ${authorityRef}`
        : 'CANDIDATE_SET_AUTHORITY_REQUIRED: provide candidate_set_ref or use the exact reviewer WorkIntent binding',
    );
  }

  // CandidateSet is the immutable QC handoff. Do NOT reconstruct its material
  // from presenter execution provenance or from the current live Workplace.
  // Read the exact sealed ProductRefs and, for managed-production members,
  // expose the artifact/trace snapshot persisted BEFORE CandidateSet sealing.
  const sealedProducts = set.members.map(member => {
    const productRef = member.productRef;
    if (productRef.ref.startsWith('managed-node-submission:')) {
      const id = Number(productRef.ref.slice('managed-node-submission:'.length));
      const row = getDb().prepare(
        `SELECT schema_version,payload_snapshot,content_hash
           FROM factory_managed_node_submissions WHERE id=?`,
      ).get(id) as {
        schema_version: string;
        payload_snapshot: string;
        content_hash: string;
      } | undefined;
      if (!row
          || row.schema_version !== productRef.schemaId
          || row.content_hash !== productRef.digest) {
        throw new Error(`CANDIDATE_PRODUCT_NOT_FOUND: ${productRef.ref}`);
      }
      return { productRef, content: JSON.parse(row.payload_snapshot) as unknown };
    }
    const row = productRepo().getByProductRef(productRef);
    if (!row) throw new Error(`CANDIDATE_PRODUCT_NOT_FOUND: ${productRef.ref}`);
    return { productRef, content: row.payload };
  });

  const managedSnapshots = sealedProducts
    .map(item => item.content)
    .filter(isWorkplaceProductionSnapshot);
  const artifacts = managedSnapshots.flatMap(snapshot => snapshot.artifacts);
  const traces = managedSnapshots.flatMap(snapshot => snapshot.traces);
  const revision = revisionRepo().getRevision(set.productionRevisionRef);
  if (!revision) {
    throw new Error(`CANDIDATE_REVISION_NOT_FOUND: ${set.productionRevisionRef}`);
  }

  return {
    candidate_set_ref: set.candidateSetRef,
    workplace_ref: serializedRef,
    role: set.role,
    production_revision_ref: set.productionRevisionRef,
    subject_candidate_set_ref: set.subjectCandidateSetRef,
    product_refs: set.members.map(member => member.productRef),
    produced_artifacts: artifacts,
    produced_traces: traces,
    contributing_execution_refs: revision.contributingExecutionRefs,
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
      'Read the immutable current CandidateSet for one exact Workplace and role. Managed-production details are derived from the exact sealed ProductRef snapshot, never from presenter execution or current live desk state.',
    annotations: { title: 'Factory: Read Candidate Set', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        workplace_ref: { type: 'string' },
        role: { type: 'string', enum: ['author', 'reviewer'] },
        candidate_set_ref: { type: 'string' },
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
