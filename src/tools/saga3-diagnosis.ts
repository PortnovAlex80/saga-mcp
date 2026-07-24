/**
 * D5 advisory-diagnosis MCP boundary.
 *
 * Two tools, mirroring the D3 readiness boundary (saga3-readiness.ts):
 *   diagnosis_get    — read-only: hands the diagnosis advisor the immutable
 *                      DiagnosisCase the kernel built for the EXACT certificate
 *                      target (policy conditions, allowed source_refs, output
 *                      schema, the grounding rule). The advisor may cite ONLY
 *                      identifiers from allowed_source_refs (anti-invent-
 *                      evidence contract, invariant I4).
 *   diagnosis_submit — bounded: validates the typed diagnosis report
 *                      deterministically against the frozen case and persists
 *                      it with separate advisor provenance. On a valid report
 *                      the row is marked accepted_by_kernel (the durable
 *                      advisory answer); on an invalid one it is marked
 *                      rejected_by_kernel with the validation errors (durable
 *                      audit, invariant I5). NEVER touches the D4
 *                      settlement/certificate/proposal/readiness rows
 *                      (invariant I6).
 *
 * The advisor PROPOSES a diagnosis report; only the kernel accepts it. The D4
 * certificate authority and the diagnosis-advisor provenance are separate
 * lineages — a diagnosis execution_id never lands in an authoritative row.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';
// (withImmediateTransaction intentionally NOT imported here: the diagnosis
// submit handler does NOT wrap insertDiagnosisReportAtomically in an outer
// transaction — that caused a nested-transaction error in the live D5 smoke.
// The repository function is itself the single atomic boundary.)
import { readExecutionContextStrict } from '../saga3/authority/authorize-saga-tool-call.js';
import {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  FORBIDDEN_DIAGNOSIS_FIELDS,
  hashDiagnosisReport,
} from '../saga3/domain/discovery-diagnosis-report.js';
import {
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  type DiscoveryDiagnosisCase,
} from '../saga3/domain/discovery-diagnosis-case.js';
import { validateDiagnosisReport } from '../saga3/domain/discovery-diagnosis-validator.js';
import {
  ensureSaga3DiagnosisSchema,
  insertDiagnosisReportAtomically,
} from '../saga3/persistence/saga3-diagnosis-repository.js';

export interface Saga3DiagnosisHandlersOptions {
  db?: () => ReturnType<typeof getDb>;
  now?: () => Date;
}

interface DiagnosisControlRow {
  id: number;
  epic_id: number;
  certificate_id: number;
  certificate_hash: string;
  settlement_input_hash: string;
  diagnosis_case: string;
  diagnosis_case_hash: string;
  diagnosis_contract_version: string;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: string;
}

/**
 * Authority/fence/epic/task binding for one diagnosis call. Mirrors the D3
 * requireReadinessBinding gate: every check throws on failure so a malformed
 * binding can never reach the report submission. The execution's authority
 * WorkIntent MUST be the diagnosis ControlIntent's authority_intent_id, and the
 * execution's task MUST be the ControlIntent's projected_task_id.
 */
