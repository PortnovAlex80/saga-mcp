// src/shared/artifact-drift-events.ts
//
// BLINDSIGHT F6 — append-only drift-event history for artifacts.
//
// artifacts.drift_state is a mutable projection: every re-hash
// (refreshArtifactHash) and every deliberate accept OVERWRITES it, destroying
// the transition history. This module records every drift_state TRANSITION
// (from != to) as one immutable factory_artifact_drift_events row, written by
// the SAME code path that performs the overwrite: old value + new value form
// a recoverable chain, so "never drifted" and "drifted and repaired" stay
// distinguishable forever. Same-state re-reads append nothing — the chain
// carries signal, not noise.
//
// Lives in the shared kernel (any layer may import it) and speaks a MINIMAL
// structural SQL port so both the better-sqlite3 infrastructure helpers and
// driver-neutral module application services (SqlDatabasePort) can append
// through their own connection.

export type ArtifactDriftState = 'unknown' | 'clean' | 'drifted';

/** Structural prepare/run capability — satisfied by better-sqlite3 and SqlDatabasePort alike. */
export interface DriftEventSqlPort {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
}

export interface ArtifactDriftEvent {
  readonly id: number;
  readonly artifactId: number;
  readonly fromState: ArtifactDriftState;
  readonly toState: ArtifactDriftState;
  readonly observedContentHash: string | null;
  readonly acceptedHash: string | null;
  readonly cause: string;
  readonly observedBy: string;
  readonly observedAt: string;
}

interface DriftEventRow {
  id: number;
  artifact_id: number;
  from_state: ArtifactDriftState;
  to_state: ArtifactDriftState;
  observed_content_hash: string | null;
  accepted_hash: string | null;
  cause: string;
  observed_by: string;
  observed_at: string;
}

/**
 * Append one transition. NOT a transition (from === to) -> no row (no noise).
 * Callers MUST invoke this in the same transaction/statement batch as the
 * drift_state overwrite it describes.
 */
export function appendArtifactDriftTransition(
  db: DriftEventSqlPort,
  input: {
    readonly artifactId: number;
    readonly fromState: ArtifactDriftState;
    readonly toState: ArtifactDriftState;
    readonly observedContentHash?: string | null;
    readonly acceptedHash?: string | null;
    /** What wrote the new state, e.g. 'disk-reconcile', 'artifact-update', 'formalization-acceptance'. */
    readonly cause: string;
    readonly observedBy: string;
  },
): boolean {
  if (input.fromState === input.toState) return false;
  db.prepare(
    `INSERT INTO factory_artifact_drift_events
       (artifact_id, from_state, to_state, observed_content_hash,
        accepted_hash, cause, observed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.artifactId,
    input.fromState,
    input.toState,
    input.observedContentHash ?? null,
    input.acceptedHash ?? null,
    input.cause,
    input.observedBy,
  );
  return true;
}

/**
 * Read the full recoverable drift chain for one artifact, oldest first.
 * Empty array = the artifact never changed drift_state after birth.
 */
export function readArtifactDriftChain(
  db: DriftEventSqlPort,
  artifactId: number,
): readonly ArtifactDriftEvent[] {
  const rows = db.prepare(
    `SELECT id, artifact_id, from_state, to_state, observed_content_hash,
            accepted_hash, cause, observed_by, observed_at
       FROM factory_artifact_drift_events
      WHERE artifact_id=?
      ORDER BY id ASC`,
  ).all(artifactId) as DriftEventRow[];
  return rows.map(row => ({
    id: row.id,
    artifactId: row.artifact_id,
    fromState: row.from_state,
    toState: row.to_state,
    observedContentHash: row.observed_content_hash,
    acceptedHash: row.accepted_hash,
    cause: row.cause,
    observedBy: row.observed_by,
    observedAt: row.observed_at,
  }));
}
