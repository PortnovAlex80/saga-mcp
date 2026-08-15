import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  SOURCE_CHANGE_CANDIDATE_SCHEMA,
  materializeManagedSourceChange,
} from '../../dist/infrastructure/source-change/managed-source-change-candidate.js';
const contentDigest = value => createHash('sha256').update(value).digest('hex');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function setup({ scopes = ['app.js'], files = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-source-change-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', '-M', 'dev');
  const base = git(root, 'rev-parse', 'HEAD');

  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects(id,name,status) VALUES (1,'p','active')").run();
  db.prepare("INSERT INTO epics(id,project_id,name,status,priority) VALUES (1,1,'e','planned','high')").run();
  db.prepare("INSERT INTO repositories(id,name,default_branch) VALUES (1,'r','dev')").run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(root);
  const workplace = 'workplace/7/development@2/cell/item';
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES (?,7,'development@2','cell','item','in_progress','running','author',2)`,
  ).run(workplace);
  const taskId = Number(db.prepare(
    `INSERT INTO tasks
       (epic_id,title,status,priority,execution_mode,project_repository_id,
        integration_state,metadata,workplace_ref)
     VALUES (1,'source','in_progress','high','artifact_change',1,'pending',?,?)`,
  ).run(JSON.stringify({ cell_input_item: { changeScopes: scopes } }), workplace).lastInsertRowid);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,phase)
     VALUES ('exec-source','run',1,1,?,'worker','machine','executing')`,
  ).run(taskId);
  db.prepare(
    `INSERT INTO factory_effective_desk_base_receipts
       (receipt_ref,execution_ref,task_id,workplace_ref,process_run_id,
        project_repository_id,integration_branch,lineage_anchor_commit,
        effective_base_commit,observed_integration_head,receipt_digest)
     VALUES ('base-receipt','exec-source',?,?,7,1,'dev',?,?,?,'base-digest')`,
  ).run(taskId, workplace, base, base, base);
  return { root, db, base };
}

test('Factory materializes a TextSet candidate without moving canonical dev', () => {
  const fixture = setup();
  const previous = process.env.SAGA_EXECUTION_ID;
  process.env.SAGA_EXECUTION_ID = 'exec-source';
  try {
    const content = 'export const value = 2;\n';
    const result = materializeManagedSourceChange(fixture.db, SOURCE_CHANGE_CANDIDATE_SCHEMA, {
      schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
      workItemKey: 'item',
      baseCommit: fixture.base,
      entries: [{ path: 'app.js', operation: 'modify', content }],
      tests: [{ command: 'trusted:test', outcome: 'requested' }],
    });
    assert.equal(git(fixture.root, 'rev-parse', 'dev'), fixture.base);
    assert.notEqual(result.source.commitSha, fixture.base);
    assert.equal(git(fixture.root, 'show', `${result.source.commitSha}:app.js`), content.trim());
    assert.equal(git(fixture.root, 'rev-parse', `${result.source.commitSha}^`), fixture.base);
    assert.equal(result.effectiveBaseReceipt.ref, 'base-receipt');
    assert.equal(result.textSet.entries[0].digest, contentDigest(content));

    const replay = materializeManagedSourceChange(fixture.db, SOURCE_CHANGE_CANDIDATE_SCHEMA, {
      schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
      workItemKey: 'item',
      baseCommit: fixture.base,
      entries: [{ path: 'app.js', operation: 'modify', content, digest: contentDigest(content) }],
    });
    assert.equal(replay.source.commitSha, result.source.commitSha);
  } finally {
    if (previous === undefined) delete process.env.SAGA_EXECUTION_ID;
    else process.env.SAGA_EXECUTION_ID = previous;
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('path escape and undeclared scope fail before any candidate ref is created', () => {
  const fixture = setup();
  const previous = process.env.SAGA_EXECUTION_ID;
  process.env.SAGA_EXECUTION_ID = 'exec-source';
  try {
    for (const candidatePath of ['../outside.txt', 'other.js', '.git/config']) {
      assert.throws(
        () => materializeManagedSourceChange(fixture.db, SOURCE_CHANGE_CANDIDATE_SCHEMA, {
          schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
          workItemKey: 'item',
          baseCommit: fixture.base,
          entries: [{
            path: candidatePath,
            operation: 'modify',
            content: 'bad',
            digest: contentDigest('bad'),
          }],
        }),
        /SOURCE_CHANGE_(PATH_INVALID|OUT_OF_SCOPE|GIT_INTERNAL_PATH_DENIED)/,
      );
    }
    assert.equal(git(fixture.root, 'for-each-ref', '--format=%(refname)', 'refs/saga/candidates'), '');
    assert.equal(git(fixture.root, 'rev-parse', 'dev'), fixture.base);
  } finally {
    if (previous === undefined) delete process.env.SAGA_EXECUTION_ID;
    else process.env.SAGA_EXECUTION_ID = previous;
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('r8 mixed exact and directory scopes materialize a complete multi-file candidate', () => {
  const scopes = [
    'build.gradle.kts', 'gradle/', 'gradlew', 'gradlew.bat',
    'src/main/kotlin/', 'src/test/',
  ];
  const fixture = setup({
    scopes,
    files: {
      'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=old\n',
      'gradlew.bat': 'set CLASSPATH=broken\r\n',
      'src/main/kotlin/com/marsvenus/MessageService.kt': 'class MessageService\n',
      'src/main/kotlin/com/marsvenus/Application.kt': 'class Application\n',
    },
  });
  const previous = process.env.SAGA_EXECUTION_ID;
  process.env.SAGA_EXECUTION_ID = 'exec-source';
  try {
    const result = materializeManagedSourceChange(fixture.db, SOURCE_CHANGE_CANDIDATE_SCHEMA, {
      schemaVersion: SOURCE_CHANGE_CANDIDATE_SCHEMA,
      workItemKey: 'item',
      baseCommit: fixture.base,
      entries: [
        {
          path: 'src/main/kotlin/com/marsvenus/MessageService.kt',
          operation: 'modify',
          content: '@Service\nclass MessageService\n',
        },
        {
          path: 'src/main/kotlin/com/marsvenus/Application.kt',
          operation: 'modify',
          content: '@ComponentScan("com.marsvenus")\nclass Application\n',
        },
        {
          path: 'gradlew.bat',
          operation: 'modify',
          content: 'set CLASSPATH=%DIRNAME%gradle\\wrapper\\gradle-wrapper.jar\r\n',
        },
      ],
    });
    assert.equal(result.textSet.entries.length, 3);
    assert.equal(
      git(fixture.root, 'show', `${result.source.commitSha}:gradlew.bat`),
      'set CLASSPATH=%DIRNAME%gradle\\wrapper\\gradle-wrapper.jar',
    );
    assert.equal(git(fixture.root, 'rev-parse', 'dev'), fixture.base);
  } finally {
    if (previous === undefined) delete process.env.SAGA_EXECUTION_ID;
    else process.env.SAGA_EXECUTION_ID = previous;
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
