#!/usr/bin/env node
/**
 * Check the status of a factory sandbox DB.
 * Usage: node check-sandbox.mjs <db-path>
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write('Usage: node check-sandbox.mjs <db-path>\n');
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });

const tasks = db.prepare(
  `SELECT count(*) as total, sum(case when status='done' then 1 else 0 end) as done FROM tasks`,
).get();
console.log(`tasks: ${tasks.done}/${tasks.total} done`);

const lc = db.prepare('SELECT status, current_stage_id, terminal_status FROM factory_lifecycle_runs').all();
console.log('lifecycle:', JSON.stringify(lc));

const order = db.prepare('SELECT state, last_error FROM factory_orders').all();
console.log('order:', JSON.stringify(order.map(o => ({ state: o.state, error: o.last_error?.slice(0, 80) }))));

try {
  const caps = db.prepare('SELECT count(*) as n FROM factory_replay_capsules').get();
  console.log('capsules:', caps.n);
} catch {
  console.log('capsules: 0');
}

try {
  const taskKinds = db.prepare(
    `SELECT task_kind, count(*) as n FROM tasks GROUP BY task_kind ORDER BY task_kind`,
  ).all();
  console.log('task kinds:', taskKinds.map(t => `${t.task_kind}:${t.n}`).join(', '));
} catch { /* no tasks */ }

db.close();
