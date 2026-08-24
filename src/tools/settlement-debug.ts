// Settlement debugger — read-only causal trace tool.
//
// WHY THIS EXISTS (Insight 5 from post-migration analysis):
// When a ProcessRun settles with decision `inconsistent` or `clarification-required`,
// the operator (human or LLM agent) asks "WHY?" — what check failed, which artifact
// has a broken trace edge, which gap caused the decision. The answer IS in the database
// (factory_node_runs.output_bindings contains per-node `gap` strings;
// factory_process_outcome_certificates contains decision + reason_codes + rationale),
// but NO tool exposed it. This tool closes that observability gap by joining the
// causal chain from ProcessRun → certificate → per-node bindings into one structured trace.
//
// This is Option 1 (read-only query) from the settlement-debugger design. It requires
// zero schema changes and zero handler modifications — it only reads and decodes what
// the runtime already persists.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Tool definition (MCP surface)
// ---------------------------------------------------------------------------

export const definitions: Tool[] = [
  {
    name: 'settlement_explain',
    description:
      'Explain WHY a ProcessRun settled with its decision. Returns the full causal trace: ' +
      'the certificate (decision, reason_codes, rationale, decoded payload), plus each node\'s ' +
      'output bindings (gap string, unaccepted artifacts, baseline drift, trace digest, ' +
      'ledger write ids) in execution order. Read-only diagnostic — use this to answer "why did ' +
      'settlement produce inconsistent/clarification-required/reject?" without manual SQL.',
    annotations: {
      title: 'Settlement: Explain Decision',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        process_run_id: {
          type: 'number',
          description: 'The ProcessRun id to trace.',
        },
      },
      required: ['process_run_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handlers: Record<string, ToolHandler> = {
  settlement_explain: handleSettlementExplain,
};

function handleSettlementExplain(args: Record<string, unknown>): unknown {
  const processRunId = requiredNumber(args, 'process_run_id');
  const db = getDb();

  // 1. ProcessRun row — status, outcome, certificate ref, authority.
  const run = db.prepare(`
    SELECT id, module_ref_key, status, local_outcome, authority,
           output_schema, output_ref, output_hash,
           certificate_schema, certificate_ref, certificate_hash,
           error, active_issue_ref, active_issue_hash
      FROM factory_process_runs WHERE id = ?
  `).get(processRunId) as Record<string, unknown> | undefined;
  if (!run) throw new Error(`process_run ${processRunId} not found`);

  // 2. Certificate row — decision, reason_codes, rationale, input_hash, payload.
  let certificate = null;
  try {
    const cert = db.prepare(`
      SELECT id, process_run_id, decision, reason_codes, rationale,
             input_hash, certificate_payload, certificate_hash,
             authority, issued_at
        FROM factory_process_outcome_certificates WHERE process_run_id = ?
    `).get(processRunId) as Record<string, unknown> | undefined;
    if (cert) {
      certificate = {
        id: cert.id,
        decision: cert.decision,
        reasonCodes: safeJsonArray(cert.reason_codes),
        rationale: cert.rationale,
        inputHash: cert.input_hash,
        certificatePayload: safeJson(cert.certificate_payload),
        certificateHash: cert.certificate_hash,
        authority: cert.authority,
        issuedAt: cert.issued_at,
      };
    }
  } catch {
    // Table may not exist on old DBs — certificate stays null.
  }

  // 3. NodeRun rows — per-node output bindings + completion, in execution order.
  let nodeTrace: unknown[] = [];
  try {
    const rows = db.prepare(`
      SELECT id, process_run_id, node_id, attempt, status,
             output_schema, output_hash, output_bindings,
             completion, completion_hash,
             execution_receipt
        FROM factory_node_runs WHERE process_run_id = ? ORDER BY id ASC
    `).all(processRunId) as Record<string, unknown>[];
    nodeTrace = rows.map(row => decodeNodeRun(row));
  } catch {
    // Table may not exist on old DBs — nodeTrace stays empty.
  }

  // 4. Discovery-specific settlement — REMOVED (ADR-095 Phase 3.2, 2026-08-24):
  // the legacy Discovery settlement-snapshot query over the D4 legacy table is
  // gone; the generic certificate/node trace above is the tool's whole surface.
  // The tool itself stays for non-Discovery traces; no live code reads the
  // legacy settlement table anymore.

  return {
    run: {
      processRunId: run.id,
      moduleRef: run.module_ref_key,
      status: run.status,
      localOutcome: run.local_outcome,
      authority: run.authority,
      output: run.output_schema ? {
        schema: run.output_schema,
        ref: run.output_ref,
        hash: run.output_hash,
      } : null,
      certificate: run.certificate_schema ? {
        schema: run.certificate_schema,
        ref: run.certificate_ref,
        hash: run.certificate_hash,
      } : null,
      error: run.error,
      activeIssue: run.active_issue_ref ?? run.active_issue_hash,
    },
    certificate,
    nodeTrace,
  };
}

// ---------------------------------------------------------------------------
// NodeRun decoder — extracts the per-node decision-relevant fields from
// output_bindings (the KernelHandlerResult.production.bindings JSON).
// ---------------------------------------------------------------------------

function decodeNodeRun(row: Record<string, unknown>): unknown {
  const bindings = safeJson(row.output_bindings);
  const completion = safeJson(row.completion);
  const receipt = safeJson(row.execution_receipt);

  // Extract the causal fields from bindings. These are written by the
  // formalization/development/delivery manifestResult helpers and the
  // discovery settlement service.
  const extracted = bindings && typeof bindings === 'object'
    ? extractCausalFields(bindings as Record<string, unknown>)
    : { gap: null, unacceptedArtifactIds: null, baselineDriftArtifactIds: null, traceDigest: null, ledgerArtifactWriteIds: null, categoryBindings: null };

  return {
    nodeId: row.node_id,
    attempt: row.attempt,
    status: row.status,
    output: row.output_schema ? {
      schema: row.output_schema,
      hash: row.output_hash,
    } : null,
    bindings: extracted,
    completion: completion && typeof completion === 'object'
      ? {
          outcome: (completion as Record<string, unknown>).outcome ?? null,
          terminal: (completion as Record<string, unknown>).terminal ?? null,
          certificateRef: extractCertificateRef(completion as Record<string, unknown>),
        }
      : null,
    executionReceipt: receipt && typeof receipt === 'object'
      ? {
          taskId: (receipt as Record<string, unknown>).taskId ?? null,
          executionId: (receipt as Record<string, unknown>).executionId ?? null,
        }
      : null,
  };
}

/**
 * Pull the decision-relevant fields out of a node's output_bindings object.
 * These are the keys written by manifestResult() in each module's installation:
 *   - gap: the aggregated traceability gap string from findContractGap (null = clean)
 *   - unacceptedArtifactIds: artifacts the worker tried to write but were rejected
 *   - baselineDriftArtifactIds: artifacts that drifted from the accepted baseline
 *   - traceDigest: sha256 of the canonical trace set (detects graph mutations)
 *   - ledgerArtifactWriteIds: managed-production ledger row ids for this node
 *   - categoryBindings: the per-type counts (PRD/FR/UC/AC/SRS etc.)
 *
 * Not all modules write all fields — any missing key is returned as null.
 */
function extractCausalFields(bindings: Record<string, unknown>): Record<string, unknown> {
  return {
    gap: bindings.gap ?? bindings.settlementError ?? null,
    unacceptedArtifactIds: bindings.unacceptedArtifactIds ?? null,
    baselineDriftArtifactIds: bindings.baselineDriftArtifactIds ?? null,
    traceDigest: bindings.traceDigest ?? null,
    ledgerArtifactWriteIds: bindings.ledgerArtifactWriteIds ?? null,
    categoryBindings: bindings.categoryBindings ?? null,
  };
}

/**
 * Drill into completion.outputEnvelope.certificateRef — the content-addressed
 * pointer to the factory_process_outcome_certificates row this node produced.
 */
function extractCertificateRef(completion: Record<string, unknown>): unknown {
  const env = completion.outputEnvelope;
  if (env && typeof env === 'object') {
    return (env as Record<string, unknown>).certificateRef ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON helpers — defensive parsing of columns that may be null, malformed,
// or absent on older database schemas.
// ---------------------------------------------------------------------------

function safeJson(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw; // already parsed (better-sqlite3 may do this)
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // return raw string if not valid JSON
  }
}

function safeJsonArray(raw: unknown): unknown[] {
  const parsed = safeJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

// ---------------------------------------------------------------------------
// Arg helpers (same pattern as process-modules.ts)
// ---------------------------------------------------------------------------

function requiredNumber(args: Record<string, unknown>, field: string): number {
  const v = args[field];
  if (v === undefined || v === null) throw new Error(`Missing required field: ${field}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Field ${field} must be a finite number, got: ${v}`);
  return n;
}
