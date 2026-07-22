/**
 * Saga 3 — SQL schema.
 *
 * Durable tables backing the Level 1/2/3 domain types in ./types.ts.
 * Every column maps 1:1 to a field on the corresponding interface; nothing
 * is invented or dropped. CHECK constraints mirror the literal unions in
 * types.ts so SQLite rejects any row that the type system would reject.
 *
 * Idempotent: every statement is CREATE ... IF NOT EXISTS, so this file is
 * safe to exec on every boot (mirrors src/schema.ts).
 */

import type Database from 'better-sqlite3';

/**
 * The full saga3 DDL. Tables are ordered so that foreign-key targets exist
 * before their referencers, though all FKs are DEFERRABLE/AUTOINCREMENT-free
 * string keys — saga3 owns its own id space and does not share rows with the
 * legacy tracker tables.
 *
 * Column naming follows the legacy src/schema.ts convention (snake_case) even
 * though the TS interfaces are camelCase; the repository layer translates.
 */
export const SAGA3_SCHEMA = `
-- ---------------------------------------------------------------------------
-- saga3_episode_specs
--   Backs EpisodeSpec (Level 1 normative intent). Immutable once sealed.
--   UNIQUE(generation) — one row per frozen episode generation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_episode_specs (
  id                    TEXT PRIMARY KEY,
  project_id            INTEGER NOT NULL DEFAULT 0,
  epic_id               INTEGER NOT NULL DEFAULT 0,
  mandate               TEXT NOT NULL DEFAULT '',
  controller_version    TEXT NOT NULL DEFAULT 'v3',
  generation            INTEGER NOT NULL,
  platform_policy_hash  TEXT NOT NULL,
  constitution_hash     TEXT NOT NULL,
  governance_hash       TEXT NOT NULL,
  source_baseline       TEXT,
  environment_baseline  TEXT,
  sealed                INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (epic_id, generation)
);

-- ---------------------------------------------------------------------------
-- saga3_condition_instances
--   Backs ConditionInstance (Level 2 deterministic control). The CAS column
--   projection_version drives optimistic concurrency on status writes.
--   UNIQUE(episode_spec_id, condition_type, obligation_id, scope_type, scope_id)
--   is the controller's identity key for a scoped condition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_condition_instances (
  episode_spec_id       TEXT NOT NULL,
  condition_type        TEXT NOT NULL,
  obligation_id         TEXT NOT NULL,
  scope_type            TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'Unknown'
                          CHECK (status IN ('True', 'False', 'Unknown')),
  projection_version    INTEGER NOT NULL DEFAULT 0,
  observed_generation   INTEGER,
  source_fingerprint    TEXT,
  environment_fingerprint TEXT,
  invalidation_reason   TEXT,
  last_transition_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_spec_id, condition_type, obligation_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_saga3_conditions_episode
  ON saga3_condition_instances(episode_spec_id, status);

-- ---------------------------------------------------------------------------
-- saga3_evidence_records
--   Backs EvidenceRecord (Level 2). Append-only provenance for every oracle
--   observation the controller has attached to a condition. trust_class and
--   verdict mirror the TS unions exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_evidence_records (
  id                      TEXT PRIMARY KEY,
  episode_spec_id         TEXT NOT NULL,
  condition_type          TEXT NOT NULL,
  obligation_id           TEXT NOT NULL,
  generation              INTEGER NOT NULL,
  source_fingerprint      TEXT NOT NULL,
  environment_fingerprint TEXT NOT NULL,
  oracle_id               TEXT NOT NULL,
  oracle_version          TEXT NOT NULL,
  trust_class             TEXT NOT NULL
                            CHECK (trust_class IN ('deterministic', 'authoritative', 'advisory')),
  verdict                 TEXT NOT NULL
                            CHECK (verdict IN ('passed', 'failed', 'unknown', 'error')),
  raw_digest              TEXT NOT NULL,
  observed_at             INTEGER NOT NULL,
  freshness_max_age_ms    INTEGER NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saga3_evidence_condition
  ON saga3_evidence_records(episode_spec_id, condition_type, obligation_id);
CREATE INDEX IF NOT EXISTS idx_saga3_evidence_observed
  ON saga3_evidence_records(observed_at);

-- ---------------------------------------------------------------------------
-- saga3_work_intents
--   Backs WorkIntent (Level 2). Deterministic uniqueness key prevents the
--   controller from ever materializing two intents for the same deficit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_work_intents (
  id                  TEXT PRIMARY KEY,
  episode_spec_id     TEXT NOT NULL,
  generation          INTEGER NOT NULL,
  target_condition    TEXT NOT NULL,
  target_obligation   TEXT NOT NULL,
  scope_type          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  strategy_id         TEXT NOT NULL,
  skill_id            TEXT NOT NULL,
  origin              TEXT NOT NULL DEFAULT 'normal'
                        CHECK (origin IN ('normal', 'recovery')),
  parent_incident_id  TEXT,
  prerequisites       TEXT NOT NULL DEFAULT '[]',
  read_scopes         TEXT NOT NULL DEFAULT '[]',
  write_scopes        TEXT NOT NULL DEFAULT '[]',
  conflict_keys       TEXT NOT NULL DEFAULT '[]',
  budget_reservation  INTEGER,
  status              TEXT NOT NULL DEFAULT 'materialized'
                        CHECK (status IN ('materialized', 'admitted', 'assigned',
                                          'completed', 'cancelled', 'failed')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_spec_id, generation, target_condition, target_obligation,
          scope_type, scope_id, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_saga3_intents_status
  ON saga3_work_intents(episode_spec_id, status);

-- ---------------------------------------------------------------------------
-- saga3_worker_assignments
--   Backs WorkerAssignment (Level 2). One assignment per admitted intent;
--   lease_epoch drives lease expiry / reassignment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_worker_assignments (
  id              TEXT PRIMARY KEY,
  work_intent_id  TEXT NOT NULL,
  skill_id        TEXT NOT NULL,
  worker_id       TEXT,
  execution_id    TEXT,
  lease_epoch     INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'running', 'submitted',
                                     'verified', 'failed', 'lost')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saga3_assignments_intent
  ON saga3_worker_assignments(work_intent_id);
CREATE INDEX IF NOT EXISTS idx_saga3_assignments_state
  ON saga3_worker_assignments(state);

-- ---------------------------------------------------------------------------
-- saga3_artifacts
--   Backs ArtifactOutput (Level 3). content lives on disk (or in the worker
--   output); this table is the durable manifest. UNIQUE(episode_spec_id, path).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_artifacts (
  id              TEXT PRIMARY KEY,
  episode_spec_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  path            TEXT NOT NULL,
  digest          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_spec_id, path)
);

CREATE INDEX IF NOT EXISTS idx_saga3_artifacts_episode
  ON saga3_artifacts(episode_spec_id);

-- ---------------------------------------------------------------------------
-- saga3_outcome_certificates
--   Backs OutcomeCertificate (Level 2). One terminal certificate per episode;
--   UNIQUE(episode_spec_id). All 9 TERMINAL_OUTCOMES are enumerated in the
--   CHECK so SQLite rejects any typo'd or future outcome not yet registered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga3_outcome_certificates (
  episode_spec_id         TEXT PRIMARY KEY,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN (
                              'SUCCEEDED',
                              'SUCCEEDED_DEGRADED',
                              'INFEASIBLE',
                              'UNDERSPECIFIED_CONSTITUTION',
                              'POLICY_CONFLICT',
                              'VERIFICATION_IMPOSSIBLE',
                              'EXTERNAL_STATE_UNKNOWN',
                              'RESOURCE_EXHAUSTED',
                              'FAILED_UNRECOVERABLE'
                            )),
  causal_reason           TEXT NOT NULL,
  generation              INTEGER NOT NULL,
  source_fingerprint      TEXT,
  satisfied_conditions    TEXT NOT NULL DEFAULT '[]',
  unresolved_conditions   TEXT NOT NULL DEFAULT '[]',
  certified_at            INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Index on episode_specs.sealed for fast "find unsealed generation" lookups.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_saga3_episode_specs_sealed
  ON saga3_episode_specs(sealed);
`;

