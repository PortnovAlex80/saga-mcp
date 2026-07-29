// tests/process-modules/recovery-engine.test.mjs
//
// W4-A4 — Universal recovery engine conformance.
//
// Verifies:
//   - routeRecoveryAction covers all 7 RecoveryAction values.
//   - The router prefers module actionMap bindings over disposition defaults,
//     supports the '*' wildcard, and falls back to disposition when no binding
//     is declared.
//   - routeRecoveryActionOnExhaustion promotes in-budget repair actions to
//     'escalate' while preserving terminal/human/external actions.
//   - buildRecoveryFeedback produces a byte-compatible RecoveryFeedback
//     envelope without touching the database.
//   - UniversalRecoveryEngine wires to the existing SqliteRecoveryCaseRepository
//     (Wave 3): it records issues, tracks the attempt budget, honours
//     idempotent replay, promotes the action on exhaustion, and resolves
//     active cases on verifier success.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { RECOVERY_ISSUE_SCHEMA } = await import(
  '../../dist/process-modules/domain/recovery.js'
);
const {
  routeRecoveryAction,
  routeRecoveryActionOnExhaustion,
  buildRecoveryFeedback,
  UniversalRecoveryEngine,
} = await import(
  '../../dist/process-modules/application/recovery-engine.js'
);
const { SqliteRecoveryCaseRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const MODULE_REF = Object.freeze({ name: 'recovery-engine-test', version: '1.0.0' });
const POLICY_ID = 'repair-invalid-result';
const VERIFY_NODE = 'verify';
const REPAIR_NODE = 'repair';
const MAX_ATTEMPTS = 2;

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-recovery-engine-'));
  process.env.DB_PATH = path.join(temp, 'engine.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (70,1,'Engine')`).run();
  // The recovery-case repository keys cases off saga3_process_runs and
  // saga3_node_runs; seed both so the foreign keys resolve. Use the
  // auto-assigned ids as the real processRunId / nodeRunIds.
  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const inputPayload = { projectId: 1, epicId: 70, objective: 'route' };
  const { record } = processRunRepo.start({
    moduleRef: MODULE_REF,
    input: {
      schema: 'recovery.input.v1',
      payload: inputPayload,
      contentHash: sha256Hex(inputPayload),
    },
    executorKind: 'generic-flow',
    projectedStage: 'synthetic',
    invocationContext: {
      projectId: 1,
      epicId: 70,
      initiatedBy: 'recovery-engine-test',
      idempotencyKey: 'engine-seed',
    },
  });
  return { temp, db, nodeRunRepo, processRunId: record.id };
}

/** Mint a real NodeRun row for the given process run (satisfies the FK). */
function mintNodeRun(ctx, nodeId = 'verify') {
  return ctx.nodeRunRepo.start({
    processRunId: ctx.processRunId,
    nodeId,
    nodeKind: 'kernel',
  }).id;
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function makeIssue({ reasonCode = 'CONTRACT_BROKEN', disposition = 'repair' } = {}) {
  return {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId: POLICY_ID,
    disposition,
    reasonCode,
    summary: 'The authored result does not satisfy its contract.',
    findings: [{
      code: 'TRACE_MISSING',
      severity: 'error',
      message: 'Requirement R-1 has no exact implementation trace.',
      path: '$.traces.R-1',
      expected: 'one exact implementation reference',
      actual: null,
    }],
    subjectRefs: [{
      kind: 'artifact',
      ref: 'artifact:synthetic:7',
      contentHash: 'before-repair-hash',
    }],
    acceptanceCriteria: ['R-1 has one exact implementation trace.'],
    allowedChanges: ['artifact:synthetic:7'],
    context: { gate: 'verify-result', contractVersion: 'v1' },
  };
}

function makeSourceProduction() {
  return {
    schema: 'synthetic.invalid-result.v1',
    artifactRef: 'artifact:synthetic:7',
    contentHash: 'before-repair-hash',
    bindings: { artifactId: 7, sourceExecutionId: 'execution-1' },
  };
}

// ---------------------------------------------------------------------------
// routeRecoveryAction — pure router covering all 7 actions.
// ---------------------------------------------------------------------------

test('routeRecoveryAction: explicit actionMap[reasonCode] wins', () => {
  const issue = makeIssue({ reasonCode: 'TRACE_GAP', disposition: 'repair' });
  const binding = {
    nodeId: VERIFY_NODE,
    actionMap: { TRACE_GAP: 'enter-recovery-node', OTHER: 'request-human' },
  };
  assert.equal(routeRecoveryAction(issue, binding), 'enter-recovery-node');
});

test('routeRecoveryAction: "*" wildcard wins when reasonCode is unmapped', () => {
  const issue = makeIssue({ reasonCode: 'UNMAPPED', disposition: 'repair' });
  const binding = {
    nodeId: VERIFY_NODE,
    actionMap: { '*': 'pause-external' },
  };
  assert.equal(routeRecoveryAction(issue, binding), 'pause-external');
});

test('routeRecoveryAction: explicit key beats "*" wildcard', () => {
  const issue = makeIssue({ reasonCode: 'EXACT', disposition: 'repair' });
  const binding = {
    nodeId: VERIFY_NODE,
    actionMap: { EXACT: 'return-to-producer', '*': 'escalate' },
  };
  assert.equal(routeRecoveryAction(issue, binding), 'return-to-producer');
});

test('routeRecoveryAction: disposition fallback when no binding matches', () => {
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'repair' }), null),
    'return-to-producer',
  );
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'retry' }), null),
    'retry-current-node',
  );
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'human' }), null),
    'request-human',
  );
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'fatal' }), null),
    'terminate',
  );
});

