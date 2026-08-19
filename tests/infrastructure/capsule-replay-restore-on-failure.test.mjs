// tests/infrastructure/capsule-replay-restore-on-failure.test.mjs
//
// PREVENTIVE-HUNT Layer 7, X-9 — "Sealed-branch force-mover".
//
// `git checkout -B <sourceBranch> <baseCommit>` inside applyGitRecipe
// (capsule-replay-executor:580) is the ONLY force-mover of a sealed worker
// branch. On a successful replay the deterministic re-commit returns the
// branch to the sealed source commit. On FAILURE the recovery (:618-621)
// reset+checkout'd the WORKTREE but left the branch AT baseCommit — so every
// seal-consuming proof that checks `rev-parse refs/heads/<branch>` against the
// sealed source commit (integration REVIEWED_SOURCE_MISMATCH, carry-forward
// GIT_IDENTITY_DRIFT, replay's own base checks) failed PERMANENTLY.
//
// Proves, through the REAL seam (executeCapsuleReplay over a real temp git
// repo with a real capsule row and a real git recipe):
//
//   RB1 a recipe failure after checkout -B RESTORES a pre-existing sealed
//       branch to its captured commit (plain update-ref back to what was
//       there) and still rethrows the original error;
//   RB2 when the branch did NOT exist before the replay, the failed replay
//       DELETES it (returning to the pre-replay state);
//   RB3 the success path stays byte-identical: a valid recipe reconstructs
//       the exact sealed commit (deterministic identity) and the integration
//       branch does not move;
//   RB4 a typed mid-recipe mismatch (COMMIT_MISMATCH after the replay commit)
//       also restores the branch from the replayed (moved) position.
//
// BEFORE the fix RB1/RB2/RB4 are RED: the branch is left at baseCommit (or
// the replayed commit), never restored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureReplayCapsuleSchema } from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { executeCapsuleReplay } from '../../dist/infrastructure/replay/capsule-replay-executor.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Sealed Author',
  GIT_AUTHOR_EMAIL: 'sealed@example.test',
  GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Sealed Committer',
  GIT_COMMITTER_EMAIL: 'sealed@example.test',
  GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
};

function git(root, args, env = process.env) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Diff output must keep its trailing newline (`git apply` requires it). */
function gitPatch(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitChecked(root, ref) {
  try {
    return git(root, ['rev-parse', '--verify', ref]);
  } catch {
    return null;
  }
}

/** Real repo: dev at base B; sealed branch task/7 at deterministic S. */
function makeRepo(marker) {
  const root = mkdtempSync(join(tmpdir(), `saga-x9-${marker}-`));
  git(root, ['init', '-b', 'dev']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'user.email', 't@t.test']);
  writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, ['add', 'app.txt']);
  git(root, ['commit', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-b', 'task/7']);
  writeFileSync(join(root, 'app.txt'), 'sealed change\n');
  writeFileSync(join(root, 'new-file.txt'), 'sealed artifact\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'sealed: implement item'], FIXED_ENV);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);
  const sourceTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const patch = gitPatch(root, ['diff', base, sourceCommit]);
  git(root, ['checkout', 'dev']);
  return { root, base, sourceCommit, sourceTree, patch };
}

function makeCapsulePayload(recipe) {
  return {
    schemaVersion: 'factory.replay-capsule.v1',
    key: {
      projectId: 1,
      moduleRef: 'module@1',
      nodeId: 'cell',
      productionCellId: 'cell',
      workKey: 'item-1',
      role: 'author',
      packageContractDigest: sha('pkg'),
      semanticInputDigest: sha('input'),
      subjectProductionDigest: null,
      repositoryBaseDigest: null,
    },
    replayKey: sha('rk'),
    inputBindings: [],
    typedProducts: [],
    artifacts: [],
    traces: [],
    git: recipe,
  };
}

/** The DB world: execution row with a frozen replay binding + capsule row. */
function makeDb(payload) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureReplayCapsuleSchema(db);
  db.pragma('foreign_keys=OFF');
  db.prepare(`INSERT INTO projects(id,name,status) VALUES (1,'p','active')`).run();
  db.prepare(`INSERT INTO epics(id,project_id,name,status) VALUES (1,1,'e','planned')`).run();
  db.prepare(
    `INSERT INTO tasks(id,epic_id,title,status,execution_mode,metadata)
     VALUES (1,1,'author','done','git_change','{}')`,
  ).run();
  const payloadHash = sha(payload);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,phase,metadata)
     VALUES ('exec-x9','run-1',1,1,1,'worker-1','machine-1','executing',?)`,
  ).run(JSON.stringify({
    execution_context: {
      replay: { capsule_ref: 'capsule:x9', capsule_payload_hash: payloadHash },
    },
  }));
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref,replay_key,project_id,source_execution_ref,source_candidate_set_ref,
        payload_hash,payload_snapshot)
     VALUES ('capsule:x9',?,?, 'exec-x9','candidate-set/x9', ?, ?)`,
  ).run(payload.replayKey, 1, payloadHash, JSON.stringify(payload));
  return db;
}

function runReplay(repo, payload) {
  const db = makeDb(payload);
  try {
    return executeCapsuleReplay(db, {
      product_submit: () => { throw new Error('unexpected product_submit'); },
      artifact_create: () => { throw new Error('unexpected artifact_create'); },
      trace_add: () => { throw new Error('unexpected trace_add'); },
      worker_done: () => { throw new Error('unexpected worker_done'); },
    }, { taskId: 1, workerId: 'worker-1', executionId: 'exec-x9', cwd: repo.root });
  } finally {
    db.close();
  }
}

