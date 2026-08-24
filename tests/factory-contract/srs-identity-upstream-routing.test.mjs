// BM-5 Red-Team correction 1 (2026-08-24) — CODE-SCOPED upstream routing for
// plan-independent frozen-SRS identity defects.
//
// The v1.3.0 repair converted the Elite-8 unsatisfiable conjunction into ONE
// typed pre-worker red (`srs-file-identity-conflict`), but the red still
// reduced to `repair_required` targeting the PLANNER: every resubmitted plan
// re-failed identically (the SRS is frozen — no plan repairs it), burning
// maxAttempts + recovery epochs on a defect the planner cannot touch. Same
// class: `srs-artifact-drifted` and (under a register)
// `srs-module-manifest-missing` — the Elite-7 trap of a refusal code
// ordering the PLANNER to edit a frozen document.
//
// The correction is deliberately NOT the blanket `failureOwnership:
// 'upstream'` flag: that would misroute GENUINE plan errors emitted by the
// SAME provider (`srs-module-uncovered`, `task-graph-invalid`, decode and
// binding codes) to the producing workshop. The planner check plans declare
// `upstreamOwnedFailureCodes` — the typed codes decided from the frozen SRS
// (+ register) alone — and the gate reducer escalates EXACTLY those receipts
// to the producer-defect verdict `failed` (existing upstream-ownership
// semantics: cell terminates, no repair budget charged, the conveyor's
// failure routing carries the typed cause to the upstream repair boundary).
//
// This suite proves, in order:
//   R1 the installed planner plans (primary + re-plan continuation) declare
//      the code set and do NOT use the blanket flag;
//   R2 the reducer escalates ONLY the declared codes — genuine plan errors
//      from the same entry keep author repair, indeterminate outcomes keep
//      the local retry, and untyped evidence never matches (fail-safe);
//   R3 the REAL provider through the REAL installed plan yields verdict
//      `failed` on an ambiguous SRS (planner not charged: no
//      repair_required, no recovery issue);
//   R4 the continuation defect-evidence seam (readParentDefectEvidence — the
//      EXISTING re-route path) decodes the failed receipt's typed cause, so
//      the upstream repair boundary receives the SRS defect, not a planner
//      loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { driveGateRun } = await import(
  '../../dist/process-modules/application/gate-run-driver.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { developmentReplanContinuationProcessModule, DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF } = await import(
  '../../dist/process-modules/modules/development/development-continuation-process-module.js'
);
const {
  PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES,
  createDevelopmentTaskGraphCheckProvider,
} = await import(
  '../../dist/modules/development/application/development-check-providers.js'
);
const { encodeCheckDiagnostic } = await import(
  '../../dist/process-modules/domain/workplace/check-diagnostic.js'
);
const { computeCheckPlanDigest } = await import(
  '../../dist/process-modules/domain/workplace/gate.js'
);
const { readParentDefectEvidence } = await import(
  '../../dist/app/factory-continuation.js'
);
const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
} = await import('../../dist/modules/development/domain/development-schemas.js');

const workplaceRef = {
  processRunId: 1,
  moduleRef: 'solution-development@1.0.0',
  productionCellId: 'development-plan-task-graph',
  workKey: 'singleton',
};

// ---------------------------------------------------------------------------
// R1 — plan wiring: code-scoped, never the blanket flag.
// ---------------------------------------------------------------------------

function plannerEntry(moduleDefinition, nodeId, providerId) {
  const node = moduleDefinition.flow.nodes.find(candidate => candidate.id === nodeId);
  assert.ok(node, `${nodeId} node exists`);
  const plan = node.cellDefinition.checkPlan
    ?? node.cellDefinition.authorGate?.checkPlan;
  assert.ok(plan, `${nodeId} cell carries a check plan`);
  const entry = plan.entries.find(e => e.check.providerId === providerId);
  assert.ok(entry, `${providerId} entry in the ${nodeId} plan`);
  return entry;
}