test('routeRecoveryAction: empty actionMap falls back to disposition', () => {
  const binding = { nodeId: VERIFY_NODE, actionMap: {} };
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'retry' }), binding),
    'retry-current-node',
  );
});

test('routeRecoveryAction: invalid actionMap value is ignored, falls through', () => {
  // An actionMap value that is not a member of RecoveryAction must not be
  // returned; the router falls back to the disposition default.
  const binding = {
    nodeId: VERIFY_NODE,
    actionMap: { CONTRACT_BROKEN: 'not-a-real-action' },
  };
  assert.equal(
    routeRecoveryAction(makeIssue({ disposition: 'repair' }), binding),
    'return-to-producer',
  );
});

test('routeRecoveryAction: every RecoveryAction is reachable via actionMap', () => {
  const all = [
    'retry-current-node',
    'return-to-producer',
    'enter-recovery-node',
    'request-human',
    'pause-external',
    'escalate',
    'terminate',
  ];
  for (const expected of all) {
    const issue = makeIssue({ reasonCode: 'KEY', disposition: 'repair' });
    const binding = { nodeId: VERIFY_NODE, actionMap: { KEY: expected } };
    assert.equal(routeRecoveryAction(issue, binding), expected);
  }
});

// ---------------------------------------------------------------------------
// routeRecoveryActionOnExhaustion.
// ---------------------------------------------------------------------------

test('routeRecoveryActionOnExhaustion: in-budget repair actions escalate', () => {
  assert.equal(routeRecoveryActionOnExhaustion('retry-current-node'), 'escalate');
  assert.equal(routeRecoveryActionOnExhaustion('return-to-producer'), 'escalate');
  assert.equal(routeRecoveryActionOnExhaustion('enter-recovery-node'), 'escalate');
});

test('routeRecoveryActionOnExhaustion: terminal/human/external actions preserved', () => {
  assert.equal(routeRecoveryActionOnExhaustion('escalate'), 'escalate');
  assert.equal(routeRecoveryActionOnExhaustion('terminate'), 'terminate');
  assert.equal(routeRecoveryActionOnExhaustion('request-human'), 'request-human');
  assert.equal(routeRecoveryActionOnExhaustion('pause-external'), 'pause-external');
});

// ---------------------------------------------------------------------------
// buildRecoveryFeedback — pure envelope assembly.
// ---------------------------------------------------------------------------

