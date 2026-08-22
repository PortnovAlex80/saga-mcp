// CC-GAP-8 — verification reachability/accounting: module-local append-only
// criterion-key ledger, opened at graph materialization.
//
// Elite-6 defect (CC-00C F5/I3): 22 proposed verificationItems materialized
// by the flow only after readiness; readiness failed first, none ran, and
// none surfaced as pending — deferred obligations vanished from accounting.
//
// These focused tests pin the ledger semantics:
//   - materialization opens proposed -> pending per criterion key, idempotent;
//   - pending survives readiness failure (settlement input built with no
//     runnable candidate) and continuation (a new run re-opens its own
//     obligations while the old run's history stays append-only intact);
//   - executed FAILED is a recorded fact, never a discharge;
//   - discharge ONLY by an exact passed receipt (criterion key + candidate +
//     trusted provider receipt) or an operator-attributed waiver with
//     provenance;
//   - pre-ledger graphs are typed legacy-unaccounted, never back-filled;
//   - stage/order projection visibility (execution stage, deferral gate,
//     owner, unblock condition, deterministic criterion-key ordering);
//   - the ledger is append-only (UPDATE/DELETE rejected);
//   - BLOCKING MUTATION: rendering unexecuted deferred verificationItems as
//     discharged FAILS accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { SqliteDevelopmentModuleStore } = await import(
  '../../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js'
);
const { SqliteProcessProductRepository } = await import(
  '../../../dist/process-modules/persistence/sqlite-process-product-repository.js'
);
const { buildCanonicalDevelopmentTaskGraph } = await import(
  '../../../dist/modules/development/domain/development-task-graph.js'
);
const { sha256Hex } = await import('../../../dist/shared/canonical-json.js');
const {
  readDevelopmentVerificationLedgerEvents,
  recordVerificationExecuted,
  recordVerificationWaiver,
  projectDevelopmentVerificationAccounting,
  listDevelopmentVerificationAccountingByEpic,
} = await import(
  '../../../dist/modules/development/infrastructure/development-verification-ledger.js'
);
const {
  assertRenderedAccountingTruthful,
  assertVerificationAccountingIntegrity,
} = await import(
  '../../../dist/modules/development/domain/verification-accounting.js'
);
const {
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
} = await import(
  '../../../dist/modules/development/application/development-check-providers.js'
);

