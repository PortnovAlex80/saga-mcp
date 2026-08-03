import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteDeliveryApprovalInbox } = await import(
  '../../dist/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.js'
);

test('delivery approval inbox pauses, binds and immutably replays a human decision', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-delivery-approval-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'approval.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
    db.prepare(
      `INSERT INTO trusted_providers
        (id,project_id,name,version,category,trust_basis,determinism,scope,status)
       VALUES (5,1,'release-manager','1','authorized_decision',
               'named release authority','none','delivery','active')`,
    ).run();
    const processRepo = new SqliteProcessRunRepository(db);
    const started = processRepo.start({
      moduleRef: { name: 'delivery-release', version: '1.0.0' },
      executorKind: 'generic-flow',
      projectedStage: null,
      input: {
        schema: 'case',
        payload: { case: true },
        contentHash: sha256Hex({ case: true }),
      },
      invocationContext: {
        projectId: 1,
        epicId: 10,
        initiatedBy: 'test',
        idempotencyKey: 'approval-test',
      },
    });
    const deliveryCase = {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'operator',
      integratedCandidate: { hash: 'candidate-hash' },
      policy: { contentHash: 'policy-hash' },
    };
    const inbox = new SqliteDeliveryApprovalInbox(db);
    const pending = inbox.decide({
      processRunId: started.record.id,
      deliveryCase,
      preflightHash: 'preflight-hash',
      heartbeat: () => {},
    });
    assert.equal(pending.status, 'pending');
    assert.equal(inbox.listOpen(1).length, 1);

    const requestId = `delivery-approval-request:${started.record.id}`;
    const recorded = inbox.recordDecision({
      requestId,
      status: 'approved',
      decidedBy: 'release-owner',
      rationale: 'All release evidence reviewed.',
      providerId: 5,
    });
    assert.equal(recorded.replayed, false);
    assert.equal(inbox.listOpen(1).length, 0);

    const approved = inbox.decide({
      processRunId: started.record.id,
      deliveryCase,
      preflightHash: 'preflight-hash',
      heartbeat: () => {},
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.provider.providerId, 5);
    assert.equal(approved.decision.hash, recorded.decisionHash);

    const replay = inbox.recordDecision({
      requestId,
      status: 'approved',
      decidedBy: 'release-owner',
      rationale: 'All release evidence reviewed.',
      providerId: 5,
    });
    assert.equal(replay.replayed, true);
    assert.throws(
      () => inbox.recordDecision({
        requestId,
        status: 'denied',
        decidedBy: 'release-owner',
        rationale: 'Changed mind.',
        providerId: 5,
      }),
      /DELIVERY_APPROVAL_DECISION_IMMUTABLE/,
    );
  } finally {
    closeDb();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    rmSync(temp, { recursive: true, force: true });
  }
});