/**
 * The installed PLANNER_CHECK_PLAN, verbatim (its digest was computed at
 * module build time; the driver recomputes and verifies it). Production
 * runs exactly this plan object — not a test restatement. The planner cell
 * has no review, so the singleton helper mounts the plan as the
 * author-phase gate with gatePhase 'final'.
 */
function installedPlannerPlan() {
  const node = developmentProcessModule.flow.nodes.find(
    candidate => candidate.id === 'plan-task-graph',
  );
  const plan = node?.cellDefinition?.checkPlan
    ?? node?.cellDefinition?.authorGate?.checkPlan;
  assert.ok(plan, 'plan-task-graph cell carries its check plan');
  return plan;
}

test('R1: the installed planner plans declare the frozen-SRS upstream-owned code set, not the blanket flag', () => {
  const primary = plannerEntry(
    developmentProcessModule,
    'plan-task-graph',
    'development.task-graph-contract.v1',
  );
  assert.equal(primary.failureOwnership, undefined,
    'the blanket upstream flag would misroute genuine plan errors emitted by the same provider');
  assert.deepEqual(
    [...primary.upstreamOwnedFailureCodes ?? []].sort(),
    [...PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES].sort(),
  );
  // The declared set is exactly the plan-independent frozen-SRS codes; the
  // genuine plan-error codes stay OUT of it.
  for (const planError of ['srs-module-uncovered', 'task-graph-invalid',
    'task-graph-decode-invalid', 'submission-binding-invalid']) {
    assert.equal(
      (primary.upstreamOwnedFailureCodes ?? []).includes(planError),
      false,
      `${planError} is a workplace-local plan error and must keep planner repair`,
    );
  }

  // The re-plan continuation planner uses the same provider and the same
  // code-scoped ownership (the frozen SRS is still the input there).
  const replanNode = developmentReplanContinuationProcessModule.flow.nodes.find(
    candidate => candidate.id === 'replan-task-graph',
  );
  assert.ok(replanNode, 'replan-task-graph node exists in the re-plan continuation module');
  const replanPlan = replanNode.cellDefinition.checkPlan
    ?? replanNode.cellDefinition.authorGate?.checkPlan;
  const replanEntry = replanPlan?.entries.find(
    e => e.check.providerId === 'development.task-graph-contract.v1',
  );
  assert.ok(replanEntry, 'task-graph entry in the re-plan plan');
  assert.deepEqual(
    [...replanEntry.upstreamOwnedFailureCodes ?? []].sort(),
    [...PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES].sort(),
  );
  assert.equal(replanEntry.failureOwnership, undefined);
  // Sanity: the continuation module this plan lives in is the cycle-2 one.
  assert.equal(
    developmentReplanContinuationProcessModule.identity.version,
    DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF.version,
  );
});

// ---------------------------------------------------------------------------
// R2 — reducer semantics (synthetic provider through the REAL driver).
// ---------------------------------------------------------------------------

function driveWithPlan(checkPlan, providerResult) {
  const receipts = [];
  const repo = {
    createGateRun() {},
    recordGatePresentation() {},
    setGateRunState() {},
    recordCheckReceipt(receipt) { receipts.push(receipt); return receipt; },
    recordDecision(decision) { return { decision, replayed: false }; },
    readTerminalDecisionForGateRun() { return null; },
  };
  const provider = {
    providerId: 'development.task-graph-contract.v1',
    version: '1.4.0',
    providerDigest: 'provider-digest',
    run: () => providerResult,
  };
  return {
    decision: driveGateRun(repo, { resolve: () => provider }, {
      workplaceRef,
      subjectCandidateSetRef: 'candidate-set/1',
      checkPlan,
      gatePhase: 'author',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'lease:1',
      installationDigest: 'install:1',
      checkParameters: {},
      environmentRef: null,
      presentationRef: 'worker-execution:routing-test',
    }).decision,
    receipts,
  };
}

