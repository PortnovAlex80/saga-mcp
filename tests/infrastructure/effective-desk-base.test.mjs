import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createSqliteProductionCellProjectionPersistence } from
  '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { resolveEffectiveDeskBase } from
  '../../dist/infrastructure/workers/effective-desk-base.js';
import { RepositoryDeskProvisioner } from
  '../../dist/infrastructure/workers/repository-desk-provisioner.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-effective-base-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(path.join(root, 'product.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', '-M', 'dev');
  const base = git(root, 'rev-parse', 'HEAD');

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE factory_process_runs (
      id INTEGER PRIMARY KEY,
      input_snapshot TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO projects(id,name,status) VALUES (1,'p','active')").run();
  db.prepare("INSERT INTO epics(id,project_id,name,status,priority) VALUES (1,1,'e','planned','high')").run();
  db.prepare("INSERT INTO repositories(id,name,default_branch) VALUES (1,'r','dev')").run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(root);
  db.prepare('INSERT INTO factory_process_runs(id,input_snapshot) VALUES (7,?)').run(
    JSON.stringify({
      repositories: [{ projectRepositoryId: 1, expectedBaseCommit: base }],
    }),
  );

  const items = ['foundation', 'dependent'].map((itemId, ordinal) => {
    const workplaceRef = `workplace/7/test@1/cell/${itemId}`;
    db.prepare(
      `INSERT INTO factory_workplaces
         (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
          kanban_phase,loop_state,next_role,revision)
       VALUES (?,7,'test@1','cell',?,'todo','idle','author',0)`,
    ).run(workplaceRef, itemId);
    const task = db.prepare(
      `INSERT INTO tasks
         (epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,
          execution_mode,project_repository_id,integration_state,generation_key,
          tags,metadata,workplace_ref)
       VALUES (1,?,'todo','high','test','test','test','git_change',1,'pending',?,
               '[]',?,?)`,
    ).run(itemId, `g:${itemId}`, JSON.stringify({ process_run_id: 7 }), workplaceRef);
    return { ordinal, itemId, workplaceRef, taskId: Number(task.lastInsertRowid) };
  });
  const graphItems = [
    { ...items[0], dependencyItemIds: [], dependencyWorkplaceRefs: [], dependencyTaskIds: [] },
    {
      ...items[1],
      dependencyItemIds: [items[0].itemId],
      dependencyWorkplaceRefs: [items[0].workplaceRef],
      dependencyTaskIds: [items[0].taskId],
    },
  ];
  const graphDigest = sha256Hex({
    productionCellId: 'cell',
    items: graphItems,
  });
  createSqliteProductionCellProjectionPersistence(db).sealWorkplaceGraph({
    graphRef: `workplace-graph:${graphDigest}`,
    graphDigest,
    processRunId: 7,
    moduleRef: 'test@1',
    productionCellId: 'cell',
    sealedAt: '2026-08-09T00:00:00.000Z',
    items: graphItems,
  });
  return { root, db, base, items };
}

