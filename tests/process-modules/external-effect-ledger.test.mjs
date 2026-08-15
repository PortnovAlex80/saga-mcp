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
const { SqliteExternalEffectLedger } = await import(
  '../../dist/process-modules/persistence/sqlite-external-effect-ledger.js'
);

const MODULE_REF = { name: 'software-delivery', version: '1.0.0' };

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-external-effect-'));
  process.env.DB_PATH = path.join(temp, 'external-effect.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const processRepo = new SqliteProcessRunRepository(db);
  const input = { releaseCandidateRef: 'candidate:abc' };
  const processRun = processRepo.start({
    moduleRef: MODULE_REF,
    executorKind: 'generic-flow',
    input: {
      schema: 'factory.delivery-case.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'delivery',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'operator',
      idempotencyKey: 'delivery-run-1',
    },
  }).record;
  return {
    temp,
    db,
    processRun,
    ledger: new SqliteExternalEffectLedger(db),
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startAction(ledger, processRunId, overrides = {}) {
  const request = overrides.request ?? {
    candidateHash: 'a'.repeat(64),
    environment: 'production',
  };
  return ledger.start({
    providerNamespace: overrides.providerNamespace ?? 'release-provider.v1',
    actionKey: overrides.actionKey ?? 'deploy:candidate-abc:production',
    processRunId: overrides.processRunId ?? processRunId,
    moduleRef: overrides.moduleRef ?? MODULE_REF,
    nodeId: overrides.nodeId ?? 'execute-release',
    request,
    requestHash: overrides.requestHash ?? sha256Hex(request),
  });
}

function requireClaim(value) {
  assert.ok(value, 'expected a claim');
  return value.claim;
}

test('start verifies canonical request hash and pins key to one immutable request and binding', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const first = startAction(ledger, processRun.id);
    assert.equal(first.replayed, false);
    assert.equal(first.record.state, 'new');
    assert.equal(first.record.requestHash, sha256Hex({
      candidateHash: 'a'.repeat(64),
      environment: 'production',
    }));

    const replay = startAction(ledger, processRun.id);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);

    assert.throws(
      () => startAction(ledger, processRun.id, {
        request: { candidateHash: 'b'.repeat(64), environment: 'production' },
      }),
      /ACTION_KEY_REUSED_WITH_DIFFERENT_REQUEST/,
    );
    assert.throws(
      () => startAction(ledger, processRun.id, { nodeId: 'another-node' }),
      /ACTION_KEY_REUSED_WITH_DIFFERENT_BINDING/,
    );
    assert.throws(
      () => startAction(ledger, processRun.id, { requestHash: '0'.repeat(64) }),
      /REQUEST_HASH_MISMATCH/,
    );
    assert.throws(
      () => startAction(ledger, processRun.id, {
        providerNamespace: 'another-provider.v1',
        actionKey: 'same-provider-independent-key',
        moduleRef: { name: 'wrong-module', version: '1.0.0' },
      }),
      /PROCESS_RUN_MODULE_MISMATCH/,
    );
  } finally {
    cleanup(temp);
  }
});

test('cancelled ProcessRun cannot begin or re-claim an external mutation', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id).record;
    const processRepo = new SqliteProcessRunRepository();
    processRepo.update(processRun.id, { status: 'cancelled', error: 'operator cancelled' });

    assert.throws(
      () => ledger.claim({
        actionId: action.id,
        owner: 'stale-delivery-worker',
        leaseSeconds: 60,
      }),
      /PROCESS_RUN_NOT_ACTIVE/,
    );
    assert.throws(
      () => startAction(ledger, processRun.id, {
        providerNamespace: 'release-provider.v1',
        actionKey: 'deploy:another-candidate:production',
      }),
      /PROCESS_RUN_NOT_ACTIVE/,
    );
  } finally {
    cleanup(temp);
  }
});

