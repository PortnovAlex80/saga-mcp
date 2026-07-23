import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { withImmediateTransaction } from './dispatcher.js';
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
  SubmittedProposalResult,
} from '../saga3/domain/proposal.js';
import { canonicalJson } from '../saga3/persistence/saga3-proposal-repository.js';

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

export interface Saga3ProposalHandlersOptions {
  /** Override the DB handle (test seam). Defaults to the saga singleton. */
  db?: () => ReturnType<typeof getDb>;
  /** Override now() (test seam). */
  now?: () => Date;
}

/** Result including a replay flag for idempotent re-submission. */
export interface SubmittedProposalResultWithReplay extends SubmittedProposalResult {
  replayed: boolean;
}

/**
 * proposal_submit — the Saga 3 product-worker submission boundary.
 *
 * Roadmap §7.3 + §7.4. The worker submits ONLY the semantic payload; this
 * handler is ATOMIC and IDEMPOTENT:
 *
 *   - ATOMIC: every check (intent, task, execution fence, schema, payload
 *     validation) and every write (proposal insert + visibility comment) runs
 *     inside one BEGIN IMMEDIATE transaction. A crash between the proposal
 *     insert and the comment cannot leave a proposal without visibility.
 *   - IDEMPOTENT: a UNIQUE(intent_id, execution_id, content_hash) index means
 *     replaying the exact same submission returns the existing proposal with
 *     replayed=true. A corrected payload has a different content_hash and
 *     inserts normally (the engine reads the latest by id).
 *
 * Provenance is captured from the worker_executions row's launch-time snapshot
 * (recorded at claim time by dispatcher.findNextClaimable), NOT from the
 * current episode config — so a mid-run /api/model/set does not retroactively
 * change the provenance of a worker that started under the old model.
 *
 * The execution fence is strict: execution.task_id == submission.task_id AND
 * execution.epic_id == intent.epic_id AND execution.state IN ('reserved',
 * 'running'). cancel_requested and any terminal state are rejected — a worker
 * asked to stop cannot legitimately submit.
 *
 * The authoritative outcome is NOT produced here. D1's engine records only a
 * PROVISIONAL outcome (outcomeAuthority='worker_proposal'); D4 settlement makes
 * it authoritative.
 */
