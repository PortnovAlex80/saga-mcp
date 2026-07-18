// End-to-end smoke test of the autonomous orchestration engine using
// mock-claude.mjs as a subprocess replacement for claude.exe.
//
// The test seeds a minimal episode that has already cleared discovery +
// formalization + planning + development. The engine then has to drive it
// through:
//   verification  →  mock worker calls verification_record + worker_done
//   integration   →  mock worker calls worker_merge_acquire + git merge
//                     (empty commit) + worker_merge_release(merged)
//   completed     →  episode_transition passes the final gate
//
// The full discovery→formalization chain is covered by product-workflow.test.mjs.
// This file focuses on the engine pump loop + close-handler + mock-claude
// contract — the surface that cannot be unit-tested with handler calls alone.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-e2e-'));
process.env.DB_PATH = path.join(temp, 'e2e.db');

// Workspace for the mock project — must be a real git repo because the
// verification/integration tasks are execution_mode='git_change'.
const workspace = path.join(temp, 'workspace');
mkdirSync(workspace);
execFileSync('git', ['init', '-b', 'dev'], { cwd: workspace });
execFileSync('git', ['config', 'user.email', 'e2e@test'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: workspace });
writeFileSync(path.join(workspace, 'README.md'), 'seed\n');
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'seed'], { cwd: workspace });

const sagaRoot = path.resolve(import.meta.dirname, '..');
import { spawn as nodeSpawn } from 'node:child_process';

// Handlers must be imported AFTER process.env.DB_PATH is set.
const { handlers: projects } = await import('../dist/tools/projects.js');
const { handlers: epics } = await import('../dist/tools/epics.js');
const { handlers: tasks } = await import('../dist/tools/tasks.js');
const { handlers: repositories } = await import('../dist/tools/repositories.js');
const { handlers: lifecycle } = await import('../dist/tools/lifecycle.js');
const { handlers: artifacts } = await import('../dist/tools/artifacts.js');
const { closeDb, getDb } = await import('../dist/db.js');
const { orchestrate } = await import('../dist/orchestrate.js');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex');
}

function seedEpisode() {
  const db = getDb();

  const project = projects.project_create({ name: 'E2E Mock Project' });
  const repo = repositories.repository_register({
    project_id: project.id, name: 'mock-repo', local_path: workspace,
    default_branch: 'dev', integration_branch: 'dev',
  });
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: os.hostname(), local_path: workspace,
  });

  const epic = epics.epic_create({ project_id: project.id, name: 'REQ-e2e-mock' });

  // Insert episode_workflows row at the verification stage. We skip the
  // discovery/formalization chain — covered by product-workflow.test.mjs.
  db.prepare(
    `INSERT INTO episode_workflows (epic_id, stage) VALUES (?, 'verification')`,
  ).run(epic.id);

  // One accepted AC at a frozen hash — the verification gate requires this.
  const acContent = '# AC-1\n\nGiven the mock, When the worker runs, Then it exits 0.\n';
  const acHash = hashOf(acContent);
  writeFileSync(path.join(temp, 'AC.md'), acContent);
  const ac = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id, type: 'AC', code: 'AC-1',
    title: 'Mock AC-1', path: path.join(temp, 'AC.md'),
    status: 'accepted', content_hash: acHash,
  });
  // artifact_create may not write accepted_hash directly — patch it.
  db.prepare(`UPDATE artifacts SET accepted_hash=? WHERE id=?`).run(acHash, ac.id);

  // One verification task targeting AC-1. Source artifact linkage is what
  // the migration uses to populate verification_target_artifact_id; we set
  // the target explicitly to skip the migration path.
  const verify = tasks.task_create({
    epic_id: epic.id,
    title: 'VERIFY AC-1: mock worker exits 0',
    task_kind: 'verification.ac',
    workflow_stage: 'verification',
    execution_skill: 'saga-verifier',
    execution_mode: 'git_change',
    project_repository_id: repo.id,
    priority: 'high',
    source_artifact_ids: [ac.id],
  });
  db.prepare(`UPDATE tasks SET verification_target_artifact_id=? WHERE id=?`).run(ac.id, verify.id);

  // Add the integration task for the integration stage. Blocked by verify.
  const integrate = tasks.task_create({
    epic_id: epic.id,
    title: 'INTEGRATE: merge mock-branch into dev',
    task_kind: 'integration.merge',
    workflow_stage: 'integration',
    execution_skill: 'saga-worker',
    execution_mode: 'git_change',
    project_repository_id: repo.id,
    priority: 'high',
    depends_on: [verify.id],
    source_artifact_ids: [ac.id],
  });

  return { project, repo, epic, ac, verify, integrate };
}

// ---------------------------------------------------------------------------
// The smoke test
// ---------------------------------------------------------------------------

test('e2e: engine drives verification → integration → completed with mock-claude', async () => {
  const { project, epic, verify, integrate } = seedEpisode();

  // Run the orchestrate engine with mock-claude as the worker subprocess.
  // Sleep is real (not faked) because the mock needs ~1s per worker, and
  // we want the close-handler to observe real DB transitions.
  const result = await orchestrate({
    projectId: project.id,
    epicId: epic.id,
    concurrency: 2,
    claudePath: process.execPath,            // node
    // argv[0]=node, argv[1]=script, argv[2..]=claude flags. claude-runner
    // invokes spawn(claudePath, args, opts) where args[0]='-p'. We need
    // the spawn to actually be `node tests/mock-claude.mjs -p ...`. The
    // runner prepends claudePath as argv[0] only if claudePath !== 'claude';
    // to inject the script path we override spawn below.
    spawn: (cmd, args, opts) => {
      // Rewrite `node -p ...` → `node tests/mock-claude.mjs -p ...`
      const mockScript = path.join(sagaRoot, 'tests', 'mock-claude.mjs');
      const newArgs = [mockScript, ...args];
      return nodeSpawn(cmd, newArgs, opts);
    },
    // Speed up the test: shorter pump ticks.
    sleep: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 100))),
  });

  // Verify the engine reached 'completed' via the integration stage.
  const db = getDb();
  const episode = db.prepare(
    `SELECT stage FROM episode_workflows WHERE epic_id=?`,
  ).get(epic.id);
  assert.equal(episode.stage, 'completed',
    `engine should reach 'completed', got '${episode.stage}' (reason=${result.reason})`);

  // Verify both tasks reached 'done'.
  const v = db.prepare(`SELECT status, integration_state FROM tasks WHERE id=?`).get(verify.id);
  assert.equal(v.status, 'done',
    `verification task #${verify.id} should be done, got '${v.status}'`);
  const i = db.prepare(`SELECT status, integration_state FROM tasks WHERE id=?`).get(integrate.id);
  assert.equal(i.status, 'done',
    `integration task #${integrate.id} should be done, got '${i.status}'`);

  // The engine should report reason='completed'.
  assert.equal(result.reason, 'completed',
    `orchestrate result.reason should be 'completed', got '${result.reason}'`);
});
