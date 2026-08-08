/**
 * Discovery Proposal compatibility projection.
 *
 * `factory_proposals` remains a deterministic compatibility/read-model spine
 * for legacy Discovery settlement consumers. It is projected only from the
 * universal managed submission produced by `product_submit`, so inference and
 * replay share the exact same production boundary.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { DISCOVERY_PROPOSAL_SCHEMA } from '../domain/discovery-proposal.js';
import { DISCOVERY_INTENT_KIND } from '../../../shared/work-intent.js';
import { canonicalJson } from './discovery-normalization-repository.js';

const PROJECTION_SCHEMAS = new Set<string>([DISCOVERY_PROPOSAL_SCHEMA]);

export function requiresDiscoveryProjection(schema: string): boolean {
  return PROJECTION_SCHEMAS.has(schema);
}

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
  if (!sub || !requiresDiscoveryProjection(sub.schema_version) || sub.intent_id === null) {
    return null;
  }

  const payloadText = sub.payload_snapshot;
  const contentHash = sub.content_hash;
  const verifyHash = createHash('sha256').update(payloadText).digest('hex');
  if (verifyHash !== contentHash) {
    const parsed = JSON.parse(payloadText) as unknown;
    const canonicalPayloadText = canonicalJson(parsed);
    const canonicalHash = createHash('sha256').update(canonicalPayloadText).digest('hex');
    if (canonicalHash !== contentHash) {
      throw new Error(
        `DISCOVERY_PROJECTION_HASH_MISMATCH: managed submission ${sub.id} content_hash does not match payload`,
      );
    }
  }

  const execRow = db.prepare(
    'SELECT worker_id, metadata FROM worker_executions WHERE execution_id=?',
  ).get(sub.execution_id) as {
    worker_id: string;
    metadata: string;
  } | undefined;
  if (!execRow) return null;

  let modelRoute: {
    provider: string | null;
    model: string | null;
    effort: string | null;
  } = { provider: null, model: null, effort: null };
  let capsuleRef: string | null = null;
  try {
    const envelope = JSON.parse(execRow.metadata) as {
      execution_context?: {
        model_route?: {
          provider: string | null;
          model: string | null;
          effort: string | null;
        };
        replay?: { capsule_ref?: string | null };
      };
    };
    if (envelope.execution_context?.model_route) {
      modelRoute = envelope.execution_context.model_route;
    }
    const frozenCapsule = envelope.execution_context?.replay?.capsule_ref;
    capsuleRef = typeof frozenCapsule === 'string' && frozenCapsule.length > 0
      ? frozenCapsule
      : null;
  } catch {
    // Missing optional provenance does not invalidate the immutable product.
  }

  const replayedProduction = capsuleRef !== null;
  const provenance = {
    // model_route remains frozen in ExecutionContext as the route that WOULD
    // have been used on a miss. It is not producer provenance on a capsule hit.
    model: replayedProduction ? null : modelRoute.model,
    provider: replayedProduction ? null : modelRoute.provider,
    effort: replayedProduction ? null : modelRoute.effort,
    worker_id: execRow.worker_id,
    execution_id: sub.execution_id,
    submitted_at: new Date().toISOString(),
    production_source: replayedProduction ? 'replay' : 'inference',
    capsule_ref: capsuleRef,
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
