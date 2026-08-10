import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';

export function ensureRunningProcessRun(db, id, projectId, epicId) {
  ensureFactoryProcessRunSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
       executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'race-fixture','1.0.0','race-fixture@1.0.0',?,
             'generic-flow','race.input.v1','{}',?,'running')`,
  ).run(id, projectId, epicId, `race-process:${id}`, 'a'.repeat(64));
}
