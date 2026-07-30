#!/usr/bin/env node
/**
 * saga-snapshot.mjs — capture/restore the formalization slice of a saga lifecycle.
 *
 * Design: docs/design/ARTIFACT-SNAPSHOT-RESTORE.md
 * Pattern: sidecar infra tool (like reset-saga-db.mjs / saga-reset-stage.mjs).
 *
 * After a successful formalization stage (status=completed, local_outcome=
 * 'formalized'), `capture` serializes the full formalization slice to a JSON
 * file (saga3.snapshot.v1). After reset-saga-db.mjs wipes the DB, `restore`
 * replays the slice verbatim (id preservation — every row is INSERTed with its
 * original id), so a `--resume` lifecycle continues straight into development
 * without re-running the ~20-30 min formalization.
 *
 * Commands:
 *   capture  --epic=<id> [--out=<path>]            capture the formalization slice
 *   restore  --epic=<id> [--in=<path>] [--verify-disk-hash] [--confirm]
 *
 * Env: DB_PATH (default C:/Users/user/.zcode/saga.db)
 *
 * Format: saga3.formalization-checkpoint.v2. The snapshot stores raw table rows with their
 * original ids — restore uses id preservation (INSERT with explicit id), NOT
 * ref-remapping. This is the simpler, deterministic variant of §4.3/§4.4 of the
 * design: it is valid only over a freshly-reset DB (so the same ids cannot
 * collide), and it makes saga3_process_transitions.handoff_snapshot (which
 * carries numeric artifactIds) valid without patching.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';
const SCHEMA_VERSION = 'saga3.formalization-checkpoint.v2';

const FORMALIZATION_STAGES = ['initial-discovery', 'solution-formalization'];

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv) {
  const opts = { command: null, epic: null, out: null, in: null, verifyDiskHash: false, confirm: false };
  for (const arg of argv.slice(2)) {
    if (arg === 'capture' || arg === 'restore') opts.command = arg;
    else if (arg.startsWith('--epic=')) opts.epic = Number(arg.slice(7));
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else if (arg.startsWith('--in=')) opts.in = arg.slice(5);
    else if (arg === '--verify-disk-hash') opts.verifyDiskHash = true;
    else if (arg === '--confirm' || arg === '--yes') opts.confirm = true;
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); printUsage(); process.exit(1); }
  }
  if (!opts.command) { printUsage(); process.exit(1); }
  if (opts.epic == null || Number.isNaN(opts.epic)) {
    console.error('--epic=<id> is required');
    process.exit(1);
  }
  return opts;
}

function printUsage() {
  console.error('Usage:');
  console.error('  saga-snapshot.mjs capture --epic=<id> [--out=<path>]');
  console.error('  saga-snapshot.mjs restore --epic=<id> [--in=<path>] [--verify-disk-hash] [--confirm]');
  console.error('');
  console.error(`DB: DB_PATH env (default ${DB_PATH})`);
  console.error('Default snapshot path: <workspace>/.saga/snapshots/epic-<id>-formalization.json');
}

// ============================================================================
// Helpers
// ============================================================================

function sha256Hex(s) {
  return createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

/** Resolve the lifecycle_run id and the formalization process_run id for an epic. */
function resolveLifecycle(db, epicId) {
  const lr = db.prepare(
    'SELECT id, status, current_stage_id, current_stage_run_id FROM saga3_lifecycle_runs WHERE epic_id=? ORDER BY id DESC LIMIT 1',
  ).get(epicId);
  if (!lr) throw new Error(`No saga3_lifecycle_runs row for epic ${epicId}`);
  // The formalization process_run = process_run_id of the solution-formalization stage_run.
  const frSr = db.prepare(
    `SELECT sr.id AS stage_run_id, sr.process_run_id, sr.status,
            sr.local_outcome
       FROM saga3_stage_runs sr
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='solution-formalization'
      ORDER BY sr.id DESC LIMIT 1`,
  ).get(lr.id);
  if (!frSr) throw new Error(`No solution-formalization stage_run for lifecycle_run ${lr.id} (epic ${epicId})`);
  if (!frSr.process_run_id) throw new Error(`solution-formalization stage_run ${frSr.stage_run_id} has no bound process_run`);
  if (frSr.status !== 'completed' || frSr.local_outcome !== 'formalized') {
    throw new Error(
      `Formalization checkpoint is not reusable: stage_run ${frSr.stage_run_id} `
      + `has status='${frSr.status}', local_outcome='${frSr.local_outcome}'`,
    );
  }
  return { lifecycleRunId: lr.id, lifecycleRun: lr, formalizationStageRunId: frSr.stage_run_id, formalizationProcessRunId: frSr.process_run_id };
}

// ============================================================================
// CAPTURE
// ============================================================================