function plannerShapedPlan({ codes } = {}) {
  // The same shape as the installed PLANNER_CHECK_PLAN (product-contract
  // entry removed for focus; only the task-graph entry matters here).
  const plan = {
    checkPlanId: 'test.plan-task-graph',
    version: '1.0.0',
    entries: [{
      check: {
        providerId: 'development.task-graph-contract.v1',
        version: '1.4.0',
        providerDigest: 'provider-digest',
      },
      parameters: {},
      repairTargetRoleOnFailure: 'author',
      environmentRef: null,
      ...(codes ? { upstreamOwnedFailureCodes: codes } : {}),
    }],
    decisionPolicyRef: 'factory.fail-closed-check-plan.v1',
    decisionPolicyDigest: 'factory.fail-closed-check-plan.v1',
    unknownErrorPolicy: 'fail-closed',
  };
  return { ...plan, checkPlanDigest: computeCheckPlanDigest(plan) };
}

const CODES = [...PLAN_INDEPENDENT_FROZEN_SRS_FAILURE_CODES];

test('R2a: each declared frozen-SRS code escalates to failed — no repair_required, no recovery issue', () => {
  for (const code of CODES) {
    const { decision } = driveWithPlan(
      plannerShapedPlan({ codes: CODES }),
      {
        outcome: 'failed',
        evidenceRefs: [encodeCheckDiagnostic({
          code,
          message: `synthetic ${code} witness`,
          subjectRef: 'candidate-set/1',
        })],
      },
    );
    assert.equal(decision.verdict, 'failed', `${code} must escalate as a producer defect`);
    assert.equal(decision.repairTargetRole, null, `${code}: no repair target — planner not charged`);
    assert.equal(decision.recoveryIssueRef, null, `${code}: no recovery issue is created`);
  }
});

test('R2b: a genuine plan error from the SAME entry keeps planner repair (no misroute)', () => {
  const { decision } = driveWithPlan(
    plannerShapedPlan({ codes: CODES }),
    {
      outcome: 'failed',
      evidenceRefs: [encodeCheckDiagnostic({
        code: 'srs-module-uncovered',
        message: 'SRS §2.2 module declares file(s) no implementation item covers',
        subjectRef: 'candidate-set/1',
      })],
    },
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'author');
  assert.ok(decision.recoveryIssueRef, 'the planner gets its ordinary repair issue');
});

test('R2c: indeterminate outcomes keep the local retry even with the code set declared (substrate may be at fault)', () => {
  const { decision } = driveWithPlan(
    plannerShapedPlan({ codes: CODES }),
    'unknown',
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'author');
});

test('R2d: a failed receipt with NO decodable diagnostic never matches the code set (fail-safe local repair)', () => {
  const { decision } = driveWithPlan(
    plannerShapedPlan({ codes: CODES }),
    { outcome: 'failed', evidenceRefs: ['opaque-evidence://not-a-diagnostic'] },
  );
  assert.equal(decision.verdict, 'repair_required');
  assert.equal(decision.repairTargetRole, 'author');
});

// ---------------------------------------------------------------------------
// R3 — the REAL provider through the REAL installed plan.
// ---------------------------------------------------------------------------

const AMBIGUOUS_SRS = `# REQ: SRS

### 2.2 Module Manifest

| Module | Responsibility | Owned Surfaces |
|---|---|---|
| \`web\` | Browser product | \`index.html\` |

## §D1 Canonical File/Module Surface

| File | Module | Responsibility |
|---|---|---|
| \`frontend/index.html\` | web | Customer product |
| \`admin/index.html\` | admin | Admin product |

## §D2 AC Map

\`\`\`yaml
- ac: AC-1
  title: Customer product served
  module: web
  files: [frontend/index.html]
  criticality: blocker
- ac: AC-2
  title: Admin product served
  module: admin
  files: [admin/index.html]
  criticality: blocker
\`\`\`
`;

