/**
 * D3 readiness-advisor MCP boundary.
 *
 * Two tools, mirroring the D2 normalization boundary:
 *   readiness_get   — read-only: hands the advisor the immutable Proposal +
 *                     the EXACT allowed source_refs it may cite (anti-invent-
 *                     evidence contract) + the output schema + the rule.
 *   readiness_submit — bounded: validates the typed assessment deterministically,
 *                     persists it with separate advisor provenance, marks it
 *                     accepted_by_kernel. NEVER touches the product Proposal.
 *
 * The advisor PROPOSES an assessment; only the kernel accepts it. The product
 * Proposal provenance and the readiness-advisor provenance are separate
 * lineages — an advisor execution_id never lands in a saga3_proposals row.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
import { withImmediateTransaction } from './dispatcher.js';
import { readExecutionContextStrict } from '../saga3/authority/authorize-saga-tool-call.js';
import {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  validateReadinessAssessment,
  type ReadinessAssessmentPayload,
} from '../saga3/domain/discovery-readiness-assessment.js';
import type { ProposalProvenance } from '../saga3/domain/proposal.js';
import type { DiscoveryProposalPayload } from '../saga3/domain/discovery-proposal.js';
import {
  ensureSaga3ReadinessSchema,
  insertReadinessAssessment,
  markReadinessAccepted,
} from '../saga3/persistence/saga3-readiness-repository.js';

export interface Saga3ReadinessHandlersOptions {
  db?: () => ReturnType<typeof getDb>;
  now?: () => Date;
}

interface ReadinessControlRow {
  id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  source_intent_id: number;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: string;
}

interface ProductProposalRow {
  id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  payload: string;
  content_hash: string;
  provenance: string;
  source_submission_id: number | null;
  normalization_proposal_id: number | null;
}

/**
 * Authority/fence/epic/WorkIntent/task binding for one readiness call. Mirrors
 * the D2 requireControlBinding gate: every check throws on failure so a
 * malformed binding can never reach validation.
 */
