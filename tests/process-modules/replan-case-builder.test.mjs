// tests/process-modules/replan-case-builder.test.mjs
//
// RE-PLAN CYCLE (REPLAN-CYCLE-TZ §2-3) — the cycle-2 case-builder, unit T3
// of 9. When a scope-impossible verdict mints a re-plan mandate, the planner
// of cycle 2 must see ALL of cycle-1's reality: the surviving cross-seam keys,
// which items closed, the integrated repo head + file tree, the module
// boundaries, and a parallelism hint (the operator's key demand: the cycle-2
// planner sees the whole integrated code, so it can carve NON-overlapping
// scopes that genuinely run at concurrency 2).
//
// Fixtures are the REAL stage-11 shapes: the physics worker kept touching
// src/physics/spacecraft.js while its frozen scope owned
// [package.json, src/game/, tests/].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { buildReplanCase } from '../../dist/modules/development/application/replan-case-builder.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROCESS_RUN_ID = 7;
const CELL_ID = 'development-implementation';
const MODULE_REF = 'solution-development@1.0.0';

// The REAL stage-11 surviving key (composed provider code + message grammar of
// development-check-providers path-outside-authority).
const SURVIVING_KEY = 'development.implementation-scope.v1:path-outside-authority'
  + '::Git paths [src/physics/spacecraft.js] are outside frozen changeScopes '
  + '[package.json, src/game/, tests/].';

function developmentCase() {
  return {
    schemaVersion: 'factory.development-case.v1',
    projectId: 1,
    epicId: 1,
    formalizationCertificate: {
      ref: 'artifact:1', hash: sha('cert'), decision: 'formalized',
    },
    solutionContract: { ref: 'artifact:2', hash: sha('contract') },
    acceptanceBaselineHash: sha('baseline'),
    srs: { ref: 'artifact:3', hash: sha('srs') },
    acceptanceCriteria: [],
    repositories: [{
      projectRepositoryId: 1,
      integrationBranch: 'dev',
      expectedBaseCommit: 'a1b2c3d4e5f6a7b8',
    }],
    policy: { requiredChangeScopes: ['src/'] },
    initiatedBy: 'test',
  };
}

function seedCell(db) {
  // FK targets: projects → epics → factory_process_runs → worker_executions.
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('replan-case-test');
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('replan-case-test');
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?, 1, 1, 'solution-development', '1.0.0', ?, ?, 'generic-flow',
             'x', '{}', ?)`,
  ).run(PROCESS_RUN_ID, MODULE_REF, `run:${PROCESS_RUN_ID}`, sha('run'));
  const insertExecution = db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, phase)
     VALUES (?, ?, 1, 1, ?, ?, 'machine', 'executing')`,
  );
  const insertWorkplace = db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, terminal_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
     VALUES (1, ?, ?, ?, ?)`,
  );
  const insertSubmission = db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?, ?, 'implement-work-items', 1, ?, ?, 'v1', ?, ?)`,
  );
  // The stage-11 cycle-1 carve: physics + ui closed; shared-engine remains.
  const items = [
    {
      key: 'impl-physics-core', scopes: ['package.json', 'src/game/', 'tests/'],
      status: 'done', kanban: 'done', loop: 'terminal', reason: 'accepted',
      commit: 'feed0000feed0000feed0000feed0000',
      files: ['package.json', 'src/game/physics.js', 'tests/physics.test.js'],
    },
    {
      key: 'impl-ui-shell', scopes: ['src/ui/'],
      status: 'done', kanban: 'done', loop: 'terminal', reason: 'accepted',
      commit: 'beef1111beef1111beef1111beef1111',
      files: ['src/ui/shell.js'],
    },
    {
      key: 'impl-shared-engine', scopes: ['src/engine/'],
      status: 'todo', kanban: 'todo', loop: 'idle', reason: null,
      commit: null, files: null,
    },
  ];
  let executionId = 0;
  for (const item of items) {
    const workKey = item.key;
    const workplaceRef = `workplace/${PROCESS_RUN_ID}/${MODULE_REF}/${CELL_ID}/${workKey}`;
    insertWorkplace.run(
      workplaceRef, PROCESS_RUN_ID, MODULE_REF, CELL_ID, workKey,
      item.kanban, item.loop, 'author', item.reason,
    );
    const info = insertTask.run(
      `${item.key} (author)`, item.status, workplaceRef,
      JSON.stringify({ role: 'author', cell_input_item: { key: item.key, changeScopes: item.scopes } }),
    );
    const rowTaskId = Number(info.lastInsertRowid);
    if (item.files) {
      executionId += 1;
      insertExecution.run(`execution:${executionId}`, `run-${executionId}`, rowTaskId, `worker-${executionId}`);
      const payload = {
        workItemKey: item.key,
        repository: { baseCommit: 'a1b2c3d4e5f6a7b8' },
        snapshot: { commitSha: item.commit, changedFiles: item.files },
        source: { branch: `task/${item.key}` },
      };
      insertSubmission.run(
        PROCESS_RUN_ID, MODULE_REF, rowTaskId, `execution:${executionId}`,
        JSON.stringify(payload), sha(payload),
      );
    }
  }
}