/**
 * Apply the saga3 schema to an open better-sqlite3 database.
 *
 * Idempotent — every statement is `CREATE ... IF NOT EXISTS`, so this is safe
 * to call on every boot (mirrors the legacy `db.exec(SCHEMA_SQL)` in db.ts).
 */
export function initSaga3Schema(db: Database.Database): void {
  db.exec(SAGA3_SCHEMA);

  // Migrate the original skeleton table. It had no episode identity and used
  // UNIQUE(generation) globally, so progress could not be resumed reliably.
  const columns = db.prepare(`PRAGMA table_info('saga3_episode_specs')`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'epic_id')) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE saga3_episode_specs RENAME TO saga3_episode_specs_legacy;
        CREATE TABLE saga3_episode_specs (
          id                    TEXT PRIMARY KEY,
          project_id            INTEGER NOT NULL DEFAULT 0,
          epic_id               INTEGER NOT NULL DEFAULT 0,
          mandate               TEXT NOT NULL DEFAULT '',
          controller_version    TEXT NOT NULL DEFAULT 'v3',
          generation            INTEGER NOT NULL,
          platform_policy_hash  TEXT NOT NULL,
          constitution_hash     TEXT NOT NULL,
          governance_hash       TEXT NOT NULL,
          source_baseline       TEXT,
          environment_baseline  TEXT,
          sealed                INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (epic_id, generation)
        );
        INSERT INTO saga3_episode_specs
          (id, generation, platform_policy_hash, constitution_hash,
           governance_hash, source_baseline, environment_baseline, sealed,
           created_at, updated_at)
        SELECT id, generation, platform_policy_hash, constitution_hash,
               governance_hash, source_baseline, environment_baseline, sealed,
               created_at, updated_at
          FROM saga3_episode_specs_legacy;
        DROP TABLE saga3_episode_specs_legacy;
      `);
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_saga3_episode_specs_sealed
      ON saga3_episode_specs(sealed);
    CREATE INDEX IF NOT EXISTS idx_saga3_episode_specs_epic
      ON saga3_episode_specs(epic_id, generation DESC);
  `);
}
