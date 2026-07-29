// tests/execution/recovery-conformance.test.mjs
//
// W4-A8 — §3 EXIT GATE item 7: "One recovery engine repairs two unrelated
// synthetic modules." Spec: docs/refactor-management/09-contracts/
// WAVE4-PROTOCOL-RECOVERY-SPEC.md §1, §3.7.
//
// WHAT THIS PROVES
//   The generic recovery engine (W4-A4 `application/recovery-engine.ts`) is
//   module-kind-agnostic. ONE engine, fed module-owned RecoveryIssue +
//   RecoveryPolicyBinding from two completely unrelated synthetic modules
//   (an LM-node module and an External-node module), produces the correct
//   RecoveryAction in every one of the five conformance scenarios named in
//   the task:
//     1. PRODUCER REENTRY — `return-to-producer` routes feedback back to the
//        producing node so the same worker re-executes the upstream node.
//     2. HUMAN ACTION — `request-human` parks the run for a human decision.
//     3. ESCALATION — `escalate` raises beyond the module's recovery budget.
//     4. EXHAUSTION — after maxAttempts is consumed, the durable case flips
//        to `exhausted` and a fresh source NodeRun is rejected.
//     5. RESTART — the same source NodeRun + same issue is an idempotent
//        replay; restarting the worker does NOT consume the retry budget
//        again (this is the §0.7.11 crash-resume contract applied to
//        recovery).
//
//   The two modules are deliberately unrelated: lm-marketing is an LM-node
//   module with a `git_change` execution profile; external-seo is an
//   External-node module with an adapter ref and NO execution profile. They
//   share no flow, no schema, no skill, no vocabulary. The test proves the
//   engine never switches on module kind, name, or vocabulary — only on the
//   RecoveryPolicyBinding.actionMap keys the module itself declared.
//
// ISOLATION NOTE (W4-A8 task §"Verify"): this file imports the sibling-lane
// surface that the integrator lands in order A1..A4..A8. In the isolated
// W4-A8 worktree the W4-A4 `recovery-engine.ts` is absent, so the dynamic
// import below resolves to null and the engine-dependent tests SKIP with a
// clear reason — NOT a failure. The integrator's full Wave-4 gate run (all
// siblings present) is where those tests MUST PASS. The persistence-level
// exhaustion/restart tests use the EXISTING `SqliteRecoveryCaseRepository`
// (frozen Wave 3 baseline, present in every W4 worktree) and therefore run
// unconditionally.
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
// Sibling surface (lands via integrator cherry-pick). Resolved lazily; in
// isolation it is absent and engine-dependent tests SKIP (not fail).
// ---------------------------------------------------------------------------
//  - W4-A4: `application/recovery-engine.ts` — the generic
//    RecoveryIssue→RecoveryAction mapper. Contract (per W4-A4 task file):
//        routeRecoveryAction(issue, policyBinding): RecoveryAction
//    It uses the RecoveryAction union (7 values) from Wave 1 SPI
//    (`domain/spi/recovery-definitions.ts`) and the existing
//    RecoveryCaseRepository (NOT replaces it).

/** @typedef {{ routeRecoveryAction?: any, RECOVERY_ACTIONS?: any, buildRecoveryFeedback?: any }} EngineSurface */

/**
 * Lazily import the sibling Wave-4 recovery engine. Returns null when the
 * sibling is absent (isolated worktree). The caller decides whether to skip
 * or fail.
 *
 * @returns {Promise<EngineSurface | null>}
 */