const PROJECT_ID = 1;
const EPIC_ID = 2;
const REPO_ID = 7;
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const CANDIDATE_HASH = 'a'.repeat(64);
const VERIFICATION_EVIDENCE_SCHEMA =
  'factory.candidate-verification-evidence-product.v2';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE epics (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT);
    CREATE TABLE project_repositories (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL,
      integration_branch TEXT NOT NULL, local_path TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE repository_checkouts (
      id INTEGER PRIMARY KEY, project_repository_id INTEGER,
      machine_id TEXT, status TEXT, local_path TEXT
    );
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY, epic_id INTEGER NOT NULL, type TEXT, code TEXT,
      status TEXT, content_hash TEXT, accepted_hash TEXT, drift_state TEXT
    );
    CREATE TABLE factory_workplaces (
      workplace_ref TEXT PRIMARY KEY, process_run_id INTEGER NOT NULL,
      production_cell_id TEXT NOT NULL, loop_state TEXT NOT NULL,
      terminal_reason TEXT NOT NULL
    );
    CREATE TABLE factory_cell_final_acceptances (
      workplace_ref TEXT NOT NULL, candidate_set_ref TEXT NOT NULL,
      gate_decision_key TEXT NOT NULL
    );
    CREATE TABLE factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_task_id TEXT
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY, workplace_ref TEXT NOT NULL,
      role TEXT NOT NULL, subject_candidate_set_ref TEXT
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL, product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL
    );
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, process_run_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE TABLE factory_gate_decisions (
      decision_key TEXT, gate_run_ref TEXT,
      subject_candidate_set_ref TEXT, gate_phase TEXT, verdict TEXT,
      assessment_candidate_set_refs TEXT
    );
    CREATE TABLE factory_check_receipts (
      check_receipt_ref TEXT PRIMARY KEY, check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL, provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL, provider_digest TEXT NOT NULL,
      outcome TEXT NOT NULL, receipt_digest TEXT NOT NULL,
      evidence_refs TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, workplace_ref TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE trusted_providers (
      id INTEGER PRIMARY KEY, project_id INTEGER, category TEXT NOT NULL,
      name TEXT NOT NULL, trust_basis TEXT NOT NULL, determinism TEXT NOT NULL,
      scope TEXT NOT NULL, version TEXT, status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  db.prepare('INSERT INTO projects VALUES (1, ?)').run('p');
  db.prepare('INSERT INTO epics VALUES (2, 1, ?)').run('e');
  db.prepare('INSERT INTO project_repositories VALUES (7, 1, ?, NULL, ?)')
    .run('dev', 'active');
  db.prepare(`INSERT INTO artifacts VALUES
    (14, 2, 'AC', 'AC-1', 'accepted', ?, ?, 'clean'),
    (15, 2, 'AC', 'AC-2', 'accepted', ?, ?, 'clean')`)
    .run(HASH_1, HASH_1, HASH_2, HASH_2);
  db.prepare(`INSERT INTO trusted_providers
    (project_id, category, name, trust_basis, determinism, scope, version, status)
    VALUES (NULL, 'deterministic_evidence', ?, ?, 'full', 'verification', ?, 'active')`)
    .run(
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
      `built-in:${DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST}`,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    );
  // Ensure factory_process_runs / factory_process_products before any
  // process-run row is inserted in the tests below.
  new SqliteProcessProductRepository(db);
  return db;
}

function makeStore(db) {
  // products repo first: it ensures factory_process_runs / factory_process_products.
  const products = new SqliteProcessProductRepository(db);
  const store = new SqliteDevelopmentModuleStore(
    db,
    products,
    { read: () => null, ok: () => false },
    { hostname: () => 'test-host' },
  );
  return { store, products };
}

function insertProcessRun(db, id) {
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?, ?, ?, 'solution-development', '1.0.0', 'solution-development@1.0.0',
             ?, 'generic-flow', 'factory.development-case.v1', '{}', ?)`,
  ).run(id, PROJECT_ID, EPIC_ID, `run-${id}`, sha256Hex({ id }));
}

function makeDevelopmentCase() {
  return {
    schemaVersion: 'factory.development-case.v1',
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    formalizationCertificate: {
      schema: 'cert', ref: 'cert:1', hash: 'c'.repeat(64), decision: 'formalized',
    },
    solutionContract: { schema: 'contract', ref: 'contract:1', hash: 'd'.repeat(64) },
    acceptanceBaselineHash: 'e'.repeat(64),
    srs: { schema: 'srs', ref: 'srs:1', hash: 'f'.repeat(64) },
    acceptanceCriteria: [
      {
        artifactId: 14, code: 'AC-1', acceptedHash: HASH_1,
        implementationRequired: true, criticality: 'blocker',
      },
      {
        artifactId: 15, code: 'AC-2', acceptedHash: HASH_2,
        implementationRequired: true, criticality: 'degradable',
      },
    ],
    repositories: [{ projectRepositoryId: REPO_ID, integrationBranch: 'dev', expectedBaseCommit: 'b'.repeat(40) }],
    policy: { id: 'p', version: '1', contentHash: '' },
    initiatedBy: 'operator',
  };
}

function makeGraph(developmentCase) {
  const proposal = {
    schemaVersion: 'factory.development-task-graph-proposal.v1',
    implementationItems: [{
      key: 'impl-1', kind: 'implementation', taskKind: 'development.code',
      executionSkill: 'saga-managed-source-author', executionMode: 'artifact_change',
      projectRepositoryId: REPO_ID, acceptanceCriterionKeys: ['14:AC-1', '15:AC-2'],
      dependsOnKeys: [], changeScopes: ['src/'], required: true, criticality: 'blocker',
    }],
    verificationItems: [
      {
        key: 'verify-ac-1', kind: 'verification', taskKind: 'verification.ac',
        executionSkill: 'saga-verifier', executionMode: 'read_only_evidence',
        projectRepositoryId: REPO_ID, acceptanceCriterionKeys: ['14:AC-1'],
        dependsOnKeys: ['impl-1'], changeScopes: [], required: true, criticality: 'blocker',
      },
      {
        key: 'verify-ac-2', kind: 'verification', taskKind: 'verification.ac',
        executionSkill: 'saga-verifier', executionMode: 'read_only_evidence',
        projectRepositoryId: REPO_ID, acceptanceCriterionKeys: ['15:AC-2'],
        dependsOnKeys: ['impl-1'], changeScopes: [], required: true, criticality: 'degradable',
      },
    ],
    integrationTargets: [{
      projectRepositoryId: REPO_ID, sourceWorkItemKeys: ['impl-1'],
      targetBranch: 'dev', expectedBaseCommit: 'b'.repeat(40),
    }],
  };
  return buildCanonicalDevelopmentTaskGraph(developmentCase, proposal, {
    schema: 'factory.development-task-graph-proposal.v1',
    ref: 'managed-node-submission:9001',
    hash: '9'.repeat(64),
  });
}

/** Seed one ACCEPTED verification workplace + trusted provider receipt. */
function seedAcceptedVerification(db, {
  processRunId, criterionKey, itemKey, criterionHash, outcome, receiptRef,
}) {
  const taskId = 300 + processRunId;
  const workplaceRef = `workplace/${processRunId}/development-verification/${itemKey}`;
  const candidateSetRef = `candidate-set/${processRunId}/development-verification/${itemKey}/author`;
  const decisionKey = `decision/${candidateSetRef}/final`;
  const gateRunRef = `gate-run/${candidateSetRef}`;
  const payload = {
    schemaVersion: VERIFICATION_EVIDENCE_SCHEMA,
    verificationItemKey: itemKey,
    acceptanceCriterionKey: criterionKey,
    acceptedCriterionHash: criterionHash,
    candidateHash: CANDIDATE_HASH,
    outcome: 'unknown',
    evidence: { summary: 's', observations: [], limitations: [] },
  };
  db.prepare(`INSERT INTO factory_workplaces VALUES (?,?,?,?,?)`)
    .run(workplaceRef, processRunId, 'development-verification', 'terminal', 'accepted');
  db.prepare(`INSERT INTO factory_cell_final_acceptances VALUES (?,?,?)`)
    .run(workplaceRef, candidateSetRef, decisionKey);
  db.prepare(`INSERT INTO factory_accepted_authority_head VALUES (?,?,?)`)
    .run(workplaceRef, candidateSetRef, String(taskId));
  db.prepare(`INSERT INTO factory_candidate_sets (candidate_set_ref,workplace_ref,role)
              VALUES (?,?,?)`).run(candidateSetRef, workplaceRef, 'author');
  db.prepare(`INSERT INTO factory_candidate_set_members VALUES (?,?,?)`)
    .run(candidateSetRef, VERIFICATION_EVIDENCE_SCHEMA, 'managed-node-submission:501');
  db.prepare(`INSERT INTO factory_managed_node_submissions
              (id,process_run_id,task_id,execution_id,payload_snapshot,content_hash)
              VALUES (?,?,?,?,?,?)`)
    .run(501, processRunId, taskId, 'exec-501', JSON.stringify(payload), sha256Hex(payload));
  db.prepare(`INSERT INTO tasks VALUES (?,?,?)`)
    .run(taskId, workplaceRef, JSON.stringify({
      role: 'author',
      cell_input_item: { key: itemKey },
    }));
  db.prepare(`INSERT INTO factory_gate_decisions VALUES (?,?,?,?,?,?)`)
    .run(decisionKey, gateRunRef, candidateSetRef, 'final', 'accepted', '[]');
  db.prepare(`INSERT INTO factory_check_receipts VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(
      receiptRef, gateRunRef, candidateSetRef,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
      outcome, sha256Hex({ receiptRef, outcome }),
      JSON.stringify(['evidence://observation']),
    );
}