function requireReadinessBinding(
  db: ReturnType<typeof getDb>,
  controlIntentId: number,
  executionId: string,
): { control: ReadinessControlRow; provenance: ProposalProvenance } {
  const strict = readExecutionContextStrict(db, executionId);
  if (!strict.ok) {
    throw new Error(`readiness: AUTHORITY_CONTEXT_INVALID — ${strict.reason}`);
  }
  if (!strict.snapshot.authority) {
    throw new Error('readiness: execution has no Saga 3 authority');
  }
  const control = db.prepare(
    `SELECT id, epic_id, proposal_id, proposal_content_hash, source_intent_id,
            authority_intent_id, projected_task_id, status
       FROM saga3_readiness_control_intents WHERE id=?`,
  ).get(controlIntentId) as ReadinessControlRow | undefined;
  if (!control) throw new Error(`readiness: ControlIntent ${controlIntentId} not found`);
  if (control.authority_intent_id !== strict.snapshot.work_intent_id) {
    throw new Error('readiness: execution authority is not bound to this ControlIntent');
  }
  if (control.projected_task_id !== strict.row.task_id) {
    throw new Error('readiness: execution task is not the ControlIntent projected task');
  }
  if (control.status !== 'open' && control.status !== 'executing' && control.status !== 'paused') {
    throw new Error(`readiness: ControlIntent ${controlIntentId} status '${control.status}' is not active`);
  }
  const exec = db.prepare(
    `SELECT worker_id, state FROM worker_executions WHERE execution_id=?`,
  ).get(executionId) as { worker_id: string; state: string } | undefined;
  if (!exec || (exec.state !== 'reserved' && exec.state !== 'running')) {
    throw new Error(`readiness: execution ${executionId} is not live`);
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

/**
 * Build the EXACT set of source identifiers the advisor is allowed to cite.
 * This is the anti-invent-evidence contract: anything outside this set is
 * rejected by validateReadinessAssessment. The advisor receives this list
 * via readiness_get and MUST cite only from it.
 *
 * Allowed sources:
 *   - JSON paths into the canonical Proposal payload fields
 *     (`$.problem_statement`, `$.evidence_refs[0]`, ...);
 *   - explicit evidence literal strings from the Proposal's evidence_refs;
 *   - lineage identifiers: `proposal:<id>`, `raw:<id>` (if normalized),
 *     `normalization:<id>` (if LM-transformed).
 */
function collectAllowedSourceRefs(
  proposal: ProductProposalRow,
  payload: DiscoveryProposalPayload,
): string[] {
  const refs = new Set<string>();
  refs.add(`proposal:${proposal.id}`);
  // Top-level field paths.
  for (const key of Object.keys(payload)) {
    refs.add(`$.${key}`);
  }
  // Indexed evidence paths + the literal evidence strings themselves.
  payload.evidence_refs.forEach((evidence, index) => {
    refs.add(`$.evidence_refs[${index}]`);
    refs.add(evidence);
  });
  // Lineage identifiers (may be absent for a direct worker proposal).
  if (proposal.source_submission_id !== null) {
    refs.add(`raw:${proposal.source_submission_id}`);
  }
  if (proposal.normalization_proposal_id !== null) {
    refs.add(`normalization:${proposal.normalization_proposal_id}`);
  }
  return [...refs];
}

export function createSaga3ReadinessHandlers(
  options: Saga3ReadinessHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const getDbFn = options.db ?? getDb;
  ensureSaga3ReadinessSchema(getDbFn());

  const readinessGet: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const executionId = stringArg(args, 'execution_id');
    const db = getDbFn();
    const binding = requireReadinessBinding(db, controlIntentId, executionId);
    const proposal = db.prepare(
      `SELECT id, intent_id, task_id, execution_id, payload, content_hash,
              provenance, source_submission_id, normalization_proposal_id
         FROM saga3_proposals WHERE id=?`,
    ).get(binding.control.proposal_id) as ProductProposalRow | undefined;
    if (!proposal) {
      throw new Error(`readiness_get: Proposal ${binding.control.proposal_id} not found`);
    }
    // Bind to the IMMUTABLE Proposal version: the stored hash must match the
    // hash the ControlIntent was created for.
    if (proposal.content_hash !== binding.control.proposal_content_hash) {
      throw new Error(
        `readiness_get: Proposal ${proposal.id} content_hash changed since the ControlIntent was created; this is a new assessment target`,
      );
    }
    const payload = JSON.parse(proposal.payload) as DiscoveryProposalPayload;
    const allowedSourceRefs = collectAllowedSourceRefs(proposal, payload);
    return {
      control_intent_id: controlIntentId,
      proposal_id: proposal.id,
      proposal_content_hash: proposal.content_hash,
      proposal_payload: payload,
      allowed_source_refs: allowedSourceRefs,
      output_schema: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
      rule: 'Assess every required dimension. Cite only identifiers from allowed_source_refs for every claim and gap. Do not invent evidence. This is a shadow assessment — it cannot change the outcome.',
    };
  };

  const readinessSubmit: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const executionId = stringArg(args, 'execution_id');
    const schemaVersion = stringArg(args, 'schema_version');
    const payload = args.payload;
    if (schemaVersion !== DISCOVERY_READINESS_ASSESSMENT_SCHEMA) {
      throw new Error(
        `readiness_submit: schema_version mismatch — expected '${DISCOVERY_READINESS_ASSESSMENT_SCHEMA}', got '${schemaVersion}'`,
      );
    }

    return withImmediateTransaction(getDbFn(), () => {
      const db = getDbFn();
      const binding = requireReadinessBinding(db, controlIntentId, executionId);

      // Re-read the product Proposal and re-bind to its immutable hash. A
      // changed hash is a new assessment target and must NOT reuse this
      // ControlIntent's assessment.
      const proposal = db.prepare(
        `SELECT id, intent_id, task_id, execution_id, payload, content_hash,
                provenance, source_submission_id, normalization_proposal_id
           FROM saga3_proposals WHERE id=?`,
      ).get(binding.control.proposal_id) as ProductProposalRow | undefined;
      if (!proposal) {
        throw new Error(`readiness_submit: Proposal ${binding.control.proposal_id} not found`);
      }
      if (proposal.content_hash !== binding.control.proposal_content_hash) {
        throw new Error(
          `readiness_submit: Proposal ${proposal.id} content_hash changed; ControlIntent ${controlIntentId} is for an older version`,
        );
      }
      const proposalPayload = JSON.parse(proposal.payload) as DiscoveryProposalPayload;
      const allowedSourceRefs = collectAllowedSourceRefs(proposal, proposalPayload);

      // Deterministic validation — no LM. Rejects malformed or evidence-
      // inventing assessments before they are persisted as accepted.
      const validation = validateReadinessAssessment(
        payload,
        proposal.id,
        proposal.content_hash,
        allowedSourceRefs,
      );
      if (!validation.valid) {
        throw new Error(
          `readiness_submit: assessment validation failed — ${validation.errors.join('; ')}`,
        );
      }
      const typed = payload as ReadinessAssessmentPayload;
      // Re-check the immutable-target identity (defence in depth: the
      // validator already enforced it, but a replay must not cross targets).
      if (typed.proposal_id !== binding.control.proposal_id
          || typed.proposal_content_hash !== binding.control.proposal_content_hash) {
        throw new Error('readiness_submit: assessment targets a different Proposal version than the ControlIntent');
      }

      const inserted = insertReadinessAssessment(db, {
        controlIntentId,
        proposalId: proposal.id,
        proposalContentHash: proposal.content_hash,
        taskId: binding.control.projected_task_id!,
        executionId,
        payload: typed,
        overallReadiness: typed.overall_readiness,
        recommendedNextAction: typed.recommended_next_action,
        provenance: binding.provenance,
      });

      // The advisor PROPOSES; only the kernel marks accepted. Validation
      // above IS the kernel acceptance gate.
      markReadinessAccepted(db, inserted.record.id);

      // Audit trail comment on the advisor task (not the product task).
      if (!inserted.replayed) {
        db.prepare(
          `INSERT INTO comments (task_id, author, content) VALUES (?, 'saga3-kernel', ?)`,
        ).run(
          binding.control.projected_task_id,
          `Readiness assessment accepted: control=${controlIntentId} assessment=${inserted.record.id} overall=${typed.overall_readiness} hash=${inserted.record.content_hash.slice(0, 12)}…`,
        );
      }
      return {
        assessment_id: inserted.record.id,
        content_hash: inserted.record.content_hash,
        status: 'accepted_by_kernel' as const,
        replayed: inserted.replayed,
      };
    });
  };

  return {
    definitions: [
      {
        name: 'readiness_get',
        description: 'Read the immutable canonical discovery Proposal and the exact source references a shadow readiness advisor may cite, plus the assessment output schema.',
        inputSchema: {
          type: 'object',
          properties: {
            control_intent_id: { type: 'integer' },
            execution_id: { type: 'string' },
          },
          required: ['control_intent_id', 'execution_id'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'readiness_submit',
        description: 'Submit one typed readiness assessment for the immutable Proposal bound to the ControlIntent. The kernel validates it deterministically and accepts or rejects; this never modifies the product Proposal or the discovery outcome.',
        inputSchema: {
          type: 'object',
          properties: {
            control_intent_id: { type: 'integer' },
            execution_id: { type: 'string' },
            schema_version: { type: 'string', enum: [DISCOVERY_READINESS_ASSESSMENT_SCHEMA] },
            payload: { type: 'object' },
          },
          required: ['control_intent_id', 'execution_id', 'schema_version', 'payload'],
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
    handlers: {
      readiness_get: readinessGet,
      readiness_submit: readinessSubmit,
    },
  };
}

function integerArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`readiness: '${key}' must be an integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`readiness: '${key}' must be a non-empty string`);
  }
  return v;
}
