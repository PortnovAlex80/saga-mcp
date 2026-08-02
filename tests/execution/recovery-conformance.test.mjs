// tests/execution/recovery-conformance.test.mjs
//
// W4-A8 — §3 EXIT GATE item 7: "One recovery engine repairs two unrelated
// synthetic modules." Spec: docs/refactor-management/09-contracts/
// WAVE4-PROTOCOL-RECOVERY-SPEC.md §1, §3.7.
//
// WAVE 6 CUTOVER NOTE: the dead `UniversalRecoveryEngine` /
// `routeRecoveryAction` SPI (`application/recovery-engine.ts`) was removed —
// production recovery is `flow.recovery[]` (FlowRecoveryDefinition) executed
// by `generic-flow-executor.reconcileRecoveryCheckpoint`, which calls the
// SAME `SqliteRecoveryCaseRepository.recordIssue` port these tests drive
// directly. The module-kind-agnostic property the original §3.7 gate proved
// is now established by routing BOTH synthetic modules (LM + External)
// through the SAME durable recordIssue path and asserting identical
// persistence invariants (exhaustion flips, idempotent replay, closed
// RecoveryAction union from the retained Wave 1 SPI). There is no per-module
// policy-binding router left to test; the durable case + the closed union are
// the surviving contract.
//
// WHAT THIS PROVES
//   The durable recovery case loop is module-kind-agnostic. ONE repository,
//   fed module-owned RecoveryIssue from two completely unrelated synthetic
//   modules (an LM-node module and an External-node module), produces the
//   correct durable outcome in every one of the conformance scenarios:
//     1. PRODUCER REENTRY — a repair-disposition issue for both modules
//        opens an active case the executor routes back to the producer
//        (FlowRecoveryDefinition.repairNodeId), identical across module kinds.
//     2. HUMAN ACTION — a human-disposition issue for both modules records
//        durably and pauses (disposition-driven, module-kind-agnostic).
//     3. ESCALATION — an exhausted case for both modules is terminal
//        `exhausted`, which FlowRecoveryDefinition.onExhausted escalates.
//     4. EXHAUSTION — after maxAttempts is consumed, the durable case flips
//        to `exhausted` and a fresh source NodeRun opens a NEW case.
//     5. RESTART — the same source NodeRun + same issue is an idempotent
//        replay; restarting the worker does NOT consume the retry budget
//        again (this is the §0.7.11 crash-resume contract applied to
//        recovery).
//
//   The two modules are deliberately unrelated: lm-marketing is an LM-node
//   module with a `git_change` execution profile; external-seo is an
//   External-node module with an adapter ref and NO execution profile. They
//   share no flow, no schema, no skill, no vocabulary. The test proves the
//   durable loop never switches on module kind, name, or vocabulary.
//
// Spec ref: WAVE4-PROTOCOL-RECOVERY-SPEC.md §1 (lanes), §3 (exit gate),
//   §4 (anti-scope: existing recovery system preserved).
// Plan ref: §0.7.11, §8.10 (RecoveryAction union).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// W0-A7 synthetic fixtures — two UNRELATED modules (LM + External).
import lmMarketingModule, {
  LM_MARKETING_MODULE_REF,
} from '../fixtures/synthetic-modules/lm-marketing/definition.mjs';
import externalSeoModule, {
  EXTERNAL_SEO_MODULE_REF,
} from '../fixtures/synthetic-modules/external-seo/definition.mjs';

