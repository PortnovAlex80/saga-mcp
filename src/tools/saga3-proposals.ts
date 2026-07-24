import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { withImmediateTransaction } from './dispatcher.js';
import type { ToolHandler } from '../types.js';
import { DISCOVERY_INTENT_KIND, DISCOVERY_WORK_INTENT_SCHEMA } from '../saga3/domain/work-intent.js';
import { DISCOVERY_PROPOSAL_SCHEMA } from '../saga3/domain/discovery-proposal.js';
import { normalizeDiscoveryProposalInput } from '../saga3/domain/discovery-normalization.js';
import type { ProposalProvenance, SubmitProposal } from '../saga3/domain/proposal.js';
import { readExecutionContextStrict } from '../saga3/authority/authorize-saga-tool-call.js';
import {
  canonicalJson,
  ensureSaga3NormalizationSchema,
  insertRawSubmission,
} from '../saga3/persistence/saga3-normalization-repository.js';

const PROPOSAL_CONTRACTS = {
  [DISCOVERY_INTENT_KIND]: {
    intent_output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
    proposal_schema_version: DISCOVERY_PROPOSAL_SCHEMA,
  },
} as const;

export interface Saga3ProposalHandlersOptions {
  db?: () => ReturnType<typeof getDb>;
  now?: () => Date;
}

export type D2SubmissionStatus = 'submitted' | 'normalization_required' | 'rejected_syntax';

export interface D2ProposalSubmitResult {
  raw_submission_id: number;
  raw_hash: string;
  proposal_id: number | null;
  content_hash: string | null;
  status: D2SubmissionStatus;
  replayed: boolean;
  deterministic_trace: string[];
  validation_errors: string[];
  alias_conflicts: string[];
}

