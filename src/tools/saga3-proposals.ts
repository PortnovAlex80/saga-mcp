import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} from '../saga3/domain/work-intent.js';
import {
  DISCOVERY_PROPOSAL_SCHEMA,
  validateDiscoveryProposal,
} from '../saga3/domain/discovery-proposal.js';
import type {
  ProposalProvenance,
  SubmitProposal,
} from '../saga3/domain/proposal.js';
import { Saga3ProposalRepository } from '../saga3/persistence/saga3-proposal-repository.js';
import type { WorkerModelRoute } from '../application/ports/worker-executor.js';

/**
 * Per-kind (kind, output_schema) → (proposal_schema_version, validator) map.
 *
 * The kernel owns the contract version, not the worker. proposal_submit rejects
 * any submission whose schema_version does not match the registered one. D1
 * supports only kind='discovery'; later stages register their own entries.
 */
const PROPOSAL_CONTRACTS = {
  [DISCOVERY_INTENT_KIND]: {
    intent_output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
    proposal_schema_version: DISCOVERY_PROPOSAL_SCHEMA,
    validate: validateDiscoveryProposal,
  },
} as const;

/**
 * Reads the model route for an epic (model/provider/effort) so the handler can
 * capture provenance automatically. Injected from the composition root; in D1
 * it is wired to the shared SqliteEpisodeRuntimeRepository reader.
 */
export type ModelRouteForProposal = (epicId: number) => WorkerModelRoute;

export interface Saga3ProposalHandlersOptions {
  /** Repository for saga3_work_intents + saga3_proposals. */
  repository?: Saga3ProposalRepository;
  /** Reads model route for provenance capture. Defaults to DB-direct read. */
  modelRoute?: ModelRouteForProposal;
}

const defaultModelRoute: ModelRouteForProposal = epicId => {
  const db = getDb();
  const row = db.prepare(
    `SELECT json_extract(metadata, '$.active_model') AS m,
            json_extract(metadata, '$.active_provider') AS p,
            json_extract(metadata, '$.active_model_effort') AS e
       FROM episode_workflows WHERE epic_id=?`,
  ).get(epicId) as { m: string | null; p: string | null; e: string | null } | undefined;
  return {
    model: row?.m ?? null,
    provider: row?.p ?? 'zai',
    effort: row?.e ?? null,
  };
};

/**
 * proposal_submit — the Saga 3 product-worker submission boundary.
 *
 * Roadmap §7.3 + §7.4. The worker submits ONLY the semantic payload; this
 * handler:
 *   1. verifies the WorkIntent exists and matches the claimed kind;
 *   2. verifies the task is the projected board task for that intent;
 *   3. verifies the execution fence (task.current_execution_id === execution_id
 *      AND a live worker_executions row for this execution owns the task);
 *   4. verifies the payload matches the registered schema version for its kind;
 *   5. validates the payload structurally (deterministic, no LM);
 *   6. computes the content hash from the canonical JSON encoding;
 *   7. captures provenance automatically (model/provider/effort/worker/exec/time)
 *      — the worker never supplies these;
 *   8. persists the proposal and returns proposal_id + content_hash.
 *
 * The authoritative outcome is NOT produced here. D1's engine records only a
 * PROVISIONAL outcome (outcomeAuthority='worker_proposal'); D4 settlement makes
 * it authoritative.
 */