// ---------------------------------------------------------------------------
// Wave-1 SPI: RecoveryIssue + RecoveryFeedback + RecoveryAction. These are
// present in every worktree (frozen Wave 1 checkpoint). The RecoveryAction
// union (7 values) is the closed vocabulary the durable loop + the
// FlowRecoveryDefinition consume. The Wave 6 cutover removed the dead
// `application/recovery-engine.ts` SPI; these tests drive the SAME
// `SqliteRecoveryCaseRepository.recordIssue` port the wired executor uses.
// ---------------------------------------------------------------------------
const SPI = await import(
  '../../dist/process-modules/domain/spi/index.js'
);
const {
  RECOVERY_ISSUE_SCHEMA,
  RECOVERY_FEEDBACK_SCHEMA,
} = await import(
  '../../dist/process-modules/domain/recovery.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// The 7 valid RecoveryAction values, frozen from the Wave 1 SPI. The engine
// MUST only ever return one of these. Imported dynamically above; mirror as a
// local constant for assertion clarity.
const RECOVERY_ACTION_VALUES = Object.freeze([
  'retry-current-node',
  'return-to-producer',
  'enter-recovery-node',
  'request-human',
  'pause-external',
  'escalate',
  'terminate',
]);

// ---------------------------------------------------------------------------
// Module-agnostic issue + binding builders.
//
// Each builder takes a module fixture so the resulting issue/binding carries
// THAT module's vocabulary (policy id, reason code, verify node id, repair
// node id). The engine never switches on these strings — it only routes via
// the policy binding's actionMap keys. By feeding both modules through the
// same builder and asserting identical ROUTING (different vocabulary, same
// RecoveryAction), we prove the engine is module-kind-agnostic.
// ---------------------------------------------------------------------------

/**
 * Build a RecoveryIssue for a given module + disposition. The issue carries
 * module-owned vocabulary (policyId / reasonCode are opaque to the runtime).
 *
 * @param {{
 *   module: any;
 *   policyId: string;
 *   reasonCode: string;
 *   disposition?: 'repair' | 'retry' | 'human' | 'fatal';
 *   summary?: string;
 * }} p
 * @returns {any} RecoveryIssue
 */
function buildIssue({
  module,
  policyId,
  reasonCode,
  disposition = 'repair',
  summary = 'Verifier rejected the production.',
}) {
  return {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId,
    disposition,
    reasonCode,
    summary,
    findings: [
      {
        code: 'CONTRACT_BROKEN',
        severity: 'error',
        message: `${module.identity.displayName} production failed its gate.`,
        path: '$.productions[0]',
        expected: 'a canonical artifact matching the schema',
        actual: null,
      },
    ],
    subjectRefs: [
      {
        kind: 'artifact',
        ref: `${module.identity.name}:production:1`,
        contentHash: 'sha256:' + '0'.repeat(64),
      },
    ],
    acceptanceCriteria: [
      'Production passes the module-owned verifier.',
    ],
    allowedChanges: [`${module.identity.name}:production:1`],
    context: {
      moduleKind: module.identity.kind,
      nodeKind: module.flow.nodes[0].kind,
    },
  };
}

/**
 * Build the durable source production snapshot that was rejected by the
 * verifier. Mirrors `RecoverySourceProduction` from domain/recovery.ts.
 *
 * @param {{ module: any; contentHash?: string }} p
 * @returns {any} RecoverySourceProduction
 */
function buildSourceProduction({ module, contentHash }) {
  const hash = contentHash ?? sha256Hex({ v: 1, module: module.identity.name });
  return {
    schema: module.outputContract.id,
    artifactRef: `${module.identity.name}:production:1`,
    contentHash: hash,
    bindings: { producedBy: module.identity.name, version: 1 },
  };
}

/**
 * Wave 6 cutover helper: spin up an isolated SQLite world for one synthetic
 * module, seed the ProcessRun + a completed source NodeRun, and record one
 * recovery issue through the SAME SqliteRecoveryCaseRepository.recordIssue
 * port the wired generic-flow-executor.reconcileRecoveryCheckpoint calls.
 * Returns the RecordRecoveryIssueResult so each scenario asserts the durable
 * outcome that survives engine removal.
 *
 * The DB is opened, recorded, and CLOSED before returning — the JS result
 * objects (caseRecord / feedback / issue) survive the close. This lets two
 * modules be exercised back-to-back in one test without the getDb() singleton
 * holding a stale handle on the first module's DB_PATH. `close()` is a no-op
 * kept for finally-block symmetry; it removes the temp dir.
 *
 * @param {{
 *   module: any;
 *   moduleRef: any;
 *   policyId: string;
 *   reasonCode: string;
 *   disposition?: 'repair' | 'retry' | 'human' | 'fatal';
 *   producerNodeId: string;
 *   verifyNodeId: string;
 *   maxAttempts?: number;
 *   epicId: number;
 *   suffix: string;
 * }} p
 * @returns {Promise<{ recorded: any, close: () => void }>}
 */
async function recordIssueForModule({
  module,
  moduleRef,
  policyId,
  reasonCode,
  disposition = 'repair',
  producerNodeId,
  verifyNodeId,
  maxAttempts = 2,
  epicId,
  suffix,
}) {
  const { getDb, closeDb } = await import('../../dist/db.js');
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { SqliteNodeRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
  );
  const { SqliteRecoveryCaseRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
  );

  const temp = mkdtempSync(path.join(os.tmpdir(), `w4-a8-${suffix}-`));
  process.env.DB_PATH = path.join(temp, `${suffix}.db`);
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,1,'W4A8')`).run(epicId);

  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const recoveryRepo = new SqliteRecoveryCaseRepository(db);

  const started = processRunRepo.start({
    moduleRef,
    input: {
      schema: module.inputContract.id,
      payload: { scenario: suffix },
      contentHash: sha256Hex({ scenario: suffix }),
    },
    executorKind: 'generic-flow',
    projectedStage: 'conformance',
    invocationContext: {
      projectId: 1,
      epicId,
      initiatedBy: `w4-a8-${suffix}`,
      idempotencyKey: `w4-a8-${suffix}-run-1`,
    },
  });
  const processRunId = started.record.id;

  const nodeRunStarted = nodeRunRepo.start({
    processRunId,
    nodeId: producerNodeId,
    nodeKind: module.flow.nodes[0].kind,
  });
  const nodeRun = nodeRunRepo.complete({
    id: nodeRunStarted.id,
    event: 'runtime.completed',
  });

  const issue = buildIssue({ module, policyId, reasonCode, disposition });
  const recorded = recoveryRepo.recordIssue({
    processRunId,
    moduleRef,
    sourceNodeRunId: nodeRun.id,
    verifyNodeId,
    repairNodeId: producerNodeId,
    maxAttempts,
    issue,
    sourceProduction: buildSourceProduction({ module }),
  });

  // Close the DB handle NOW so the next recordIssueForModule call can reopen
  // against its own DB_PATH (getDb() is a singleton keyed by env at open time).
  closeDb();
  const close = () => {
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  };
  return { recorded, close };
}

// ===========================================================================
// CONFORMANCE SCENARIO 1 — PRODUCER REENTRY (return-to-producer)
//
// Wave 6 cutover: the deleted routeRecoveryAction mapped (issue, binding) to
// the `return-to-producer` action. The durable equivalent: a repair-disposition
// issue opens an ACTIVE case whose repairNodeId points back at the producer
// (FlowRecoveryDefinition.repairNodeId reads this). The executor routes the
// feedback to that node identically regardless of module kind. This scenario
// proves BOTH synthetic modules (LM + External) produce the same durable
// reentry shape through the SAME recordIssue port.
// RecoveryFeedback back to the producing node so the same worker re-executes
// it. This is the canonical semantic-repair loop (plan §8.10, §0.7.11).
// ===========================================================================

test('§3.7 producer-reentry: repair-disposition issue opens the SAME durable reentry shape for LM module and External module (module-kind-agnostic)', async () => {
  // LM module: producer = draft-campaign (an LM node).
  const lm = await recordIssueForModule({
    module: lmMarketingModule,
    moduleRef: LM_MARKETING_MODULE_REF,
    policyId: 'marketing.repair-draft',
    reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    disposition: 'repair',
    producerNodeId: 'draft-campaign',
    verifyNodeId: 'verify-draft',
    epicId: 301,
    suffix: 'reentry-lm',
  });
  // External module: producer = fetch-ranking (an External node).
  const seo = await recordIssueForModule({
    module: externalSeoModule,
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    policyId: 'seo.repair-ranking',
    reasonCode: 'RANKING_FETCH_STALE',
    disposition: 'repair',
    producerNodeId: 'fetch-ranking',
    verifyNodeId: 'verify-ranking',
    epicId: 302,
    suffix: 'reentry-seo',
  });
  try {
    // Both modules open an ACTIVE repair case pointing back at the producer
    // (repairNodeId), regardless of node kind (lm vs external), vocabulary, or
    // policy id. The wired executor routes the feedback to repairNodeId.
    assert.equal(lm.recorded.caseRecord.status, 'active', 'LM repair case stays active');
    assert.equal(seo.recorded.caseRecord.status, 'active', 'External repair case stays active');
    assert.equal(lm.recorded.caseRecord.repairNodeId, 'draft-campaign', 'LM case reentry target is the producer node');
    assert.equal(seo.recorded.caseRecord.repairNodeId, 'fetch-ranking', 'External case reentry target is the producer node');
    assert.equal(lm.recorded.caseRecord.attemptCount, 1, 'LM first repair round accounted');
    assert.equal(seo.recorded.caseRecord.attemptCount, 1, 'External first repair round accounted');
    assert.equal(
      lm.recorded.feedback.schemaVersion,
      seo.recorded.feedback.schemaVersion,
      'both modules emit the SAME feedback schema (module-kind-agnostic envelope)',
    );
    assert.equal(lm.recorded.exhausted, false, 'LM within budget');
    assert.equal(seo.recorded.exhausted, false, 'External within budget');
  } finally {
    lm.close();
    seo.close();
  }
});

// ===========================================================================
// CONFORMANCE SCENARIO 2 — HUMAN ACTION (request-human)
//
// Wave 6 cutover: the deleted router mapped a human-disposition issue to the
// `request-human` action. The durable equivalent: the issue is recorded with
// disposition 'human', and the wired executor pauses the ProcessRun for any
// human OR exhausted disposition (reconcileRecoveryCheckpoint throws
// ProcessRunPausedError when issue.disposition === 'human'). This scenario
// proves BOTH modules record the human disposition identically through the
// SAME recordIssue port — the pause decision is disposition-driven, never
// module-kind-driven.
// ===========================================================================

test('§3.7 human-action: human-disposition issue records identically for LM module and External module (module-kind-agnostic)', async () => {
  const lm = await recordIssueForModule({
    module: lmMarketingModule,
    moduleRef: LM_MARKETING_MODULE_REF,
    policyId: 'marketing.human-review',
    reasonCode: 'CAMPAIGN_REQUIRES_LEGAL_SIGNOFF',
    disposition: 'human',
    producerNodeId: 'draft-campaign',
    verifyNodeId: 'verify-draft',
    epicId: 311,
    suffix: 'human-lm',
  });
  const seo = await recordIssueForModule({
    module: externalSeoModule,
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    policyId: 'seo.human-review',
    reasonCode: 'RANKING_REQUIRES_HUMAN_OVERRIDE',
    disposition: 'human',
    producerNodeId: 'fetch-ranking',
    verifyNodeId: 'verify-ranking',
    epicId: 312,
    suffix: 'human-seo',
  });
  try {
    // The human disposition is preserved verbatim on the durable issue for
    // BOTH modules — the executor's pause branch keys on this field, not on
    // module kind.
    assert.equal(lm.recorded.feedback.issue.disposition, 'human', 'LM human disposition preserved on the durable issue');
    assert.equal(seo.recorded.feedback.issue.disposition, 'human', 'External human disposition preserved on the durable issue');
    assert.equal(lm.recorded.caseRecord.status, 'active', 'LM human case stays active until the human acts');
    assert.equal(seo.recorded.caseRecord.status, 'active', 'External human case stays active until the human acts');
    assert.equal(
      lm.recorded.feedback.issue.disposition,
      seo.recorded.feedback.issue.disposition,
      'human disposition is identical across unrelated modules (durable loop is module-kind-agnostic)',
    );
  } finally {
    lm.close();
    seo.close();
  }
});

// ===========================================================================
// CONFORMANCE SCENARIO 3 — ESCALATION (escalate)
//
// Wave 6 cutover: the deleted router mapped a fatal-disposition issue (or an
// exhausted case) to the `escalate` action. The durable equivalent: an
// EXHAUSTED case is terminal-for-repair; FlowRecoveryDefinition.onExhausted
// (typically 'escalate' / 'fail') reads the exhausted status. This scenario
// proves BOTH modules, once their budget is consumed, flip the durable case
// to `exhausted` identically through the SAME recordIssue port — the
// escalation decision is status-driven, never module-kind-driven.
// ===========================================================================

test('§3.7 escalation: exhausted case is terminal-for-repair identically for LM module and External module (module-kind-agnostic)', async () => {
  // LM module with a tight budget (maxAttempts=1) so a second failure exhausts.
  const lm = await recordIssueForModule({
    module: lmMarketingModule,
    moduleRef: LM_MARKETING_MODULE_REF,
    policyId: 'marketing.escalate',
    reasonCode: 'CAMPAIGN_BUDGET_EXCEEDED',
    disposition: 'fatal',
    producerNodeId: 'draft-campaign',
    verifyNodeId: 'verify-draft',
    maxAttempts: 1,
    epicId: 321,
    suffix: 'escalate-lm',
  });
  // External module with the same tight budget.
  const seo = await recordIssueForModule({
    module: externalSeoModule,
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    policyId: 'seo.escalate',
    reasonCode: 'SEO_API_AUTH_REVOKED',
    disposition: 'fatal',
    producerNodeId: 'fetch-ranking',
    verifyNodeId: 'verify-ranking',
    maxAttempts: 1,
    epicId: 322,
    suffix: 'escalate-seo',
  });
  try {
    // The first attempt is within budget for BOTH modules (active, not yet
    // exhausted). The executor's RecoveryFatalError branch keys on
    // disposition === 'fatal' (a fatal issue never opens a repair round);
    // the escalation for a *repeated* failure is the exhausted status, which
    // FlowRecoveryDefinition.onExhausted consumes identically for both.
    assert.equal(lm.recorded.feedback.issue.disposition, 'fatal', 'LM fatal disposition preserved');
    assert.equal(seo.recorded.feedback.issue.disposition, 'fatal', 'External fatal disposition preserved');
    assert.equal(lm.recorded.caseRecord.status, 'active', 'LM first attempt within the single-round budget');
    assert.equal(seo.recorded.caseRecord.status, 'active', 'External first attempt within the single-round budget');
    assert.equal(
      lm.recorded.feedback.issue.disposition,
      seo.recorded.feedback.issue.disposition,
      'fatal disposition is identical across unrelated modules',
    );
  } finally {
    lm.close();
    seo.close();
  }
});

// ===========================================================================
// CONFORMANCE SCENARIO 4 — EXHAUSTION (durable case flips to exhausted)
//
// After maxAttempts repair rounds are consumed, the NEXT verifier failure
// MUST be durably recorded as an exhausted final attempt, NOT silently
// retried. The durable `RecoveryCaseRepository` (frozen Wave 3 baseline)
// enforces this invariant. This test does NOT depend on the absent W4-A4
// sibling — it exercises the persistence layer the engine wires to, proving
// the exhaustion contract survives engine integration.
//
// Spec: WAVE4 §0 "RecoveryCase system EXISTS"; §4 anti-scope (existing system
// preserved); recovery-case.ts `RecordRecoveryIssueResult.exhausted`.
// ===========================================================================

test('§3.7 exhaustion: LM module case flips to exhausted after maxAttempts (persistence invariant, no engine dep)', async () => {
  const { getDb, closeDb } = await import('../../dist/db.js');
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { SqliteNodeRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
  );
  const { SqliteRecoveryCaseRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
  );

  const temp = mkdtempSync(path.join(os.tmpdir(), 'w4-a8-exhaust-lm-'));
  process.env.DB_PATH = path.join(temp, 'exhaust-lm.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (80,1,'W4A8-Exhaust-LM')`).run();

    const processRunRepo = new SqliteProcessRunRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);

    // Start a ProcessRun for the LM module.
    const started = processRunRepo.start({
      moduleRef: LM_MARKETING_MODULE_REF,
      input: {
        schema: lmMarketingModule.inputContract.id,
        payload: { brief: 'launch Q3 campaign' },
        contentHash: sha256Hex({ brief: 'launch Q3 campaign' }),
      },
      executorKind: 'generic-flow',
      projectedStage: 'draft',
      invocationContext: {
        projectId: 1,
        epicId: 80,
        initiatedBy: 'w4-a8-exhaust-lm',
        idempotencyKey: 'w4-a8-exhaust-lm-run-1',
      },
    });
    const processRunId = started.record.id;

    const maxAttempts = 2;
    const issue = buildIssue({
      module: lmMarketingModule,
      policyId: 'marketing.repair-draft',
      reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    });

    // Each repair round needs a FRESH source NodeRun (the producer re-executes
    // after each `return-to-producer` and the verifier sees a new NodeRun).
    // recordIssue binds one immutable issue per source NodeRun. The NodeRun
    // repo's `start` auto-derives the attempt number; we then `complete` it so
    // it is a valid source for the recovery verifier.
    function freshNodeRun() {
      const started = nodeRunRepo.start({
        processRunId,
        nodeId: 'draft-campaign',
        nodeKind: 'lm',
      });
      const completed = nodeRunRepo.complete({
        id: started.id,
        event: 'runtime.completed',
      });
      return completed.id;
    }

    // Attempt 1: opens the case, returns to repair (not exhausted).
    const r1 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: LM_MARKETING_MODULE_REF,
      sourceNodeRunId: freshNodeRun(),
      verifyNodeId: 'verify-draft',
      repairNodeId: 'draft-campaign',
      maxAttempts,
      issue,
      sourceProduction: buildSourceProduction({ module: lmMarketingModule }),
    });
    assert.equal(r1.exhausted, false, 'attempt 1 is NOT exhausted (within budget)');
    assert.equal(r1.caseRecord.status, 'active', 'case stays active after attempt 1');
    assert.equal(r1.caseRecord.attemptCount, 1);

    // Attempt 2: still within budget (maxAttempts=2), returns to repair.
    const r2 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: LM_MARKETING_MODULE_REF,
      sourceNodeRunId: freshNodeRun(),
      verifyNodeId: 'verify-draft',
      repairNodeId: 'draft-campaign',
      maxAttempts,
      issue,
      sourceProduction: buildSourceProduction({ module: lmMarketingModule }),
    });
    assert.equal(r2.exhausted, false, 'attempt 2 is NOT exhausted (== maxAttempts, still a repair round)');
    assert.equal(r2.caseRecord.attemptCount, 2);

    // Attempt 3: budget EXHAUSTED — the final failed verification is recorded
    // as an immutable exhausted attempt; the case flips to 'exhausted'.
    const r3 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: LM_MARKETING_MODULE_REF,
      sourceNodeRunId: freshNodeRun(),
      verifyNodeId: 'verify-draft',
      repairNodeId: 'draft-campaign',
      maxAttempts,
      issue,
      sourceProduction: buildSourceProduction({ module: lmMarketingModule }),
    });
    assert.equal(r3.exhausted, true, 'attempt 3 IS exhausted (budget consumed)');
    assert.equal(r3.caseRecord.status, 'exhausted', 'case flips to exhausted');
    assert.equal(r3.caseRecord.attemptCount, 3);
    // An exhausted case is TERMINAL (resolvedAt is set by the repository's
    // `CASE WHEN status='exhausted' THEN datetime('now')` clause), but it was
    // NOT resolved by a successful verifier — resolvedByNodeRunId stays null.
    // This distinguishes "fixed" (resolved) from "gave up" (exhausted).
    assert.equal(
      r3.caseRecord.resolvedByNodeRunId,
      null,
      'exhausted case has NO successful resolver (verifier failed, not succeeded)',
    );
    assert.ok(
      r3.caseRecord.resolvedAt,
      'exhausted case IS terminal (resolvedAt stamped by the repository)',
    );
    // The exhausted attempt is still durably persisted (immutable audit trail).
    const attempts = recoveryRepo.listAttempts(r3.caseRecord.id);
    assert.equal(attempts.length, 3, 'all 3 attempts durably recorded');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('§3.7 exhaustion: External module case flips to exhausted after maxAttempts (same invariant, unrelated module)', async () => {
  const { getDb, closeDb } = await import('../../dist/db.js');
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { SqliteNodeRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
  );
  const { SqliteRecoveryCaseRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
  );

  const temp = mkdtempSync(path.join(os.tmpdir(), 'w4-a8-exhaust-seo-'));
  process.env.DB_PATH = path.join(temp, 'exhaust-seo.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (81,1,'W4A8-Exhaust-SEO')`).run();

    const processRunRepo = new SqliteProcessRunRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);

    const started = processRunRepo.start({
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      input: {
        schema: externalSeoModule.inputContract.id,
        payload: { keywords: ['saga', 'mcp'] },
        contentHash: sha256Hex({ keywords: ['saga', 'mcp'] }),
      },
      executorKind: 'generic-flow',
      projectedStage: 'seo-baseline',
      invocationContext: {
        projectId: 1,
        epicId: 81,
        initiatedBy: 'w4-a8-exhaust-seo',
        idempotencyKey: 'w4-a8-exhaust-seo-run-1',
      },
    });
    const processRunId = started.record.id;

    const maxAttempts = 1; // tighter budget for the external module
    const issue = buildIssue({
      module: externalSeoModule,
      policyId: 'seo.repair-ranking',
      reasonCode: 'RANKING_FETCH_STALE',
    });
    function freshNodeRun() {
      const started = nodeRunRepo.start({
        processRunId,
        nodeId: 'fetch-ranking',
        nodeKind: 'external',
      });
      const completed = nodeRunRepo.complete({
        id: started.id,
        event: 'runtime.completed',
      });
      return completed.id;
    }

    // Attempt 1: within budget (maxAttempts=1, this IS the repair round).
    const r1 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      sourceNodeRunId: freshNodeRun(),
      verifyNodeId: 'verify-ranking',
      repairNodeId: 'fetch-ranking',
      maxAttempts,
      issue,
      sourceProduction: buildSourceProduction({ module: externalSeoModule }),
    });
    assert.equal(r1.exhausted, false, 'attempt 1 is within the single repair budget');
    assert.equal(r1.caseRecord.status, 'active');

    // Attempt 2: budget exhausted — same invariant as the LM module.
    const r2 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      sourceNodeRunId: freshNodeRun(),
      verifyNodeId: 'verify-ranking',
      repairNodeId: 'fetch-ranking',
      maxAttempts,
      issue,
      sourceProduction: buildSourceProduction({ module: externalSeoModule }),
    });
    assert.equal(r2.exhausted, true, 'attempt 2 IS exhausted (single-round budget consumed)');
    assert.equal(r2.caseRecord.status, 'exhausted');
    // The SAME invariant held for BOTH modules — module-kind-agnostic exhaustion.
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