function persistCandidate(products, processRunId) {
  products.persist({
    processRunId,
    productKind: 'development.integrated-candidate',
    schema: 'factory.integrated-release-candidate.v1',
    productHash: CANDIDATE_HASH,
    artifactRefPrefix: 'development-integrated-candidate',
    payload: {
      schemaVersion: 'factory.integrated-release-candidate.v1',
      taskGraphHash: '0'.repeat(64),
      implementationWorksetHash: '0'.repeat(64),
      repositories: [],
      buildProducts: [],
      integrationIntentRefs: [],
      frozen: true,
      candidateHash: CANDIDATE_HASH,
    },
  });
}

// ---------------------------------------------------------------------------
// Ledger opens at graph materialization
// ---------------------------------------------------------------------------

test('graph materialization opens proposed->pending ledger entries per criterion key', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 11);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({
      processRunId: 11, developmentCase, graph,
    });

    const events = readDevelopmentVerificationLedgerEvents(db, 11);
    assert.equal(events.length, 4, 'two criterion keys x (proposed + pending)');
    const statesByKey = new Map(events.map(e => [`${e.criterionKey}:${e.entryState}`, e]));
    assert.ok(statesByKey.get('14:AC-1:proposed'));
    assert.ok(statesByKey.get('14:AC-1:pending'));
    assert.ok(statesByKey.get('15:AC-2:proposed'));
    assert.ok(statesByKey.get('15:AC-2:pending'));
    const proposed = statesByKey.get('14:AC-1:proposed');
    assert.equal(proposed.proposedFromRef, 'managed-node-submission:9001',
      'proposed carries the planner submission provenance');
    assert.equal(proposed.verificationItemKey, 'verify-ac-1');
    assert.equal(proposed.required, true);
    assert.equal(proposed.criticality, 'blocker');
    // append order: proposed precedes pending per criterion key
    assert.ok(statesByKey.get('14:AC-1:proposed').sequence
      < statesByKey.get('14:AC-1:pending').sequence);
  } finally {
    db.close();
  }
});

