#!/usr/bin/env node
/**
 * saga4-snapshot.mjs — снимок состояния pipeline для последующего restore.
 *
 * Экспортирует ВСЕ таблицы, определяющие «где мы» в lifecycle, в один JSON.
 * Позволяет:
 *   1. Сделать снимок перед рискованной операцией
 *   2. Если что-то сломалось — восстановить из снимка
 *   3. Перенести состояние на другую БД (clone)
 *   4. Начать с того же места после фикса бага
 *
 * Usage:
 *   node saga4-snapshot.mjs export > snapshot.json
 *   node saga4-snapshot.mjs import snapshot.json
 *   node saga4-snapshot.mjs export --project=1 > blink-snapshot.json
 *
 * Таблицы в снимке:
 *   - projects (фильтр по project_id)
 *   - repositories
 *   - project_repositories
 *   - epics
 *   - artifacts (+ traces)
 *   - saga3_lifecycle_runs + stage_runs
 *   - saga3_process_runs
 *   - saga3_node_runs
 *   - saga3_managed_artifact_productions + trace_productions
 *   - saga3_exact_candidate_acceptance_decisions + items
 *   - saga3_recovery_cases + attempts
 *   - tasks + task_dependencies
 *   - worker_executions
 *   - command_receipts
 *   - lifecycle_execution_controls
 *
 * НЕ экспортирует (transient/огромные):
 *   - activity_log (audit trail, восстанавливается из логов)
 *   - board-runs (worker JSONL логи — на диске отдельно)
 *   - module_installations (immutable infra, переустанавливается)
 */
import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';

// Таблицы для snapshot: [table, filter_column?]
// Если filter_column задан — экспорт только строк этого project
const SNAPSHOT_TABLES = [
  // Core project structure
  ['projects', 'id'],
  ['repositories'],
  ['project_repositories', 'project_id'],
  ['epics', 'project_id'],
  // Artifacts + traces (the "work done")
  ['artifacts', 'epic_id'],
  ['artifact_traces'],  // фильтр по source_id IN artifacts — позже
  // Lifecycle (where we are in the pipeline)
  ['saga3_lifecycle_runs', 'project_id'],
  ['saga3_stage_runs'],  // фильтр по lifecycle_run_id — позже
  ['saga3_process_runs', 'project_id'],
  ['saga3_process_transitions'],
  ['saga3_node_runs'],
  // Ledger (canonical production records)
  ['saga3_managed_artifact_productions'],
  ['saga3_managed_trace_productions'],
  // Acceptance gate decisions
  ['saga3_exact_candidate_acceptance_decisions'],
  ['saga3_exact_candidate_acceptance_items'],
  // Recovery state
  ['saga3_recovery_cases'],
  ['saga3_recovery_attempts'],
  // Kanban (tasks + worker state)
  ['tasks', 'epic_id'],  // epic_id is column name (not project_id)
  ['task_dependencies'],
  ['task_conflict_keys'],
  ['worker_executions'],
  ['command_receipts'],
  // Engine control state
  ['lifecycle_execution_controls'],
  // Work intents
  ['saga3_work_intents'],
  // Verification evidence
  ['verification_evidence'],
];

// transient tables — skip
const SKIP_TABLES = new Set([
  'activity_log',           // audit trail (huge, reconstructable)
  'saga3_module_installations',  // immutable infra (reinstalled on startup)
  'saga3_scenario_installations',
  'saga3_scenario_module_locks',
  'saga3_protocol_runs',
  'saga3_protocol_step_runs',
  'saga3_call_instances',
  'notes',                  // session notes (not pipeline state)
  'comments',               // task comments (audit, reconstructable)
  'subtasks',
  'runtime_observations',
  'human_requests',
  'integration_intents',
  'lifecycle_events',
  'task_work_items',
  'work_attempts',
  'repository_checkouts',   // machine-specific
]);

function getAllTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_compat_%'").all().map(r => r.name);
}

function getColumns(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map(c => c.name);
}