export function createSaga3ProposalHandlers(
  options: Saga3ProposalHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const getDbFn = options.db ?? getDb;
  const now = options.now ?? (() => new Date());

  const handleSubmitProposal: ToolHandler = args => {
    const submission = readSubmission(args);
    const contract = PROPOSAL_CONTRACTS[submission.kind as keyof typeof PROPOSAL_CONTRACTS];
    if (!contract) throw new Error(`proposal_submit: unsupported kind '${submission.kind}'`);
    if (submission.schema_version !== contract.proposal_schema_version) {
      throw new Error(`proposal_submit: schema_version mismatch — expected '${contract.proposal_schema_version}' for kind '${submission.kind}', got '${submission.schema_version}'`);
    }

    return withImmediateTransaction(getDbFn(), () => {
      const db = getDbFn();
      ensureSaga3NormalizationSchema(db);
      const intentRow = db.prepare(
        `SELECT id, kind, output_schema, projected_task_id, epic_id FROM saga3_work_intents WHERE id=?`,
      ).get(submission.intent_id) as {
        id: number; kind: string; output_schema: string; projected_task_id: number | null; epic_id: number;
      } | undefined;
      if (!intentRow) throw new Error(`proposal_submit: WorkIntent ${submission.intent_id} not found`);
      if (intentRow.kind !== submission.kind) throw new Error(`proposal_submit: intent kind mismatch`);
      if (intentRow.output_schema !== contract.intent_output_schema) throw new Error(`proposal_submit: intent output_schema mismatch`);
      if (intentRow.projected_task_id !== submission.task_id) throw new Error(`proposal_submit: task is not the projected task`);

      const taskRow = db.prepare(`SELECT current_execution_id FROM tasks WHERE id=?`).get(submission.task_id) as { current_execution_id: string | null } | undefined;
      if (!taskRow) throw new Error(`proposal_submit: task ${submission.task_id} not found`);
      if (!taskRow.current_execution_id || taskRow.current_execution_id !== submission.execution_id) throw new Error(`proposal_submit: execution fence failed`);

      const execRow = db.prepare(`SELECT worker_id, state, task_id, epic_id FROM worker_executions WHERE execution_id=?`).get(submission.execution_id) as {
        worker_id: string; state: string; task_id: number; epic_id: number;
      } | undefined;
      if (!execRow) throw new Error(`proposal_submit: execution ${submission.execution_id} not found`);
      if (execRow.task_id !== submission.task_id) throw new Error(`proposal_submit: execution ${submission.execution_id} owns task ${execRow.task_id}, not ${submission.task_id}`);
      if (execRow.epic_id !== intentRow.epic_id) throw new Error(`proposal_submit: execution ${submission.execution_id} belongs to epic ${execRow.epic_id}, intent belongs to epic ${intentRow.epic_id}`);
      if (execRow.state !== 'reserved' && execRow.state !== 'running') throw new Error(`proposal_submit: execution ${submission.execution_id} is not live (state='${execRow.state}'); only reserved/running may submit`);

      const strictContext = readExecutionContextStrict(db, submission.execution_id);
      if (!strictContext.ok) throw new Error(`proposal_submit: AUTHORITY_CONTEXT_INVALID — ${strictContext.reason}`);
      if (!strictContext.snapshot.authority || strictContext.snapshot.work_intent_id !== submission.intent_id || strictContext.row.task_id !== submission.task_id) {
        throw new Error('proposal_submit: execution context is not bound to this WorkIntent/task');
      }

      const route = strictContext.snapshot.model_route;
      const baseProvenance: ProposalProvenance = {
        model: route.model,
        provider: route.provider,
        effort: route.effort,
        worker_id: execRow.worker_id,
        execution_id: submission.execution_id,
        submitted_at: now().toISOString(),
      };
      const deterministic = normalizeDiscoveryProposalInput(submission.payload);
      const rawStatus = deterministic.disposition === 'accepted'
        ? 'accepted_deterministically'
        : deterministic.disposition === 'needs_lm' ? 'normalization_required' : 'rejected_syntax';
      const raw = insertRawSubmission(db, {
        intentId: submission.intent_id,
        taskId: submission.task_id,
        executionId: submission.execution_id,
        kind: submission.kind,
        schemaVersion: submission.schema_version,
        rawPayload: deterministic.raw_text,
        parsedPayload: deterministic.parsed_payload,
        status: rawStatus,
        normalizationTrace: deterministic.trace,
        validationErrors: deterministic.validation_errors,
        aliasConflicts: deterministic.alias_conflicts,
        allowedEvidenceRefs: deterministic.allowed_evidence_refs,
        provenance: baseProvenance,
      });

      if (deterministic.disposition !== 'accepted') {
        if (!raw.replayed) {
          db.prepare(`INSERT INTO comments (task_id, author, content) VALUES (?, 'saga3-kernel', ?)`).run(
            submission.task_id,
            deterministic.disposition === 'needs_lm'
              ? `Raw proposal stored: source=${raw.record.id} normalization required`
              : `Raw proposal rejected deterministically: source=${raw.record.id} invalid JSON`,
          );
        }
        return {
          raw_submission_id: raw.record.id,
          raw_hash: raw.record.raw_hash,
          proposal_id: null,
          content_hash: null,
          status: deterministic.disposition === 'needs_lm' ? 'normalization_required' : 'rejected_syntax',
          replayed: raw.replayed,
          deterministic_trace: deterministic.trace,
          validation_errors: deterministic.validation_errors,
          alias_conflicts: deterministic.alias_conflicts,
        } satisfies D2ProposalSubmitResult;
      }

      const payloadText = canonicalJson(deterministic.normalized_payload);
      const contentHash = createHash('sha256').update(payloadText).digest('hex');
      const provenance: ProposalProvenance = {
        ...baseProvenance,
        normalization_mode: 'deterministic',
        source_submission_id: raw.record.id,
      };
      const inserted = db.prepare(
        `INSERT INTO saga3_proposals
           (intent_id, task_id, execution_id, kind, schema_version, payload, content_hash, status, provenance, source_submission_id)
         VALUES (?,?,?,?,?,?,?, 'submitted', ?, ?)
         ON CONFLICT(intent_id, execution_id, content_hash) DO NOTHING`,
      ).run(submission.intent_id, submission.task_id, submission.execution_id, submission.kind,
        submission.schema_version, payloadText, contentHash, JSON.stringify(provenance), raw.record.id);
      const proposal = db.prepare(
        `SELECT id FROM saga3_proposals WHERE intent_id=? AND execution_id=? AND content_hash=?`,
      ).get(submission.intent_id, submission.execution_id, contentHash) as { id: number } | undefined;
      if (!proposal) throw new Error('proposal_submit: canonical proposal vanished after insert');
      if (inserted.changes === 1) {
        db.prepare(`INSERT INTO comments (task_id, author, content) VALUES (?, 'saga3-kernel', ?)`).run(
          submission.task_id,
          `Proposal accepted deterministically: source=${raw.record.id} proposal=${proposal.id} hash=${contentHash.slice(0, 12)}…`,
        );
      }
      return {
        raw_submission_id: raw.record.id,
        raw_hash: raw.record.raw_hash,
        proposal_id: proposal.id,
        content_hash: contentHash,
        status: 'submitted',
        replayed: raw.replayed && inserted.changes === 0,
        deterministic_trace: deterministic.trace,
        validation_errors: [],
        alias_conflicts: [],
      } satisfies D2ProposalSubmitResult;
    });
  };

  return {
    definitions: [{
      name: 'proposal_submit',
      description: 'Store the immutable raw discovery response, then run deterministic normalization: strict JSON, full markdown-fence removal, supported aliases, schema validation. Only semantic ambiguity is delegated to a bounded normalization control worker.',
      annotations: { title: 'Saga3: Submit Proposal', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        required: ['intent_id', 'task_id', 'execution_id', 'kind', 'schema_version', 'payload'],
        properties: {
          intent_id: { type: 'integer' },
          task_id: { type: 'integer' },
          execution_id: { type: 'string' },
          kind: { type: 'string', enum: [DISCOVERY_INTENT_KIND] },
          schema_version: { type: 'string', enum: [DISCOVERY_PROPOSAL_SCHEMA] },
          payload: { oneOf: [{ type: 'object' }, { type: 'string' }] },
        },
      },
    }],
    handlers: { proposal_submit: handleSubmitProposal },
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