test('materialization replay is idempotent: no duplicate ledger events', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 12);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 12, developmentCase, graph });
    store.materializeValidatedTaskGraph({ processRunId: 12, developmentCase, graph });
    store.materializeValidatedTaskGraph({ processRunId: 12, developmentCase, graph });
    assert.equal(readDevelopmentVerificationLedgerEvents(db, 12).length, 4);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Stage/order projection visibility
// ---------------------------------------------------------------------------

test('projection exposes stage, deferral gate, owner, unblock condition and deterministic order', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 13);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 13, developmentCase, graph });

    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 13 });
    assert.ok(projection);
    assert.equal(projection.accountingType, 'criterion-key-ledger');
    assert.equal(projection.orderedBy, 'criterion-key');
    assert.equal(projection.graphHash, graph.graphHash);
    assert.equal(projection.entries.length, 2);
    const [first, second] = projection.entries;
    assert.equal(first.criterionKey, '14:AC-1');
    assert.equal(first.ordinal, 0);
    assert.equal(second.criterionKey, '15:AC-2');
    assert.equal(second.ordinal, 1);
    for (const entry of projection.entries) {
      assert.equal(entry.state, 'pending');
      assert.equal(entry.stage.executionStage, 'verify-acceptance');
      assert.equal(entry.stage.gatedBy, 'certify-product-readiness',
        'pending obligations are visibly deferred behind the readiness gate');
      assert.equal(entry.owner, 'development-verification');
      assert.ok(entry.unblockCondition && entry.unblockCondition.includes('readiness-recovery'),
        'pending entries state the unblock condition');
      assert.equal(entry.discharged, false);
      assert.equal(entry.discharge, null);
    }
    assert.deepEqual(projection.summary, {
      proposed: 0, pending: 2, executedPassed: 0, executedFailed: 0,
      waived: 0, legacyUnaccounted: 0, open: 2, discharged: 0, total: 2,
    });
    assertVerificationAccountingIntegrity(projection);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// CC-GAP-8 core: pending survives readiness failure
// ---------------------------------------------------------------------------

test('pending survives readiness failure: settlement input without a runnable candidate discharges nothing', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 14);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 14, developmentCase, graph });

    // Elite-6 F5 shape: readiness failed first, no candidate was ever bound —
    // settlement input is still built (blocked path) and must NOT discharge.
    const input = store.buildSettlementInput({ processRunId: 14, developmentCase });
    assert.equal(input.integratedCandidate, null, 'no runnable candidate bound');
    assert.equal(input.acceptanceVerification, null, 'no verification evidence ran');

    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 14 });
    assert.ok(projection);
    assert.equal(projection.summary.pending, 2,
      'all deferred obligations remain first-class pending entries');
    assert.equal(projection.summary.discharged, 0);
    for (const entry of projection.entries) {
      assert.equal(entry.state, 'pending');
      assert.equal(entry.discharged, false);
    }
    assertVerificationAccountingIntegrity(projection);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Executed semantics: exact passed receipt discharges; failed does not
