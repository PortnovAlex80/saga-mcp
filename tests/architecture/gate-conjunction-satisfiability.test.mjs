// tests/architecture/gate-conjunction-satisfiability.test.mjs
//
// STAGE-14 TASK 3 — the SATISFIABILITY RUNG of the §23 testing ladder
// (WORKSHOP-CONTROL-TRACKING §3.5/§4.4): not "does this check return the
// right verdict?" but "does a state exist satisfying ALL simultaneously
// enforced constraints?" The stage-12 deadlock lived ONLY in the conjunction
// of individually-correct gates (review demanded the artefact, scope forbade
// its home) — a defect class no per-gate unit can see, because the
// conjunction is nobody's unit. This file gives the rung its first concrete
// instances:
//
//   1. CLASSIFICATION RATCHET — every check provider installed in the
//      development lifecycle's plans must be classified in the
//      satisfiability vocabulary below, as either DECIDABLE (with the named
//      decision procedure or lawful exit that makes the conjunction
//      satisfiable) or honestly OPEN (semantic judgments the factory does
//      not pretend to decide). A new gate cannot silently add an
//      unclassified conjunction obligation: this test fails first.
//
//   2. THE DECIDABLE CONTAINMENT INSTANCE — the property stage 13 made
//      lawful, decided mechanically with the REAL widening ledger: an
//      uncontended need has a satisfying assignment (GRANT — the conjunction
//      {criteria require path} ∧ {path within frozen authority} is
//      satisfiable via a wider frozen revision); a contended need is
//      UNSATISFIABLE WITH A NAMED WITNESS (REFUSAL naming the live holder).
//      Both directions are decided BEFORE any worker burns an epoch — that
//      is the whole value of the rung.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { SqliteScopeWideningLedger } from '../../dist/infrastructure/workplace/sqlite-scope-widening-ledger.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';

// ---------------------------------------------------------------------------
// The satisfiability vocabulary: provider → class. DECIDABLE classes name the
// procedure that decides the conjunction; OPEN classes honestly mark what the
// factory does not decide. Adding a provider to a plan without adding it here
// fails the rung — that is the point.
// ---------------------------------------------------------------------------
const SATISFIABILITY_CLASSIFICATION = Object.freeze({
  'development.task-graph-contract.v1':
    'decidable:graph-structure (lineage/coverage/DAG containment — set & graph operations)',
  'development.implementation-scope.v1':
    'decidable:containment-with-lawful-widening (path-within-frozen-scope is decidable; the stage-13 scope-widening transition is the lawful exit that makes the conjunction with criterion demands satisfiable; contention decides grants)',
  'factory.review-verdict.v1':
    'open:semantic-human-role (review judgment is not decided by the factory; the rung requires it be MARKED open, never hidden as decidable)',
  'development.readiness-profile-monotonicity.v1':
    'decidable:set-comparison (declaration surface ⊇ prior surface — monotone set relation)',
  'development.implementation-claim-monotonicity.v1':
    'decidable:set-comparison (claimed surface ⊇ union of prior claims unless explicitly dispositioned — monotone set relation over durable rows; STAGE-18 R2)',
  'factory.local-runnability.v1':
    'decidable:derivation-union-coverage (executed set = canonical ∪ declared — additive union coverage, M1-b step 4)',
  'factory.product-contract.v1':
    'decidable:schema-cardinality-binding (typed product schema/cardinality against the frozen WorkIntent — closed shape check)',
  'development.verification-product-contract.v2':
    'decidable:schema-cardinality-binding (verification evidence product schema/cardinality — closed shape check)',
});

/** Walk the installed module and collect every (plan, providerId) pair. */
function collectInstalledPlanProviders(moduleDefinition) {
  const found = [];
  const pushPlan = (planName, plan) => {
    for (const entry of plan?.entries ?? []) {
      found.push({ planName, providerId: entry.check?.providerId ?? null });
    }
  };
  for (const node of moduleDefinition.flow?.nodes ?? []) {
    const cell = node.cellDefinition;
    if (!cell) continue;
    if (cell.authorGate?.checkPlan) {
      pushPlan(`${cell.id}:author`, cell.authorGate.checkPlan);
    }
    if (cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan) {
      pushPlan(`${cell.id}:final`, cell.review?.finalGate?.checkPlan ?? cell.review?.checkPlan);
    }
    if (cell.checkPlan) pushPlan(`${cell.id}:plan`, cell.checkPlan);
  }
  return found;
}

test('SAT rung: every check provider installed in the development lifecycle is classified — no gate may add an unclassified conjunction obligation', () => {
  const installed = collectInstalledPlanProviders(developmentProcessModule);
  assert.ok(installed.length >= 5,
    `expected the development module's plans to enumerate their providers (found ${installed.length})`);
  const unclassified = installed.filter(
    entry => entry.providerId === null
      || !Object.hasOwn(SATISFIABILITY_CLASSIFICATION, entry.providerId),
  );
  assert.deepEqual(
    unclassified.map(entry => `${entry.planName}:${entry.providerId}`),
    [],
    'every installed check provider must carry a satisfiability classification '
      + '(decidable with its procedure, or honestly open). A new gate that '
      + 'enforces a constraint must be classified HERE in the same commit — '
      + 'otherwise it may admit no possible world silently.',
  );
});

