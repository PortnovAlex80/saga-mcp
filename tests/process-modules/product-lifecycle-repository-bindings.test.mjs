import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  canonicalizeProductDeliveryLifecycleInput,
  resolveProductDeliveryRepositories,
} from '../../dist/app/product-lifecycle-repository-bindings.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE project_repositories (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      repository_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      integration_branch TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO repositories(id,name) VALUES (?,?)')
    .run(1, 'autism-buttons');
  return db;
}

function input(repository) {
  return {
    initiative: {
      subject: 'Hex buttons',
      context: {},
      evidence: [],
      constraints: {},
    },
    development: {
      repositories: [repository],
      policy: { id: 'p', version: '1', contentHash: 'hash' },
    },
    delivery: {
      policy: {},
      operatorAuthorization: {},
    },
  };
}

test('portable repository ref resolves to the current local id after reprovisioning', () => {
  const db = fixture();
  const portable = {
    repositoryRef: { repositoryName: 'autism-buttons', role: 'primary' },
    integrationBranch: 'main',
    expectedBaseCommit: 'abc',
  };

  db.prepare(
    `INSERT INTO project_repositories
      (id,project_id,repository_id,role,integration_branch,status)
     VALUES (65,1,1,'primary','main','active')`,
  ).run();
  assert.equal(
    resolveProductDeliveryRepositories(db, 1, [portable])[0].projectRepositoryId,
    65,
  );

  db.prepare('DELETE FROM project_repositories WHERE id=65').run();
  db.prepare(
    `INSERT INTO project_repositories
      (id,project_id,repository_id,role,integration_branch,status)
     VALUES (77,1,1,'primary','main','active')`,
  ).run();
  assert.equal(
    resolveProductDeliveryRepositories(db, 1, [portable])[0].projectRepositoryId,
    77,
  );
  db.close();
});

test('legacy local id is canonicalized before persistence and stale id fails closed', () => {
  const db = fixture();
  db.prepare(
    `INSERT INTO project_repositories
      (id,project_id,repository_id,role,integration_branch,status)
     VALUES (77,1,1,'primary','main','active')`,
  ).run();

  const canonical = canonicalizeProductDeliveryLifecycleInput(db, 1, input({
    projectRepositoryId: 77,
    integrationBranch: 'main',
    expectedBaseCommit: 'abc',
  }));
  assert.deepEqual(canonical.development.repositories, [{
    repositoryRef: { repositoryName: 'autism-buttons', role: 'primary' },
    integrationBranch: 'main',
    expectedBaseCommit: 'abc',
  }]);
  assert.equal(
    JSON.stringify(canonical).includes('projectRepositoryId'),
    false,
    'durable lifecycle input must not contain a local repository id',
  );

  assert.throws(
    () => canonicalizeProductDeliveryLifecycleInput(db, 1, input({
      projectRepositoryId: 65,
      integrationBranch: 'main',
      expectedBaseCommit: 'abc',
    })),
    /PRODUCT_LIFECYCLE_LOCAL_REPOSITORY_ID_STALE_OR_FOREIGN: 65/,
  );
  db.close();
});