test('buildRecoveryFeedback: assembles a schema-stamped envelope', () => {
  const issue = makeIssue();
  const feedback = buildRecoveryFeedback({
    caseId: 42,
    processRunId: 9101,
    moduleRef: MODULE_REF,
    sourceNodeRunId: 777,
    verifyNodeId: VERIFY_NODE,
    repairNodeId: REPAIR_NODE,
    attempt: 1,
    maxAttempts: MAX_ATTEMPTS,
    issueRef: 'recovery-case:42:attempt:1',
    issueHash: 'deadbeef',
    issue,
    sourceProduction: makeSourceProduction(),
  });
  assert.equal(feedback.schemaVersion, 'saga3.recovery-feedback.v1');
  assert.equal(feedback.caseId, 42);
  assert.equal(feedback.processRunId, 9101);
  assert.deepEqual(feedback.moduleRef, MODULE_REF);
  assert.equal(feedback.sourceNodeRunId, 777);
  assert.equal(feedback.verifyNodeId, VERIFY_NODE);
  assert.equal(feedback.repairNodeId, REPAIR_NODE);
  assert.equal(feedback.attempt, 1);
  assert.equal(feedback.maxAttempts, MAX_ATTEMPTS);
  assert.equal(feedback.issueRef, 'recovery-case:42:attempt:1');
  assert.equal(feedback.issueHash, 'deadbeef');
  assert.equal(feedback.issue, issue);
  assert.equal(feedback.sourceProduction.artifactRef, 'artifact:synthetic:7');
});

test('buildRecoveryFeedback: null repairNodeId is preserved', () => {
  const feedback = buildRecoveryFeedback({
    caseId: 1,
    processRunId: 9101,
    moduleRef: MODULE_REF,
    sourceNodeRunId: 1,
    verifyNodeId: VERIFY_NODE,
    repairNodeId: null,
    attempt: 1,
    maxAttempts: 1,
    issueRef: 'ref',
    issueHash: 'hash',
    issue: makeIssue(),
    sourceProduction: makeSourceProduction(),
  });
  assert.equal(feedback.repairNodeId, null);
});

test('buildRecoveryFeedback: pure — same input produces identical output', () => {
  const input = {
    caseId: 7,
    processRunId: 9101,
    moduleRef: MODULE_REF,
    sourceNodeRunId: 9,
    verifyNodeId: VERIFY_NODE,
    repairNodeId: REPAIR_NODE,
    attempt: 3,
    maxAttempts: MAX_ATTEMPTS,
    issueRef: 'recovery-case:7:attempt:3',
    issueHash: 'abc',
    issue: makeIssue(),
    sourceProduction: makeSourceProduction(),
  };
  assert.deepEqual(buildRecoveryFeedback(input), buildRecoveryFeedback(input));
});

// ---------------------------------------------------------------------------
// UniversalRecoveryEngine — wires to the existing SQLite repository.
// ---------------------------------------------------------------------------