test('successful execution is fenced, terminal and idempotent for the exact result', () => {
  const { temp, db, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id).record;
    const claimed = ledger.claim({
      actionId: action.id,
      owner: 'delivery-worker:1',
      leaseSeconds: 60,
    });
    const claim = requireClaim(claimed);
    assert.equal(claim.fence, 1);
    assert.equal(claimed.record.state, 'executing');
    assert.equal(claimed.record.executionAttempts, 1);

    const result = {
      outcome: 'succeeded',
      providerEffectId: 'deployment:42',
      receipt: { deploymentId: 42, status: 'accepted' },
    };
    const completed = ledger.recordExecutionResult({ claim, result });
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.providerEffectId, 'deployment:42');
    assert.equal(completed.activeClaimKind, null);
    assert.ok(completed.completedAt);
    assert.equal(ledger.claim({
      actionId: action.id,
      owner: 'delivery-worker:2',
      leaseSeconds: 60,
    }), null);

    const replay = ledger.recordExecutionResult({ claim, result });
    assert.equal(replay.state, 'succeeded');
    assert.equal(replay.executionResultHash, completed.executionResultHash);
    assert.throws(
      () => ledger.recordExecutionResult({
        claim,
        result: {
          outcome: 'succeeded',
          providerEffectId: 'deployment:DIFFERENT',
          receipt: { deploymentId: 42, status: 'accepted' },
        },
      }),
      /EXECUTION_RESULT_REPLAY_MISMATCH/,
    );

    const events = db.prepare(
      `SELECT sequence,event_type,claim_fence
         FROM factory_external_effect_events
        WHERE action_id=? ORDER BY sequence`,
    ).all(action.id);
    assert.deepEqual(
      events.map(event => event.event_type),
      ['action.started', 'execution.claimed', 'execution.succeeded'],
    );
    assert.deepEqual(events.map(event => event.claim_fence), [0, 1, 1]);
  } finally {
    cleanup(temp);
  }
});

test('failed or unknown execution cannot retry until observation authorizes it', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id).record;
    const firstExecution = requireClaim(ledger.claim({
      actionId: action.id,
      owner: 'delivery-worker:1',
      leaseSeconds: 60,
    }));
    const failed = ledger.recordExecutionResult({
      claim: firstExecution,
      result: {
        outcome: 'failed',
        error: 'provider returned 503 after accepting the connection',
        details: { status: 503 },
      },
    });
    assert.equal(failed.state, 'failed');
    assert.throws(
      () => ledger.claim({
        actionId: action.id,
        owner: 'delivery-worker:2',
        leaseSeconds: 60,
      }),
      /OBSERVATION_REQUIRED_BEFORE_RETRY/,
    );

    const observation = requireClaim(ledger.claimObservation({
      actionId: action.id,
      owner: 'release-reconciler:1',
      leaseSeconds: 60,
    }));
    assert.ok(observation.fence > firstExecution.fence);
    const authorized = ledger.recordObservation({
      claim: observation,
      observation: {
        outcome: 'absent-retry-safe',
        evidence: {
          providerQueryId: 'query:17',
          matchedDeployments: [],
          idempotencyTokenSeen: false,
        },
      },
    });
    assert.equal(authorized.state, 'retry-authorized');

    const secondExecution = requireClaim(ledger.claim({
      actionId: action.id,
      owner: 'delivery-worker:2',
      leaseSeconds: 60,
    }));
    assert.ok(secondExecution.fence > observation.fence);
    assert.throws(
      () => ledger.recordExecutionResult({
        claim: firstExecution,
        result: {
          outcome: 'failed',
          error: 'provider returned 503 after accepting the connection',
          details: { status: 503 },
        },
      }),
      /STALE_EXECUTION_FENCE/,
    );
    const completed = ledger.recordExecutionResult({
      claim: secondExecution,
      result: {
        outcome: 'succeeded',
        receipt: { deploymentId: 99 },
        providerEffectId: 'deployment:99',
      },
    });
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.executionAttempts, 2);
  } finally {
    cleanup(temp);
  }
});