test('dependent author freezes the actual post-dependency integration head', () => {
  const fixture = setup();
  try {
    const rootReceipt = resolveEffectiveDeskBase(fixture.db, {
      executionRef: 'exec-root',
      task: {
        id: fixture.items[0].taskId,
        workplace_ref: fixture.items[0].workplaceRef,
        project_repository_id: 1,
        metadata: JSON.stringify({ process_run_id: 7 }),
      },
      repository: { id: 1, integrationBranch: 'dev', repositoryRoot: fixture.root },
    });
    assert.equal(rootReceipt.effectiveBaseCommit, fixture.base);
    assert.deepEqual(rootReceipt.dependencyTaskIds, []);

    writeFileSync(path.join(fixture.root, 'product.txt'), 'foundation\n');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-m', 'integrate foundation');
    const integrated = git(fixture.root, 'rev-parse', 'HEAD');
    fixture.db.prepare(
      `UPDATE tasks SET status='done',integration_state='merged',integrated_commit=? WHERE id=?`,
    ).run(integrated, fixture.items[0].taskId);

    const receipt = resolveEffectiveDeskBase(fixture.db, {
      executionRef: 'exec-dependent',
      task: {
        id: fixture.items[1].taskId,
        workplace_ref: fixture.items[1].workplaceRef,
        project_repository_id: 1,
        metadata: JSON.stringify({ process_run_id: 7 }),
      },
      repository: { id: 1, integrationBranch: 'dev', repositoryRoot: fixture.root },
    });
    assert.equal(receipt.lineageAnchorCommit, fixture.base);
    assert.equal(receipt.effectiveBaseCommit, integrated);
    assert.equal(receipt.observedIntegrationHead, integrated);
    assert.deepEqual(receipt.dependencyTaskIds, [fixture.items[0].taskId]);
    assert.equal(receipt.dependencyIntegratedCommits[0].commit, integrated);
    assert.equal(
      resolveEffectiveDeskBase(fixture.db, {
        executionRef: 'exec-dependent',
        task: {
          id: fixture.items[1].taskId,
          workplace_ref: fixture.items[1].workplaceRef,
          project_repository_id: 1,
          metadata: JSON.stringify({ process_run_id: 7 }),
        },
        repository: { id: 1, integrationBranch: 'dev', repositoryRoot: fixture.root },
      }).receiptDigest,
      receipt.receiptDigest,
    );
    assert.throws(
      () => fixture.db.prepare(
        "UPDATE factory_effective_desk_base_receipts SET effective_base_commit='bad'",
      ).run(),
      /immutable/,
    );
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing integration blocks a dependent and a new execution never reuses a stale author desk', () => {
  const fixture = setup();
  try {
    fixture.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(fixture.items[0].taskId);
    assert.throws(
      () => resolveEffectiveDeskBase(fixture.db, {
        executionRef: 'exec-denied',
        task: {
          id: fixture.items[1].taskId,
          workplace_ref: fixture.items[1].workplaceRef,
          project_repository_id: 1,
          metadata: JSON.stringify({ process_run_id: 7 }),
        },
        repository: { id: 1, integrationBranch: 'dev', repositoryRoot: fixture.root },
      }),
      /DEPENDENCY_NOT_INTEGRATED/,
    );

    const provisioner = new RepositoryDeskProvisioner();
    const firstDesk = provisioner.provisionAuthorDesk({
      repositoryRoot: fixture.root,
      taskId: fixture.items[1].taskId,
      executionRef: 'exec-old',
      integrationBranch: 'dev',
      baseCommit: fixture.base,
      expectedIntegrationHead: fixture.base,
      projectRepositoryId: 1,
    });
    writeFileSync(path.join(fixture.root, 'product.txt'), 'new head\n');
    git(fixture.root, 'add', '.');
    git(fixture.root, 'commit', '-m', 'advance dev');
    const advanced = git(fixture.root, 'rev-parse', 'HEAD');
    const nextDesk = provisioner.provisionAuthorDesk({
      repositoryRoot: fixture.root,
      taskId: fixture.items[1].taskId,
      executionRef: 'exec-repair',
      integrationBranch: 'dev',
      baseCommit: advanced,
      expectedIntegrationHead: advanced,
      projectRepositoryId: 1,
    });
    assert.notEqual(nextDesk.git.branch, firstDesk.git.branch);
    assert.notEqual(nextDesk.executionPath, firstDesk.executionPath);
    assert.equal(nextDesk.git.baseCommit, advanced);
    assert.equal(git(fixture.root, 'rev-parse', firstDesk.git.branch), fixture.base);

    const replayDesk = provisioner.provisionAuthorDesk({
      repositoryRoot: fixture.root,
      taskId: fixture.items[1].taskId,
      executionRef: 'exec-repair',
      integrationBranch: 'dev',
      baseCommit: advanced,
      expectedIntegrationHead: advanced,
      projectRepositoryId: 1,
    });
    assert.equal(replayDesk.git.branch, nextDesk.git.branch);
    assert.equal(replayDesk.executionPath, nextDesk.executionPath);
  } finally {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