export function createSaga3ProposalHandlers(
  options: Saga3ProposalHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const repository = options.repository ?? new Saga3ProposalRepository();
  const modelRoute = options.modelRoute ?? defaultModelRoute;

  const handleSubmitProposal: ToolHandler = args => {
    const submission = readSubmission(args);
    const db = getDb();

    // 1. Intent exists + kind matches a registered contract.
    const contract = PROPOSAL_CONTRACTS[submission.kind as keyof typeof PROPOSAL_CONTRACTS];
    if (!contract) {
      throw new Error(`proposal_submit: unsupported kind '${submission.kind}'`);
    }
    if (submission.schema_version !== contract.proposal_schema_version) {
      throw new Error(
        `proposal_submit: schema_version mismatch — expected '${contract.proposal_schema_version}' for kind '${submission.kind}', got '${submission.schema_version}'`,
      );
    }
    const intent = repository.readWorkIntent(submission.intent_id);
    if (!intent) {
      throw new Error(`proposal_submit: WorkIntent ${submission.intent_id} not found`);
    }
    if (intent.kind !== submission.kind) {
      throw new Error(
        `proposal_submit: intent ${submission.intent_id} has kind '${intent.kind}', cannot accept '${submission.kind}' proposal`,
      );
    }
    if (intent.output_schema !== contract.intent_output_schema) {
      throw new Error(
        `proposal_submit: intent ${submission.intent_id} output_schema '${intent.output_schema}' does not match registered '${contract.intent_output_schema}'`,
      );
    }

    // 2. Task is the projected board task for this intent.
    if (intent.projected_task_id !== submission.task_id) {
      throw new Error(
        `proposal_submit: task ${submission.task_id} is not the projected task for intent ${submission.intent_id} (expected ${intent.projected_task_id ?? 'none'})`,
      );
    }

    // 3. Execution fence: task.current_execution_id must match AND a live
    //    worker_executions row for this execution must own the task.
    const task = db.prepare(
      `SELECT current_execution_id, status FROM tasks WHERE id=?`,
    ).get(submission.task_id) as { current_execution_id: string | null; status: string } | undefined;
    if (!task) {
      throw new Error(`proposal_submit: task ${submission.task_id} not found`);
    }
    if (!task.current_execution_id || task.current_execution_id !== submission.execution_id) {
      throw new Error(
        `proposal_submit: execution fence failed — task ${submission.task_id} current_execution_id is '${task.current_execution_id}', expected '${submission.execution_id}'`,
      );
    }
    const exec = db.prepare(
      `SELECT worker_id, state, project_id, epic_id FROM worker_executions WHERE execution_id=?`,
    ).get(submission.execution_id) as {
      worker_id: string; state: string; project_id: number; epic_id: number;
    } | undefined;
    if (!exec || exec.state === 'exited' || exec.state === 'spawn_failed' || exec.state === 'lost' || exec.state === 'terminated') {
      throw new Error(
        `proposal_submit: execution ${submission.execution_id} is not live (state=${exec?.state ?? 'missing'})`,
      );
    }

    // 4+5. Schema version already checked (step 1); now structural validation.
    const validation = contract.validate(submission.payload);
    if (!validation.valid) {
      throw new Error(
        `proposal_submit: payload validation failed — ${validation.errors.join('; ')}`,
      );
    }

    // 7. Capture provenance automatically. The worker never supplies this.
    const route = modelRoute(exec.epic_id);
    const provenance: ProposalProvenance = {
      model: route.model,
      provider: route.provider,
      effort: route.effort,
      worker_id: exec.worker_id,
      execution_id: submission.execution_id,
      submitted_at: new Date().toISOString(),
    };

    // 6 + 8. Hash + persist.
    const result = repository.recordProposal(submission, provenance);

    // Surface proposal_id + status on the task so the frontend can show it
    // without a separate query (roadmap §10 visibility — task-comment style).
    db.prepare(
      `INSERT INTO comments (task_id, author, content)
       VALUES (?, 'saga3-kernel', ?)`,
    ).run(
      submission.task_id,
      `Proposal submitted: id=${result.proposal_id} hash=${result.content_hash.slice(0, 12)}… status=${result.status}`,
    );

    return result;
  };

  return {
    definitions: [
      {
        name: 'proposal_submit',
        description:
          'Saga 3 product-worker submission boundary. Submit a typed Proposal (semantic payload only) against a WorkIntent. The kernel validates intent/task linkage, the execution fence, the payload schema, then records the proposal with automatically captured provenance (model/provider/effort/worker/execution). The worker must NOT supply provenance — only the payload. Call this from the assigned task, then call worker_done. Returns { proposal_id, content_hash, status }.',
        annotations: {
          title: 'Saga3: Submit Proposal',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: {
          type: 'object',
          required: ['intent_id', 'task_id', 'execution_id', 'kind', 'schema_version', 'payload'],
          properties: {
            intent_id: {
              type: 'integer',
              description: 'The WorkIntent this proposal answers. Find it in the task metadata (work_intent_id).',
            },
            task_id: {
              type: 'integer',
              description: 'The assigned task projected from the WorkIntent. Must equal the task you are running.',
            },
            execution_id: {
              type: 'string',
              description: 'Your execution fence id (from the worker_next assignment). Must match task.current_execution_id.',
            },
            kind: {
              type: 'string',
              enum: [DISCOVERY_INTENT_KIND],
              description: `Proposal kind. D1 supports only '${DISCOVERY_INTENT_KIND}'.`,
            },
            schema_version: {
              type: 'string',
              enum: [DISCOVERY_PROPOSAL_SCHEMA],
              description: `Contract version, owned by the kernel. For discovery use '${DISCOVERY_PROPOSAL_SCHEMA}'.`,
            },
            payload: {
              type: 'object',
              description:
                'Semantic payload only (provenance is auto-captured). For discovery: problem_statement, observed_context, stakeholders_or_actors[], assumptions[], unknowns[], risks[], candidate_scope, evidence_refs[], recommended_outcome (go|clarify|reject|defer|inconclusive|failed), rationale.',
            },
          },
        },
      },
    ],
    handlers: {
      proposal_submit: handleSubmitProposal,
    },
  };
}

function readSubmission(args: Record<string, unknown>): SubmitProposal {
  const intentId = args.intent_id as number;
  const taskId = args.task_id as number;
  const executionId = args.execution_id as string;
  const kind = args.kind as string;
  const schemaVersion = args.schema_version as string;
  const payload = args.payload;
  if (!Number.isInteger(intentId)) throw new Error('proposal_submit: intent_id must be an integer');
  if (!Number.isInteger(taskId)) throw new Error('proposal_submit: task_id must be an integer');
  if (typeof executionId !== 'string' || executionId === '') throw new Error('proposal_submit: execution_id must be a non-empty string');
  if (typeof kind !== 'string') throw new Error('proposal_submit: kind must be a string');
  if (typeof schemaVersion !== 'string') throw new Error('proposal_submit: schema_version must be a string');
  if (payload === undefined) throw new Error('proposal_submit: payload is required');
  return { intent_id: intentId, task_id: taskId, execution_id: executionId, kind, schema_version: schemaVersion, payload };
}
