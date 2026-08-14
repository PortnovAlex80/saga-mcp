// src/infrastructure/replay/replay-key-material.ts
//
// P6 of the desync map — the SINGLE resolver for replay key material.
//
// Two independent resolvers previously duplicated this SQL and the
// subject-production digest formula with DIVERGENT semantics: the claim-side
// resolver silently fell back to `process_node_input_hash` (run-scoped
// provenance — a key that can never match cross-run), while the
// certification-side resolver required the frozen cross-run
// `semantic_input_digest`. A capsule claimed under one semantics could be
// uncertifiable under the other. Live data shows the fallback path is dead
// (every conveyor task carries semantic_input_digest), so the STRICT
// semantics is the single canonical one, exported from here for both sides.
//
// Typed-submission products have stable digests. Managed-production products
// carry run-specific provenance; resolve to the stable projection.

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';
import {
  computeReplayKey,
  type ReplayKeyMaterial,
} from '../../replay/replay-capsule.js';
import {
  isWorkplaceProductionSnapshot,
  workplaceProductionSemanticDigest,
} from '../../process-modules/shared/workplace-production-snapshot.js';

export { computeReplayKey };
export type { ReplayKeyMaterial };

/** Minimal task shape the resolver reads — structural, not a domain import. */
export interface ReplayTaskBinding {
  readonly id: number;
  readonly epic_id: number;
  readonly metadata: string | null;
  readonly workplace_ref: string | null;
}

export function resolveStableProductDigest(
  db: Database.Database,
  schemaId: string,
  ref: string,
  digest: string,
): string {
  if (ref.startsWith('managed-node-submission:')) return digest;
  const row = db.prepare(
    `SELECT payload_snapshot FROM factory_process_products
      WHERE schema_id=? AND artifact_ref=? AND product_hash=?`,
  ).get(schemaId, ref, digest) as { payload_snapshot: string } | undefined;
  if (!row) return digest;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_snapshot);
  } catch {
    return digest;
  }
  if (!isWorkplaceProductionSnapshot(payload)) return digest;
  return workplaceProductionSemanticDigest(payload);
}

function metadataObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function readWorkplaceRefForTask(
  db: Database.Database,
  task: ReplayTaskBinding,
): string | null {
  if (task.workplace_ref) return task.workplace_ref;
  const row = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(task.id) as { workplace_ref: string | null } | undefined;
  return row?.workplace_ref ?? null;
}

/**
 * The canonical STRICT replay key material resolver. Returns null when the
 * task lacks the frozen cross-run semantic identity (replay is then not
 * allowed — the caller decides how to represent the non-replayable claim).
 *
 * A reviewer's key additionally binds its subject: the authority-accepted
 * author CandidateSet (resolved by EXACT final-accepted gate decision, ADR-053
 * cutover), never sealed_at recency.
 */
export function resolveReplayKeyMaterial(
  db: Database.Database,
  task: ReplayTaskBinding,
  role: 'author' | 'reviewer',
): ReplayKeyMaterial | null {
  const metadata = metadataObject(task.metadata);
  const processRunId = Number(metadata.process_run_id);
  const nodeId = requiredString(metadata.process_node_id);
  const moduleRef = requiredString(metadata.process_module_ref);
  const productionCellId = requiredString(metadata.production_cell_id);
  const workKey = requiredString(metadata.work_key);

  // Raw nodeInputHash may contain run provenance. Replay is allowed only when
  // an explicit cross-run semantic digest was frozen by the producer runtime.
  const semanticInputDigest = requiredString(metadata.semantic_input_digest);
  if (!Number.isSafeInteger(processRunId) || processRunId <= 0
      || !nodeId || !moduleRef || !productionCellId || !workKey || !semanticInputDigest) {
    return null;
  }
  const run = db.prepare(
    'SELECT project_id,package_digest FROM factory_process_runs WHERE id=?',
  ).get(processRunId) as { project_id: number; package_digest: string | null } | undefined;
  if (!run?.package_digest) return null;

  let subjectProductionDigest: string | null = null;
  if (role === 'reviewer') {
    const workplaceRef = readWorkplaceRefForTask(db, task);
    if (!workplaceRef) return null;
    // ADR-053 cutover: resolve the accepted author set by EXACT gate-decision
    // ref, NOT by sealed_at recency. The reviewer's subject is the
    // authority-accepted author CandidateSet.
    const authorSet = db.prepare(
      `SELECT accepted_author_candidate_set_ref AS candidate_set_ref
         FROM factory_accepted_authority_head
        WHERE workplace_ref=?`,
    ).get(workplaceRef) as { candidate_set_ref: string } | undefined;
    if (!authorSet) return null;
    const members = db.prepare(
      `SELECT product_schema,product_ref,product_digest
         FROM factory_candidate_set_members
        WHERE candidate_set_ref=?
        ORDER BY product_schema,product_digest`,
    ).all(authorSet.candidate_set_ref) as Array<{
      product_schema: string;
      product_ref: string;
      product_digest: string;
    }>;
    if (members.length === 0) return null;
    subjectProductionDigest = sha256Hex(
      members.map(member => ({
        schemaId: member.product_schema,
        digest: resolveStableProductDigest(db, member.product_schema, member.product_ref, member.product_digest),
      })),
    );
  }

  return {
    projectId: run.project_id,
    moduleRef,
    nodeId,
    productionCellId,
    workKey,
    role,
    packageDigest: run.package_digest,
    semanticInputDigest,
    subjectProductionDigest,
  };
}