export function createSaga3ProposalHandlers(
  options: Saga3ProposalHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const getDbFn = options.db ?? getDb;
  const now = options.now ?? (() => new Date());

  const handleSubmitProposal: ToolHandler = args => {
    const submission = readSubmission(args);

    // Schema-version + contract gate first (no DB needed). The kernel owns the
    // contract version — a mismatch is rejected before touching the fence.
    const contract = PROPOSAL_CONTRACTS[submission.kind as keyof typeof PROPOSAL_CONTRACTS];
    if (!contract) {
      throw new Error(`proposal_submit: unsupported kind '${submission.kind}'`);
    }
    if (submission.schema_version !== contract.proposal_schema_version) {
      throw new Error(
        `proposal_submit: schema_version mismatch — expected '${contract.proposal_schema_version}' for kind '${submission.kind}', got '${submission.schema_version}'`,
      );
    }

    return withImmediateTransaction(getDbFn(), () => {
      const db = getDbFn();

      // 1. Intent exists + kind matches + output_schema matches the contract.
      const intentRow = db.prepare(
        `SELECT id, kind, output_schema, projected_task_id, epic_id FROM saga3_work_intents WHERE id=?`,
      ).get(submission.intent_id) as {
        id: number; kind: string; output_schema: string;
        projected_task_id: number | null; epic_id: number;
      } | undefined;
      if (!intentRow) {
        throw new Error(`proposal_submit: WorkIntent ${submission.intent_id} not found`);
      }
      if (intentRow.kind !== submission.kind) {
        throw new Error(
          `proposal_submit: intent ${submission.intent_id} has kind '${intentRow.kind}', cannot accept '${submission.kind}' proposal`,
        );
      }
      if (intentRow.output_schema !== contract.intent_output_schema) {
        throw new Error(
          `proposal_submit: intent ${submission.intent_id} output_schema '${intentRow.output_schema}' does not match registered '${contract.intent_output_schema}'`,
        );
      }

      // 2. Task is the projected board task for this intent.
      if (intentRow.projected_task_id !== submission.task_id) {
        throw new Error(
          `proposal_submit: task ${submission.task_id} is not the projected task for intent ${submission.intent_id} (expected ${intentRow.projected_task_id ?? 'none'})`,
        );
      }

      // 3. Execution fence — strict matching, no denylist.
      const taskRow = db.prepare(
        `SELECT current_execution_id FROM tasks WHERE id=?`,
      ).get(submission.task_id) as { current_execution_id: string | null } | undefined;
      if (!taskRow) {
        throw new Error(`proposal_submit: task ${submission.task_id} not found`);
      }
      if (!taskRow.current_execution_id || taskRow.current_execution_id !== submission.execution_id) {
        throw new Error(
          `proposal_submit: execution fence failed — task ${submission.task_id} current_execution_id is '${taskRow.current_execution_id}', expected '${submission.execution_id}'`,
        );
      }
      const execRow = db.prepare(
        `SELECT worker_id, state, task_id, epic_id, metadata FROM worker_executions WHERE execution_id=?`,
      ).get(submission.execution_id) as {
        worker_id: string; state: string; task_id: number; epic_id: number; metadata: string;
      } | undefined;
      if (!execRow) {
        throw new Error(
          `proposal_submit: execution ${submission.execution_id} not found`,
        );
      }
      // Strict fence: the execution must own THIS task and THIS episode, and be
      // live (reserved or running only). cancel_requested and terminal states
      // are rejected.
      if (execRow.task_id !== submission.task_id) {
        throw new Error(
          `proposal_submit: execution ${submission.execution_id} owns task ${execRow.task_id}, not ${submission.task_id}`,
        );
      }
      if (execRow.epic_id !== intentRow.epic_id) {
        throw new Error(
          `proposal_submit: execution ${submission.execution_id} belongs to epic ${execRow.epic_id}, intent belongs to epic ${intentRow.epic_id}`,
        );
      }
      if (execRow.state !== 'reserved' && execRow.state !== 'running') {
        throw new Error(
          `proposal_submit: execution ${submission.execution_id} is not live (state='${execRow.state}'); only reserved/running may submit`,
        );
      }

      // 4. Structural payload validation (deterministic, no LM).
      const validation = contract.validate(submission.payload);
      if (!validation.valid) {
        throw new Error(
          `proposal_submit: payload validation failed — ${validation.errors.join('; ')}`,
        );
      }

      // 5. Provenance from the launch-time snapshot captured at claim. Falls
      //    back to a legacy empty snapshot (older executions without metadata)
      //    rather than re-reading mutable episode config.
      const snapshot = parseLaunchSnapshot(execRow.metadata);
      const provenance: ProposalProvenance = {
        model: snapshot.model,
        provider: snapshot.provider,
        effort: snapshot.effort,
        worker_id: execRow.worker_id,
        execution_id: submission.execution_id,
        submitted_at: now().toISOString(),
      };

      // 6. Hash + idempotent insert (within this same transaction).
      const payloadJson = canonicalJson(submission.payload);
      const contentHash = createHash('sha256').update(payloadJson).digest('hex');

      // ON CONFLICT DO NOTHING: an exact replay returns the existing row.
      const insertInfo = db.prepare(
        `INSERT INTO saga3_proposals
           (intent_id, task_id, execution_id, kind, schema_version,
            payload, content_hash, status, provenance)
         VALUES (?,?,?,?,?,?,?, 'submitted', ?)
         ON CONFLICT(intent_id, execution_id, content_hash) DO NOTHING`,
      ).run(
        submission.intent_id,
        submission.task_id,
        submission.execution_id,
        submission.kind,
        submission.schema_version,
        payloadJson,
        contentHash,
        JSON.stringify(provenance),
      );

      let proposalId: number;
      let replayed: boolean;
      if (insertInfo.changes === 1) {
        proposalId = Number(insertInfo.lastInsertRowid);
        replayed = false;
      } else {
        // Conflict: fetch the existing row for the exact same key.
        const existing = db.prepare(
          `SELECT id FROM saga3_proposals
            WHERE intent_id=? AND execution_id=? AND content_hash=?`,
        ).get(submission.intent_id, submission.execution_id, contentHash) as
          | { id: number }
          | undefined;
        proposalId = existing!.id;
        replayed = true;
      }

      // 7. Visibility comment — ONLY on a fresh insert. The handler is marked
      //    idempotentHint: true, so its side effects must be idempotent too: a
      //    replay must not create a duplicate visibility comment (review P1).
      if (!replayed) {
        db.prepare(
          `INSERT INTO comments (task_id, author, content)
           VALUES (?, 'saga3-kernel', ?)`,
        ).run(
          submission.task_id,
          `Proposal submitted: id=${proposalId} hash=${contentHash.slice(0, 12)}… status=submitted`,
        );
      }

      const result: SubmittedProposalResultWithReplay = {
        proposal_id: proposalId,
        content_hash: contentHash,
        status: 'submitted',
        replayed,
      };
      return result;
    });
  };

  return {
    definitions: [
      {
        name: 'proposal_submit',
        description:
          'Saga 3 product-worker submission boundary. Submit a typed Proposal (semantic payload only) against a WorkIntent. The kernel validates intent/task linkage, the execution fence, the payload schema, then records the proposal ATOMICALLY with automatically captured provenance (model/provider/effort/worker/execution) read from the launch-time execution snapshot. The worker must NOT supply provenance — only the payload. Idempotent: replaying the exact same (intent, execution, content_hash) returns the existing proposal with replayed=true. Call this from the assigned task, then call worker_done. Returns { proposal_id, content_hash, status, replayed }.',
        annotations: {
          title: 'Saga3: Submit Proposal',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
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

interface LaunchSnapshot {
  model: string | null;
  provider: string;
  effort: string | null;
}

function parseLaunchSnapshot(metadata: string): LaunchSnapshot {
  // The model route provenance is read from the FROZEN execution_context
  // snapshot captured at claim (D1.1 single-source-of-truth). Resolution order:
  //   1. metadata.execution_context.model_route   (D1.1 — canonical)
  //   2. metadata.authority_snapshot              (transitional D1 shape)
  //   3. flat {model, provider, effort}           (earliest D1 shape)
  //   4. nulls                                    (pre-fix / '{}' metadata)
  // Never re-reads mutable episode config — claim model == spawn model == this
  // provenance model.
  try {
    const parsed = JSON.parse(metadata) as Partial<LaunchSnapshot> & {
      authority_snapshot?: Partial<LaunchSnapshot>;
      execution_context?: { model_route?: Partial<LaunchSnapshot> };
    };
    const ctx = parsed.execution_context?.model_route;
    const src = ctx ?? parsed.authority_snapshot ?? parsed;
    return {
      model: src.model ?? null,
      provider: src.provider ?? 'zai',
      effort: src.effort ?? null,
    };
  } catch {
    return { model: null, provider: 'zai', effort: null };
  }
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
