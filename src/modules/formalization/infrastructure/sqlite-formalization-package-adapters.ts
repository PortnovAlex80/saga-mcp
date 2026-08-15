/**
 * W8-A6 — SQLite-backed implementations of the formalization package ports.
 *
 * Plan §0.11.7. Spec:
 * `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The package ports (`./formalization-package-ports.ts`) are pure interfaces —
 * no substrate. Production needs concrete implementations wired by the
 * composition root. This file provides the SQLite-backed implementations:
 *
 *   - `SqliteFormalizationBriefProvisioning` implements
 *     `FormalizationBriefProvisioningPort` — the exact brief-read/insert/trace
 *     the port and constructed with an explicit `Database` handle (no global
 *     lookup).
 *
 *   - `SqliteFormalizationManagedProduction` implements
 *     `FormalizationManagedProductionPort` — a thin bridge from the
 *     module-local port to the shared `ManagedProductionLedger`, so a handler
 *     depends on the formalization-owned port, not on `persistence/` directly.
 *
 * ── Layering ───────────────────────────────────────────────────────────────
 *
 * This file imports `better-sqlite3` and the shared managed-production ledger.
 * That makes it a Rule 2 violation (module imports a persistence adapter /
 * substrate) — the SAME classification as the existing
 * `./sqlite-formalization-kernel.ts` sibling. It is allowlisted in
 * `tests/architecture/dependency-direction.test.mjs` under the
 * `modulePorts` reason ("Phase 4/5 moves persistence behind module-local
 * ports") — which is exactly what this file IS: the module-local port adapter
 * that lets the handler stop importing the substrate.
 *
 * The whole point of the ports/adapter split is that THIS file is the ONLY
 * formalization file that touches the substrate; every other formalization
 * file depends on the port interface.
 */

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  FormalizationBriefProvisioningContext,
  FormalizationBriefProvisioningOutcome,
  FormalizationBriefProvisioningPort,
  FormalizationManagedArtifactWrite,
  FormalizationManagedProductionPort,
  FormalizationManagedTraceWrite,
  FormalizationPackagePorts,
  FormalizationPrdRootRead,
} from '../../../process-modules/modules/formalization/package/ports/formalization-package-ports.js';
import type {
  FormalizationCanonicalGraphPort,
  ManagedArtifactProductionRecord,
  ManagedProductionLedger,
  ManagedTraceProductionRecord,
} from '../domain/formalization-kernel-ports.js';

// ---------------------------------------------------------------------------
// Brief provisioning adapter.
// ---------------------------------------------------------------------------

/**
 * Product types that are NOT valid root ancestors for a PRD. A PRD's root must
 * be a discovery-side artifact (brief/decision/discovery-doc/…) — anything in
 * this set is a peer formalization artifact and does not count as a root.
 * `findContractGap` `OWN_PRODUCT_TYPES` set.
 */
const PRD_ROOT_EXCLUDED_TYPES = new Set([
  'PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS',
]);

/**
 * `ensureBriefRootTrace` performed via `getDb()`:
 *
 *   read  — `SELECT target_id, type FROM artifact_traces JOIN artifacts …`
 *           (does the PRD already have a non-product derived_from target?)
 *   find  — `SELECT id FROM artifacts WHERE epic_id=? AND type='brief' AND
 *           status='accepted'`
 *   create— `INSERT INTO artifacts (…, 'brief', …)` (synthetic brief)
 *   link  — `INSERT OR IGNORE INTO artifact_traces (source_id, target_type,
 *           target_id, link_type)`
 *
 * The constructor takes the `Database` handle explicitly — there is NO
 * `getDb()` call here. The composition root owns the handle and injects it.
 */