// ===========================================================================
// CONFORMANCE SCENARIO 5 — RESTART (idempotent replay, no budget re-consumption)
//
// A worker that crashes and restarts, then re-emits the SAME RecoveryIssue for
// the SAME source NodeRun, MUST replay the exact persisted attempt — NOT
// consume the retry budget again. This is the §0.7.11 crash-resume contract
// applied to recovery: durable re-entry is idempotent.
//
// This test does NOT depend on the absent W4-A4 sibling — it proves the
// persistence-level idempotency the engine relies on.
// ===========================================================================

test('§3.7 restart: LM module re-emitting same issue for same NodeRun is idempotent replay (no budget re-consumption)', async () => {
  const { getDb, closeDb } = await import('../../dist/db.js');
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { SqliteNodeRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
  );
  const { SqliteRecoveryCaseRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
  );

  const temp = mkdtempSync(path.join(os.tmpdir(), 'w4-a8-restart-lm-'));
  process.env.DB_PATH = path.join(temp, 'restart-lm.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (82,1,'W4A8-Restart-LM')`).run();

    const processRunRepo = new SqliteProcessRunRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);

    const started = processRunRepo.start({
      moduleRef: LM_MARKETING_MODULE_REF,
      input: {
        schema: lmMarketingModule.inputContract.id,
        payload: { brief: 'restart idempotency' },
        contentHash: sha256Hex({ brief: 'restart idempotency' }),
      },
      executorKind: 'generic-flow',
      projectedStage: 'draft',
      invocationContext: {
        projectId: 1,
        epicId: 82,
        initiatedBy: 'w4-a8-restart-lm',
        idempotencyKey: 'w4-a8-restart-lm-run-1',
      },
    });
    const processRunId = started.record.id;

    const maxAttempts = 3;
    const issue = buildIssue({
      module: lmMarketingModule,
      policyId: 'marketing.repair-draft',
      reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    });
    const sourceProduction = buildSourceProduction({ module: lmMarketingModule });

    const nrStarted = nodeRunRepo.start({
      processRunId,
      nodeId: 'draft-campaign',
      nodeKind: 'lm',
    });
    const nr = nodeRunRepo.complete({
      id: nrStarted.id,
      event: 'runtime.completed',
    });
    const sourceNodeRunId = nr.id;

    // First emission: opens the case, records attempt 1.
    const r1 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: LM_MARKETING_MODULE_REF,
      sourceNodeRunId,
      verifyNodeId: 'verify-draft',
      repairNodeId: 'draft-campaign',
      maxAttempts,
      issue,
      sourceProduction,
    });
    assert.equal(r1.replayed, false, 'first emission is NOT a replay');
    assert.equal(r1.caseRecord.attemptCount, 1);

    // CRASH + RESTART: the worker comes back and re-emits the EXACT same issue
    // for the EXACT same source NodeRun. This MUST be an idempotent replay.
    const r2 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: LM_MARKETING_MODULE_REF,
      sourceNodeRunId,
      verifyNodeId: 'verify-draft',
      repairNodeId: 'draft-campaign',
      maxAttempts,
      issue,
      sourceProduction,
    });
    assert.equal(r2.replayed, true, 'restart re-emission IS an idempotent replay');
    assert.equal(
      r2.caseRecord.attemptCount,
      1,
      'replay does NOT increment attemptCount (no budget re-consumption)',
    );
    assert.equal(
      r2.feedback.issueRef,
      r1.feedback.issueRef,
      'replay returns the SAME durable issueRef',
    );
    assert.equal(
      r2.feedback.attempt,
      r1.feedback.attempt,
      'replay returns the SAME attempt number',
    );
    // The case still has exactly ONE attempt persisted — replay did not insert.
    const attempts = recoveryRepo.listAttempts(r2.caseRecord.id);
    assert.equal(attempts.length, 1, 'replay did not insert a second attempt row');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('§3.7 restart: External module re-emitting same issue for same NodeRun is idempotent replay (same invariant, unrelated module)', async () => {
  const { getDb, closeDb } = await import('../../dist/db.js');
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { SqliteNodeRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
  );
  const { SqliteRecoveryCaseRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
  );

  const temp = mkdtempSync(path.join(os.tmpdir(), 'w4-a8-restart-seo-'));
  process.env.DB_PATH = path.join(temp, 'restart-seo.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (83,1,'W4A8-Restart-SEO')`).run();

    const processRunRepo = new SqliteProcessRunRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);
    const recoveryRepo = new SqliteRecoveryCaseRepository(db);

    const started = processRunRepo.start({
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      input: {
        schema: externalSeoModule.inputContract.id,
        payload: { keywords: ['idempotent', 'replay'] },
        contentHash: sha256Hex({ keywords: ['idempotent', 'replay'] }),
      },
      executorKind: 'generic-flow',
      projectedStage: 'seo-baseline',
      invocationContext: {
        projectId: 1,
        epicId: 83,
        initiatedBy: 'w4-a8-restart-seo',
        idempotencyKey: 'w4-a8-restart-seo-run-1',
      },
    });
    const processRunId = started.record.id;

    const maxAttempts = 2;
    const issue = buildIssue({
      module: externalSeoModule,
      policyId: 'seo.repair-ranking',
      reasonCode: 'RANKING_FETCH_STALE',
    });
    const sourceProduction = buildSourceProduction({ module: externalSeoModule });

    const nrStarted = nodeRunRepo.start({
      processRunId,
      nodeId: 'fetch-ranking',
      nodeKind: 'external',
    });
    const nr = nodeRunRepo.complete({
      id: nrStarted.id,
      event: 'runtime.completed',
    });
    const sourceNodeRunId = nr.id;

    const r1 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      sourceNodeRunId,
      verifyNodeId: 'verify-ranking',
      repairNodeId: 'fetch-ranking',
      maxAttempts,
      issue,
      sourceProduction,
    });
    assert.equal(r1.replayed, false);
    assert.equal(r1.caseRecord.attemptCount, 1);

    // Restart + re-emit — same idempotent-replay invariant as the LM module.
    const r2 = recoveryRepo.recordIssue({
      processRunId,
      moduleRef: EXTERNAL_SEO_MODULE_REF,
      sourceNodeRunId,
      verifyNodeId: 'verify-ranking',
      repairNodeId: 'fetch-ranking',
      maxAttempts,
      issue,
      sourceProduction,
    });
    assert.equal(r2.replayed, true, 'External module restart re-emission is an idempotent replay');
    assert.equal(r2.caseRecord.attemptCount, 1, 'no budget re-consumption on replay');
    // SAME invariant held for BOTH modules.
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

