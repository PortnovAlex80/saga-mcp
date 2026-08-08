#!/usr/bin/env node
/**
 * Create Run B (replay proof) — a NEW factory order with a NEW idempotency key
 * but the SAME semantic inputs (same idea, same project/epic). The project
 * retains its replay capsules from Run A. Run B should hit capsules for all
 * compatible worker invocations and run the replay adapter instead of the LLM.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const dbPath = process.argv[2] ?? '.real-factory-smoke/factory.sqlite';
const db = new Database(dbPath);

// Read the original lifecycle input (same semantic inputs → same replay keys)
const li = db.prepare('SELECT lifecycle_input_json FROM factory_launch_requests ORDER BY rowid LIMIT 1').get();
const inputJson = li.lifecycle_input_json;

// Create a NEW order + launch with a DIFFERENT idempotency key
const orderRef = `order-replayB-${crypto.randomUUID()}`;
const launchRef = `launch-replayB-${crypto.randomUUID()}`;
const idempotencyKey = `replay-run-B-${crypto.randomUUID()}`;

// The order is for the same project/epic (1/1) — capsules persist at project level
db.prepare(
  `INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
   VALUES (?,1,1,NULL,'existing_project','starting')`,
).run(orderRef);
db.prepare(
  `INSERT INTO factory_launch_requests
     (launch_ref,order_ref,mode,project_id,epic_id,
      lifecycle_input_json,lifecycle_input_schema,
      initiated_by,idempotency_key,concurrency,state)
   VALUES (?,?,'new',1,1,?,?, 'replay-proof', ?, 5, 'requested')`,
).run(
  launchRef, orderRef,
  inputJson, 'factory.product-delivery-lifecycle-input.v2',
  idempotencyKey,
);

process.stdout.write(`${JSON.stringify({ launchRef, orderRef, idempotencyKey, dbPath }, null, 2)}\n`);
db.close();
