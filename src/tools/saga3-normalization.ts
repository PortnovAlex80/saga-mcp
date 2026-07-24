import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import { withImmediateTransaction } from './dispatcher.js';
import { readExecutionContextStrict } from '../saga3/authority/authorize-saga-tool-call.js';
import {
  DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
  validateDiscoveryNormalizationProposal,
  type DiscoveryNormalizationProposalPayload,
} from '../saga3/domain/discovery-normalization-proposal.js';
import type { ProposalProvenance } from '../saga3/domain/proposal.js';
import {
  canonicalJson,
  ensureSaga3NormalizationSchema,
  insertNormalizationProposal,
  markNormalizationAccepted,
  markRawSubmissionNormalized,
  readRawSubmission,
} from '../saga3/persistence/saga3-normalization-repository.js';

export interface Saga3NormalizationHandlersOptions {
  db?: () => ReturnType<typeof getDb>;
  now?: () => Date;
}

interface ControlIntentRow {
  id: number;
  epic_id: number;
  source_submission_id: number;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: string;
}

function requireControlBinding(
  db: ReturnType<typeof getDb>,
  controlIntentId: number,
  sourceSubmissionId: number,
  executionId: string,
): { control: ControlIntentRow; provenance: ProposalProvenance } {
  const strict = readExecutionContextStrict(db, executionId);
  if (!strict.ok) {
    throw new Error(`normalization: AUTHORITY_CONTEXT_INVALID — ${strict.reason}`);
  }
  if (!strict.snapshot.authority) {
    throw new Error('normalization: execution has no Saga 3 authority');
  }
  const control = db.prepare(
    `SELECT id, epic_id, source_submission_id, authority_intent_id,
            projected_task_id, status
       FROM saga3_control_intents WHERE id=?`,
  ).get(controlIntentId) as ControlIntentRow | undefined;
  if (!control) throw new Error(`normalization: ControlIntent ${controlIntentId} not found`);
  if (control.source_submission_id !== sourceSubmissionId) {
    throw new Error(`normalization: ControlIntent ${controlIntentId} is not for source ${sourceSubmissionId}`);
  }
  if (control.authority_intent_id !== strict.snapshot.work_intent_id) {
    throw new Error('normalization: execution authority is not bound to this ControlIntent');
  }
  if (control.projected_task_id !== strict.row.task_id) {
    throw new Error('normalization: execution task is not the ControlIntent projected task');
  }
  if (control.status !== 'open' && control.status !== 'executing' && control.status !== 'paused') {
    throw new Error(`normalization: ControlIntent ${controlIntentId} status '${control.status}' is not active`);
  }
  const exec = db.prepare(
    `SELECT worker_id, state FROM worker_executions WHERE execution_id=?`,
  ).get(executionId) as { worker_id: string; state: string } | undefined;
  if (!exec || (exec.state !== 'reserved' && exec.state !== 'running')) {
    throw new Error(`normalization: execution ${executionId} is not live`);
  }
  const route = strict.snapshot.model_route;
  return {
    control,
    provenance: {
      model: route.model,
      provider: route.provider,
      effort: route.effort,
      worker_id: exec.worker_id,
      execution_id: executionId,
      submitted_at: new Date().toISOString(),
    },
  };
}