function requireDiagnosisBinding(
  db: ReturnType<typeof getDb>,
  controlIntentId: number,
  executionId: string,
): { control: DiagnosisControlRow; provenance: DiagnosisProvenance } {
  const strict = readExecutionContextStrict(db, executionId);
  if (!strict.ok) {
    throw new Error(`diagnosis: AUTHORITY_CONTEXT_INVALID — ${strict.reason}`);
  }
  if (!strict.snapshot.authority) {
    throw new Error('diagnosis: execution has no Saga 3 authority');
  }
  const control = db.prepare(
    `SELECT id, epic_id, certificate_id, certificate_hash, settlement_input_hash,
            diagnosis_case, diagnosis_case_hash, diagnosis_contract_version,
            authority_intent_id, projected_task_id, status
       FROM saga3_discovery_diagnosis_control_intents WHERE id=?`,
  ).get(controlIntentId) as DiagnosisControlRow | undefined;
  if (!control) throw new Error(`diagnosis: ControlIntent ${controlIntentId} not found`);
  if (control.authority_intent_id !== strict.snapshot.work_intent_id) {
    throw new Error('diagnosis: execution authority is not bound to this ControlIntent');
  }
  if (control.projected_task_id !== strict.row.task_id) {
    throw new Error('diagnosis: execution task is not the ControlIntent projected task');
  }
  if (control.status !== 'open' && control.status !== 'executing' && control.status !== 'paused') {
    throw new Error(`diagnosis: ControlIntent ${controlIntentId} status '${control.status}' is not active`);
  }
  const exec = db.prepare(
    `SELECT worker_id, state FROM worker_executions WHERE execution_id=?`,
  ).get(executionId) as { worker_id: string; state: string } | undefined;
  if (!exec || (exec.state !== 'reserved' && exec.state !== 'running')) {
    throw new Error(`diagnosis: execution ${executionId} is not live`);
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

export function createSaga3DiagnosisHandlers(
  options: Saga3DiagnosisHandlersOptions = {},
): { definitions: Tool[]; handlers: Record<string, ToolHandler> } {
  const getDbFn = options.db ?? getDb;
  ensureSaga3DiagnosisSchema(getDbFn());

  const diagnosisGet: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const executionId = stringArg(args, 'execution_id');
    const db = getDbFn();
    const binding = requireDiagnosisBinding(db, controlIntentId, executionId);
    // The DiagnosisCase was frozen on the control row by the service
    // (ensureDiagnosisControl). The advisor receives the EXACT case the kernel
    // built — it may not reason over anything outside it.
    let caseData: DiscoveryDiagnosisCase;
    try {
      caseData = JSON.parse(binding.control.diagnosis_case) as DiscoveryDiagnosisCase;
    } catch {
      throw new Error(`diagnosis_get: ControlIntent ${controlIntentId} diagnosis_case is not valid JSON`);
    }
    return {
      control_intent_id: controlIntentId,
      certificate_id: binding.control.certificate_id,
      certificate_hash: binding.control.certificate_hash,
      diagnosis_case: caseData,
      allowed_source_refs: caseData.allowed_source_refs,
      output_schema: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      rule: 'Explain why the kernel issued this decision. Cite only identifiers from allowed_source_refs. Do not invent evidence. This is advisory — it cannot change the outcome.',
    };
  };

  const diagnosisSubmit: ToolHandler = args => {
    const controlIntentId = integerArg(args, 'control_intent_id');
    const executionId = stringArg(args, 'execution_id');
    const schemaVersion = stringArg(args, 'schema_version');
    const payload = args.payload;
    if (schemaVersion !== DISCOVERY_DIAGNOSIS_REPORT_SCHEMA) {
      throw new Error(
        `diagnosis_submit: schema_version mismatch — expected '${DISCOVERY_DIAGNOSIS_REPORT_SCHEMA}', got '${schemaVersion}'`,
      );
    }

    // NO outer withImmediateTransaction: insertDiagnosisReportAtomically opens
    // its own BEGIN IMMEDIATE and closes it atomically. Wrapping the call in a
    // second transaction causes a nested-transaction error ("cannot start a
    // transaction within a transaction"), which is exactly what the live D5
    // smoke surfaced (the worker composed a valid report but the submit threw).
    // The read-only binding/case/validation steps do not need a transaction; the
    // atomic insert is the single integrity boundary. The comment INSERT after a
    // successful/failed insert is best-effort observability — if it throws, the
    // report row is already durable (and a retry replays it).
    const db = getDbFn();
    const binding = requireDiagnosisBinding(db, controlIntentId, executionId);

    // Re-read the frozen DiagnosisCase the kernel built for THIS target. The
    // validator runs against the case, never against the live state.
    let caseData: DiscoveryDiagnosisCase;
    try {
      caseData = JSON.parse(binding.control.diagnosis_case) as DiscoveryDiagnosisCase;
    } catch {
      throw new Error(`diagnosis_submit: ControlIntent ${controlIntentId} diagnosis_case is not valid JSON`);
    }

    // Defence in depth: the payload's target must bind to the control's
    // certificate target. The validator checks target vs case.certificate;
    // here we additionally confirm the case itself is for THIS control's cert.
    if (caseData.certificate.id !== binding.control.certificate_id
        || caseData.certificate.hash !== binding.control.certificate_hash) {
      throw new Error(`diagnosis_submit: ControlIntent ${controlIntentId} case target does not match the control's certificate target`);
    }

    // Forbidden authority-shaped fields: reject OUTRIGHT (the payload attempts
    // to override the outcome / stage / certificate — invariants I1, I2). The
    // validator also checks these, but we surface them as durable rejections
    // (rejected_by_kernel) rather than throws, so the attempt is auditable.
    const forbiddenPresent: string[] = [];
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const forbidden of FORBIDDEN_DIAGNOSIS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
          forbiddenPresent.push(forbidden);
        }
      }
    }

    // P0-2 (mirrors readiness_submit): persist the submitted report FIRST,
    // THEN run deterministic validation. A rejection is DURABLE — the advisor
    // proposed, the kernel rejected, and the rejection reason survives so a
    // human / the service can see why. We never silently discard an advisor
    // proposal. The verdict (accepted/rejected) is computed here and passed
    // to the atomic insert, which applies it inside its own BEGIN IMMEDIATE.
    let validationErrors: string[];
    let status: 'accepted_by_kernel' | 'rejected_by_kernel';
    if (forbiddenPresent.length > 0) {
      validationErrors = forbiddenPresent.map(
        f => `diagnosis payload must not contain forbidden field '${f}'`,
      );
      status = 'rejected_by_kernel';
    } else {
      const validation = validateDiagnosisReport(payload, caseData);
      validationErrors = validation.errors;
      status = validation.valid ? 'accepted_by_kernel' : 'rejected_by_kernel';
    }

    // Recompute the content hash from the canonical payload via the domain
    // helper. The atomic insert re-verifies this inside BEGIN IMMEDIATE
    // (co-tamper guard).
    const expectedContentHash = hashDiagnosisReport(payload as Parameters<typeof hashDiagnosisReport>[0]);

    const inserted = insertDiagnosisReportAtomically(db, {
      controlIntentId,
      certificateId: binding.control.certificate_id,
      certificateHash: binding.control.certificate_hash,
      settlementInputHash: binding.control.settlement_input_hash,
      decision: caseData.certificate.decision,
      taskId: binding.control.projected_task_id!,
      executionId,
      schemaVersion,
      payload,
      expectedContentHash,
      status,
      validationErrors,
      provenance: binding.provenance,
    });

    // Idempotent replay: the same (control + content_hash) under a new
    // execution returns the existing row with its original verdict.
    if (inserted.replayed) {
      return {
        report_id: inserted.record.id,
        content_hash: inserted.record.content_hash,
        status: inserted.record.status,
        replayed: true,
        validation_errors: inserted.record.validation_errors,
      };
    }

    // Best-effort observability comment (the report row is already durable).
    if (inserted.record.status === 'rejected_by_kernel') {
      try {
        db.prepare(
          `INSERT INTO comments (task_id, author, content) VALUES (?, 'saga3-kernel', ?)`,
        ).run(
          binding.control.projected_task_id,
          `Diagnosis report REJECTED: control=${controlIntentId} report=${inserted.record.id} errors=${validationErrors.length > 0 ? validationErrors[0].slice(0, 120) : 'unknown'}`,
        );
      } catch { /* comment is observability only */ }
    } else {
      try {
        db.prepare(
          `INSERT INTO comments (task_id, author, content) VALUES (?, 'saga3-kernel', ?)`,
        ).run(
          binding.control.projected_task_id,
          `Diagnosis report accepted: control=${controlIntentId} report=${inserted.record.id} hash=${inserted.record.content_hash.slice(0, 12)}…`,
        );
      } catch { /* comment is observability only */ }
    }

    return {
      report_id: inserted.record.id,
      content_hash: inserted.record.content_hash,
      status: inserted.record.status,
      replayed: false,
      validation_errors: inserted.record.validation_errors,
    };
  };

  return {
    definitions: [
      {
        name: 'diagnosis_get',
        description: 'Read the immutable DiagnosisCase the kernel built for the exact certificate target, plus the allowed source references a diagnosis advisor may cite and the report output schema.',
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
        name: 'diagnosis_submit',
        description: 'Submit one typed advisory diagnosis report for the immutable certificate target bound to the ControlIntent. The kernel validates it deterministically and accepts or rejects; this never modifies the D4 settlement, certificate, proposal, readiness, or the discovery outcome.',
        inputSchema: {
          type: 'object',
          properties: {
            control_intent_id: { type: 'integer' },
            execution_id: { type: 'string' },
            schema_version: { type: 'string', enum: [DISCOVERY_DIAGNOSIS_REPORT_SCHEMA] },
            payload: { type: 'object' },
          },
          required: ['control_intent_id', 'execution_id', 'schema_version', 'payload'],
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
    handlers: {
      diagnosis_get: diagnosisGet,
      diagnosis_submit: diagnosisSubmit,
    },
  };
}

/** Provenance captured for a diagnosis report submission (separate from D4). */
export interface DiagnosisProvenance {
  model: string | null;
  provider: string;
  effort: string | null;
  worker_id: string;
  execution_id: string;
  submitted_at: string;
}

function integerArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`diagnosis: '${key}' must be an integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`diagnosis: '${key}' must be a non-empty string`);
  }
  return v;
}

// Re-export so the composition root / tests can reference the contract version.
export { DISCOVERY_DIAGNOSIS_CONTRACT_VERSION };