test('SAT rung, decidable instance: the containment conjunction has a satisfying assignment when uncontended — the ledger GRANTS a wider frozen revision', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('sat-rung');
  db.prepare('INSERT INTO epics (project_id, name) VALUES (1, ?)').run('sat-rung-epic');
  try {
    const repo = new SqliteWorkplaceRepository(db);
    const ref = {
      processRunId: 7, moduleRef: 'test@1.0.0',
      productionCellId: 'sat-cell', workKey: 'card-a',
    };
    repo.materialize({
      processRunId: ref.processRunId, moduleRef: ref.moduleRef,
      productionCellId: ref.productionCellId, workKey: ref.workKey,
    });
    db.prepare(
      `INSERT INTO tasks (title, status, epic_id, task_kind, workflow_stage, execution_mode, tags, metadata, workplace_ref)
       VALUES ('sat-card', 'todo', 1, 'test.author', 'test', 'tracker_only', '[]', ?, ?)`,
    ).run(
      JSON.stringify({
        process_run_id: 7,
        cell_input_item: { key: 'card-a', changeScopes: ['src/north/'] },
      }),
      `workplace/7/test@1.0.0/sat-cell/card-a`,
    );
    const ledger = new SqliteScopeWideningLedger(db);
    const requestId = ledger.recordRequest({
      workplaceRef: `workplace/7/test@1.0.0/sat-cell/card-a`,
      taskId: db.prepare('SELECT id FROM tasks').get().id,
      role: 'author',
      source: 'worker-declared',
      requestedScopes: ['atlas/registry-map.json'],
    });
    const decision = ledger.decide({
      request: { id: requestId, workplace_ref: `workplace/7/test@1.0.0/sat-cell/card-a` },
    });
    // SAT: the conjunction {criteria require atlas/registry-map.json} ∧
    // {changed paths within frozen authority} HAS a satisfying assignment —
    // the wider revision. Decided mechanically, before any epoch burns.
    assert.equal(decision.granted, true);
    assert.equal(decision.grantedRevision, 1);
    assert.deepEqual(decision.grantedScopes, ['atlas/registry-map.json', 'src/north/']);
  } finally {
    db.close();
  }
});

test('SAT rung, decidable instance: the contended conjunction is UNSATISFIABLE WITH A NAMED WITNESS — refusal names the live holder', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('sat-rung');
  db.prepare('INSERT INTO epics (project_id, name) VALUES (1, ?)').run('sat-rung-epic');
  try {
    const repo = new SqliteWorkplaceRepository(db);
    const mkCard = (workKey, scopes) => {
      const ref = {
        processRunId: 7, moduleRef: 'test@1.0.0',
        productionCellId: 'sat-cell', workKey,
      };
      repo.materialize({
        processRunId: ref.processRunId, moduleRef: ref.moduleRef,
        productionCellId: ref.productionCellId, workKey,
      });
      const info = db.prepare(
        `INSERT INTO tasks (title, status, epic_id, task_kind, workflow_stage, execution_mode, tags, metadata, workplace_ref)
         VALUES (?, 'todo', 1, 'test.author', 'test', 'tracker_only', '[]', ?, ?)`,
      ).run(
        `sat-${workKey}`,
        JSON.stringify({ process_run_id: 7, cell_input_item: { key: workKey, changeScopes: scopes } }),
        `workplace/7/test@1.0.0/sat-cell/${workKey}`,
      );
      return { ref, taskId: Number(info.lastInsertRowid) };
    };
    const requester = mkCard('card-a', ['src/north/']);
    mkCard('card-b', ['atlas/']); // LIVE holder of the atlas/ claim
    const ledger = new SqliteScopeWideningLedger(db);
    const requestId = ledger.recordRequest({
      workplaceRef: `workplace/7/test@1.0.0/sat-cell/card-a`,
      taskId: requester.taskId,
      role: 'author',
      source: 'worker-declared',
      requestedScopes: ['atlas/registry-map.json'],
    });
    const decision = ledger.decide({
      request: { id: requestId, workplace_ref: `workplace/7/test@1.0.0/sat-cell/card-a` },
    });
    // UNSAT, DECIDED, WITH WITNESS: the conjunction has no satisfying
    // assignment while card-b holds atlas/, and the refusal NAMES the holder —
    // a human can act on it. Detected at the decision point, not by autopsy.
    assert.equal(decision.granted, false);
    assert.equal(decision.holders.length, 1);
    assert.equal(decision.holders[0].workKey, 'card-b');
    assert.equal(decision.holders[0].scope, 'atlas/');
  } finally {
    db.close();
  }
});
