/**
 * DiscoveryOutcomeCertificateProjection — projects a Discovery D4 certificate
 * (OutcomeCertificateRecord from saga3_discovery_outcome_certificates) into the
 * generic ProcessOutcomeCertificate shape ON THE FLY.
 *
 * This is a PROJECTION, not a copy. The discovery table remains the single
 * source of truth for discovery certificates; this adapter only re-shapes the
 * read view so the generic Process Module tooling (process_run_get, generic
 * certificate listers) can consume discovery certificates through the same
 * interface as formalization/artifact-review certificates.
 *
 * Why a projection (not a migration):
 *   - Discovery D4 already has its provenance chain (proposal → readiness →
 *     settlement → certificate). Copying would break that chain or duplicate it.
 *   - The generic table is for modules that have no prior certificate store.
 *     Discovery does — it just needs to be readable from the generic surface.
 *   - A projection is reversible and zero-cost; a migration is one-way.
 *
 * The adapter is READ-ONLY. Discovery never writes to the generic certificate
 * table; it writes to its own table (via the settlement service) and the
 * projection makes those rows visible generically.
 */

import type Database from 'better-sqlite3';
// CONVEYOR Wave 7 — saga3 cross-tree leak elimination: OutcomeCertificateRecord
// is now declared locally in the discovery module (byte-identical to the saga3
// original). The readOutcomeCertificate SQL was inlined from
// src/saga3/persistence/saga3-settlement-repository.ts so this projection no
// longer reaches outside src/process-modules/.
import type { OutcomeCertificateRecord } from './discovery-domain-contracts.js';
import { DISCOVERY_PROCESS_MODULE_REF } from './discovery-process-module.js';
import { processModuleKey } from '../../domain/process-module.js';
import type { ProcessOutcomeCertificate } from '../../persistence/process-outcome-certificate.js';

/**
 * The discovery certificate's generic schemaVersion. Distinct from the discovery
 * payload schema id so consumers can dispatch on schemaVersion when reading the
 * generic surface. The payload itself is preserved verbatim from the discovery
 * certificate_payload column (canonical JSON parsed back to an object).
 */
export const DISCOVERY_GENERIC_CERTIFICATE_SCHEMA_VERSION =
  'saga3.discovery-outcome-certificate.generic.v1';

// ---------------------------------------------------------------------------
// Inlined readOutcomeCertificate (Wave 7 saga3 leak elimination).
//
// Previously imported from
// src/saga3/persistence/saga3-settlement-repository.ts. That function is a
// single read-only SELECT over saga3_discovery_outcome_certificates + a
// row-to-record mapping. Inlined here verbatim so the projection no longer
// reaches outside src/process-modules/. The saga3 layer keeps its own copy.
// ---------------------------------------------------------------------------

interface DiscoveryCertificateRow {
  id: number;
  settlement_id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  decision: 'go' | 'clarify' | 'reject';
  reason_codes: string;
  input_hash: string;
  certificate_payload: string;
  certificate_hash: string;
  issued_at: string;
}

function discoveryCertificateRowToRecord(
  row: DiscoveryCertificateRow,
): OutcomeCertificateRecord {
  return {
    id: row.id,
    settlement_id: row.settlement_id,
    epic_id: row.epic_id,
    proposal_id: row.proposal_id,
    proposal_content_hash: row.proposal_content_hash,
    readiness_assessment_id: row.readiness_assessment_id,
    readiness_assessment_hash: row.readiness_assessment_hash,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    decision: row.decision,
    reason_codes: JSON.parse(row.reason_codes ?? '[]'),
    input_hash: row.input_hash,
    certificate_payload: row.certificate_payload,
    certificate_hash: row.certificate_hash,
    issued_at: row.issued_at,
  };
}

/**
 * Read an outcome certificate by its exact discovery-internal id. Read-only.
 * Returns null if no such row. Inlined from the saga3 settlement repository.
 */
function readDiscoveryOutcomeCertificate(
  db: Database.Database,
  certificateId: number,
): OutcomeCertificateRecord | null {
  const row = db.prepare(
    'SELECT * FROM saga3_discovery_outcome_certificates WHERE id=?',
  ).get(certificateId) as DiscoveryCertificateRow | undefined;
  return row ? discoveryCertificateRowToRecord(row) : null;
}

/**
 * Map a discovery OutcomeCertificateRecord to the generic shape. Pure function
 * — no DB access. The caller supplies the projectId (the discovery certificate
 * carries epic_id; project_id is inferred from the epic).
 */
export function projectDiscoveryCertificate(
  cert: OutcomeCertificateRecord,
  projectId: number,
): ProcessOutcomeCertificate {
  const payload = JSON.parse(cert.certificate_payload) as Record<string, unknown>;
  return {
    id: cert.id,
    // Discovery certificates predate ProcessRun rows. processRunId is synthetic:
    // we encode the discovery-internal lineage so the generic surface can still
    // point back. Format: negative id namespace reserved for projections
    // (positive ids are real saga3_process_outcome_certificates rows).
    processRunId: -cert.id,
    moduleRef: { ...DISCOVERY_PROCESS_MODULE_REF },
    moduleRefKey: processModuleKey(DISCOVERY_PROCESS_MODULE_REF),
    projectId,
    epicId: cert.epic_id,
    schemaVersion: DISCOVERY_GENERIC_CERTIFICATE_SCHEMA_VERSION,
    decision: cert.decision,
    reasonCodes: cert.reason_codes,
    rationale: payload.rationale as string ?? '',
    inputHash: cert.input_hash,
    certificatePayload: {
      schemaVersion: DISCOVERY_GENERIC_CERTIFICATE_SCHEMA_VERSION,
      decision: cert.decision,
      reasonCodes: cert.reason_codes,
      rationale: payload.rationale as string ?? '',
      inputHash: cert.input_hash,
      payload,
    },
    certificateHash: cert.certificate_hash,
    // Discovery certificates are issued by the settlement policy — the only
    // authority that may convert proposal + readiness into a decision.
    authority: 'discovery_settlement_policy',
    issuedAt: cert.issued_at,
  };
}

/**
 * Read-only adapter that implements a SLICE of the generic
 * ProcessOutcomeCertificateRepository contract, backed by the discovery
 * certificate table. Composition: a top-level repository can delegate reads to
 * this adapter when the module is discovery, and to the generic SQLite repo
 * otherwise.
 *
 * write operations (issue) are NOT implemented — discovery writes go through its
 * own settlement service. Calling them throws.
 */
export class DiscoveryOutcomeCertificateProjection {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Project one discovery certificate by its discovery-internal id. */
  read(certificateId: number, projectId: number): ProcessOutcomeCertificate | null {
    const cert = readDiscoveryOutcomeCertificate(this.db, certificateId);
    return cert ? projectDiscoveryCertificate(cert, projectId) : null;
  }

  /**
   * Project the discovery certificate for one epic. Discovery certificates are
   * epic-scoped (one per settled proposal); the projectId is required to fill
   * the generic shape.
   */
  readByEpic(epicId: number, projectId: number): ProcessOutcomeCertificate | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_discovery_outcome_certificates WHERE epic_id=? ORDER BY id DESC LIMIT 1`,
    ).get(epicId) as { id: number } | undefined;
    if (!row) return null;
    return this.read(row.id, projectId);
  }
}