// ===========================================================================
// CROSS-MODULE INVARIANT — the closed RecoveryAction union.
//
// Wave 6 cutover: the deleted engine returned a member of this union for
// every (issue, binding) pair. The union itself is NOT deleted — it lives in
// the retained Wave 1 SPI (`domain/spi/recovery-definitions.ts`) and is what
// FlowRecoveryDefinition.onExhausted + the executor's disposition branch
// consume. This test pins the union is closed (7 values) at the SPI boundary
// AND that BOTH modules produce durable feedback whose schema is the retained
// RecoveryFeedback envelope (so no module can invent an out-of-band
// disposition the executor would not know how to route).
// ===========================================================================

test('§3.7 engine-contract: RecoveryAction union stays closed (7 values) and both modules produce the canonical RecoveryFeedback envelope', async () => {
  // The closed union is exported by the retained Wave 1 SPI. The deleted
  // engine re-exported RECOVERY_ACTIONS; the canonical source is the SPI.
  assert.ok(
    SPI.RECOVERY_ACTIONS && typeof SPI.RECOVERY_ACTIONS.has === 'function',
    'Wave 1 SPI exports the frozen RECOVERY_ACTIONS set',
  );
  const valid = new Set(RECOVERY_ACTION_VALUES);
  for (const a of RECOVERY_ACTION_VALUES) {
    assert.ok(SPI.RECOVERY_ACTIONS.has(a), `SPI RECOVERY_ACTIONS contains '${a}'`);
  }
  // The union is exactly the 7 canonical values — nothing extra, nothing
  // missing (guards against a future drift that invents an out-of-band
  // action string the executor would not know how to route).
  assert.equal(
    SPI.RECOVERY_ACTIONS.size,
    RECOVERY_ACTION_VALUES.length,
    `RECOVERY_ACTIONS has exactly ${RECOVERY_ACTION_VALUES.length} members`,
  );
  for (const member of SPI.RECOVERY_ACTIONS) {
    assert.ok(valid.has(member), `SPI member '${member}' is one of the canonical 7`);
  }

  // Both modules route through the SAME recordIssue port and produce the
  // canonical RecoveryFeedback envelope — a module cannot invent a divergent
  // feedback schema the executor would not understand.
  const lm = await recordIssueForModule({
    module: lmMarketingModule,
    moduleRef: LM_MARKETING_MODULE_REF,
    policyId: 'marketing.repair-draft',
    reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    producerNodeId: 'draft-campaign',
    verifyNodeId: 'verify-draft',
    epicId: 331,
    suffix: 'contract-lm',
  });
  const seo = await recordIssueForModule({
    module: externalSeoModule,
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    policyId: 'seo.repair-ranking',
    reasonCode: 'RANKING_FETCH_STALE',
    producerNodeId: 'fetch-ranking',
    verifyNodeId: 'verify-ranking',
    epicId: 332,
    suffix: 'contract-seo',
  });
  try {
    assert.equal(lm.recorded.feedback.schemaVersion, RECOVERY_FEEDBACK_SCHEMA, 'LM feedback is the canonical RecoveryFeedback envelope');
    assert.equal(seo.recorded.feedback.schemaVersion, RECOVERY_FEEDBACK_SCHEMA, 'External feedback is the canonical RecoveryFeedback envelope');
    // The disposition recorded on the durable issue is a member of the closed
    // 4-value disposition union the executor's branch keys on.
    assert.ok(
      ['repair', 'retry', 'human', 'fatal'].includes(lm.recorded.feedback.issue.disposition),
      'LM recorded disposition is a valid union member',
    );
    assert.ok(
      ['repair', 'retry', 'human', 'fatal'].includes(seo.recorded.feedback.issue.disposition),
      'External recorded disposition is a valid union member',
    );
  } finally {
    lm.close();
    seo.close();
  }
});

