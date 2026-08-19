// tests/infrastructure/production-cell-integration-transient-git.test.mjs
//
// PREVENTIVE-HUNT Layer 7, X-5 — "Transient git failure poisons 'conflict'".
//
// integrateAcceptedWorkplace wrote integration_state='conflict' on ANY nonzero
// merge-tree exit (:384-387). A TRANSIENT git failure (missing binary, lock,
// timeout, OOM, environment corruption — distinguishable because the output
// carries NO conflict signature) was recorded exactly like a real conflict;
// the observation path (:173-179) then trusted the column forever, parking
// the task as PRODUCTION_CELL_INTEGRATION_CONFLICT with no retry path. The
// K11 fix (:293-301) banned exactly this pattern for 'merged'; 'conflict' had
// the same hole.
//
// The transient is simulated with a REAL git failure class: spawnSync
// inherits process.env, and GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0=merge.renames/
// GIT_CONFIG_VALUE_0=<non-boolean> makes every `git merge-tree` invocation
// exit 128 with `fatal: bad boolean config value` and NO CONFLICT output,
// while rev-parse / merge-base --is-ancestor (the other git calls on the
// integration path) stay fully functional.
//
// Proves, through the REAL seams (ProductionCellCoordinator writing the
// authority head + SqliteProductionCellIntegration over a real temp git repo):
//
//   TG1 a REAL conflict (nonzero exit WITH `CONFLICT (...)` output) still
//       writes 'conflict' and returns the byte-identical repair_required —
//       the conflict path is not weakened;
//   TG2 a transient merge-tree failure throws the typed
//       PRODUCTION_CELL_INTEGRATION_GIT_TRANSIENT and does NOT write the
//       column — the action stays retryable;
//   TG3 the observation path classifies the un-poisoned task as
//       absent-retry-safe (not blocked), and a clean retry integrates
//       successfully.
//
// BEFORE the fix TG2/TG3 are RED: the transient writes 'conflict' and
// observation parks the task forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteProductionCellIntegration } from '../../dist/infrastructure/workplace/sqlite-production-cell-integration.js';
import { SqliteSealedProductMaterialRepository } from '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { SqliteManagedNodeSubmissionRepository } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const SCHEMA = 'factory.source-change-candidate.v1';
const REVIEW_SCHEMA = 'factory.development-review-verdict.v1';
const HEX64 = 'a'.repeat(64);

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo: dev at base; candidate commit on a saga candidate ref. */
function makeGitRepo(marker, { devConflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `saga-x5-${marker}-`));
  git(root, 'init', '-b', 'dev');
  git(root, 'config', 'user.name', 'Saga Test');
  git(root, 'config', 'user.email', 'saga@example.test');
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'candidate');
  writeFileSync(join(root, 'app.txt'), `candidate-${marker}\n`);
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'candidate');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const sourceTree = git(root, 'rev-parse', 'HEAD^{tree}');
  git(root, 'update-ref', `refs/saga/candidates/${marker}`, sourceCommit);
  git(root, 'checkout', 'dev');
  if (devConflict) {
    // A sibling change on the integration branch touching the SAME file —
    // merge-tree --write-tree will report a REAL conflict.
    writeFileSync(join(root, 'app.txt'), `dev-side-${marker}\n`);
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-m', 'dev-side change');
  }
  return { root, base, sourceCommit, sourceTree };
}

/** The c5-matrix world: coordinator + integration consumer + lifecycle. */
function makeWorld(marker, opts) {
  const { root, base, sourceCommit, sourceTree } = makeGitRepo(marker, opts);

  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  new SqliteManagedNodeSubmissionRepository(db);
  db.pragma('foreign_keys=OFF');

  db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
  db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
  db.prepare(`INSERT INTO repositories(id,name) VALUES (1,'r')`).run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(root);

  const ref = asWorkplaceRef({
    processRunId: 22,
    moduleRef: 'module@1',
    productionCellId: 'cell',
    workKey: 'item',
  });
  const workplace = serializeWorkplaceRef(ref);

  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const authorityHeadRepo = new SqliteAcceptedAuthorityHeadRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo,
    now: () => new Date(),
  });
  const integration = new SqliteProductionCellIntegration(db, authorityHeadRepo);

  coordinator.materializeCell({
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: ref.workKey,
  });
  coordinator.admitWork(ref);
  projectWorkerStarted(workplaceRepo, ref);
  coordinator.sealCandidateSet(ref);

  return {
    root, db, ref, workplace, base, sourceCommit, sourceTree,
    workplaceRepo, authorityHeadRepo, coordinator, integration,
  };
}

