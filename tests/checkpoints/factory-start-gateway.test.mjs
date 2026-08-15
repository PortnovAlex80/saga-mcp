import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  decodeFactoryStartCommand,
  resolveFactoryResumeTarget,
} from '../../dist/app/factory-start.js';
import {
  claimFactoryLaunch,
  markFactoryLaunchRunning,
  requestFactoryLaunch,
} from '../../dist/infrastructure/factory/sqlite-factory-launch-repository.js';
import { isPublicAddress } from '../../tracker-view/product-idea-source.mjs';

test('factory start accepts exactly one public selector and no launch coordinates', () => {
  assert.deepEqual(decodeFactoryStartCommand({ project_id:7 }), {
    kind:'resume', projectId:7,
  });
  assert.deepEqual(decodeFactoryStartCommand({ idea_url:'https://example.com/idea#x' }), {
    kind:'new', ideaUrl:'https://example.com/idea', idempotencyKey:undefined,
  });
  // new_start mode: intentional new Factory Run for an existing project (§7)
  assert.deepEqual(decodeFactoryStartCommand({ project_id:7, mode:'new_start' }), {
    kind:'new_start', projectId:7, idempotencyKey:undefined,
  });
  assert.deepEqual(
    decodeFactoryStartCommand({ project_id:7, mode:'new_start', idempotency_key:'K1' }),
    { kind:'new_start', projectId:7, idempotencyKey:'K1' },
  );
  assert.deepEqual(
    decodeFactoryStartCommand({ idea_url:'https://x.example/i', idempotency_key:'K2' }),
    { kind:'new', ideaUrl:'https://x.example/i', idempotencyKey:'K2' },
  );
  assert.throws(() => decodeFactoryStartCommand({}), /exactly one/);
  assert.throws(
    () => decodeFactoryStartCommand({ project_id:7, idea_url:'https://example.com' }),
    /exactly one/,
  );
  assert.throws(
    () => decodeFactoryStartCommand({ project_id:7, epic_id:9 }),
    /unsupported factory start field/,
  );
  assert.throws(() => decodeFactoryStartCommand({ idea_url:'http://example.com' }), /HTTPS/);
});

test('idea source network policy rejects local and private destinations', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.1.1', '::1', 'fe80::1', 'fd00::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('project resume resolves one exact durable run and fails ambiguity', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  const insert = db.prepare(
    `INSERT INTO factory_lifecycle_runs
      (lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
       definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,
       entry_stage_id,current_stage_id)
     VALUES ('factory','1','factory@1','Factory','','{}','d',1,2,'actor',?,
       'input','{}','h',?,'a','a')`,
  );
  insert.run('order-a', 'paused');
  const target = resolveFactoryResumeTarget(db, 1);
  assert.equal(target.epicId, 2);
  assert.equal(target.idempotencyKey, 'order-a');
  insert.run('order-b', 'running');
  assert.throws(() => resolveFactoryResumeTarget(db, 1), /exactly one/);
  db.close();
});

test('runtime host launch capability is single-use', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  db.prepare(
    `INSERT INTO factory_orders
       (order_ref,project_id,epic_id,source_kind,state)
     VALUES ('o',1,2,'existing_project','paused')`,
  ).run();
  const ref = requestFactoryLaunch({
    orderRef:'o', mode:'resume', projectId:1, epicId:2,
    initiatedBy:'actor', idempotencyKey:'key', concurrency:4,
  }, db);
  const ticket = claimFactoryLaunch(ref, 'fence-a', db);
  assert.equal(ticket.projectId, 1);
  assert.equal(requestFactoryLaunch({
    orderRef:'o', mode:'resume', projectId:1, epicId:2,
    initiatedBy:'actor', idempotencyKey:'key', concurrency:4,
  }, db), ref);
  assert.throws(() => claimFactoryLaunch(ref, 'fence-b', db), /NOT_CLAIMABLE/);
  db.close();
});

test('continuation launch preserves the FactoryOrder root lifecycle pointer', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  const insertRun = db.prepare(
    `INSERT INTO factory_lifecycle_runs
      (id,lifecycle_name,lifecycle_version,lifecycle_ref_key,display_name,description,
       definition_snapshot,definition_hash,project_id,epic_id,initiated_by,
       idempotency_key,input_schema,input_snapshot,input_hash,status,
       entry_stage_id,current_stage_id)
     VALUES (?, 'factory', '1', 'factory@1', 'Factory', '', '{}', ?, 1, 2,
       'actor', ?, 'input', '{}', ?, ?, 'a', 'a')`,
  );
  insertRun.run(1, 'root-definition', 'root-key', 'root-input', 'failed');
  insertRun.run(2, 'child-definition', 'child-key', 'child-input', 'created');
  db.prepare(
    `INSERT INTO factory_orders
       (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
     VALUES ('o',1,2,1,'existing_project','start_failed')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_order_runs
       (order_ref,lifecycle_run_id,ordinal,parent_lifecycle_run_id,kind,continuation_ref)
     VALUES ('o',1,0,NULL,'root',NULL),('o',2,1,1,'continuation','continuation:1')`,
  ).run();
  const ref = requestFactoryLaunch({
    orderRef:'o', mode:'resume', projectId:1, epicId:2, lifecycleRunId:2,
    initiatedBy:'actor', idempotencyKey:'child-launch', concurrency:2,
  }, db);
  const ticket = claimFactoryLaunch(ref, 'fence', db);
  markFactoryLaunchRunning(ref, ticket.claimToken, 2, db);

  assert.equal(
    db.prepare("SELECT lifecycle_run_id FROM factory_orders WHERE order_ref='o'").get()
      .lifecycle_run_id,
    1,
  );
  assert.equal(
    resolveFactoryResumeTarget(db, 1).orderRef,
    'o',
    'child resume resolves its FactoryOrder through append-only order-run lineage',
  );
  db.close();
});