test('authoritative observation can settle an unknown action as matched or blocked', () => {
  const { temp, ledger, processRun } = fixture();
  try {
    const matchedAction = startAction(ledger, processRun.id).record;
    const execution = requireClaim(ledger.claim({
      actionId: matchedAction.id,
      owner: 'worker',
      leaseSeconds: 60,
    }));
    ledger.recordExecutionResult({
      claim: execution,
      result: { outcome: 'unknown', error: 'connection reset after write' },
    });
    const observation = requireClaim(ledger.claimObservation({
      actionId: matchedAction.id,
      owner: 'provider-observer',
      leaseSeconds: 60,
    }));
    const matched = ledger.recordObservation({
      claim: observation,
      observation: {
        outcome: 'matched',
        evidence: { deploymentId: 314, candidateHash: 'a'.repeat(64) },
        providerEffectId: 'deployment:314',
      },
    });
    assert.equal(matched.state, 'succeeded');
    assert.equal(matched.providerEffectId, 'deployment:314');

    const blockedAction = startAction(ledger, processRun.id, {
      actionKey: 'deploy:candidate-abc:restricted-environment',
    }).record;
    const blockedExecution = requireClaim(ledger.claim({
      actionId: blockedAction.id,
      owner: 'worker',
      leaseSeconds: 60,
    }));
    ledger.recordExecutionResult({
      claim: blockedExecution,
      result: { outcome: 'failed', error: 'policy response was ambiguous' },
    });
    const blockedObservation = requireClaim(ledger.claimObservation({
      actionId: blockedAction.id,
      owner: 'provider-observer',
      leaseSeconds: 60,
    }));
    const blocked = ledger.recordObservation({
      claim: blockedObservation,
      observation: {
        outcome: 'blocked',
        reason: 'provider policy permanently denies this target',
        evidence: { policyDecisionId: 'deny:7' },
      },
    });
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.lastError, /permanently denies/);
    assert.equal(ledger.claim({
      actionId: blocked.id,
      owner: 'worker',
      leaseSeconds: 60,
    }), null);
  } finally {
    cleanup(temp);
  }
});

test('expired execution requires observation and every replacement claim fences stale owners', () => {
  const { temp, db, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id).record;
    const abandonedExecution = requireClaim(ledger.claim({
      actionId: action.id,
      owner: 'worker-that-crashed',
      leaseSeconds: 60,
    }));
    assert.equal(ledger.claimObservation({
      actionId: action.id,
      owner: 'observer',
      leaseSeconds: 60,
    }), null, 'a still-live execution cannot be observed concurrently');

    db.prepare(
      `UPDATE factory_external_effect_actions
          SET active_claim_expires_at='2000-01-01 00:00:00'
        WHERE id=?`,
    ).run(action.id);
    const firstObservation = requireClaim(ledger.claimObservation({
      actionId: action.id,
      owner: 'observer:old',
      leaseSeconds: 60,
    }));
    assert.ok(firstObservation.fence > abandonedExecution.fence);
    assert.equal(ledger.read(action.id).state, 'unknown');
    assert.throws(
      () => ledger.recordExecutionResult({
        claim: abandonedExecution,
        result: {
          outcome: 'succeeded',
          receipt: { late: true },
        },
      }),
      /STALE_EXECUTION_FENCE/,
    );

    db.prepare(
      `UPDATE factory_external_effect_actions
          SET active_claim_expires_at='2000-01-01 00:00:00'
        WHERE id=?`,
    ).run(action.id);
    const replacementObservation = requireClaim(ledger.claimObservation({
      actionId: action.id,
      owner: 'observer:new',
      leaseSeconds: 60,
    }));
    assert.ok(replacementObservation.fence > firstObservation.fence);
    assert.throws(
      () => ledger.recordObservation({
        claim: firstObservation,
        observation: {
          outcome: 'absent-retry-safe',
          evidence: { stale: true },
        },
      }),
      /STALE_OBSERVATION_FENCE/,
    );
    const blocked = ledger.recordObservation({
      claim: replacementObservation,
      observation: {
        outcome: 'blocked',
        reason: 'provider state cannot be reconciled automatically',
        evidence: { incident: 'INC-1' },
      },
    });
    assert.equal(blocked.state, 'blocked');
  } finally {
    cleanup(temp);
  }
});

test('binding and append-only audit history are protected by SQLite triggers', () => {
  const { temp, db, ledger, processRun } = fixture();
  try {
    const action = startAction(ledger, processRun.id).record;
    assert.throws(
      () => db.prepare(
        `UPDATE factory_external_effect_actions
            SET request_hash=? WHERE id=?`,
      ).run('f'.repeat(64), action.id),
      /EXTERNAL_EFFECT_ACTION_BINDING_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare(
        `UPDATE factory_external_effect_events
            SET actor='tampered' WHERE action_id=?`,
      ).run(action.id),
      /EXTERNAL_EFFECT_AUDIT_EVENT_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare(
        'DELETE FROM factory_external_effect_events WHERE action_id=?',
      ).run(action.id),
      /EXTERNAL_EFFECT_AUDIT_EVENT_DELETE_FORBIDDEN/,
    );
    assert.throws(
      () => db.prepare(
        'DELETE FROM factory_external_effect_actions WHERE id=?',
      ).run(action.id),
      /EXTERNAL_EFFECT_ACTION_AUDIT_DELETE_FORBIDDEN/,
    );
  } finally {
    cleanup(temp);
  }
});