// ---------------------------------------------------------------------------

test('executed with an exact passed receipt discharges with receipt provenance', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 15);
    const { store, products } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 15, developmentCase, graph });
    seedAcceptedVerification(db, {
      processRunId: 15, criterionKey: '14:AC-1', itemKey: 'verify-ac-1',
      criterionHash: HASH_1, outcome: 'passed', receiptRef: 'check-receipt:pass-1',
    });
    persistCandidate(products, 15);

    store.buildSettlementInput({ processRunId: 15, developmentCase });

    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 15 });
    assert.ok(projection);
    const entry = projection.entries.find(e => e.criterionKey === '14:AC-1');
    assert.equal(entry.state, 'executed');
    assert.equal(entry.outcome, 'passed');
    assert.equal(entry.discharged, true);
    assert.equal(entry.discharge.kind, 'passed-receipt');
    assert.equal(entry.discharge.receiptRef, 'check-receipt:pass-1');
    assert.ok(entry.discharge.receiptDigest.length > 0);
    assert.equal(entry.discharge.candidateHash, CANDIDATE_HASH,
      'the receipt is bound to the exact candidate');
    assert.equal(entry.stage.gatedBy, null, 'no longer gated once executed');
    // settlement input assembly is idempotent — no duplicate executed events
    store.buildSettlementInput({ processRunId: 15, developmentCase });
    const events = readDevelopmentVerificationLedgerEvents(db, 15)
      .filter(e => e.entryState === 'executed');
    assert.equal(events.length, 1);
    assertVerificationAccountingIntegrity(projection);
  } finally {
    db.close();
  }
});

test('executed FAILED is a recorded fact and is NOT discharged; a later passed receipt discharges', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 16);
    const { store, products } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 16, developmentCase, graph });
    seedAcceptedVerification(db, {
      processRunId: 16, criterionKey: '15:AC-2', itemKey: 'verify-ac-2',
      criterionHash: HASH_2, outcome: 'failed', receiptRef: 'check-receipt:fail-1',
    });
    persistCandidate(products, 16);

    store.buildSettlementInput({ processRunId: 16, developmentCase });

    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 16 });
    assert.ok(projection);
    const entry = projection.entries.find(e => e.criterionKey === '15:AC-2');
    assert.equal(entry.state, 'executed');
    assert.equal(entry.outcome, 'failed');
    assert.equal(entry.discharged, false, 'a failed execution never discharges');
    assert.equal(entry.discharge, null);
    assert.equal(projection.summary.executedFailed, 1);
    assert.equal(projection.summary.discharged, 0);
    assertVerificationAccountingIntegrity(projection);

    // recovery: the exact criterion is re-executed and passes
    recordVerificationExecuted(db, {
      processRunId: 16, criterionKey: '15:AC-2', verificationItemKey: 'verify-ac-2',
      outcome: 'passed', receiptRef: 'check-receipt:pass-2',
      receiptDigest: sha256Hex('pass-2'), candidateHash: CANDIDATE_HASH,
    });
    const recovered = projectDevelopmentVerificationAccounting(db, { processRunId: 16 });
    const recoveredEntry = recovered.entries.find(e => e.criterionKey === '15:AC-2');
    assert.equal(recoveredEntry.state, 'executed');
    assert.equal(recoveredEntry.outcome, 'passed');
    assert.equal(recoveredEntry.discharged, true,
      'the later exact passed receipt discharges after a failed execution');
    assertVerificationAccountingIntegrity(recovered);
  } finally {
    db.close();
  }
});