test('UniversalRecoveryEngine: records issue and routes in-budget action', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const decision = engine.recordAndRoute({
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: MAX_ATTEMPTS,
      issue: makeIssue({ reasonCode: 'CONTRACT_BROKEN', disposition: 'repair' }),
      sourceProduction: makeSourceProduction(),
      policyBinding: {
        nodeId: VERIFY_NODE,
        actionMap: { CONTRACT_BROKEN: 'return-to-producer' },
      },
    });
    assert.equal(decision.action, 'return-to-producer');
    assert.equal(decision.exhausted, false);
    assert.equal(decision.replayed, false);
    assert.equal(decision.feedback.attempt, 1);
    assert.equal(decision.feedback.maxAttempts, MAX_ATTEMPTS);
    assert.equal(decision.feedback.schemaVersion, 'saga3.recovery-feedback.v1');
    assert.equal(decision.recorded.caseRecord.status, 'active');
    assert.equal(decision.recorded.caseRecord.attemptCount, 1);
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: idempotent replay returns same case + replayed=true', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const issue = makeIssue({ reasonCode: 'CONTRACT_BROKEN' });
    const base = {
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: MAX_ATTEMPTS,
      issue,
      sourceProduction: makeSourceProduction(),
    };
    const first = engine.recordAndRoute(base);
    const second = engine.recordAndRoute(base);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.action, first.action);
    assert.equal(second.feedback.caseId, first.feedback.caseId);
    assert.equal(second.feedback.attempt, first.feedback.attempt);
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: exhaustion promotes in-budget action to escalate', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const issue = makeIssue({ reasonCode: 'CONTRACT_BROKEN', disposition: 'repair' });
    const binding = {
      nodeId: VERIFY_NODE,
      actionMap: { CONTRACT_BROKEN: 'return-to-producer' },
    };
    // maxAttempts=1: attempt 1 is in-budget (1 > 1 is false); the verifier
    // repaired and re-ran, but failed again as a NEW source NodeRun — that
    // opens attempt 2 > maxAttempts 1 → exhausted.
    const first = engine.recordAndRoute({
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: 1,
      issue,
      sourceProduction: makeSourceProduction(),
      policyBinding: binding,
    });
    assert.equal(first.action, 'return-to-producer');
    assert.equal(first.exhausted, false); // attempt 1, in-budget
    assert.equal(first.recorded.caseRecord.status, 'active');

    const second = engine.recordAndRoute({
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: 1,
      issue,
      sourceProduction: makeSourceProduction(),
      policyBinding: binding,
    });
    // Second failure opens attempt 2 > maxAttempts 1 → exhausted + escalated.
    assert.equal(second.exhausted, true);
    assert.equal(second.action, 'escalate');
    assert.equal(second.recorded.caseRecord.status, 'exhausted');
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: terminal action is preserved even when budget exhausts', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    // A fatal issue mapped to 'terminate' must stay 'terminate' even after the
    // repair budget is consumed — exhaustion must not resurrect a terminal
    // action into 'escalate'.
    const binding = {
      nodeId: VERIFY_NODE,
      actionMap: { CONTRACT_BROKEN: 'terminate' },
    };
    const base = {
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: 1,
      issue: makeIssue({ disposition: 'fatal' }),
      sourceProduction: makeSourceProduction(),
      policyBinding: binding,
    };
    const first = engine.recordAndRoute({ ...base, sourceNodeRunId: mintNodeRun(ctx) });
    assert.equal(first.action, 'terminate');
    const second = engine.recordAndRoute({ ...base, sourceNodeRunId: mintNodeRun(ctx) });
    assert.equal(second.exhausted, true);
    assert.equal(second.action, 'terminate'); // NOT promoted to escalate
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: request-human survives exhaustion', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const base = {
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: 1,
      issue: makeIssue({ disposition: 'human' }),
      sourceProduction: makeSourceProduction(),
    };
    const first = engine.recordAndRoute({ ...base, sourceNodeRunId: mintNodeRun(ctx) });
    assert.equal(first.action, 'request-human');
    const second = engine.recordAndRoute({ ...base, sourceNodeRunId: mintNodeRun(ctx) });
    assert.equal(second.exhausted, true);
    assert.equal(second.action, 'request-human'); // NOT promoted to escalate
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: resolveActive clears the active case', () => {
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const opened = engine.recordAndRoute({
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: MAX_ATTEMPTS,
      issue: makeIssue(),
      sourceProduction: makeSourceProduction(),
    });
    assert.notEqual(opened.recorded.caseRecord.id, undefined);
    const activeBefore = repo.readActive(ctx.processRunId, POLICY_ID);
    assert.ok(activeBefore, 'case should be active after recordIssue');

    const resolvedId = engine.resolveActive(
      ctx.processRunId,
      POLICY_ID,
      mintNodeRun(ctx), // a later verifier NodeRun that succeeded
    );
    assert.equal(resolvedId, opened.recorded.caseRecord.id);

    const activeAfter = repo.readActive(ctx.processRunId, POLICY_ID);
    assert.equal(activeAfter, null, 'no active case remains after resolve');
    const resolved = repo.readCase(opened.recorded.caseRecord.id);
    assert.equal(resolved.status, 'resolved');
  } finally {
    cleanup(ctx.temp);
  }
});

test('UniversalRecoveryEngine: feedback from engine matches feedback persisted by the repository', () => {
  // The engine must not synthesise a divergent envelope: the feedback it
  // returns is the exact snapshot the SQLite repository persists, so a
  // ProtocolRun-driven repair path can consume either interchangeably.
  const ctx = fixture();
  try {
    const repo = new SqliteRecoveryCaseRepository(ctx.db);
    const engine = new UniversalRecoveryEngine(repo);
    const decision = engine.recordAndRoute({
      processRunId: ctx.processRunId,
      moduleRef: MODULE_REF,
      sourceNodeRunId: mintNodeRun(ctx),
      verifyNodeId: VERIFY_NODE,
      repairNodeId: REPAIR_NODE,
      maxAttempts: MAX_ATTEMPTS,
      issue: makeIssue(),
      sourceProduction: makeSourceProduction(),
    });
    const persisted = repo.listAttempts(decision.recorded.caseRecord.id)[0];
    assert.deepEqual(decision.feedback, persisted.feedback);
  } finally {
    cleanup(ctx.temp);
  }
});