function captureArtifactSnapshot(db, epicId) {
  const { lifecycleRunId, lifecycleRun, formalizationStageRunId, formalizationProcessRunId } =
    resolveLifecycle(db, epicId);

  const project = db.prepare('SELECT * FROM projects WHERE id=(SELECT project_id FROM epics WHERE id=?)').get(epicId);
  const epic = db.prepare('SELECT * FROM epics WHERE id=?').get(epicId);
  if (!project || !epic) throw new Error(`Missing project/epic for epic ${epicId}`);

  // Project repositories + their backing repositories.
  const projectRepositories = db.prepare('SELECT * FROM project_repositories WHERE project_id=?').all(project.id);
  const repoIds = projectRepositories.map(pr => pr.repository_id);
  const repositories = repoIds.length
    ? db.prepare(`SELECT * FROM repositories WHERE id IN (${repoIds.join(',')})`).all()
    : [];

  const episodeWorkflow = db.prepare('SELECT * FROM episode_workflows WHERE epic_id=?').get(epicId) ?? null;

  // 1. artifacts for the epic (all statuses; capture is pre-development in the
  //    happy path but we keep every row so restore reconstructs the full state).
  const artifacts = db.prepare('SELECT * FROM artifacts WHERE epic_id=? ORDER BY id').all(epicId);

  // 2. artifact_traces for the epic's artifacts (resolve via source join).
  const traces = db.prepare(
    `SELECT t.* FROM artifact_traces t
       JOIN artifacts a ON a.id=t.source_id
      WHERE a.epic_id=?
      ORDER BY t.id`,
  ).all(epicId);

  // 3. formalization tasks (workflow_stage='formalization').
  const formalizationTasks = db.prepare(
    `SELECT * FROM tasks WHERE epic_id=? AND workflow_stage='formalization' ORDER BY id`,
  ).all(epicId);

  // 4-6. saga3 process layer — discovery + formalization only.
  const stageRuns = db.prepare(
    `SELECT * FROM saga3_stage_runs
       WHERE lifecycle_run_id=? AND stage_id IN (${FORMALIZATION_STAGES.map(() => '?').join(',')})
       ORDER BY ordinal`,
  ).all(lifecycleRunId, ...FORMALIZATION_STAGES);

  const processRunIds = stageRuns.map(sr => sr.process_run_id).filter(Boolean);
  const processRuns = processRunIds.length
    ? db.prepare(`SELECT * FROM saga3_process_runs WHERE id IN (${processRunIds.join(',')}) ORDER BY id`).all()
    : [];
  const moduleInstallationIds = [...new Set(
    processRuns.map(row => row.installation_id).filter(Number.isInteger),
  )];
  const moduleInstallations = moduleInstallationIds.length
    ? db.prepare(
        `SELECT * FROM saga3_module_installations
          WHERE id IN (${moduleInstallationIds.join(',')})
          ORDER BY id`,
      ).all()
    : [];
  if (moduleInstallations.length !== moduleInstallationIds.length) {
    const found = new Set(moduleInstallations.map(row => row.id));
    throw new Error(
      `Checkpoint source has missing module installations: ${
        moduleInstallationIds.filter(id => !found.has(id)).join(', ')
      }`,
    );
  }

  const nodeRuns = processRunIds.length
    ? db.prepare(`SELECT * FROM saga3_node_runs WHERE process_run_id IN (${processRunIds.join(',')}) ORDER BY id`).all()
    : [];

  const transitions = db.prepare(
    `SELECT * FROM saga3_process_transitions
       WHERE lifecycle_run_id=?
         AND from_stage_run_id IN (SELECT id FROM saga3_stage_runs
                                    WHERE lifecycle_run_id=? AND stage_id IN (${FORMALIZATION_STAGES.map(() => '?').join(',')}))
       ORDER BY id`,
  ).all(lifecycleRunId, lifecycleRunId, ...FORMALIZATION_STAGES);

  const lifecycleRuns = db.prepare('SELECT * FROM saga3_lifecycle_runs WHERE id=?').get(lifecycleRunId);

  // 3. Acceptance CAS for the formalization process run.
  const acceptanceDecisions = db.prepare(
    'SELECT * FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);
  const decisionIds = acceptanceDecisions.map(d => d.id);
  const acceptanceItems = decisionIds.length
    ? db.prepare(`SELECT * FROM saga3_exact_candidate_acceptance_items WHERE decision_id IN (${decisionIds.join(',')}) ORDER BY decision_id, ordinal`).all()
    : [];

  // Formalization baseline + solution contract.
  const acceptanceBaselines = db.prepare(
    'SELECT * FROM saga3_formalization_acceptance_baselines WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);
  const solutionContracts = db.prepare(
    'SELECT * FROM saga3_formalization_solution_contracts WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);

  // 4. Managed productions + node submissions for the formalization process run.
  const managedArtifactProductions = db.prepare(
    'SELECT * FROM saga3_managed_artifact_productions WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);
  const managedTraceProductions = db.prepare(
    'SELECT * FROM saga3_managed_trace_productions WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);
  const managedNodeSubmissions = db.prepare(
    'SELECT * FROM saga3_managed_node_submissions WHERE process_run_id=? ORDER BY id',
  ).all(formalizationProcessRunId);

  // 8. command_receipts for the formalization tasks.
  const formalizationTaskIds = formalizationTasks.map(t => t.id);
  const commandReceipts = formalizationTaskIds.length
    ? db.prepare(`SELECT * FROM command_receipts WHERE task_id IN (${formalizationTaskIds.join(',')}) ORDER BY command_id`).all()
    : [];
  const workIntentIds = [...new Set(formalizationTasks.map(task => {
    try {
      return JSON.parse(task.metadata).work_intent_id;
    } catch {
      return null;
    }
  }).filter(Number.isInteger))];
  const workIntents = workIntentIds.length
    ? db.prepare(
        `SELECT * FROM saga3_work_intents
          WHERE id IN (${workIntentIds.join(',')})
          ORDER BY id`,
      ).all()
    : [];
  const workerExecutionIds = [...new Set(
    commandReceipts.map(row => row.execution_id).filter(
      value => typeof value === 'string' && value.length > 0,
    ),
  )];
  const workerExecutions = workerExecutionIds.length
    ? db.prepare(
        `SELECT * FROM worker_executions
          WHERE execution_id IN (${workerExecutionIds.map(() => '?').join(',')})
          ORDER BY execution_id`,
      ).all(...workerExecutionIds)
    : [];
  if (workIntents.length !== workIntentIds.length) {
    const found = new Set(workIntents.map(row => row.id));
    throw new Error(
      `Checkpoint source has missing work intents: ${
        workIntentIds.filter(id => !found.has(id)).join(', ')
      }`,
    );
  }
  if (workerExecutions.length !== workerExecutionIds.length) {
    const found = new Set(workerExecutions.map(row => row.execution_id));
    throw new Error(
      `Checkpoint source has missing worker executions: ${
        workerExecutionIds.filter(id => !found.has(id)).join(', ')
      }`,
    );
  }

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    epicId,
    lifecycleRunId,
    formalizationProcessRunId,
    formalizationStageRunId,
    project,
    repositories,
    projectRepositories,
    epic,
    episodeWorkflow,
    artifacts,
    traces,
    formalizationTasks,
    stageRuns,
    processRuns,
    moduleInstallations,
    nodeRuns,
    transitions,
    lifecycleRun: lifecycleRuns,
    acceptanceDecisions,
    acceptanceItems,
    acceptanceBaselines,
    solutionContracts,
    managedArtifactProductions,
    managedTraceProductions,
    managedNodeSubmissions,
    workIntents,
    workerExecutions,
    commandReceipts,
  };
  // snapshotHash over the canonical JSON without the hash field itself.
  snapshot.snapshotHash = sha256Hex(JSON.stringify({ ...snapshot, snapshotHash: undefined }));
  return snapshot;
}

function defaultSnapshotPath(db, epicId) {
  // <workspace>/.saga/snapshots/epic-<id>-formalization.json — workspace resolved
  // from the first active project_repository local_path.
  const pr = db.prepare(
    "SELECT local_path FROM project_repositories WHERE project_id=(SELECT project_id FROM epics WHERE id=?) AND status='active' ORDER BY id LIMIT 1",
  ).get(epicId);
  const workspace = pr?.local_path ?? process.cwd();
  return path.join(workspace, '.saga', 'snapshots', `epic-${epicId}-formalization.json`);
}

function runCapture(opts) {
  const db = new Database(DB_PATH);
  try {
    const snapshot = captureArtifactSnapshot(db, opts.epic);
    const outPath = opts.out ?? defaultSnapshotPath(db, opts.epic);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

    console.log('=== CAPTURE COMPLETE ===');
    console.log(`Epic: ${opts.epic} (lifecycle_run ${snapshot.lifecycleRunId})`);
    console.log(`Formalization process_run: ${snapshot.formalizationProcessRunId} (stage_run ${snapshot.formalizationStageRunId})`);
    console.log(`Snapshot written: ${outPath}`);
    console.log('Contents:');
    console.log(`  artifacts:                       ${snapshot.artifacts.length}`);
    console.log(`  traces:                          ${snapshot.traces.length}`);
    console.log(`  formalization tasks:             ${snapshot.formalizationTasks.length}`);
    console.log(`  stage_runs (disc+form):          ${snapshot.stageRuns.length}`);
    console.log(`  process_runs:                   ${snapshot.processRuns.length}`);
    console.log(`  module installations:           ${snapshot.moduleInstallations.length}`);
    console.log(`  node_runs:                      ${snapshot.nodeRuns.length}`);
    console.log(`  process_transitions:            ${snapshot.transitions.length}`);
    console.log(`  acceptance decisions:           ${snapshot.acceptanceDecisions.length}`);
    console.log(`  acceptance items:               ${snapshot.acceptanceItems.length}`);
    console.log(`  acceptance baselines:           ${snapshot.acceptanceBaselines.length}`);
    console.log(`  solution contracts:             ${snapshot.solutionContracts.length}`);
    console.log(`  managed artifact productions:   ${snapshot.managedArtifactProductions.length}`);
    console.log(`  managed trace productions:      ${snapshot.managedTraceProductions.length}`);
    console.log(`  managed node submissions:       ${snapshot.managedNodeSubmissions.length}`);
    console.log(`  work intents:                   ${snapshot.workIntents.length}`);
    console.log(`  worker executions:              ${snapshot.workerExecutions.length}`);
    console.log(`  command_receipts:               ${snapshot.commandReceipts.length}`);
    console.log(`  snapshotHash: ${snapshot.snapshotHash}`);
  } finally {
    db.close();
  }
}

// ============================================================================
// RESTORE
// ============================================================================

/** Capture the ABORT trigger definitions so we can recreate them after restore. */
function collectAbortTriggers(db) {
  return db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
  ).all();
}

function dropAbortTriggers(db) {
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
  ).all();
  for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  return triggers.map(t => t.name);
}

/**
 * Canonical immutable ABORT-trigger set (matches the DDL emitted by the lazy
 * ensure*Schema functions in src/process-modules/.../*persistence.ts). Applied
 * with CREATE TRIGGER IF NOT EXISTS so the set is idempotent and cannot collide
 * with triggers that survived the transaction.
 *
 * After a reset-saga-db wipe the ABORT triggers are already dropped, so
 * `collectAbortTriggers` returns nothing — applying this canonical set closes
 * the §6.6 vulnerability window between restore and the next saga-server
 * startup (which would otherwise recreate them via getDb()).
 */
const CANONICAL_ABORT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_decision_no_update
  BEFORE UPDATE ON saga3_exact_candidate_acceptance_decisions
  BEGIN
    SELECT RAISE(ABORT, 'saga3 exact acceptance decisions are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_decision_no_delete
  BEFORE DELETE ON saga3_exact_candidate_acceptance_decisions
  BEGIN
    SELECT RAISE(ABORT, 'saga3 exact acceptance decisions are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_item_no_update
  BEFORE UPDATE ON saga3_exact_candidate_acceptance_items
  BEGIN
    SELECT RAISE(ABORT, 'saga3 exact acceptance items are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_exact_acceptance_item_no_delete
  BEFORE DELETE ON saga3_exact_candidate_acceptance_items
  BEGIN
    SELECT RAISE(ABORT, 'saga3 exact acceptance items are immutable');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_managed_node_submissions_no_update
  BEFORE UPDATE ON saga3_managed_node_submissions
  BEGIN
    SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_IMMUTABLE');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_managed_node_submissions_no_delete
  BEFORE DELETE ON saga3_managed_node_submissions
  BEGIN
    SELECT RAISE(ABORT, 'MANAGED_NODE_SUBMISSION_DELETE_FORBIDDEN');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_development_outputs_no_update
  BEFORE UPDATE ON saga3_development_outputs
  BEGIN
    SELECT RAISE(ABORT, 'DEVELOPMENT_OUTPUT_IMMUTABLE');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_development_outputs_no_delete
  BEFORE DELETE ON saga3_development_outputs
  BEGIN
    SELECT RAISE(ABORT, 'DEVELOPMENT_OUTPUT_DELETE_FORBIDDEN');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_delivery_outputs_no_update
  BEFORE UPDATE ON saga3_delivery_outputs
  BEGIN
    SELECT RAISE(ABORT, 'DELIVERY_OUTPUT_IMMUTABLE');
  END;
CREATE TRIGGER IF NOT EXISTS trg_saga3_delivery_outputs_no_delete
  BEFORE DELETE ON saga3_delivery_outputs
  BEGIN
    SELECT RAISE(ABORT, 'DELIVERY_OUTPUT_DELETE_FORBIDDEN');
  END;
`;

function recreateAbortTriggers(db, triggerDefs) {
  // First re-emit any triggers that existed before (their own sql, IF NOT EXISTS
  // would already guard, but some legacy DDL lacks it — best-effort, skip dups).
  for (const t of triggerDefs) {
    if (!t.sql) continue;
    try { db.exec(t.sql); } catch (e) {
      if (!String(e.message).toLowerCase().includes('already exists')) throw e;
    }
  }
  // Then apply the canonical set so the post-restore DB is never left without
  // immutable protection, even when reset-saga-db had already dropped them.
  db.exec(CANONICAL_ABORT_TRIGGERS);
}

/** Optional disk-hash verification for accepted artifacts (§5.3 / §6.5). */
function verifyDiskHashes(db, snapshot) {
  const repoById = new Map(snapshot.projectRepositories.map(pr => [pr.id, pr]));
  const violations = [];
  for (const a of snapshot.artifacts) {
    if (a.status !== 'accepted') continue;
    const pr = a.project_repository_id != null ? repoById.get(a.project_repository_id) : null;
    if (!pr?.local_path) continue; // no disk root to verify against (e.g. brief) — skip
    const root = path.resolve(pr.local_path);
    const relative = String(a.path).split('#')[0];
    const absolute = path.resolve(root, relative);
    if (!existsSync(absolute)) {
      violations.push(`${a.type} ${a.code ?? ''} path=${a.path}: file missing`);
      continue;
    }
    const diskHash = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (a.accepted_hash && diskHash !== a.accepted_hash) {
      violations.push(
        `${a.type} ${a.code ?? ''} path=${a.path}: disk ${diskHash.slice(0, 12)}... != snapshot accepted_hash ${a.accepted_hash.slice(0, 12)}...`,
      );
    }
  }
  return violations;
}

/**
 * Bump sqlite_sequence so AUTOINCREMENT continues past preserved ids. Only ever
 * moves the sequence forward (monotonic) — INSERT OR REPLACE would otherwise
 * clobber a higher pre-existing seq (e.g. stale debris from prior cycles) with
 * a lower MAX(id), risking a future AUTOINCREMENT collision.
 */
function bumpSequence(db, name) {
  const maxRow = db.prepare(`SELECT MAX(id) AS m FROM ${name}`).get();
  const maxId = maxRow?.m ?? 0;
  const cur = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(name);
  const nextSeq = Math.max(maxId, cur?.seq ?? 0);
  db.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, nextSeq);
}

function insertRawRows(db, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const allowed = new Set(
    db.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name),
  );
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0 || columns.some(column => !allowed.has(column))) {
      throw new Error(`SNAPSHOT_ROW_SCHEMA_MISMATCH: ${table}`);
    }
    const quoted = columns.map(column => `"${column}"`).join(', ');
    const parameters = columns.map(column => `@${column}`).join(', ');
    db.prepare(
      `INSERT INTO "${table}" (${quoted}) VALUES (${parameters})`,
    ).run(row);
  }
}

function resolveResumeStage(snapshot) {
  let definition;
  try {
    definition = JSON.parse(snapshot.lifecycleRun.definition_snapshot);
  } catch {
    throw new Error('SNAPSHOT_LIFECYCLE_DEFINITION_INVALID');
  }
  const source = definition?.stages?.find(
    stage => stage.id === 'solution-formalization',
  );
  const outcome = snapshot.stageRuns.find(
    stage => stage.stage_id === 'solution-formalization',
  )?.local_outcome;
  const route = source?.outcomeRoutes?.[outcome];
  if (!route || route.type !== 'stage' || typeof route.stageId !== 'string') {
    throw new Error(
      `SNAPSHOT_RESUME_ROUTE_MISSING: solution-formalization/${String(outcome)}`,
    );
  }
  if (!definition.stages.some(stage => stage.id === route.stageId)) {
    throw new Error(`SNAPSHOT_RESUME_STAGE_UNKNOWN: ${route.stageId}`);
  }
  return route.stageId;
}

/**
 * Restore the snapshot into a freshly-reset DB with full id preservation.
 *
 * Order mirrors §4.2 (one transaction, FK off, ABORT triggers dropped):
 *   project/repo/epic -> artifacts -> traces -> formalization tasks ->
 *   saga3 process layer -> acceptance CAS -> baseline -> contract ->
 *   command_receipts -> episode_workflows -> lifecycle cursor tuning ->
 *   sqlite_sequence bump -> recreate triggers.
 */
function restoreArtifactSnapshot(db, snapshot) {
  const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
  const resumeStageId = resolveResumeStage(snapshot);

  const triggerDefs = collectAbortTriggers(db);

  const tx = db.transaction(() => {
    // 1. Drop ABORT triggers (recreated at the end / on next getDb()).
    dropAbortTriggers(db);

    // 2. Idempotency guard: restore only over a clean DB.
    const existing = db.prepare('SELECT 1 FROM epics WHERE id=?').get(snapshot.epicId);
    if (existing) {
      throw new Error(
        `ARTIFACT_SNAPSHOT_RESTORE_TARGET_NOT_EMPTY: epic ${snapshot.epicId} already exists; reset-saga-db first`,
      );
    }

    // 2b. reset-saga-db.mjs clears almost all run-data tables but has a stale
    //     table name ('traces') for the trace table, whose actual name is
    //     'artifact_traces'. As a result dangling traces from prior cycles
    //     survive a reset. They reference deleted artifacts (no epic) and would
    //     collide with the id-preserving INSERTs below, so purge the whole
    //     table — after a reset it is expected to be empty, and any surviving
    //     rows are debris. This makes restore robust independently of that bug.
    try { db.exec('DELETE FROM artifact_traces'); } catch { /* table absent */ }

    // 3. project / repositories / project_repositories / epic (id preserved).
    const p = snapshot.project;
    db.prepare(
      `INSERT INTO projects (id, name, description, status, tags, metadata, created_at, updated_at)
       VALUES (@id, @name, @description, @status, @tags, @metadata, @created_at, @updated_at)`,
    ).run(p);

    for (const r of snapshot.repositories) {
      db.prepare(
        `INSERT INTO repositories (id, name, remote_url, default_branch, metadata, created_at, updated_at)
         VALUES (@id, @name, @remote_url, @default_branch, @metadata, @created_at, @updated_at)`,
      ).run(r);
    }
    for (const pr of snapshot.projectRepositories) {
      db.prepare(
        `INSERT INTO project_repositories (id, project_id, repository_id, role, local_path,
                  integration_branch, docs_root, status, metadata, created_at, updated_at)
         VALUES (@id, @project_id, @repository_id, @role, @local_path,
                 @integration_branch, @docs_root, @status, @metadata, @created_at, @updated_at)`,
      ).run(pr);
    }
    const e = snapshot.epic;
    db.prepare(
      `INSERT INTO epics (id, project_id, name, description, status, priority, sort_order,
              branch, tags, metadata, created_at, updated_at)
       VALUES (@id, @project_id, @name, @description, @status, @priority, @sort_order,
               @branch, @tags, @metadata, @created_at, @updated_at)`,
    ).run(e);

    // 4. artifacts (id preserved — preserves parent_artifact_id + trace ids +
    //    acceptance_items.artifact_id + handoff_snapshot numeric ids).
    const insertArtifact = db.prepare(
      `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status,
              parent_artifact_id, project_repository_id, content_hash, accepted_hash,
              drift_state, evidence_status, tags, metadata, created_at, updated_at)
       VALUES (@id, @project_id, @epic_id, @type, @code, @title, @path, @status,
               @parent_artifact_id, @project_repository_id, @content_hash, @accepted_hash,
               @drift_state, @evidence_status, @tags, @metadata, @created_at, @updated_at)`,
    );
    for (const a of snapshot.artifacts) insertArtifact.run(a);

    // 5. artifact_traces (source_id/target_id already valid thanks to id preservation).
    const insertTrace = db.prepare(
      `INSERT INTO artifact_traces (id, source_id, target_type, target_id, link_type, created_at)
       VALUES (@id, @source_id, @target_type, @target_id, @link_type, @created_at)`,
    );
    for (const t of snapshot.traces) insertTrace.run(t);

    // 6. formalization tasks (id preserved).
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, epic_id, title, description, status, priority, sort_order,
              assigned_to, current_execution_id, verification_target_artifact_id,
              estimated_hours, actual_hours, due_date, source_ref, task_kind, workflow_stage,
              execution_skill, review_skill, execution_mode, project_repository_id,
              integration_state, integrated_at, integrated_commit, generated_from_task_id,
              generation_key, declared_risk, derived_risk, policy_minimum, final_risk,
              tags, metadata, created_at, updated_at)
       VALUES (@id, @epic_id, @title, @description, @status, @priority, @sort_order,
               @assigned_to, @current_execution_id, @verification_target_artifact_id,
               @estimated_hours, @actual_hours, @due_date, @source_ref, @task_kind, @workflow_stage,
               @execution_skill, @review_skill, @execution_mode, @project_repository_id,
               @integration_state, @integrated_at, @integrated_commit, @generated_from_task_id,
               @generation_key, @declared_risk, @derived_risk, @policy_minimum, @final_risk,
               @tags, @metadata, @created_at, @updated_at)`,
    );
    for (const t of snapshot.formalizationTasks) insertTask.run(t);

    insertRawRows(db, 'saga3_work_intents', snapshot.workIntents);
    insertRawRows(db, 'worker_executions', snapshot.workerExecutions);

    // ProcessRun pins are part of the immutable replay contract. Restore the
    // exact installation rows before restoring runs that reference them.
    insertRawRows(
      db,
      'saga3_module_installations',
      snapshot.moduleInstallations,
    );

    // 7. saga3 process layer (id preserved across all saga3 tables).
    const insertProcessRun = db.prepare(
      `INSERT INTO saga3_process_runs (id, project_id, epic_id, module_name, module_version,
              module_ref_key, idempotency_key, executor_kind, input_schema, input_snapshot,
              input_hash, projected_stage, status, local_outcome, output_schema, output_ref,
              output_hash, certificate_schema, certificate_ref, certificate_hash,
              executor_run_ref, error, started_at, completed_at, created_at, updated_at,
              execution_lease_owner, execution_lease_expires_at, authority,
              active_recovery_case_id, active_issue_ref, active_issue_hash,
              installation_id, package_digest)
       VALUES (@id, @project_id, @epic_id, @module_name, @module_version,
               @module_ref_key, @idempotency_key, @executor_kind, @input_schema, @input_snapshot,
               @input_hash, @projected_stage, @status, @local_outcome, @output_schema, @output_ref,
               @output_hash, @certificate_schema, @certificate_ref, @certificate_hash,
               @executor_run_ref, @error, @started_at, @completed_at, @created_at, @updated_at,
               @execution_lease_owner, @execution_lease_expires_at, @authority,
               @active_recovery_case_id, @active_issue_ref, @active_issue_hash,
               @installation_id, @package_digest)`,
    );
    for (const pr of snapshot.processRuns) insertProcessRun.run(pr);

    const insertLifecycleRun = db.prepare(
      `INSERT INTO saga3_lifecycle_runs (id, lifecycle_name, lifecycle_version, lifecycle_ref_key,
              display_name, description, definition_snapshot, definition_hash, project_id, epic_id,
              initiated_by, idempotency_key, input_schema, input_snapshot, input_hash, status,
              entry_stage_id, current_stage_id, current_stage_run_id, terminal_status, version,
              execution_lease_owner, execution_lease_fence, execution_lease_expires_at, error,
              started_at, completed_at, created_at, updated_at)
       VALUES (@id, @lifecycle_name, @lifecycle_version, @lifecycle_ref_key,
               @display_name, @description, @definition_snapshot, @definition_hash, @project_id, @epic_id,
               @initiated_by, @idempotency_key, @input_schema, @input_snapshot, @input_hash, @status,
               @entry_stage_id, @current_stage_id, @current_stage_run_id, @terminal_status, @version,
               @execution_lease_owner, @execution_lease_fence, @execution_lease_expires_at, @error,
               @started_at, @completed_at, @created_at, @updated_at)`,
    );
    // Tune the cursor/lease for resume using the route frozen in the lifecycle
    // definition, not a hard-coded product lifecycle stage name.
    insertLifecycleRun.run({
      ...snapshot.lifecycleRun,
      status: 'paused',
      current_stage_id: resumeStageId,
      current_stage_run_id: null,
      terminal_status: null,
      execution_lease_owner: null,
      execution_lease_fence: 0,
      execution_lease_expires_at: null,
      error: null,
      updated_at: capturedAt,
    });

    const insertStageRun = db.prepare(
      `INSERT INTO saga3_stage_runs (id, lifecycle_run_id, ordinal, stage_id, attempt,
              module_name, module_version, module_ref_key, binding_snapshot, binding_hash,
              input_schema, input_snapshot, input_hash, status, process_run_id, local_outcome,
              authority, output_schema, output_ref, output_hash, certificate_schema,
              certificate_ref, certificate_hash, mapped_output_snapshot, result_snapshot,
              error, started_at, completed_at, created_at, updated_at)
       VALUES (@id, @lifecycle_run_id, @ordinal, @stage_id, @attempt,
               @module_name, @module_version, @module_ref_key, @binding_snapshot, @binding_hash,
               @input_schema, @input_snapshot, @input_hash, @status, @process_run_id, @local_outcome,
               @authority, @output_schema, @output_ref, @output_hash, @certificate_schema,
               @certificate_ref, @certificate_hash, @mapped_output_snapshot, @result_snapshot,
               @error, @started_at, @completed_at, @created_at, @updated_at)`,
    );
    for (const sr of snapshot.stageRuns) insertStageRun.run(sr);

    const insertNodeRun = db.prepare(
      `INSERT INTO saga3_node_runs (id, process_run_id, node_id, node_kind, attempt, status,
              event, output_ref, output_hash, error_message, started_at, completed_at,
              output_bindings, execution_receipt, output_schema, recovery_issue,
              acceptance_receipt, input_envelope_hash, node_ref, package_ref,
              predecessor_node_run_ids, definition_digest, transition_cursor, production_envelope)
       VALUES (@id, @process_run_id, @node_id, @node_kind, @attempt, @status,
               @event, @output_ref, @output_hash, @error_message, @started_at, @completed_at,
               @output_bindings, @execution_receipt, @output_schema, @recovery_issue,
               @acceptance_receipt, @input_envelope_hash, @node_ref, @package_ref,
               @predecessor_node_run_ids, @definition_digest, @transition_cursor, @production_envelope)`,
    );
    for (const nr of snapshot.nodeRuns) insertNodeRun.run(nr);

    const insertTransition = db.prepare(
      `INSERT INTO saga3_process_transitions (id, lifecycle_run_id, from_stage_run_id,
              transition_key, outcome, target_type, target_stage_id, terminal_status,
              to_stage_run_id, handoff_snapshot, handoff_hash, decision_hash, created_at)
       VALUES (@id, @lifecycle_run_id, @from_stage_run_id,
               @transition_key, @outcome, @target_type, @target_stage_id, @terminal_status,
               @to_stage_run_id, @handoff_snapshot, @handoff_hash, @decision_hash, @created_at)`,
    );
    for (const tr of snapshot.transitions) insertTransition.run(tr);

    // 8. Acceptance CAS (immutable; triggers dropped, insert verbatim).
    const insertDecision = db.prepare(
      `INSERT INTO saga3_exact_candidate_acceptance_decisions (id, schema_version, idempotency_key,
              request_hash, request_snapshot, candidate_set_hash, process_run_id, module_ref, node_id,
              intent_id, task_id, execution_id, project_id, epic_id, review_required,
              producer_receipt_command_id, producer_receipt_hash, review_receipt_command_id,
              review_receipt_hash, authority, reason_code, decision_hash, decided_at)
       VALUES (@id, @schema_version, @idempotency_key,
               @request_hash, @request_snapshot, @candidate_set_hash, @process_run_id, @module_ref, @node_id,
               @intent_id, @task_id, @execution_id, @project_id, @epic_id, @review_required,
               @producer_receipt_command_id, @producer_receipt_hash, @review_receipt_command_id,
               @review_receipt_hash, @authority, @reason_code, @decision_hash, @decided_at)`,
    );
    for (const d of snapshot.acceptanceDecisions) insertDecision.run(d);

    const insertItem = db.prepare(
      `INSERT INTO saga3_exact_candidate_acceptance_items (id, decision_id, ordinal, artifact_id,
              artifact_type, expected_content_hash, ledger_id, disposition, prior_status,
              prior_accepted_hash, prior_drift_state, final_status, final_accepted_hash,
              final_drift_state)
       VALUES (@id, @decision_id, @ordinal, @artifact_id,
               @artifact_type, @expected_content_hash, @ledger_id, @disposition, @prior_status,
               @prior_accepted_hash, @prior_drift_state, @final_status, @final_accepted_hash,
               @final_drift_state)`,
    );
    for (const it of snapshot.acceptanceItems) insertItem.run(it);

    const insertBaseline = db.prepare(
      `INSERT INTO saga3_formalization_acceptance_baselines (id, process_run_id, formalization_epic_id,
              schema_version, payload, baseline_hash, snapshot_hash, created_at)
       VALUES (@id, @process_run_id, @formalization_epic_id,
               @schema_version, @payload, @baseline_hash, @snapshot_hash, @created_at)`,
    );
    for (const b of snapshot.acceptanceBaselines) insertBaseline.run(b);

    const insertContract = db.prepare(
      `INSERT INTO saga3_formalization_solution_contracts (id, process_run_id, formalization_epic_id,
              schema_version, payload, content_hash, created_at)
       VALUES (@id, @process_run_id, @formalization_epic_id,
               @schema_version, @payload, @content_hash, @created_at)`,
    );
    for (const c of snapshot.solutionContracts) insertContract.run(c);

    // Managed productions + node submissions (provenance audit trail).
    const insertArtProd = db.prepare(
      `INSERT INTO saga3_managed_artifact_productions (id, process_run_id, module_ref, node_id,
              intent_id, task_id, execution_id, artifact_id, artifact_type, artifact_status,
              content_hash, operation, recorded_at)
       VALUES (@id, @process_run_id, @module_ref, @node_id,
               @intent_id, @task_id, @execution_id, @artifact_id, @artifact_type, @artifact_status,
               @content_hash, @operation, @recorded_at)`,
    );
    for (const ap of snapshot.managedArtifactProductions) insertArtProd.run(ap);

    const insertTraceProd = db.prepare(
      `INSERT INTO saga3_managed_trace_productions (id, process_run_id, module_ref, node_id,
              intent_id, task_id, execution_id, trace_id, source_id, target_type, target_id,
              link_type, trace_hash, recorded_at)
       VALUES (@id, @process_run_id, @module_ref, @node_id,
               @intent_id, @task_id, @execution_id, @trace_id, @source_id, @target_type, @target_id,
               @link_type, @trace_hash, @recorded_at)`,
    );
    for (const tp of snapshot.managedTraceProductions) insertTraceProd.run(tp);

    const insertNodeSub = db.prepare(
      `INSERT INTO saga3_managed_node_submissions (id, process_run_id, module_ref, node_id,
              intent_id, task_id, execution_id, schema_version, payload_snapshot, content_hash,
              submitted_at)
       VALUES (@id, @process_run_id, @module_ref, @node_id,
               @intent_id, @task_id, @execution_id, @schema_version, @payload_snapshot, @content_hash,
               @submitted_at)`,
    );
    for (const ns of snapshot.managedNodeSubmissions) insertNodeSub.run(ns);

    // 9. command_receipts for the formalization tasks.
    const insertReceipt = db.prepare(
      `INSERT INTO command_receipts (command_id, command_kind, actor_kind, actor_id, execution_id,
              task_id, payload_hash, accepted, rejection_code, result_json, accepted_at, reply_json)
       VALUES (@command_id, @command_kind, @actor_kind, @actor_id, @execution_id,
               @task_id, @payload_hash, @accepted, @rejection_code, @result_json, @accepted_at, @reply_json)`,
    );
    for (const cr of snapshot.commandReceipts) insertReceipt.run(cr);

    // 10. episode_workflows — stage='development', track from snapshot.
    const ew = snapshot.episodeWorkflow ?? { track: 'formal', metadata: '{}' };
    db.prepare(
      `INSERT INTO episode_workflows (epic_id, stage, track, baseline_artifact_id, baseline_hash,
              metadata, created_at, updated_at)
       VALUES (?, 'development', ?, NULL, NULL, ?, ?, ?)`,
    ).run(snapshot.epicId, ew.track ?? 'formal', ew.metadata ?? '{}', capturedAt, capturedAt);

    // 11. sqlite_sequence bump so AUTOINCREMENT continues past preserved ids.
    for (const table of [
      'projects', 'repositories', 'project_repositories', 'epics', 'artifacts',
      'tasks', 'artifact_traces',
      'saga3_lifecycle_runs', 'saga3_stage_runs', 'saga3_process_runs',
      'saga3_node_runs', 'saga3_process_transitions',
      'saga3_exact_candidate_acceptance_decisions', 'saga3_exact_candidate_acceptance_items',
      'saga3_formalization_acceptance_baselines', 'saga3_formalization_solution_contracts',
      'saga3_managed_artifact_productions', 'saga3_managed_trace_productions',
      'saga3_managed_node_submissions',
      'saga3_work_intents', 'saga3_module_installations',
    ]) {
      try { bumpSequence(db, table); } catch { /* table has no AUTOINCREMENT row yet */ }
    }

    recreateAbortTriggers(db, triggerDefs);
    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error(
        `SNAPSHOT_FOREIGN_KEY_VIOLATION: ${JSON.stringify(violations)}`,
      );
    }
  });
  tx();
  return { resumeStageId };
}