export class SqliteFormalizationBriefProvisioning
implements FormalizationBriefProvisioningPort {
  constructor(private readonly db: Database.Database) {}

  readPrdRoot(prdArtifactId: number): FormalizationPrdRootRead {
    const rows = this.db.prepare(
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
    const derivedFromTargetIds = rows.map(r => r.targetId);
    const acceptedRootArtifactIds = rows
      .filter(r =>
        !PRD_ROOT_EXCLUDED_TYPES.has(r.type)
        && r.status === 'accepted'
        && r.acceptedHash !== null
        && r.contentHash !== null
        && r.acceptedHash === r.contentHash
        && r.driftState === 'clean')
      .map(r => r.targetId);
    return { derivedFromTargetIds, acceptedRootArtifactIds };
  }

  provisionBriefRoot(
    ctx: FormalizationBriefProvisioningContext,
  ): FormalizationBriefProvisioningOutcome {
    // 1. Pre-check: does the PRD already have an accepted non-product root?
    const root = this.readPrdRoot(ctx.prdArtifactId);
    if (root.acceptedRootArtifactIds.length > 0) {
      return {
        status: 'already-rooted',
        rootArtifactId: root.acceptedRootArtifactIds[0],
      };
    }

    // 2. Also bail if the PRD already has ANY root trace to a non-product type
    //    when `existing` was found.
    const existingTargets = this.db.prepare(
      `SELECT t.target_id, a.type
         FROM artifact_traces t
         JOIN artifacts a ON a.id = t.target_id
        WHERE t.source_id=? AND t.link_type='derived_from' AND t.target_type='artifact'
          AND a.type NOT IN ('PRD','FR','NFR','RULE','UC','AC','SRS')`,
    ).get(ctx.prdArtifactId) as { target_id: number; type: string } | undefined;
    if (existingTargets) {
      return {
        status: 'already-rooted',
        rootArtifactId: existingTargets.target_id,
      };
    }

    // 3. Find a pre-existing accepted brief in the epic to link to.
    const existing = this.db.prepare(
      `SELECT id FROM artifacts
        WHERE epic_id=? AND type='brief' AND status='accepted'
        ORDER BY id LIMIT 1`,
    ).get(ctx.epicId) as { id: number } | undefined;
    let briefId = existing?.id;
    let newlyCreated = false;

    //    code) so the PRD has a valid root ancestor.
    if (!briefId) {
      const content = {
        schema: 'factory.discovery-brief.v1',
        epic_id: ctx.epicId,
        process_run_id: ctx.processRunId,
        note: 'Auto-provisioned by formalization resolver',
      };
      const briefHash = sha256Hex(content);
      // db_native: no physical file. Canonical content persisted in
      // metadata.content so checkpoint capture can verify integrity without
      // a file. No repository binding (db_native does not require one).
      const metadata = JSON.stringify({
        storage_kind: 'db_native',
        content_schema: 'factory.discovery-brief.v1',
        content,
      });
      const result = this.db.prepare(
        `INSERT INTO artifacts
           (project_id, epic_id, type, code, title, path, status,
            content_hash, accepted_hash, drift_state, storage_kind, tags, metadata)
         VALUES (?, ?, 'brief', 'BRIEF-1', 'Discovery Brief (auto-provisioned)',
                 'docs/discovery/brief-auto-provisioned.md', 'accepted',
                 ?, ?, 'clean', 'db_native', '[]', ?) RETURNING id`,
      ).get(ctx.projectId, ctx.epicId, briefHash, briefHash, metadata) as { id: number };
      briefId = result.id;
      newlyCreated = true;
    }

    // 5. Attach the derived_from trace (idempotent via INSERT OR IGNORE).
    this.db.prepare(
      `INSERT OR IGNORE INTO artifact_traces
         (source_id, target_type, target_id, link_type)
       VALUES (?, 'artifact', ?, 'derived_from')`,
    ).run(ctx.prdArtifactId, briefId);

    return { status: 'root-attached', briefArtifactId: briefId, newlyCreated };
  }
}

// ---------------------------------------------------------------------------
// Managed-production adapter (bridge to the shared ledger).
// ---------------------------------------------------------------------------

/**
 * Bridge the module-local `FormalizationManagedProductionPort` to the shared
 * `ManagedProductionLedger`. The shared ledger already isolates the SQL; this
 * adapter only translates the module-local query type to the shared one so a
 * formalization handler depends on its own port, not on `persistence/`.
 *
 * The translation is a pure type cast: the two query shapes are
 * byte-for-byte compatible (same field names, same types). The artifact/trace
 * records are likewise structurally compatible; this adapter normalizes the
 * optional `contentHash: string | null` of the shared record to the
 * non-nullable `string` of the module-local write (the formalization handlers
 * only ever see records with a non-null hash — a null hash is an upstream
 * invariant violation that would have failed earlier).
 */
export class SqliteFormalizationManagedProduction
implements FormalizationManagedProductionPort {
  constructor(private readonly ledger: ManagedProductionLedger) {}

  // WAVE 6 CUTOVER: listArtifactsForExecution / listTracesForExecution were
  // removed (execution-scoped product lookup fallbacks). The node-scope
  // variants below are the canonical path. See
  // tests/architecture/no-execution-scoped-lookup.test.mjs.

  listArtifactsForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly FormalizationManagedArtifactWrite[] {
    return this.ledger
      .listArtifactsForTaskInProcessRun(
        processRunId,
        moduleRef,
        nodeId,
        taskId,
      )
      .map(toManagedArtifactWrite);
  }

  listTracesForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly FormalizationManagedTraceWrite[] {
    return this.ledger
      .listTracesForTaskInProcessRun(
        processRunId,
        moduleRef,
        nodeId,
        taskId,
      )
      .map(toManagedTraceWrite);
  }

  listArtifactsForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly FormalizationManagedArtifactWrite[] {
    return this.ledger
      .listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId)
      .map(toManagedArtifactWrite);
  }

  listTracesForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly FormalizationManagedTraceWrite[] {
    return this.ledger
      .listTracesForNodeInProcessRun(processRunId, moduleRef, nodeId)
      .map(toManagedTraceWrite);
  }
}