function projectWorkerStarted(workplaceRepo, ref, reservationRef = 'execution:author') {
  const queued = workplaceRepo.read(ref);
  const leased = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(leased.applied, true);
  const started = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(started.applied, true);
}

function insertTask(db, { id, workplace }) {
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,workplace_ref,execution_mode,project_repository_id,
        integration_state,metadata)
     VALUES (?,1,'author','done',?,'artifact_change',1,'not_required','{"role":"author"}')`,
  ).run(id, workplace);
}

function insertAcceptanceChain(db, opts) {
  const {
    workplace, authorSetRef, sourceSubId, originTaskId,
    sourceCommit, sourceTree, base, marker, workKey,
  } = opts;

  const sourcePayload = {
    workItemKey: workKey,
    terminalStatus: 'complete',
    source: { branch: `refs/saga/candidates/${marker}`, commitSha: sourceCommit },
    snapshot: { commitSha: sourceCommit, treeSha: sourceTree },
    repository: { projectRepositoryId: 1, integrationBranch: 'dev', baseCommit: base },
  };
  const sourceDigest = sha(sourcePayload);
  const sealedProducts = new SqliteSealedProductMaterialRepository(db);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (91,22,'module@1','cell',1,?,'origin-author',?,?,?)`,
  ).run(originTaskId, SCHEMA, JSON.stringify(sourcePayload), sourceDigest);
  sealedProducts.seal({
    productRef: { schemaId: SCHEMA, ref: `managed-node-submission:${sourceSubId}`, digest: sourceDigest },
    payload: sourcePayload,
  });

  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,'revision/sha256:test-author','author',NULL,?,'seal:x',datetime('now'))`,
  ).run(authorSetRef, workplace, HEX64);

  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'carried-forward','candidate-set/origin-author')`,
  ).run(authorSetRef, SCHEMA, `managed-node-submission:${sourceSubId}`, sourceDigest);

  const reviewerSetRef = `${authorSetRef}:reviewer`;
  const reviewPayload = {
    verdict: 'approved',
    subject_candidate_set_ref: authorSetRef,
    findings: [],
  };
  const reviewDigest = sha(reviewPayload);
  const reviewSubId = sourceSubId + 1;
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash)
     VALUES (?,22,'module@1','cell',2,0,'reviewer',?,?,?)`,
  ).run(reviewSubId, REVIEW_SCHEMA, JSON.stringify(reviewPayload), reviewDigest);
  sealedProducts.seal({
    productRef: { schemaId: REVIEW_SCHEMA, ref: `managed-node-submission:${reviewSubId}`, digest: reviewDigest },
    payload: reviewPayload,
  });

  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,'revision/sha256:test-reviewer','reviewer',?,?,'seal:r',datetime('now'))`,
  ).run(reviewerSetRef, workplace, authorSetRef, HEX64);

  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'produced',NULL)`,
  ).run(reviewerSetRef, REVIEW_SCHEMA, `managed-node-submission:${reviewSubId}`, reviewDigest);

  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:final',?,'gate:final','run:final','final','transition:final',
        ?,?,'accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(
    workplace, authorSetRef, JSON.stringify([reviewerSetRef]),
    HEX64, HEX64, HEX64, HEX64,
  );
}

function acceptAuthor(db, coordinator, ref, { candidateSetRef, gateDecisionKey, authorTaskId }) {
  const expectedRevision = coordinator.readState(ref).revision;
  const gateRunRef = `gate-run:${gateDecisionKey}`;
  db.prepare(
    `INSERT OR IGNORE INTO factory_workplace_production_revisions
       (revision_ref,workplace_ref,parent_revision_ref,members,
        contributing_execution_refs,presenter_ref,material_digest,
        semantic_digest,sealed_at)
     VALUES (?,?,NULL,'[]','[]',?,?,?,datetime('now'))`,
  ).run(`revision:${candidateSetRef}`, serializeWorkplaceRef(ref), `presenter:${candidateSetRef}`,
    sha(`material:${candidateSetRef}`), sha(`semantic:${candidateSetRef}`));
  db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'author',NULL,?,'seal:k13',datetime('now'))`,
  ).run(candidateSetRef, serializeWorkplaceRef(ref), `revision:${candidateSetRef}`, HEX64);
  db.prepare(
    `INSERT OR IGNORE INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,'factory.acceptance.v1',?,?,'produced',NULL)`,
  ).run(candidateSetRef, `product:${candidateSetRef}`, HEX64);
  db.prepare(
    `INSERT INTO factory_gate_runs
       (gate_run_ref,workplace_ref,gate_phase,subject_candidate_set_ref,
        assessment_candidate_set_refs,check_plan_ref,check_plan_digest,
        expected_workplace_revision,gate_lease_ref,state)
     VALUES (?,?, 'author',?,'[]','plan',?,?,?,'terminal')`,
  ).run(gateRunRef, serializeWorkplaceRef(ref), candidateSetRef, HEX64, expectedRevision, `lease:${gateDecisionKey}`);
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,
        assessment_candidate_set_refs,provider_id,provider_version,
        provider_digest,environment_ref,outcome,evidence_refs,
        receipt_digest,created_at)
     VALUES (?,?,?, '[]', 'check.x', '1.0.0', ?, NULL, 'passed', '[]', ?, datetime('now'))`,
  ).run(`receipt:${gateDecisionKey}`, gateRunRef, candidateSetRef, HEX64, `rd:${gateDecisionKey}`);
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (?,?,?,?,'author',?,?,'[]','accepted','plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(
    gateDecisionKey, serializeWorkplaceRef(ref), `gate:${gateDecisionKey}`, gateRunRef,
    `transition:${gateDecisionKey}`, candidateSetRef, HEX64, HEX64, HEX64, sha(gateDecisionKey),
  );
  new CommitAcceptedCandidate({
    gateRepo: new SqliteGateRepository(db),
    coordinator,
  }).commit({
    workplaceRef: ref,
    gateDecisionKey,
    acceptedCandidateSetRef: candidateSetRef,
    acceptedAuthorTaskId: authorTaskId,
    expectedRevision,
    isFinal: false,
  });
}

function integrationInput(w, authorSetRef) {
  const acceptedProductRefs = w.db.prepare(
    `SELECT product_schema AS schemaId,product_ref AS ref,product_digest AS digest
       FROM factory_candidate_set_members WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(authorSetRef);
  return {
    workplaceRef: w.ref,
    processRunId: w.ref.processRunId,
    candidateSetRef: authorSetRef,
    gateDecisionKey: 'decision:final',
    expectedProductSchema: SCHEMA,
    acceptedProductRefs,
  };
}