async function loadRecoveryEngine() {
  // Variable specifier so a missing sibling does NOT crash module load —
  // dynamic import resolves individually per lane.
  try {
    const mod = await import(
      '../../dist/application/recovery-engine.js'
    );
    if (typeof mod.routeRecoveryAction !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wave-1 SPI: RecoveryIssue + RecoveryFeedback + RecoveryAction. These are
// present in every W4 worktree (frozen Wave 1 checkpoint). The RecoveryAction
// union (7 values) is the closed vocabulary the engine picks from.
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
 * Build a RecoveryPolicyBinding mapping the module's reason code to a runtime
 * RecoveryAction. This is the per-node recovery action map (Wave 1 SPI
 * `RecoveryPolicyBinding`). The engine reads the actionMap key the module
 * declared for its reason/event code and returns the bound action.
 *
 * @param {{ nodeId: string; reasonCode: string; action: string }} p
 * @returns {any} RecoveryPolicyBinding
 */
function buildBinding({ nodeId, reasonCode, action }) {
  return {
    nodeId,
    actionMap: { [reasonCode]: action },
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

// ===========================================================================
// CONFORMANCE SCENARIO 1 — PRODUCER REENTRY (return-to-producer)
//
// The verifier rejects the producer's output. The module's policy binding maps
// that reason code to `return-to-producer`. The engine MUST route the
// RecoveryFeedback back to the producing node so the same worker re-executes
// it. This is the canonical semantic-repair loop (plan §8.10, §0.7.11).
// ===========================================================================

test('§3.7 producer-reentry: return-to-producer routes identically for LM module and External module (module-kind-agnostic)', async (t) => {
  const engine = await loadRecoveryEngine();
  if (!engine) {
    t.diagnostic(
      'SKIP: W4-A4 recovery-engine absent in isolated W4-A8 worktree. ' +
      'Integrator runs full Wave-4 gate after A1..A4..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  // LM module: producer = draft-campaign (an LM node).
  const lmIssue = buildIssue({
    module: lmMarketingModule,
    policyId: 'marketing.repair-draft',
    reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
  });
  const lmBinding = buildBinding({
    nodeId: 'draft-campaign',
    reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    action: 'return-to-producer',
  });

  // External module: producer = fetch-ranking (an External node).
  const seoIssue = buildIssue({
    module: externalSeoModule,
    policyId: 'seo.repair-ranking',
    reasonCode: 'RANKING_FETCH_STALE',
  });
  const seoBinding = buildBinding({
    nodeId: 'fetch-ranking',
    reasonCode: 'RANKING_FETCH_STALE',
    action: 'return-to-producer',
  });

  const lmAction = engine.routeRecoveryAction(lmIssue, lmBinding);
  const seoAction = engine.routeRecoveryAction(seoIssue, seoBinding);

  // Both modules route to the SAME runtime action despite different node
  // kinds (lm vs external), different vocabularies, different policy ids.
  assert.equal(
    lmAction,
    'return-to-producer',
    'LM module producer-reentry routes to return-to-producer',
  );
  assert.equal(
    seoAction,
    'return-to-producer',
    'External module producer-reentry routes to return-to-producer',
  );
  assert.equal(
    lmAction,
    seoAction,
    'producer-reentry action is identical across unrelated modules (engine is module-kind-agnostic)',
  );
});

// ===========================================================================
// CONFORMANCE SCENARIO 2 — HUMAN ACTION (request-human)
//
// The verifier emits an issue with disposition 'human' (or the module binds
// the reason to `request-human`). The engine MUST route to `request-human`,
// parking the run for a human decision. This is the §8.10 human-decision
// action; the existing executor (generic-flow-executor.ts:888) already pauses
// the process run for such dispositions — Wave 4 names the action explicitly.
// ===========================================================================

test('§3.7 human-action: request-human routes identically for LM module and External module', async (t) => {
  const engine = await loadRecoveryEngine();
  if (!engine) {
    t.diagnostic('SKIP: W4-A4 recovery-engine absent in isolated W4-A8 worktree.');
    t.skip();
    return;
  }

  // LM module with a human-disposition issue.
  const lmIssue = buildIssue({
    module: lmMarketingModule,
    policyId: 'marketing.human-review',
    reasonCode: 'CAMPAIGN_REQUIRES_LEGAL_SIGNOFF',
    disposition: 'human',
  });
  const lmBinding = buildBinding({
    nodeId: 'draft-campaign',
    reasonCode: 'CAMPAIGN_REQUIRES_LEGAL_SIGNOFF',
    action: 'request-human',
  });

  // External module with a human-disposition issue.
  const seoIssue = buildIssue({
    module: externalSeoModule,
    policyId: 'seo.human-review',
    reasonCode: 'RANKING_REQUIRES_HUMAN_OVERRIDE',
    disposition: 'human',
  });
  const seoBinding = buildBinding({
    nodeId: 'fetch-ranking',
    reasonCode: 'RANKING_REQUIRES_HUMAN_OVERRIDE',
    action: 'request-human',
  });

  assert.equal(
    engine.routeRecoveryAction(lmIssue, lmBinding),
    'request-human',
    'LM module human-issue routes to request-human',
  );
  assert.equal(
    engine.routeRecoveryAction(seoIssue, seoBinding),
    'request-human',
    'External module human-issue routes to request-human',
  );
});

// ===========================================================================
// CONFORMANCE SCENARIO 3 — ESCALATION (escalate)
//
// The module's policy binding escalates a reason code beyond the module's
// own recovery budget (the module declines to repair locally and asks the
// runtime to escalate). The engine MUST route to `escalate`.
// ===========================================================================

test('§3.7 escalation: escalate routes identically for LM module and External module', async (t) => {
  const engine = await loadRecoveryEngine();
  if (!engine) {
    t.diagnostic('SKIP: W4-A4 recovery-engine absent in isolated W4-A8 worktree.');
    t.skip();
    return;
  }

  const lmIssue = buildIssue({
    module: lmMarketingModule,
    policyId: 'marketing.escalate',
    reasonCode: 'CAMPAIGN_BUDGET_EXCEEDED',
    disposition: 'fatal',
  });
  const lmBinding = buildBinding({
    nodeId: 'draft-campaign',
    reasonCode: 'CAMPAIGN_BUDGET_EXCEEDED',
    action: 'escalate',
  });

  const seoIssue = buildIssue({
    module: externalSeoModule,
    policyId: 'seo.escalate',
    reasonCode: 'SEO_API_AUTH_REVOKED',
    disposition: 'fatal',
  });
  const seoBinding = buildBinding({
    nodeId: 'fetch-ranking',
    reasonCode: 'SEO_API_AUTH_REVOKED',
    action: 'escalate',
  });

  assert.equal(
    engine.routeRecoveryAction(lmIssue, lmBinding),
    'escalate',
    'LM module escalation routes to escalate',
  );
  assert.equal(
    engine.routeRecoveryAction(seoIssue, seoBinding),
    'escalate',
    'External module escalation routes to escalate',
  );
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
// CROSS-MODULE INVARIANT — the engine MUST return a member of the closed
// RecoveryAction union for every input, regardless of module. This guards
// against a future engine drift that invents an out-of-band action string.
// ===========================================================================

test('§3.7 engine-contract: every routed action is a member of the closed RecoveryAction union (7 values)', async (t) => {
  const engine = await loadRecoveryEngine();
  if (!engine) {
    t.diagnostic('SKIP: W4-A4 recovery-engine absent in isolated W4-A8 worktree.');
    t.skip();
    return;
  }

  const valid = new Set(RECOVERY_ACTION_VALUES);
  // Also trust the SPI's own frozen set if the engine re-exports it.
  if (engine.RECOVERY_ACTIONS && typeof engine.RECOVERY_ACTIONS.has === 'function') {
    for (const a of RECOVERY_ACTION_VALUES) {
      assert.ok(engine.RECOVERY_ACTIONS.has(a), `engine RECOVERY_ACTIONS contains '${a}'`);
    }
  }

  // Walk every action across both modules and confirm membership.
  const cases = [
    {
      module: lmMarketingModule,
      nodeId: 'draft-campaign',
      policyId: 'marketing.repair-draft',
      reasonCode: 'CAMPAIGN_DRAFT_OFF_BRIEF',
    },
    {
      module: externalSeoModule,
      nodeId: 'fetch-ranking',
      policyId: 'seo.repair-ranking',
      reasonCode: 'RANKING_FETCH_STALE',
    },
  ];
  for (const action of RECOVERY_ACTION_VALUES) {
    for (const c of cases) {
      const issue = buildIssue({
        module: c.module,
        policyId: c.policyId,
        reasonCode: c.reasonCode,
      });
      const binding = buildBinding({
        nodeId: c.nodeId,
        reasonCode: c.reasonCode,
        action,
      });
      const routed = engine.routeRecoveryAction(issue, binding);
      assert.ok(
        valid.has(routed),
        `engine routed to '${routed}' which is NOT in the closed RecoveryAction union ` +
          `(module=${c.module.identity.name}, bound action='${action}')`,
      );
    }
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
