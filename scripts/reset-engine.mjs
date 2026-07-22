// Reset the stale engine flag, prune orphaned saga3 rows left by the old
// spec-${Date.now()} identity, then inspect the surviving state. Idempotent.
import Database from 'better-sqlite3';

const dbPath = 'C:/Users/user/.zcode/saga.db';
const EPIC_ID = 4;
const PROJECT_ID = 3;

const db = new Database(dbPath);

// 1. Reset stale engine flag for this epic.
const row = db.prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(EPIC_ID);
const meta = JSON.parse(row?.metadata || '{}');
meta.engine_running = 0;
meta.engine_pid = null;
meta.controller_version = 'v3';
meta.engine_last_error = null;
db.prepare(`UPDATE episode_workflows SET metadata=?, updated_at=datetime('now') WHERE epic_id=?`)
  .run(JSON.stringify(meta), EPIC_ID);
console.log('Reset engine flag:', JSON.stringify({
  running: meta.engine_running,
  pid: meta.engine_pid,
  ver: meta.controller_version,
  model: meta.active_model,
  conc: meta.engine_concurrency,
  requested_conc: meta.engine_requested_concurrency,
}));

// 2. Check whether the new schema (epic_id column) is present. If not, the
//    next saga3/cli run will migrate it; we just report.
const cols = db.prepare("PRAGMA table_info('saga3_episode_specs')").all();
const hasEpicId = cols.some((c) => c.name === 'epic_id');
console.log('\nsaga3_episode_specs has epic_id column:', hasEpicId);

// 3. Prune orphaned saga3 rows left by old spec-${Date.now()} episodes.
//    These are conditions/evidence tied to spec ids that never had a real row
//    in saga3_episode_specs (0 rows there, but 96 in condition_instances).
const before = {
  conds: db.prepare('SELECT COUNT(*) as n FROM saga3_condition_instances').get().n,
  ev: db.prepare('SELECT COUNT(*) as n FROM saga3_evidence_records').get().n,
  arts: db.prepare('SELECT COUNT(*) as n FROM saga3_artifacts').get().n,
  certs: db.prepare('SELECT COUNT(*) as n FROM saga3_outcome_certificates').get().n,
  work: db.prepare('SELECT COUNT(*) as n FROM saga3_work_intents').get().n,
  assign: db.prepare('SELECT COUNT(*) as n FROM saga3_worker_assignments').get().n,
};
console.log('\nBefore prune:', JSON.stringify(before));

// Only safe to prune if the specs table is still the old schema (0 rows) OR
// after migration — but in either case rows not joined to a surviving spec are
// orphaned. We delete condition_instances / evidence / artifacts that do not
// match a spec id that exists (or will exist after migration). Since the specs
// table has 0 rows now, ALL condition rows are orphaned.
const specIds = db.prepare('SELECT id FROM saga3_episode_specs').all().map((r) => r.id);
if (specIds.length === 0) {
  console.log('No surviving specs — wiping all orphaned saga3 rows.');
  db.exec('DELETE FROM saga3_condition_instances');
  db.exec('DELETE FROM saga3_evidence_records');
  db.exec('DELETE FROM saga3_artifacts');
  db.exec('DELETE FROM saga3_outcome_certificates');
  db.exec('DELETE FROM saga3_work_intents');
  db.exec('DELETE FROM saga3_worker_assignments');
} else {
  const placeholders = specIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM saga3_condition_instances WHERE episode_spec_id NOT IN (${placeholders})`).run(...specIds);
  db.prepare(`DELETE FROM saga3_evidence_records WHERE episode_spec_id NOT IN (${placeholders})`).run(...specIds);
  db.prepare(`DELETE FROM saga3_artifacts WHERE episode_spec_id NOT IN (${placeholders})`).run(...specIds);
  db.prepare(`DELETE FROM saga3_outcome_certificates WHERE episode_spec_id NOT IN (${placeholders})`).run(...specIds);
}

const after = {
  conds: db.prepare('SELECT COUNT(*) as n FROM saga3_condition_instances').get().n,
  ev: db.prepare('SELECT COUNT(*) as n FROM saga3_evidence_records').get().n,
  arts: db.prepare('SELECT COUNT(*) as n FROM saga3_artifacts').get().n,
  certs: db.prepare('SELECT COUNT(*) as n FROM saga3_outcome_certificates').get().n,
  work: db.prepare('SELECT COUNT(*) as n FROM saga3_work_intents').get().n,
  assign: db.prepare('SELECT COUNT(*) as n FROM saga3_worker_assignments').get().n,
};
console.log('After prune: ', JSON.stringify(after));

db.close();
console.log('\nReady for saga3/cli restart. The first run will apply the epic_id migration.');