function taskIntegrationState(db, id) {
  return db.prepare('SELECT integration_state FROM tasks WHERE id=?').get(id)?.integration_state;
}

/**
 * Break `git merge-tree` ONLY (a real transient git failure class: invalid
 * merge config in the environment). rev-parse / merge-base keep working, so
 * the integration path runs exactly as in production until merge-tree fails.
 */
function poisonMergeTree() {
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'merge.renames';
  process.env.GIT_CONFIG_VALUE_0 = 'bogus-transient';
  process.env.GIT_CONFIG_KEY_1 = 'merge.directoryRenames';
  process.env.GIT_CONFIG_VALUE_1 = 'bogus-transient';
}

function unpoisonMergeTree() {
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  delete process.env.GIT_CONFIG_KEY_1;
  delete process.env.GIT_CONFIG_VALUE_1;
}

function buildAcceptedWorld(marker, opts) {
  const w = makeWorld(marker, opts);
  const HEAD_TASK = 44;
  const ORIGIN_TASK = 33;
  const authorSet = `candidate-set/x5-${marker}-author`;
  insertTask(w.db, { id: HEAD_TASK, workplace: w.workplace });
  insertTask(w.db, { id: ORIGIN_TASK, workplace: w.workplace });
  insertAcceptanceChain(w.db, {
    workplace: w.workplace, authorSetRef: authorSet, sourceSubId: 91,
    originTaskId: ORIGIN_TASK, sourceCommit: w.sourceCommit, sourceTree: w.sourceTree,
    base: w.base, marker, workKey: w.ref.workKey,
  });
  acceptAuthor(w.db, w.coordinator, w.ref, {
    candidateSetRef: authorSet,
    gateDecisionKey: `gate-decision/x5-${marker}-author`,
    authorTaskId: String(HEAD_TASK),
  });
  return { w, HEAD_TASK, authorSet };
}