function exportSnapshot(db, projectId) {
  const snapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    dbPath: DB_PATH,
    projectId: projectId ?? null,
    tables: {},
  };

  // Collect artifact_ids and trace_ids for this project (for filtering)
  let artifactIds = null;
  let traceIds = null;
  let lifecycleRunIds = null;
  let processRunIds = null;
  let taskIds = null;
  if (projectId) {
    artifactIds = db.prepare('SELECT id FROM artifacts WHERE epic_id=?').all(projectId).map(r => r.id);
    traceIds = db.prepare('SELECT id FROM artifact_traces WHERE source_id IN (SELECT id FROM artifacts WHERE epic_id=?)').all(projectId).map(r => r.id);
    lifecycleRunIds = db.prepare('SELECT id FROM saga3_lifecycle_runs WHERE project_id=?').all(projectId).map(r => r.id);
    processRunIds = db.prepare('SELECT id FROM saga3_process_runs WHERE project_id=?').all(projectId).map(r => r.id);
    taskIds = db.prepare('SELECT id FROM tasks WHERE epic_id=?').all(projectId).map(r => r.id);
  }

  for (const [table, filterCol] of SNAPSHOT_TABLES) {
    try {
      // Skip if table doesn't exist
      const exists = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists || exists.c === 0) continue;

      let rows;
      if (projectId && filterCol === 'id' && table === 'projects') {
        rows = db.prepare(`SELECT * FROM ${table} WHERE id=?`).all(projectId);
      } else if (projectId && filterCol === 'project_id') {
        rows = db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(projectId);
      } else if (projectId && filterCol === 'epic_id') {
        rows = db.prepare(`SELECT * FROM ${table} WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)`).all(projectId);
      } else if (projectId && table === 'artifact_traces') {
        rows = artifactIds.length > 0
          ? db.prepare(`SELECT * FROM artifact_traces WHERE source_id IN (${artifactIds.map(()=>'?').join(',')})`).all(...artifactIds)
          : [];
      } else if (projectId && table === 'saga3_stage_runs') {
        rows = lifecycleRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_stage_runs WHERE lifecycle_run_id IN (${lifecycleRunIds.map(()=>'?').join(',')})`).all(...lifecycleRunIds)
          : [];
      } else if (projectId && table === 'saga3_node_runs') {
        rows = processRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_node_runs WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')})`).all(...processRunIds)
          : [];
      } else if (projectId && table === 'saga3_managed_artifact_productions') {
        rows = processRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_managed_artifact_productions WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')})`).all(...processRunIds)
          : [];
      } else if (projectId && table === 'saga3_managed_trace_productions') {
        rows = processRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_managed_trace_productions WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')})`).all(...processRunIds)
          : [];
      } else if (projectId && table === 'saga3_process_transitions') {
        rows = lifecycleRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_process_transitions WHERE lifecycle_run_id IN (${lifecycleRunIds.map(()=>'?').join(',')})`).all(...lifecycleRunIds)
          : [];
      } else if (projectId && table === 'saga3_recovery_cases') {
        rows = processRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_recovery_cases WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')})`).all(...processRunIds)
          : [];
      } else if (projectId && table === 'saga3_recovery_attempts') {
        rows = db.prepare(`SELECT * FROM saga3_recovery_attempts WHERE recovery_case_id IN (SELECT id FROM saga3_recovery_cases WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')}))`).all(...processRunIds);
      } else if (projectId && table === 'saga3_exact_candidate_acceptance_decisions') {
        rows = processRunIds.length > 0
          ? db.prepare(`SELECT * FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')})`).all(...processRunIds)
          : [];
      } else if (projectId && table === 'saga3_exact_candidate_acceptance_items') {
        rows = db.prepare(`SELECT * FROM saga3_exact_candidate_acceptance_items WHERE decision_id IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id IN (${processRunIds.map(()=>'?').join(',')}))`).all(...processRunIds);
      } else if (projectId && table === 'saga3_work_intents') {
        rows = db.prepare(`SELECT * FROM saga3_work_intents WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)`).all(projectId);
      } else if (projectId && table === 'tasks') {
        rows = db.prepare(`SELECT * FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)`).all(projectId);
      } else if (projectId && table === 'task_dependencies') {
        const tIds = db.prepare('SELECT id FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)').all(projectId).map(r=>r.id);
        rows = tIds.length > 0
          ? db.prepare(`SELECT * FROM task_dependencies WHERE task_id IN (${tIds.map(()=>'?').join(',')}) OR depends_on_task_id IN (${tIds.map(()=>'?').join(',')})`).all(...tIds, ...tIds)
          : [];
      } else if (projectId && table === 'task_conflict_keys') {
        const tIds = db.prepare('SELECT id FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)').all(projectId).map(r=>r.id);
        rows = tIds.length > 0
          ? db.prepare(`SELECT * FROM task_conflict_keys WHERE task_id IN (${tIds.map(()=>'?').join(',')})`).all(...tIds)
          : [];
      } else if (projectId && table === 'worker_executions') {
        const tIds = db.prepare('SELECT id FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)').all(projectId).map(r=>r.id);
        rows = tIds.length > 0
          ? db.prepare(`SELECT * FROM worker_executions WHERE task_id IN (${tIds.map(()=>'?').join(',')})`).all(...tIds)
          : [];
      } else if (projectId && table === 'command_receipts') {
        const tIds = db.prepare('SELECT id FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)').all(projectId).map(r=>r.id);
        rows = tIds.length > 0
          ? db.prepare(`SELECT * FROM command_receipts WHERE task_id IN (${tIds.map(()=>'?').join(',')})`).all(...tIds)
          : [];
      } else if (projectId && table === 'lifecycle_execution_controls') {
        rows = lifecycleRunIds.length > 0
          ? db.prepare(`SELECT * FROM lifecycle_execution_controls WHERE epic_id IN (SELECT epic_id FROM saga3_lifecycle_runs WHERE id IN (${lifecycleRunIds.map(()=>'?').join(',')}))`).all(...lifecycleRunIds)
          : [];
      } else if (projectId && table === 'verification_evidence') {
        const tIds = db.prepare('SELECT id FROM tasks WHERE epic_id IN (SELECT id FROM epics WHERE project_id=?)').all(projectId).map(r=>r.id);
        rows = tIds.length > 0
          ? db.prepare(`SELECT * FROM verification_evidence WHERE task_id IN (${tIds.map(()=>'?').join(',')})`).all(...tIds)
          : [];
      } else {
        rows = db.prepare(`SELECT * FROM ${table}`).all();
      }

      snapshot.tables[table] = rows;
      if (rows.length > 0) {
        process.stderr.write(`  ${table}: ${rows.length} rows\n`);
      }
    } catch (e) {
      process.stderr.write(`  SKIP ${table}: ${e.message}\n`);
    }
  }

  return snapshot;
}