function runRestore(opts) {
  if (!existsSync(opts.in)) {
    console.error(`Snapshot not found: ${opts.in}`);
    process.exit(1);
  }
  const snapshot = JSON.parse(readFileSync(opts.in, 'utf8'));
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    console.error(`Unsupported snapshot schemaVersion '${snapshot.schemaVersion}' (expected ${SCHEMA_VERSION})`);
    process.exit(1);
  }
  const { snapshotHash, ...snapshotBody } = snapshot;
  const computedSnapshotHash = sha256Hex(JSON.stringify(snapshotBody));
  if (
    typeof snapshotHash !== 'string'
    || snapshotHash !== computedSnapshotHash
  ) {
    console.error('Snapshot integrity check failed: snapshotHash mismatch.');
    process.exit(1);
  }
  if (snapshot.epicId !== opts.epic) {
    console.error(`--epic=${opts.epic} does not match snapshot epicId=${snapshot.epicId}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF');

  // Optional disk-hash verification (before the transaction).
  if (opts.verifyDiskHash) {
    const violations = verifyDiskHashes(db, snapshot);
    if (violations.length) {
      console.error('=== DISK HASH VERIFICATION FAILED ===');
      for (const v of violations) console.error(`  ${v}`);
      console.error(`${violations.length} accepted artifact(s) drifted. Snapshot is stale; re-capture or revert the files.`);
      db.close();
      process.exit(1);
    }
    console.log(`Disk-hash verification: OK (checked accepted artifacts with a resolvable repository root)`);
  }

  // Idempotency guard (preview before mutating).
  const existing = db.prepare('SELECT 1 FROM epics WHERE id=?').get(snapshot.epicId);
  if (existing) {
    console.error(`Epic ${snapshot.epicId} already exists in the target DB. Run reset-saga-db.mjs first.`);
    db.close();
    process.exit(1);
  }

  if (!opts.confirm) {
    const resumeStageId = resolveResumeStage(snapshot);
    console.log('=== RESTORE PREVIEW ===');
    console.log(`Snapshot: ${opts.in}`);
    console.log(`Captured: ${snapshot.capturedAt}  epic ${snapshot.epicId}  lifecycle_run ${snapshot.lifecycleRunId}`);
    console.log(`Rows to restore (with id preservation):`);
    console.log(`  projects / epics / repositories / project_repositories: 1 / 1 / ${snapshot.repositories.length} / ${snapshot.projectRepositories.length}`);
    console.log(`  artifacts:                       ${snapshot.artifacts.length}`);
    console.log(`  artifact_traces:                 ${snapshot.traces.length}`);
    console.log(`  tasks (formalization):           ${snapshot.formalizationTasks.length}`);
    console.log(`  saga3_lifecycle_runs:            1`);
    console.log(`  saga3_stage_runs:                ${snapshot.stageRuns.length}`);
    console.log(`  saga3_process_runs:              ${snapshot.processRuns.length}`);
    console.log(`  saga3_module_installations:      ${snapshot.moduleInstallations.length}`);
    console.log(`  saga3_node_runs:                 ${snapshot.nodeRuns.length}`);
    console.log(`  saga3_process_transitions:       ${snapshot.transitions.length}`);
    console.log(`  acceptance decisions/items:      ${snapshot.acceptanceDecisions.length} / ${snapshot.acceptanceItems.length}`);
    console.log(`  acceptance baselines/contracts:  ${snapshot.acceptanceBaselines.length} / ${snapshot.solutionContracts.length}`);
    console.log(`  managed productions:             ${snapshot.managedArtifactProductions.length} art / ${snapshot.managedTraceProductions.length} trace / ${snapshot.managedNodeSubmissions.length} node-sub`);
    console.log(`  command_receipts:                ${snapshot.commandReceipts.length}`);
    console.log(`  work_intents / worker_executions:${snapshot.workIntents.length} / ${snapshot.workerExecutions.length}`);
    console.log('');
    console.log('Post-restore state:');
    console.log(`  lifecycle_run: status='paused', current_stage_id='${resumeStageId}'`);
    console.log(`  episode_workflows: stage='development', track='${snapshot.episodeWorkflow?.track ?? 'formal'}'`);
    console.log('');
    console.log('Re-run with --confirm to apply.');
    db.close();
    return;
  }

  try {
    const restored = restoreArtifactSnapshot(db, snapshot);
    db.pragma('foreign_keys = ON');

    console.log('=== RESTORE COMPLETE ===');
    console.log(`Epic ${snapshot.epicId} (lifecycle_run ${snapshot.lifecycleRunId}) restored with id preservation.`);
    console.log(`lifecycle_run -> status='paused', current_stage_id='${restored.resumeStageId}'`);
    console.log(`episode_workflows -> stage='development'`);

    // Quick verification counts.
    const artCount = db.prepare('SELECT COUNT(*) n FROM artifacts WHERE epic_id=?').get(snapshot.epicId).n;
    const srsCount = db.prepare(
      "SELECT COUNT(*) n FROM artifacts WHERE epic_id=? AND type='SRS' AND status='accepted'",
    ).get(snapshot.epicId).n;
    const traceCount = db.prepare(
      'SELECT COUNT(*) n FROM artifact_traces t JOIN artifacts a ON a.id=t.source_id WHERE a.epic_id=?',
    ).get(snapshot.epicId).n;
    const frStage = db.prepare(
      "SELECT status, local_outcome FROM saga3_stage_runs WHERE stage_id='solution-formalization'",
    ).get();
    console.log(`Verify: artifacts=${artCount}, traces=${traceCount}, accepted SRS=${srsCount}`);
    console.log(`Verify: formalization stage_run status=${frStage?.status} local_outcome=${frStage?.local_outcome}`);
    console.log('');
    console.log('Resume the lifecycle with:');
    console.log(`  node dist/orchestrate-cli.js ${snapshot.project.id} ${snapshot.epicId} \\`);
    console.log(`    --resume --idempotency-key=${snapshot.lifecycleRun.idempotency_key}`);
  } catch (e) {
    db.pragma('foreign_keys = ON');
    console.error(`\nRestore failed: ${e.message}`);
    db.close();
    process.exit(1);
  }
}

// ============================================================================
// main
// ============================================================================

const opts = parseArgs(process.argv);
try {
  if (opts.command === 'capture') runCapture(opts);
  else if (opts.command === 'restore') runRestore(opts);
} catch (error) {
  console.error(`Snapshot ${opts.command} failed: ${error.message}`);
  process.exitCode = 1;
}