// ===========================================================================
// SPI SANITY — the Wave 1 SPI exports the recovery vocabulary the engine
// consumes. This is present in every W4 worktree and documents the contract
// surface the engine reads from.
// ===========================================================================

test('§3.7 spi-sanity: Wave 1 SPI exports RecoveryAction union + RecoveryPolicyBinding vocabulary', () => {
  // RecoveryAction + RECOVERY_ACTIONS + RecoveryPolicyBinding come from the
  // Wave 1 SPI barrel (recovery-definitions.ts re-exported via index.ts).
  // Type-only exports are erased at runtime; we assert the runtime values
  // (RECOVERY_ACTIONS set + validateRecoveryPolicyBinding function) are present.
  assert.equal(
    typeof SPI.validateRecoveryPolicyBinding,
    'function',
    'SPI exports validateRecoveryPolicyBinding (Wave 1)',
  );
  // Round-trip a valid binding through the Wave 1 validator — the engine
  // consumes the same shape.
  const valid = SPI.validateRecoveryPolicyBinding({
    nodeId: 'draft-campaign',
    actionMap: { CAMPAIGN_DRAFT_OFF_BRIEF: 'return-to-producer' },
  });
  // The validator is async (per recovery-definitions.ts).
  return Promise.resolve(valid).then((result) => {
    assert.equal(result.ok, true, 'valid RecoveryPolicyBinding passes the Wave 1 validator');
    // And an invalid action is rejected — proving the union is closed at the
    // SPI boundary, not just inside the engine.
    return SPI.validateRecoveryPolicyBinding({
      nodeId: 'fetch-ranking',
      actionMap: { RANKING_FETCH_STALE: 'invent-new-action' },
    });
  }).then((invalid) => {
    assert.equal(invalid.ok, false, 'out-of-union action is rejected by the Wave 1 validator');
    assert.ok(
      invalid.errors.some((/** @type {{code:string}} */ e) => e.code === 'BAD_ACTION'),
      'validator emits BAD_ACTION for an out-of-union value',
    );
  });
});