export function createSaga3NormalizationHandlers(
  options: Saga3NormalizationHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const getDbFn = options.db ?? getDb;
  const now = options.now ?? (() => new Date());
  ensureSaga3NormalizationSchema(getDbFn());

  const normalizationGet: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const sourceSubmissionId = integerArg(args, 'source_submission_id');
    const executionId = stringArg(args, 'execution_id');
    const db = getDbFn();
    requireControlBinding(db, controlIntentId, sourceSubmissionId, executionId);
    const source = readRawSubmission(db, sourceSubmissionId);
    if (!source) throw new Error(`normalization_get: source submission ${sourceSubmissionId} not found`);
    if (source.status !== 'normalization_required') {
      throw new Error(`normalization_get: source submission ${sourceSubmissionId} status is '${source.status}'`);
    }
    return {
      control_intent_id: controlIntentId,
      source_submission_id: source.id,
      source_raw_hash: source.raw_hash,
      raw_payload: source.raw_payload,
      parsed_payload: source.parsed_payload,
      deterministic_trace: source.normalization_trace,
      validation_errors: source.validation_errors,
      alias_conflicts: source.alias_conflicts,
      allowed_evidence_refs: source.allowed_evidence_refs,
      output_schema: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
      rule: 'Transform only what is present in parsed_payload. Do not add evidence. Cite top-level source paths for every canonical field.',
    };
  };

  const normalizationSubmit: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const sourceSubmissionId = integerArg(args, 'source_submission_id');
    const executionId = stringArg(args, 'execution_id');
    const schemaVersion = stringArg(args, 'schema_version');
    const payload = args.payload;
    if (schemaVersion !== DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA) {
      throw new Error(
        `normalization_submit: schema_version mismatch — expected '${DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA}'`,
      );
    }

    return withImmediateTransaction(getDbFn(), () => {
      const db = getDbFn();
      const binding = requireControlBinding(
        db,
        controlIntentId,
        sourceSubmissionId,
        executionId,
      );
      const source = readRawSubmission(db, sourceSubmissionId);
      if (!source) throw new Error(`normalization_submit: source submission ${sourceSubmissionId} not found`);
      const sourceIntent = db.prepare(`SELECT epic_id FROM saga3_work_intents WHERE id=?`).get(source.intent_id) as { epic_id: number } | undefined;
      if (!sourceIntent || sourceIntent.epic_id !== binding.control.epic_id) {
        throw new Error('normalization_submit: source submission/control epic mismatch');
      }
      if (source.status !== 'normalization_required') {
        throw new Error(`normalization_submit: source submission status is '${source.status}'`);
      }
      if (!source.provenance) {
        throw new Error('normalization_submit: source submission has no product provenance');
      }

      const validation = validateDiscoveryNormalizationProposal(
        payload,
        source.parsed_payload,
        source.allowed_evidence_refs,
      );
      if (!validation.valid) {
        throw new Error(`normalization_submit: proposal validation failed — ${validation.errors.join('; ')}`);
      }
      const typed = payload as DiscoveryNormalizationProposalPayload;
      if (typed.source_submission_id !== source.id || typed.source_raw_hash !== source.raw_hash) {
        throw new Error('normalization_submit: source identity/hash mismatch');
      }

      const normalizerProvenance: ProposalProvenance = {
        ...binding.provenance,
        submitted_at: now().toISOString(),
      };
      const inserted = insertNormalizationProposal(db, {
        controlIntentId,
        sourceSubmissionId,
        taskId: binding.control.projected_task_id!,
        executionId,
        payload,
        provenance: normalizerProvenance,
      });

      const normalizedText = canonicalJson(typed.normalized_payload);
      const contentHash = createHash('sha256').update(normalizedText).digest('hex');
      const productProvenance: ProposalProvenance = {
        ...source.provenance,
        normalization_mode: 'lm_transformation',
        source_submission_id: source.id,
        normalization_proposal_id: inserted.record.id,
        normalizer: {
          model: normalizerProvenance.model,
          provider: normalizerProvenance.provider,
          effort: normalizerProvenance.effort,
          worker_id: normalizerProvenance.worker_id,
          execution_id: normalizerProvenance.execution_id,
          submitted_at: normalizerProvenance.submitted_at,
        },
      };

      // The canonical product Proposal remains attached to the original product
      // task/execution. The normalizer owns a separate normalization proposal;
      // mixing its execution_id with the product task_id would create a false
      // task↔execution pair and break D1's provenance invariant.
      const productInsert = db.prepare(
        `INSERT INTO saga3_proposals
           (intent_id, task_id, execution_id, kind, schema_version, payload,
            content_hash, status, provenance, source_submission_id,
            normalization_proposal_id)
         VALUES (?,?,?,?,?,?,?, 'submitted', ?, ?, ?)
         ON CONFLICT(intent_id, execution_id, content_hash) DO NOTHING`,
      ).run(
        source.intent_id,
        source.task_id,
        source.execution_id,
        source.kind,
        source.schema_version,
        normalizedText,
        contentHash,
        JSON.stringify(productProvenance),
        source.id,
        inserted.record.id,
      );
      const product = db.prepare(
        `SELECT id FROM saga3_proposals
          WHERE intent_id=? AND execution_id=? AND content_hash=?`,
      ).get(source.intent_id, source.execution_id, contentHash) as { id: number } | undefined;
      if (!product) throw new Error('normalization_submit: accepted product proposal vanished');

      markNormalizationAccepted(db, inserted.record.id);
      markRawSubmissionNormalized(db, source.id);
      if (productInsert.changes === 1) {
        db.prepare(
          `INSERT INTO comments (task_id, author, content)
           VALUES (?, 'saga3-kernel', ?)`,
        ).run(
          source.task_id,
          `Normalization accepted: source=${source.id} normalization=${inserted.record.id} proposal=${product.id} hash=${contentHash.slice(0, 12)}…`,
        );
      }
      return {
        normalization_proposal_id: inserted.record.id,
        proposal_id: product.id,
        content_hash: contentHash,
        status: 'accepted_by_kernel',
        replayed: inserted.replayed && productInsert.changes === 0,
      };
    });
  };

  return {
    definitions: [
      {
        name: 'normalization_get',
        description: 'Read the immutable raw discovery submission and deterministic normalization diagnostics for the assigned NormalizeDiscoveryProposal ControlIntent.',
        annotations: { title: 'Saga3: Read Normalization Input', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          type: 'object',
          required: ['control_intent_id', 'source_submission_id', 'execution_id'],
          properties: {
            control_intent_id: { type: 'integer' },
            source_submission_id: { type: 'integer' },
            execution_id: { type: 'string' },
          },
        },
      },
      {
        name: 'normalization_submit',
        description: 'Submit a transformation proposal for a raw discovery response. The LM cannot accept it; the deterministic kernel validates source paths, schema, raw hash and evidence non-invention before creating the canonical product proposal.',
        annotations: { title: 'Saga3: Submit Normalization Proposal', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: {
          type: 'object',
          required: ['control_intent_id', 'source_submission_id', 'execution_id', 'schema_version', 'payload'],
          properties: {
            control_intent_id: { type: 'integer' },
            source_submission_id: { type: 'integer' },
            execution_id: { type: 'string' },
            schema_version: { type: 'string', enum: [DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA] },
            payload: { type: 'object' },
          },
        },
      },
    ],
    handlers: {
      normalization_get: normalizationGet,
      normalization_submit: normalizationSubmit,
    },
  };
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}