test('executed facts outside the trusted seam fail closed: unknown criterion entries are rejected', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 17);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 17, developmentCase, graph });
    assert.throws(
      () => recordVerificationExecuted(db, {
        processRunId: 17, criterionKey: '99:AC-9', verificationItemKey: 'verify-ac-9',
        outcome: 'passed', receiptRef: 'check-receipt:x',
        receiptDigest: sha256Hex('x'), candidateHash: CANDIDATE_HASH,
      }),
      /DEVELOPMENT_VERIFICATION_LEDGER_ENTRY_UNKNOWN/,
      'a criterion never accounted as pending cannot gain an executed fact',
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Waiver semantics: operator-attributed, provenance required
// ---------------------------------------------------------------------------

test('operator-attributed waiver discharges with provenance; missing provenance or unknown target fails', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 18);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 18, developmentCase, graph });

    assert.throws(
      () => recordVerificationWaiver(db, {
        processRunId: 18, criterionKey: '14:AC-1',
        operator: '', reason: 'r', provenanceRef: 'operator-journal:1',
      }),
      /DEVELOPMENT_VERIFICATION_WAIVER_PROVENANCE_REQUIRED/,
    );
    assert.throws(
      () => recordVerificationWaiver(db, {
        processRunId: 18, criterionKey: '99:AC-9',
        operator: 'op', reason: 'r', provenanceRef: 'operator-journal:1',
      }),
      /DEVELOPMENT_VERIFICATION_LEDGER_ENTRY_UNKNOWN/,
    );

    recordVerificationWaiver(db, {
      processRunId: 18, criterionKey: '14:AC-1',
      operator: 'operator@example', reason: 'explicit risk acceptance',
      provenanceRef: 'operator-journal:42',
    });
    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 18 });
    const waived = projection.entries.find(e => e.criterionKey === '14:AC-1');
    assert.equal(waived.state, 'waived');
    assert.equal(waived.discharged, true);
    assert.equal(waived.discharge.kind, 'operator-waiver');
    assert.equal(waived.discharge.operator, 'operator@example');
    assert.equal(waived.discharge.reason, 'explicit risk acceptance');
    assert.equal(waived.discharge.provenanceRef, 'operator-journal:42');
    assert.equal(projection.summary.waived, 1);
    assert.equal(projection.summary.pending, 1);
    assertVerificationAccountingIntegrity(projection);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Legacy typing: pre-ledger graphs are legacy-unaccounted, never back-filled
// ---------------------------------------------------------------------------

test('a pre-ledger materialized graph is typed legacy-unaccounted and never back-filled', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 19);
    const { products } = makeStore(db);
    // A graph product written by a pre-CC-GAP-8 code path: no ledger rows.
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    products.persist({
      processRunId: 19,
      productKind: 'development.task-graph',
      schema: 'factory.development-task-graph.v1',
      productHash: graph.graphHash,
      payload: graph,
      artifactRefPrefix: 'development-task-graph',
    });

    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 19 });
    assert.ok(projection);
    assert.equal(projection.accountingType, 'legacy-unaccounted',
      'frozen legacy evidence is typed, not re-inferred');
    assert.equal(projection.entries.length, 2);
    for (const entry of projection.entries) {
      assert.equal(entry.state, 'legacy-unaccounted');
      assert.equal(entry.discharged, false, 'legacy entries are never discharged');
      assert.equal(entry.discharge, null);
    }
    assert.equal(projection.summary.legacyUnaccounted, 2);
    assert.equal(projection.summary.discharged, 0);
    assertVerificationAccountingIntegrity(projection);

    // execution facts for a legacy run are skipped whole — no partial account
    recordVerificationExecuted(db, {
      processRunId: 19, criterionKey: '14:AC-1', verificationItemKey: 'verify-ac-1',
      outcome: 'passed', receiptRef: 'check-receipt:legacy',
      receiptDigest: sha256Hex('legacy'), candidateHash: CANDIDATE_HASH,
    });
    assert.equal(readDevelopmentVerificationLedgerEvents(db, 19).length, 0,
      'a legacy run stays whole: no partial ledger rows are invented');
    const after = projectDevelopmentVerificationAccounting(db, { processRunId: 19 });
    assert.equal(after.accountingType, 'legacy-unaccounted');
  } finally {
    db.close();
  }
});

