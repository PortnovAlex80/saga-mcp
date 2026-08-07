/**
 * Discovery Proposal Compatibility Projection (CONVEYOR v4.3 PART 5-7).
 *
 * `factory_proposals` is the D3/D4/D5 settlement spine: readiness controls,
 * settlements, and outcome certificates FK-reference it and depend on its
 * `source_submission_id` lineage column. The universal
 * `factory_managed_node_submissions` boundary is schema-generic and has no
 * equivalent column.
 *
 * This projection recreates the `factory_proposals` row DETERMINISTICALLY from
 * a current-run managed submission, so that:
 *
 *   Inference:  product_submit(P) → managed submission → projection → readiness Gate
 *   Replay:     product_submit(P) → managed submission → projection → readiness Gate
 *
 * The readiness Gate cannot distinguish how P was produced. This is the
 * architectural criterion (CONVEYOR v4.3 PART 6).
 *
 * The projection is idempotent: ON CONFLICT(intent_id, execution_id,
 * content_hash) DO NOTHING. It derives all fields from the managed submission
 * row + the frozen execution context. It does NOT store worker-supplied
 * provenance — provenance is captured from the execution fence.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { DISCOVERY_PROPOSAL_SCHEMA } from '../domain/discovery-proposal.js';
import { DISCOVERY_INTENT_KIND } from '../../../shared/work-intent.js';
import { canonicalJson } from './discovery-normalization-repository.js';

/** Schemas that trigger the Discovery proposal compatibility projection. */
const PROJECTION_SCHEMAS = new Set<string>([DISCOVERY_PROPOSAL_SCHEMA]);

/**
 * Returns true when a managed submission's schema requires the Discovery
 * proposal compatibility projection.
 */
export function requiresDiscoveryProjection(schema: string): boolean {
  return PROJECTION_SCHEMAS.has(schema);
}

/**
 * Deterministically project a managed submission into factory_proposals.
 *
 * Called after `product_submit` (or `proposal_submit`) writes the managed
 * submission. Reads the submission row + the frozen execution context to derive
 * the projection fields. Idempotent.
 *
 * Returns the proposal id (existing or newly inserted), or null when the
 * submission is not a Discovery proposal / the execution context lacks the
 * required WorkIntent binding.
 */
export function projectDiscoveryProposal(
  db: Database.Database,
  input: { submissionId: number },
): { proposalId: number; contentHash: string; replayed: boolean } | null {
  const sub = db.prepare(
    `SELECT id, process_run_id, module_ref, node_id, intent_id, task_id,
            execution_id, schema_version, payload_snapshot, content_hash
       FROM factory_managed_node_submissions WHERE id=?`,
  ).get(input.submissionId) as {
    id: number;
    process_run_id: number;
    module_ref: string;
    node_id: string;
    intent_id: number | null;
    task_id: number;
    execution_id: string;
    schema_version: string;
    payload_snapshot: string;
    content_hash: string;
  } | undefined;
  if (!sub) return null;
  if (!requiresDiscoveryProjection(sub.schema_version)) return null;
  if (sub.intent_id === null) return null;

  // The managed submission already stores canonical JSON in payload_snapshot
  // and its SHA-256 in content_hash. The factory_proposals row uses the same
  // canonical encoding, so the content_hash is identical.
  const payloadText = sub.payload_snapshot;
  const contentHash = sub.content_hash;
  // Verify the hash matches (defense in depth).
  const verifyHash = createHash('sha256').update(payloadText).digest('hex');
  if (verifyHash !== contentHash) {
    // The managed submission may store a non-canonical payload_snapshot. Re-canonicalize.
    const parsed = JSON.parse(payloadText) as unknown;
    const canonicalPayloadText = canonicalJson(parsed);
    const canonicalHash = createHash('sha256').update(canonicalPayloadText).digest('hex');
    if (canonicalHash !== contentHash) {
      throw new Error(
        `DISCOVERY_PROJECTION_HASH_MISMATCH: managed submission ${sub.id} content_hash does not match payload`,
      );
    }
  }

  // Derive provenance from the frozen execution context.
  const execRow = db.prepare(
    'SELECT worker_id, metadata FROM worker_executions WHERE execution_id=?',
  ).get(sub.execution_id) as {
    worker_id: string;
    metadata: string;
  } | undefined;
  if (!execRow) return null;
  let modelRoute: { provider: string | null; model: string | null; effort: string | null } = {
    provider: null, model: null, effort: null,
  };
  try {
    const envelope = JSON.parse(execRow.metadata) as {
      execution_context?: { model_route?: { provider: string | null; model: string | null; effort: string | null } };
    };
    if (envelope?.execution_context?.model_route) {
      modelRoute = envelope.execution_context.model_route;
    }
  } catch { /* provenance best-effort */ }

  const provenance = {
    model: modelRoute.model,
    provider: modelRoute.provider,
    effort: modelRoute.effort,
    worker_id: execRow.worker_id,
    execution_id: sub.execution_id,
    submitted_at: new Date().toISOString(),
    normalization_mode: 'deterministic',
  };

  const insertResult = db.prepare(
    `INSERT INTO factory_proposals
       (intent_id, task_id, execution_id, kind, schema_version, payload, content_hash, status, provenance)
     VALUES (?,?,?,?,?,?,?, 'submitted', ?)
     ON CONFLICT(intent_id, execution_id, content_hash) DO NOTHING`,
  ).run(
    sub.intent_id,
    sub.task_id,
    sub.execution_id,
    DISCOVERY_INTENT_KIND,
    sub.schema_version,
    payloadText,
    contentHash,
    JSON.stringify(provenance),
  );

  const proposal = db.prepare(
    `SELECT id FROM factory_proposals
      WHERE intent_id=? AND execution_id=? AND content_hash=?`,
  ).get(sub.intent_id, sub.execution_id, contentHash) as { id: number } | undefined;
  if (!proposal) {
    throw new Error(
      'DISCOVERY_PROJECTION_VANISHED: factory_proposals row not found after projection insert',
    );
  }
  return {
    proposalId: proposal.id,
    contentHash,
    replayed: insertResult.changes === 0,
  };
}
