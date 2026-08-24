import type Database from 'better-sqlite3';
import type {
  BriefProvisioningContext,
  BriefProvisioningPort,
} from '../../modules/formalization/domain/formalization-kernel-ports.js';
import { sha256Hex } from '../../shared/canonical-json.js';

const PRD_ROOT_EXCLUDED_TYPES = new Set([
  'PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS',
]);

/** SQLite adapter for the live Formalization brief-provisioning port. */
export class SqliteFormalizationBriefProvisioning
implements BriefProvisioningPort {
  constructor(private readonly db: Database.Database) {}

  ensureBriefRoot(ctx: BriefProvisioningContext): void {
    const existing = this.db.prepare(
      `SELECT t.target_id, a.type
         FROM artifact_traces t
         JOIN artifacts a ON a.id = t.target_id
        WHERE t.source_id=? AND t.link_type='derived_from' AND t.target_type='artifact'
          AND a.type NOT IN ('PRD','FR','NFR','RULE','UC','AC','SRS')`,
    ).get(ctx.prdArtifactId) as { target_id: number; type: string } | undefined;
    if (existing) return;

    let briefId = (this.db.prepare(
      `SELECT id FROM artifacts
        WHERE epic_id=? AND type='brief' AND status='accepted'
        ORDER BY id LIMIT 1`,
    ).get(ctx.epicId) as { id: number } | undefined)?.id;

    if (!briefId) {
      const briefHash = sha256Hex({
        schema: 'factory.discovery-brief.v1',
        epic_id: ctx.epicId,
        process_run_id: ctx.processRunId,
        note: 'Auto-provisioned by formalization resolver',
      });
      const result = this.db.prepare(
        `INSERT INTO artifacts
           (project_id, epic_id, type, code, title, path, status,
            content_hash, accepted_hash, drift_state, tags, metadata)
         VALUES (?, ?, 'brief', 'BRIEF-1', 'Discovery Brief (auto-provisioned)',
                 'docs/discovery/brief-auto-provisioned.md', 'accepted',
                 ?, ?, 'clean', '[]', '{}') RETURNING id`,
      ).get(ctx.projectId, ctx.epicId, briefHash, briefHash) as { id: number };
      briefId = result.id;
    }

    this.db.prepare(
      `INSERT OR IGNORE INTO artifact_traces
         (source_id, target_type, target_id, link_type)
       VALUES (?, 'artifact', ?, 'derived_from')`,
    ).run(ctx.prdArtifactId, briefId);
  }
}

/** Read-only observer for the live Formalization adapter. */
export function readPrdAcceptedRoot(
  db: Database.Database,
  prdArtifactId: number,
): number | null {
  const rows = db.prepare(
    `SELECT at.target_id AS targetId, a.type AS type,
            a.status AS status, a.accepted_hash AS acceptedHash,
            a.content_hash AS contentHash, a.drift_state AS driftState
       FROM artifact_traces at
       JOIN artifacts a ON a.id = at.target_id
      WHERE at.source_id=? AND at.link_type='derived_from'
        AND at.target_type='artifact'`,
  ).all(prdArtifactId) as Array<{
    targetId: number;
    type: string;
    status: string;
    acceptedHash: string | null;
    contentHash: string | null;
    driftState: string;
  }>;
  const accepted = rows.find(r =>
    !PRD_ROOT_EXCLUDED_TYPES.has(r.type)
    && r.status === 'accepted'
    && r.acceptedHash !== null
    && r.contentHash !== null
    && r.acceptedHash === r.contentHash
    && r.driftState === 'clean');
  return accepted ? accepted.targetId : null;
}