test('R3: the real task-graph provider through the installed planner plan yields verdict failed on an ambiguous SRS', async () => {
  const { hashDevelopmentPolicy } = await import(
    '../../dist/modules/development/domain/development-settlement-policy.js'
  );
  const policySeed = { id: 'policy', version: '1.0.0', contentHash: '' };
  const inputCase = {
    schemaVersion: DEVELOPMENT_CASE_SCHEMA,
    projectId: 1,
    epicId: 1,
    formalizationCertificate: {
      schema: 'cert', ref: 'cert:1', hash: '1'.repeat(64), decision: 'formalized',
    },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: '2'.repeat(64) },
    acceptanceBaselineHash: '3'.repeat(64),
    srs: { schema: 'srs', ref: 'artifact:55', hash: '4'.repeat(64) },
    acceptanceCriteria: [
      { artifactId: 11, code: 'AC-1', acceptedHash: '5'.repeat(64), implementationRequired: true, criticality: 'blocker' },
      { artifactId: 12, code: 'AC-2', acceptedHash: '6'.repeat(64), implementationRequired: true, criticality: 'blocker' },
    ],
    repositories: [{ projectRepositoryId: 1, integrationBranch: 'dev', expectedBaseCommit: 'abc' }],
    policy: { ...policySeed, contentHash: hashDevelopmentPolicy(policySeed) },
    initiatedBy: 'test',
  };
  const items = [{
    key: 'impl',
    kind: 'implementation',
    taskKind: 'development.code',
    executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: 1,
    acceptanceCriterionKeys: ['11:AC-1', '12:AC-2'],
    dependsOnKeys: [],
    changeScopes: ['frontend/', 'admin/'],
    required: true,
    criticality: 'blocker',
  }];
  const proposalPayload = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: items,
    verificationItems: ['11:AC-1', '12:AC-2'].map(id => ({
      key: `verify-${id}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: 1,
      acceptanceCriterionKeys: [id],
      dependsOnKeys: ['impl'],
      changeScopes: [],
      required: true,
      criticality: 'blocker',
    })),
    integrationTargets: [{
      projectRepositoryId: 1,
      sourceWorkItemKeys: ['impl'],
      targetBranch: 'dev',
      expectedBaseCommit: 'abc',
    }],
  };

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER, execution_id TEXT,
      schema_version TEXT, payload_snapshot TEXT, content_hash TEXT
    );
    CREATE TABLE factory_process_runs (
      id INTEGER PRIMARY KEY, input_schema TEXT, input_snapshot TEXT
    );
  `);
  db.prepare('INSERT INTO factory_process_runs VALUES (1,?,?)')
    .run(DEVELOPMENT_CASE_SCHEMA, JSON.stringify(inputCase));
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (1,1,?,?,?,?)')
    .run('execution:1', DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      JSON.stringify(proposalPayload), 'a'.repeat(64));

  const provider = createDevelopmentTaskGraphCheckProvider({
    db,
    candidateSets: { read: () => ({
      role: 'author',
      members: [{
        productRef: {
          schemaId: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
          ref: 'managed-node-submission:1',
          digest: 'a'.repeat(64),
        },
      }],
    }) },
    readSrsContent: () => ({ status: 'read', content: AMBIGUOUS_SRS }),
  });

  const plan = installedPlannerPlan();
  const receipts = [];
  const repo = {
    createGateRun() {},
    recordGatePresentation() {},
    setGateRunState() {},
    recordCheckReceipt(receipt) { receipts.push(receipt); return receipt; },
    recordDecision(decision) { return { decision, replayed: false }; },
    readTerminalDecisionForGateRun() { return null; },
  };
  // Resolve every entry of the installed plan: the real task-graph provider
  // plus the always-present product-contract provider (a passed stub).
  const providers = {
    resolve(providerId) {
      if (providerId === 'development.task-graph-contract.v1') return provider;
      const entry = plan.entries.find(e => e.check.providerId === providerId);
      assert.ok(entry, `unexpected provider ${providerId}`);
      return {
        providerId,
        version: entry.check.version,
        providerDigest: entry.check.providerDigest,
        run: () => 'passed',
      };
    },
  };
  const { decision } = driveGateRun(repo, providers, {
    workplaceRef,
    subjectCandidateSetRef: 'candidate-set/1',
    // The INSTALLED plan (entries as installed; the driver recomputes and
    // verifies the digest over them).
    checkPlan: plan,
    gatePhase: 'author',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: 'lease:1',
    installationDigest: 'install:1',
    checkParameters: { processRunId: 1 },
    environmentRef: null,
    presentationRef: 'worker-execution:routing-test',
  });
  db.close();

  // The planner is NOT charged: verdict failed, no repair target, no
  // recovery issue → no repair attempt, no recovery epoch for the planner.
  assert.equal(decision.verdict, 'failed',
    'the plan-independent frozen-SRS conflict must terminalize, not repair-loop');
  assert.equal(decision.repairTargetRole, null);
  assert.equal(decision.recoveryIssueRef, null);
  // The receipt carries the typed code the routing decision was made from.
  const { decodeCheckDiagnostic } = await import(
    '../../dist/process-modules/domain/workplace/check-diagnostic.js'
  );
  const taskGraphReceipt = receipts.find(
    r => r.check.providerId === 'development.task-graph-contract.v1',
  );
  assert.ok(taskGraphReceipt, 'the real provider ran inside the gate');
  assert.equal(taskGraphReceipt.outcome, 'failed');
  assert.ok(taskGraphReceipt.evidenceRefs
    .map(decodeCheckDiagnostic)
    .some(d => d?.code === 'srs-file-identity-conflict'),
  'the escalated receipt carries the typed frozen-SRS code');
});

// ---------------------------------------------------------------------------
// R4 — the continuation defect-evidence seam carries the typed cause
//      upstream (existing readParentDefectEvidence path, no new authority).
// ---------------------------------------------------------------------------

test('R4: readParentDefectEvidence decodes the escalated receipt into upstream repair context', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_lifecycle_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_stage_runs(
      id INTEGER PRIMARY KEY, lifecycle_run_id INT, stage_id TEXT,
      attempt INT, process_run_id INT
    );
    CREATE TABLE factory_process_runs(id INTEGER PRIMARY KEY);
    CREATE TABLE factory_candidate_sets(
      candidate_set_ref TEXT PRIMARY KEY, workplace_ref TEXT
    );
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO factory_lifecycle_runs(id) VALUES (77)').run();
  db.prepare(
    `INSERT INTO factory_stage_runs
       (id,lifecycle_run_id,stage_id,attempt,process_run_id)
     VALUES (1,77,'solution-development',1,9)`,
  ).run();
  db.prepare('INSERT INTO factory_process_runs(id) VALUES (9)').run();
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref)
     VALUES ('candidate-set/1','workplace/9/solution-development/development-plan-task-graph/singleton')`,
  ).run();
  // The escalated receipt exactly as the gate would persist it.
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,
        provider_version,provider_digest,outcome,evidence_refs,receipt_digest)
     VALUES ('receipt:1','run:1','candidate-set/1','development.task-graph-contract.v1',
        '1.4.0','digest','failed',?,'rd')`,
  ).run(JSON.stringify([encodeCheckDiagnostic({
    code: 'srs-file-identity-conflict',
    message: "SRS §2.2 declares 'index.html' while the §D2/§D1 file surface carries"
      + ' multiple files with that basename [admin/index.html, frontend/index.html]'
      + ' — no single file identity exists. No plan can jointly satisfy §2.2'
      + ' coverage and the §D2/§D1 surface while the SRS is frozen, and this'
      + ' failure does not depend on the submitted plan. Repair the SRS §2.2'
      + ' declaration upstream to name the exact file path.',
    subjectRef: 'candidate-set/1',
  })]));
  try {
    const evidence = readParentDefectEvidence(db, 77);
    assert.equal(evidence.length, 1);
    const cause = evidence[0];
    // The EXISTING re-route path receives the typed producer defect: the
    // provider identity plus the actionable upstream repair message — the
    // repair boundary (Formalization change request) sees the SRS cause,
    // never a planner loop.
    assert.equal(cause.providerId, 'development.task-graph-contract.v1');
    assert.match(cause.message, /no single file identity exists/);
    assert.match(cause.message, /Repair the SRS §2\.2 declaration upstream/);
  } finally {
    db.close();
  }
});