function validRecipe(repo) {
  return {
    projectRepositoryId: 1,
    integrationBranch: 'dev',
    baseCommit: repo.base,
    sourceCommit: repo.sourceCommit,
    sourceTree: repo.sourceTree,
    sourceBranch: 'task/7',
    patchBase64: Buffer.from(repo.patch, 'utf8').toString('base64'),
    commit: {
      authorName: FIXED_ENV.GIT_AUTHOR_NAME,
      authorEmail: FIXED_ENV.GIT_AUTHOR_EMAIL,
      authorDate: FIXED_ENV.GIT_AUTHOR_DATE,
      committerName: FIXED_ENV.GIT_COMMITTER_NAME,
      committerEmail: FIXED_ENV.GIT_COMMITTER_EMAIL,
      committerDate: FIXED_ENV.GIT_COMMITTER_DATE,
      message: 'sealed: implement item',
    },
  };
}

function cleanup(repo) {
  rmSync(repo.root, { recursive: true, force: true });
}

// ===========================================================================
// RB1 — failure after checkout -B restores a pre-existing sealed branch.
// ===========================================================================
test('RB1: failed replay restores the pre-existing sealed branch and rethrows', () => {
  const repo = makeRepo('rb1');
  try {
    assert.equal(gitChecked(repo.root, 'refs/heads/task/7'), repo.sourceCommit,
      'fixture: sealed branch starts at the sealed commit');
    const corrupt = {
      ...validRecipe(repo),
      patchBase64: Buffer.from('this is not a git patch\n', 'utf8').toString('base64'),
    };
    assert.throws(
      () => runReplay(repo, makeCapsulePayload(corrupt)),
      /CAPSULE_REPLAY_GIT_FAILED/,
      'the original recipe failure is still thrown',
    );
    assert.equal(
      gitChecked(repo.root, 'refs/heads/task/7'),
      repo.sourceCommit,
      'RB1: the sealed branch must be restored to its pre-replay commit, not left at baseCommit',
    );
    assert.equal(gitChecked(repo.root, 'refs/heads/dev'), repo.base,
      'the integration branch is untouched');
  } finally {
    cleanup(repo);
  }
});

// ===========================================================================
// RB2 — branch absent before the replay: failure must DELETE it.
// ===========================================================================
test('RB2: failed replay on a previously-absent branch removes it again', () => {
  const repo = makeRepo('rb2');
  try {
    git(repo.root, ['branch', '-D', 'task/7']);
    assert.equal(gitChecked(repo.root, 'refs/heads/task/7'), null,
      'fixture: branch absent before replay');
    const corrupt = {
      ...validRecipe(repo),
      patchBase64: Buffer.from('not a patch\n', 'utf8').toString('base64'),
    };
    assert.throws(
      () => runReplay(repo, makeCapsulePayload(corrupt)),
      /CAPSULE_REPLAY_GIT_FAILED/,
    );
    assert.equal(
      gitChecked(repo.root, 'refs/heads/task/7'),
      null,
      'RB2: a branch the replay created and then failed on must be deleted (pre-replay state)',
    );
  } finally {
    cleanup(repo);
  }
});

// ===========================================================================
// RB3 — success path is byte-identical (guards the fix from breaking replay).
// ===========================================================================
test('RB3: successful replay still reconstructs the exact sealed commit', () => {
  const repo = makeRepo('rb3');
  try {
    git(repo.root, ['branch', '-D', 'task/7']);
    const outcome = runReplay(repo, makeCapsulePayload(validRecipe(repo)));
    assert.equal(outcome.gitCommit, repo.sourceCommit,
      'the deterministic re-commit reproduces the sealed source commit');
    assert.equal(gitChecked(repo.root, 'refs/heads/task/7'), repo.sourceCommit,
      'the reconstructed branch points at the sealed commit');
    assert.equal(gitChecked(repo.root, 'refs/heads/dev'), repo.base,
      'the integration branch does not move');
  } finally {
    cleanup(repo);
  }
});

// ===========================================================================
// RB4 — typed mid-recipe mismatch (after the replayed commit moved the
// branch) also restores the sealed position.
// ===========================================================================
test('RB4: typed COMMIT_MISMATCH after the replay commit restores the sealed branch', () => {
  const repo = makeRepo('rb4');
  try {
    assert.equal(gitChecked(repo.root, 'refs/heads/task/7'), repo.sourceCommit);
    // A DIFFERENT commit message makes the deterministic re-commit diverge
    // from recipe.sourceCommit, tripping the typed COMMIT_MISMATCH proof
    // AFTER the branch was already moved to the replayed commit.
    const mismatched = {
      ...validRecipe(repo),
      commit: { ...validRecipe(repo).commit, message: 'sealed: DIFFERENT message' },
    };
    assert.throws(
      () => runReplay(repo, makeCapsulePayload(mismatched)),
      /CAPSULE_REPLAY_GIT_COMMIT_MISMATCH/,
    );
    assert.equal(
      gitChecked(repo.root, 'refs/heads/task/7'),
      repo.sourceCommit,
      'RB4: the branch must return to the sealed commit from the replayed position',
    );
  } finally {
    cleanup(repo);
  }
});