function hermeticDb() {
  const dir = mkdtempSync(join(tmpdir(), 'replan-case-'));
  const db = new Database(join(dir, 'case.sqlite'));
  db.exec(SCHEMA_SQL);
  ensureManagedNodeSubmissionSchema(db);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('T3 RED: buildReplanCase enriches the cycle-1 case with survivingKeys + integratedHead + fileTree + parallelismHint', () => {
  const { db, cleanup } = hermeticDb();
  try {
    seedCell(db);
    const enriched = buildReplanCase(db, {
      developmentCase: developmentCase(),
      workplaceRef: {
        processRunId: PROCESS_RUN_ID,
        moduleRef: MODULE_REF,
        productionCellId: CELL_ID,
        workKey: 'impl-physics-core',
      },
      role: 'author',
      survivingKeys: [SURVIVING_KEY],
    });

    // The STANDARD case fields are inherited from cycle 1 unchanged.
    assert.equal(enriched.acceptanceBaselineHash, sha('baseline'));
    assert.equal(enriched.repositories[0].expectedBaseCommit, 'a1b2c3d4e5f6a7b8');
    assert.ok(enriched.replanContext, 'the enriched case carries replanContext');

    const ctx = enriched.replanContext;
    assert.equal(ctx.cycleNumber, 2, 'the mandate during cycle 1 mints cycle 2');

    // cycle1Diagnosis: the surviving cross-seam keys, verbatim.
    assert.deepEqual(ctx.cycle1Diagnosis.survivingKeys, [SURVIVING_KEY]);
    assert.deepEqual(ctx.cycle1Diagnosis.completedItems.sort(),
      ['impl-physics-core', 'impl-ui-shell'],
      'the closed cycle-1 items carry forward as the git baseline knowledge');
    // scopeViolations: WHICH paths sat outside WHICH frozen scopes.
    assert.equal(ctx.cycle1Diagnosis.scopeViolations.length, 1);
    assert.deepEqual(ctx.cycle1Diagnosis.scopeViolations[0].paths, ['src/physics/spacecraft.js']);
    assert.deepEqual(ctx.cycle1Diagnosis.scopeViolations[0].scopes,
      ['package.json', 'src/game/', 'tests/']);

    // integratedRepoState: the integrated HEAD + every file cycle 1 touched.
    assert.equal(ctx.integratedRepoState.headCommit,
      'beef1111beef1111beef1111beef1111',
      'the LATEST accepted item commit is the integration head');
    assert.deepEqual([...ctx.integratedRepoState.fileTree].sort(),
      ['package.json', 'src/game/physics.js', 'src/ui/shell.js', 'tests/physics.test.js']);
    // moduleBoundaries: which modules (scopes) own which items.
    const gameModule = ctx.integratedRepoState.moduleBoundaries
      .find(pair => pair.module === 'src/game/');
    assert.ok(gameModule, 'the src/game/ boundary is exported');
    assert.deepEqual(gameModule.exports, ['impl-physics-core']);

    // parallelismHint: from the model profile; non-overlapping scope groups.
    assert.equal(ctx.parallelismHint.maxConcurrency, 2);
    const groups = ctx.parallelismHint.nonOverlappingGroups;
    const physicsGroup = groups.find(group => group.includes('impl-physics-core'));
    const uiGroup = groups.find(group => group.includes('impl-ui-shell'));
    assert.ok(physicsGroup && uiGroup, 'both closed items are grouped');
    assert.equal(physicsGroup, uiGroup,
      'physics [package.json, src/game/, tests/], ui [src/ui/] and engine [src/engine/] are pairwise NON-overlapping — one parallel group, no serialization edge warranted in cycle 2');
    assert.deepEqual(physicsGroup.sort(),
      ['impl-physics-core', 'impl-shared-engine', 'impl-ui-shell']);
  } finally {
    cleanup();
  }
});
