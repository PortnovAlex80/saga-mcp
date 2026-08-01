// Stamp process_run_id=1 onto every task in the race DB. The saga4 authority
// gate (findNextClaimable) requires tasks.metadata.process_run_id IS NOT NULL,
// otherwise a card is not claimable. The legacy setup.mjs predates saga4 and
// does not stamp it; this helper brings those fixtures up to the saga4 contract.
//
// Usage:  node tests/dispatcher-race/stamp-process-run.mjs <dbPath>
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node stamp-process-run.mjs <dbPath>');
  process.exit(2);
}

const db = new Database(dbPath);
const rows = db.prepare('SELECT id, metadata FROM tasks').all();
const stamp = db.prepare('UPDATE tasks SET metadata=? WHERE id=?');
for (const row of rows) {
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  if (meta.process_run_id == null) {
    meta.process_run_id = 1;
    stamp.run(JSON.stringify(meta), row.id);
  }
}
db.close();
console.log(`stamped process_run_id on ${rows.length} task(s)`);