function toManagedArtifactWrite(
  record: ManagedArtifactProductionRecord,
): FormalizationManagedArtifactWrite {
  return {
    ledgerId: record.ledgerId,
    artifactId: record.artifactId,
    artifactType: record.artifactType,
    artifactStatus: record.artifactStatus,
    contentHash: record.contentHash ?? '',
    processRunId: record.processRunId,
    moduleRef: record.moduleRef,
    nodeId: record.nodeId,
    intentId: record.intentId,
    taskId: record.taskId,
    executionId: record.executionId,
  };
}

function toManagedTraceWrite(
  record: ManagedTraceProductionRecord,
): FormalizationManagedTraceWrite {
  return {
    ledgerId: record.ledgerId,
    traceId: record.traceId,
    sourceId: record.sourceId,
    targetType: record.targetType,
    targetId: record.targetId,
    linkType: record.linkType,
    traceHash: record.traceHash,
    processRunId: record.processRunId,
    moduleRef: record.moduleRef,
    nodeId: record.nodeId,
    intentId: record.intentId,
    taskId: record.taskId,
    executionId: record.executionId,
  };
}

// ---------------------------------------------------------------------------
// Composition helper — build the full port bundle from concrete substrates.
// ---------------------------------------------------------------------------

/**
 * Build a production-ready `FormalizationPackagePorts` from the concrete
 * substrates the composition root already holds. This is the one call a
 * Wave 11 composition root makes to get a fully port-injected formalization
 * bundle — no `getDb()` anywhere in the resulting handler graph.
 *
 * `graph` is the existing dependency-clean graph port (e.g.
 * `SqliteFormalizationArtifactGraph`). `db` is the explicit handle. `ledger`
 * is the shared managed-production ledger.
 */
export function buildSqliteFormalizationPackagePorts(
  graph: FormalizationCanonicalGraphPort,
  db: Database.Database,
  ledger: ManagedProductionLedger,
): FormalizationPackagePorts {
  return {
    graph,
    managedProduction: new SqliteFormalizationManagedProduction(ledger),
    briefProvisioning: new SqliteFormalizationBriefProvisioning(db),
  };
}