function cleanup(w) {
  w.db.close();
  rmSync(w.root, { recursive: true, force: true });
}

// ===========================================================================
// TG1 — a REAL conflict keeps the byte-identical conflict path.
// ===========================================================================
test('TG1: real merge conflict still writes conflict and returns the identical repair reason', () => {
  const { w, HEAD_TASK, authorSet } = buildAcceptedWorld('tg1', { devConflict: true });
  try {
    const result = w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(result.outcome, 'repair_required');
    assert.equal(
      result.reason,
      `PRODUCTION_CELL_INTEGRATION_CONFLICT: task ${HEAD_TASK}`,
      'TG1: the real-conflict reason stays byte-identical',
    );
    assert.equal(taskIntegrationState(w.db, HEAD_TASK), 'conflict',
      'a REAL conflict still records the column');
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// TG2 — a transient merge-tree failure throws typed and does NOT poison.
// ===========================================================================
test('TG2: transient merge-tree failure throws GIT_TRANSIENT and leaves the column clean', () => {
  const { w, HEAD_TASK, authorSet } = buildAcceptedWorld('tg2', {});
  try {
    poisonMergeTree();
    try {
      assert.throws(
        () => w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet)),
        /PRODUCTION_CELL_INTEGRATION_GIT_TRANSIENT/,
        'TG2: a nonzero merge-tree exit WITHOUT conflict output is a typed transient, not a conflict',
      );
    } finally {
      unpoisonMergeTree();
    }
    assert.equal(
      taskIntegrationState(w.db, HEAD_TASK),
      'not_required',
      'TG2: the transient must NOT write integration_state — the action stays retryable',
    );
  } finally {
    cleanup(w);
  }
});

// ===========================================================================
// TG3 — the observation path stays retry-safe and a clean retry integrates.
// ===========================================================================
test('TG3: after a transient, observation is absent-retry-safe and the retry integrates', () => {
  const { w, HEAD_TASK, authorSet } = buildAcceptedWorld('tg3', {});
  try {
    poisonMergeTree();
    try {
      assert.throws(
        () => w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet)),
        /PRODUCTION_CELL_INTEGRATION_GIT_TRANSIENT/,
      );
    } finally {
      unpoisonMergeTree();
    }

    // The observation path must NOT park the task on a phantom conflict.
    const observation = w.integration.observeAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(observation.outcome, 'absent-retry-safe',
      'TG3: observation classifies the un-merged, un-conflicted task as retryable');

    // The clean retry integrates successfully.
    const retry = w.integration.integrateAcceptedWorkplace(integrationInput(w, authorSet));
    assert.equal(retry.outcome, 'succeeded', 'TG3: the transient did not freeze the action');
    assert.equal(taskIntegrationState(w.db, HEAD_TASK), 'merged');
  } finally {
    cleanup(w);
  }
});