test('a run with nothing materialized has no accounting projection', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 20);
    makeStore(db);
    assert.equal(
      projectDevelopmentVerificationAccounting(db, { processRunId: 20 }),
      null,
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Continuation: pending re-opens per run; the old run's history is untouched
// ---------------------------------------------------------------------------

test('continuation re-opens pending obligations for the new run while the source run history stays intact', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 21);
    insertProcessRun(db, 22);
    const { store, products } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    // Source run: materialize, verify AC-1 passed, then readiness failed on AC-2.
    store.materializeValidatedTaskGraph({ processRunId: 21, developmentCase, graph });
    seedAcceptedVerification(db, {
      processRunId: 21, criterionKey: '14:AC-1', itemKey: 'verify-ac-1',
      criterionHash: HASH_1, outcome: 'passed', receiptRef: 'check-receipt:src-pass',
    });
    persistCandidate(products, 21);
    store.buildSettlementInput({ processRunId: 21, developmentCase });
    const sourceBefore = projectDevelopmentVerificationAccounting(db, { processRunId: 21 });
    assert.equal(sourceBefore.summary.discharged, 1);
    assert.equal(sourceBefore.summary.pending, 1);

    // Continuation run adopts the same graph (exactly what
    // adoptVerificationBaseline -> materializeValidatedTaskGraph does).
    store.materializeValidatedTaskGraph({ processRunId: 22, developmentCase, graph });
    const continuation = projectDevelopmentVerificationAccounting(db, { processRunId: 22 });
    assert.equal(continuation.summary.pending, 2,
      'every obligation re-opens as pending for the continuation run');
    assert.equal(continuation.summary.discharged, 0,
      'the continuation inherits no silent discharge');

    const sourceAfter = projectDevelopmentVerificationAccounting(db, { processRunId: 21 });
    assert.deepEqual(sourceAfter.entries, sourceBefore.entries,
      'the source run accounting is append-only and untouched');

    const byEpic = listDevelopmentVerificationAccountingByEpic(db, { epicId: EPIC_ID });
    assert.equal(byEpic.length, 2);
    assert.deepEqual(byEpic.map(p => p.processRunId), [21, 22],
      'epic-wide visibility keeps both runs in deterministic order');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Append-only enforcement
// ---------------------------------------------------------------------------

test('the ledger is append-only: UPDATE and DELETE are rejected', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 23);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 23, developmentCase, graph });
    assert.throws(
      () => db.prepare(
        `UPDATE factory_development_verification_ledger SET entry_state='waived'`,
      ).run(),
      /DEVELOPMENT_VERIFICATION_LEDGER_APPEND_ONLY/,
    );
    assert.throws(
      () => db.prepare(`DELETE FROM factory_development_verification_ledger`).run(),
      /DEVELOPMENT_VERIFICATION_LEDGER_DELETE_FORBIDDEN/,
    );
    assert.equal(readDevelopmentVerificationLedgerEvents(db, 23).length, 4);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// CC-GAP-8 BLOCKING MUTATION: rendering deferred verification as discharged
// fails accounting
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION: rendering unexecuted deferred verificationItems as discharged fails accounting', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 24);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 24, developmentCase, graph });
    // Readiness failed first: nothing executed, everything pending.
    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 24 });
    assert.equal(projection.summary.pending, 2);

    // Honest render passes.
    assert.doesNotThrow(() => assertRenderedAccountingTruthful({
      rendered: projection.entries.map(e => ({
        criterionKey: e.criterionKey, discharged: false,
      })),
      projection,
    }));

    // MUTATION: the status surface renders the deferred (never executed)
    // obligations as discharged — accounting must FAIL.
    assert.throws(
      () => assertRenderedAccountingTruthful({
        rendered: projection.entries.map(e => ({
          criterionKey: e.criterionKey, discharged: true,
        })),
        projection,
      }),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_DISHONEST/,
    );

    // A row the ledger never accounted also fails.
    assert.throws(
      () => assertRenderedAccountingTruthful({
        rendered: [{ criterionKey: '77:AC-7', discharged: false }],
        projection,
      }),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_UNACCOUNTED/,
    );
  } finally {
    db.close();
  }
});

