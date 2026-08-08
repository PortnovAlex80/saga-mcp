#!/usr/bin/env node
/**
 * Create Run B (replay proof) — v2. Uses the EXACT same lifecycle input
 * snapshot from Run A (byte-for-byte), only the idempotency key differs.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.argv[2] ?? '.real-factory-smoke/factory.sqlite';
const db = new Database(dbPath);

// Delete the failed Run B (if any)
db.prepare("DELETE FROM factory_launch_requests WHERE initiated_by='replay-proof'").run();
db.prepare("DELETE FROM factory_orders WHERE order_ref LIKE 'order-replayB-%'").run();

// Read the EXACT original lifecycle input from Run A (byte-for-byte same)
const li = db.prepare('SELECT lifecycle_input_json FROM factory_launch_requests ORDER BY rowid LIMIT 1').get();
const inputJson = li.lifecycle_input_json;
const input = JSON.parse(inputJson);
console.log('lifecycle input initiatedBy:', input.initiatedBy);

// Create Run B with EXACT same inputs, different idempotency key
const orderRef = `order-replayB2-${crypto.randomUUID()}`;
const launchRef = `launch-replayB2-${crypto.randomUUID()}`;
const idempotencyKey = `replay-run-B2-${crypto.randomUUID()}`;

db.prepare(
  `INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
   VALUES (?,1,1,NULL,'existing_project','starting')`,
).run(orderRef);
db.prepare(
  `INSERT INTO factory_launch_requests
     (launch_ref,order_ref,mode,project_id,epic_id,
      lifecycle_input_json,lifecycle_input_schema,
      initiated_by,idempotency_key,concurrency,state)
   VALUES (?,?,'new',1,1,?,?, 'real-factory-smoke', ?, 5, 'requested')`,
).run(
  launchRef, orderRef,
  inputJson, 'factory.product-delivery-lifecycle-input.v2',
  idempotencyKey,
);

process.stdout.write(`${JSON.stringify({ launchRef, orderRef, idempotencyKey, dbPath }, null, 2)}\n`);
db.close();
