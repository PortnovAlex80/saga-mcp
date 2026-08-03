/**
 * Concrete brief-provisioning port adapters (Wave 7 hex extraction).
 *
 * These are the infrastructure-side adapters for the Formalization and
 * Discovery modules' `BriefProvisioningPort` / `DiscoveryBriefProvisioningPort`
 * driver-neutral ports. They keep `better-sqlite3` (and therefore the global
 * `getDb()` lookup) out of the modules — the modules speak the port, this file
 * owns the substrate.
 *
 * The composition root constructs one of these with the explicit `Database`
 * handle and injects it into the module's installation deps. Once wired, the
 * modules' `getDb()`-backed defaults are no longer reached and the `getDb`
 * import can be removed from the module files.
 */

import type Database from 'better-sqlite3';
import type {
  BriefProvisioningContext,
  BriefProvisioningPort,
} from '../../modules/formalization/domain/formalization-kernel-ports.js';
import type {
  DiscoveryBriefProvisioningContext,
  DiscoveryBriefProvisioningPort,
} from '../../modules/discovery/application/discovery-installation.js';
import { sha256Hex } from '../../process-modules/shared/canonical-json.js';

/**
 * Product types that are NOT valid root ancestors for a PRD. A PRD's root must
 * be a discovery-side artifact (brief/decision/discovery-doc/…) — anything in
 * this set is a peer formalization artifact and does not count as a root.
 */
const PRD_ROOT_EXCLUDED_TYPES = new Set([
  'PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS',
]);

/**
 * SQLite-backed adapter for the Formalization module's `BriefProvisioningPort`.
 *
 * Implements the exact brief-provisioning logic the legacy
 * `ensureBriefRootTrace` performed via `getDb()`: check whether the PRD already
 * has a non-product `derived_from` target; if not, find-or-create a synthetic
 * accepted brief in the epic and attach the idempotent `derived_from` trace.
 *
 * The constructor takes the `Database` handle explicitly — there is NO
 * `getDb()` call here. The composition root owns the handle and injects it.
 */
export class SqliteFormalizationBriefProvisioning
implements BriefProvisioningPort {
  constructor(private readonly db: Database.Database) {}

  ensureBriefRoot(ctx: BriefProvisioningContext): void {
    // 1. Bail if the PRD already has ANY root trace to a non-product type
    //    (matches the legacy guard that returned early when `existing` was
    //    found). The graph-port pre-check in the module already short-circuits
    //    the accepted-brief case; this covers unaccepted ancestors too.
    const existing = this.db.prepare(
      `SELECT t.target_id, a.type
         FROM artifact_traces t
         JOIN artifacts a ON a.id = t.target_id
        WHERE t.source_id=? AND t.link_type='derived_from' AND t.target_type='artifact'
          AND a.type NOT IN ('PRD','FR','NFR','RULE','UC','AC','SRS')`,
    ).get(ctx.prdArtifactId) as { target_id: number; type: string } | undefined;
    if (existing) return;

    // 2. Find a pre-existing accepted brief in the epic to link to.
    let briefId = (this.db.prepare(
      `SELECT id FROM artifacts
        WHERE epic_id=? AND type='brief' AND status='accepted'
        ORDER BY id LIMIT 1`,
    ).get(ctx.epicId) as { id: number } | undefined)?.id;

    // 3. Otherwise create a synthetic brief (same hash recipe as the legacy
    //    code) so the PRD has a valid root ancestor.
    if (!briefId) {
      const briefHash = sha256Hex({
        schema: 'saga3.discovery-brief.v1',
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

    // 4. Attach the derived_from trace (idempotent via INSERT OR IGNORE).
    this.db.prepare(
      `INSERT OR IGNORE INTO artifact_traces
         (source_id, target_type, target_id, link_type)
       VALUES (?, 'artifact', ?, 'derived_from')`,
    ).run(ctx.prdArtifactId, briefId);
  }
}

/**
 * Read-only companion: does the PRD already have an accepted non-product root?
 * Exposed for tests / observers that want to assert provisioning state without
 * triggering a write. Not part of the module port surface.
 */
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

/**
 * SQLite-backed adapter for the Discovery module's
 * `DiscoveryBriefProvisioningPort`.
 *
 * Implements the exact brief-provisioning logic the legacy
 * `ensureDiscoveryBriefArtifact` performed via `getDb()`: idempotently
 * find-or-create a synthetic accepted brief derived from the accepted proposal.
 *
 * The constructor takes the `Database` handle explicitly — there is NO
 * `getDb()` call here. The composition root owns the handle and injects it.
 */
export class SqliteDiscoveryBriefProvisioning
implements DiscoveryBriefProvisioningPort {
  constructor(private readonly db: Database.Database) {}

  ensureDiscoveryBrief(ctx: DiscoveryBriefProvisioningContext): void {
    // Idempotent: if a brief already exists for this epic, do nothing.
    const existing = this.db.prepare(
      "SELECT id FROM artifacts WHERE epic_id=? AND type='brief' AND status='accepted' ORDER BY id LIMIT 1",
    ).get(ctx.epicId) as { id: number } | undefined;
    if (existing) return;

    const briefHash = sha256Hex({
      schema: 'saga3.discovery-brief.v1',
      epic_id: ctx.epicId,
      problem_statement: ctx.proposalPayload?.problem_statement ?? null,
      candidate_scope: ctx.proposalPayload?.candidate_scope ?? null,
      recommended_outcome: ctx.proposalPayload?.recommended_outcome ?? null,
      note: 'Auto-provisioned by discovery proposal resolver',
    });
    this.db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (?, ?, 'brief', 'BRIEF-1', 'Discovery Brief', 'docs/discovery/brief-auto-provisioned.md', 'accepted', ?, ?, 'clean', '[]', '{}')`,
    ).run(ctx.projectId, ctx.epicId, briefHash, briefHash);
  }
}