test('BLOCKING MUTATION: executed-FAILED rendered discharged and corrupted projections fail integrity', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 25);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 25, developmentCase, graph });
    recordVerificationExecuted(db, {
      processRunId: 25, criterionKey: '14:AC-1', verificationItemKey: 'verify-ac-1',
      outcome: 'failed', receiptRef: 'check-receipt:fail',
      receiptDigest: sha256Hex('fail'), candidateHash: CANDIDATE_HASH,
    });
    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 25 });
    const failed = projection.entries.find(e => e.criterionKey === '14:AC-1');
    assert.equal(failed.state, 'executed');
    assert.equal(failed.outcome, 'failed');

    // MUTATION: executed-failed rendered discharged — accounting must FAIL.
    assert.throws(
      () => assertRenderedAccountingTruthful({
        rendered: [{ criterionKey: '14:AC-1', discharged: true }],
        projection,
      }),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_RENDER_DISHONEST/,
    );

    // MUTATION: a projection that silently discharges a pending entry fails
    // its own integrity check — with forged provenance it is the
    // silent-discharge guard that fires (pending can never hold a discharge).
    const corrupted = structuredClone(projection);
    const pending = corrupted.entries.find(e => e.criterionKey === '15:AC-2');
    pending.discharged = true;
    pending.discharge = {
      kind: 'operator-waiver', operator: 'forged', reason: 'forged',
      provenanceRef: 'forged-journal',
    };
    assert.throws(
      () => assertVerificationAccountingIntegrity(corrupted),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_SILENT_DISCHARGE/,
    );
    // MUTATION: discharged without any provenance at all fails too.
    const bare = structuredClone(projection);
    bare.entries.find(e => e.criterionKey === '15:AC-2').discharged = true;
    assert.throws(
      () => assertVerificationAccountingIntegrity(bare),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_DISCHARGE_WITHOUT_PROVENANCE/,
    );
  } finally {
    db.close();
  }
});

test('BLOCKING MUTATION: hiding stage/order coordinates from the status projection fails accounting', () => {
  const db = makeDb();
  try {
    insertProcessRun(db, 26);
    const { store } = makeStore(db);
    const developmentCase = makeDevelopmentCase();
    const graph = makeGraph(developmentCase);
    store.materializeValidatedTaskGraph({ processRunId: 26, developmentCase, graph });
    const projection = projectDevelopmentVerificationAccounting(db, { processRunId: 26 });
    assert.equal(projection.summary.pending, 2);
    assertVerificationAccountingIntegrity(projection);

    // MUTATION e (execution stage hidden/blank) — accounting must FAIL.
    const noStage = structuredClone(projection);
    noStage.entries[0].stage.executionStage = '';
    assert.throws(
      () => assertVerificationAccountingIntegrity(noStage),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_STAGE_HIDDEN/,
    );

    // MUTATION e (deferral gate hidden on a pending entry) — must FAIL.
    const noGate = structuredClone(projection);
    noGate.entries[0].stage.gatedBy = null;
    assert.throws(
      () => assertVerificationAccountingIntegrity(noGate),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_DEFERRAL_GATE_HIDDEN/,
    );

    // MUTATION e (deterministic order coordinates collapsed) — must FAIL.
    const noOrder = structuredClone(projection);
    noOrder.entries[1].ordinal = 0;
    assert.throws(
      () => assertVerificationAccountingIntegrity(noOrder),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_ORDINAL_HIDDEN/,
    );

    // MUTATION e (unblock condition hidden on a pending entry) — must FAIL.
    const noUnblock = structuredClone(projection);
    noUnblock.entries[0].unblockCondition = null;
    assert.throws(
      () => assertVerificationAccountingIntegrity(noUnblock),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_UNBLOCK_CONDITION_HIDDEN/,
    );

    // MUTATION e (stale gate left on an executed entry) — must FAIL.
    const executed = structuredClone(projection);
    const done = executed.entries[0];
    done.state = 'executed';
    done.outcome = 'passed';
    done.discharged = true;
    done.discharge = {
      kind: 'passed-receipt', receiptRef: 'check-receipt:m',
      receiptDigest: sha256Hex('m'), candidateHash: CANDIDATE_HASH,
    };
    assert.throws(
      () => assertVerificationAccountingIntegrity(executed),
      /DEVELOPMENT_VERIFICATION_ACCOUNTING_DEFERRAL_GATE_STALE/,
    );
  } finally {
    db.close();
  }
});