function importSnapshot(db, snapshotPath) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  process.stderr.write(`Importing snapshot from ${snapshotPath} (exported ${snapshot.exportedAt})\n`);

  db.pragma('foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Drop immutability triggers temporarily
    const triggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
    ).all();
    for (const t of triggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
    }

    for (const [table, rows] of Object.entries(snapshot.tables)) {
      if (!rows || rows.length === 0) continue;
      const cols = getColumns(db, table);
      if (cols.length === 0) {
        process.stderr.write(`  SKIP ${table}: no such table in target DB\n`);
        continue;
      }
      // Only keep columns that exist in the target table
      const validCols = Object.keys(rows[0]).filter(c => cols.includes(c));
      const placeholders = validCols.map(() => '?').join(', ');
      const colList = validCols.join(', ');

      // Clear existing rows for this table (INSERT OR REPLACE)
      db.prepare(`DELETE FROM ${table}`).run();

      const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`,
      );
      let inserted = 0;
      for (const row of rows) {
        stmt.run(...validCols.map(c => row[c] ?? null));
        inserted++;
      }
      process.stderr.write(`  ${table}: ${inserted} rows imported\n`);
    }

    // Recreate triggers
    for (const t of triggers) {
      if (typeof t.sql === 'string' && t.sql.trim()) {
        db.exec(t.sql);
      }
    }

    // Reset autoincrement to max id (so new rows don't collide)
    for (const table of Object.keys(snapshot.tables)) {
      try {
        db.exec(`DELETE FROM sqlite_sequence WHERE name='${table}'`);
        const maxId = db.prepare(`SELECT MAX(id) as m FROM ${table}`).get();
        if (maxId && maxId.m) {
          db.exec(`INSERT INTO sqlite_sequence VALUES ('${table}', ${maxId.m})`);
        }
      } catch { /* table has no autoincrement */ }
    }

    db.exec('COMMIT');
    process.stderr.write('\nSnapshot imported successfully.\n');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.pragma('foreign_keys=ON');
  }
}

// CLI
const { values, positionals } = parseArgs({
  options: {
    project: { type: 'string', short: 'p' },
  },
  allowPositionals: true,
});
const command = positionals[0];
const projectId = values.project ? Number(values.project) : null;

const db = new Database(DB_PATH);

if (command === 'export') {
  process.stderr.write(`Exporting snapshot${projectId ? ` for project ${projectId}` : ''}...\n`);
  const snapshot = exportSnapshot(db, projectId);
  process.stdout.write(JSON.stringify(snapshot, null, 2));
  process.stderr.write(`\nDone: ${Object.values(snapshot.tables).reduce((a, b) => a + b.length, 0)} total rows\n`);
} else if (command === 'import') {
  // This legacy importer deletes whole tables and cannot preserve the v4
  // provenance/file graph. Keep export for read-only diagnostics, but refuse
  // destructive restore. The official replacement restores an online SQLite
  // backup into a NEW clone and adopts products through an import authority.
  process.stderr.write(
    'UNSAFE_LEGACY_SNAPSHOT_IMPORT_DISABLED: use `node dist/checkpoint-cli.js restore-clone ...`\n',
  );
  process.exitCode = 2;
} else {
  process.stderr.write(`Usage:
  node saga4-snapshot.mjs export [--project=N] > snapshot.json
  node dist/checkpoint-cli.js restore-clone --manifest=... --target-db=... --target-workspace=...

Tables exported:
${SNAPSHOT_TABLES.map(([t]) => '  ' + t).join('\n')}
`);
}

db.close();
