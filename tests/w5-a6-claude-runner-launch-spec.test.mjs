// W5-A6 — Claude runner AgentLaunchSpec integration tests.
//
// Task: docs/refactor-management/05-subagent-tasks/W05-a6.md
// Spec:  docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
// Plan:  §10.12–§10.16, §13.17, §13.18, §0.8.8.
//
// This file exercises the three W5-A6 fixes through the REAL ClaudeBoardRunner
// launch() path (buildPrompt is module-private). A fake spawn captures the
// prompt (written to stdin) and the claude argv, then we assert:
//
//   §0.2.7/§10.12 (fix #1): when resolveLaunchSpec returns a pinned descriptor
//     with a resolveSkill callback, the runner reads the skill file from the
//     PINNED installation path (resolveSkill), NOT the global sagaSkillRoot.
//
//   §13.18 (fix #2): for a review-status task whose launch spec role carries a
//     reviewSkill, the prompt inlines the REVIEWER skill section (and the
//     effective_skill= line names the reviewer skill), instead of overwriting
//     it with the author semanticSkill.
//
//   §13.17 (fix #3): when the launch spec carries allowedToolIds, the runner
//     grants only the builtins the profile declares (intersected with the
//     default builtin set), instead of the unconditional hard-coded set.
//
// Legacy preservation: when resolveLaunchSpec is absent OR returns null, every
// legacy path (global skill root, author semantic skill for reviews, default
// builtin set) is preserved byte-for-byte — the existing claude-runner.test.mjs
// already covers that, but we add one explicit no-spec assertion here too.
//
// Slice 1 (saga4, commit 49ac316) adaptation: the runner is now a one-card
// host — start() REQUIRES `assignment: AssignedWork` and no longer calls
// claimTask. These tests assert launch-spec PROMPT/ARGV properties that are
// still valid; only the harness changed. makeRunner now builds a minimal
// AssignedWork for STATE_TASK_ID and passes it to start(), plus a getTask
// callback (required by assignmentFromAssignedWork). The former claimTask
// callback is retained for shape compatibility but is no longer invoked.
// execution_id is intentionally empty (see fakeAssignment note in
// claude-runner.test.mjs): markExecutionRunning needs a real OS birth token,
// unavailable for fake EventEmitter children; the W5-A6 fixes under test do
// not depend on the execution fence.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeBoardRunner } from '../tracker-view/claude-runner.mjs';

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = { write() {}, end() {} };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 143));
    return true;
  };
  return child;
}

// A spawn wrapper that captures BOTH the prompt written to stdin AND the argv,
// then flips the task to a terminal state so the close handler treats the
// worker as completed (not recovered). The close handler requires:
//   status==='review'|'done' AND assigned_to===null AND integration_complete.
// integration_complete is false for a review git_change task_kind unless
// integration_state==='merged'. We read the claim-snapshot status from the
// task id and set the terminal state accordingly.
function capturingSpawn(captured, states) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = Math.floor(Math.random() * 9000) + 1000;
    let stdinBuffer = '';
    child.stdin = {
      write(chunk) { stdinBuffer += chunk.toString(); return true; },
      end() {
        captured.push({ args, options, prompt: stdinBuffer });
        const taskId = Number(options.env.SAGA_TASK_ID);
        const prior = states.get(taskId);
        const wasReview = prior?.status === 'review';
        states.set(taskId, {
          id: taskId,
          status: wasReview ? 'done' : 'review',
          assigned_to: null,
          // review git_change tasks need integration_state='merged' for the
          // close handler to count them as completed.
          integration_state: wasReview ? 'merged' : undefined,
        });
        setTimeout(() => child.emit('close', 0), 5);
      },
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
    return child;
  };
}

// Common factory for a runner with a resolveLaunchSpec callback wired.
//
// Slice 1 (saga4, commit 49ac316): the runner is one-card and start() now
// REQUIRES `assignment: AssignedWork`; claimTask is no longer called. The
// `claimedFlag` parameter is retained for call-site compatibility but is no
// longer functional. assignmentForStateTask() builds the single pre-assigned
// card the dispatcher would have handed the runner; each test passes it to
// start(). `getTask` is required (assignmentFromAssignedWork fetches the fresh
// task row); we read it from the `states` map so the test controls the task
// shape (status, task_kind, __skill).
function makeRunner({
  temp,
  captured,
  states,
  resolveLaunchSpec,
  claimedFlag,
  recoverAssignment = () => { throw new Error('recovery should not run'); },
}) {
  return new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name: 'w5-a6-project', tags: '[]' }),
    resolveWorkspace: () => temp,
    // claimTask is no longer called by the runner (Slice 1); kept only for
    // constructor-shape compatibility. The pre-assigned card is supplied via
    // start({ assignment }).
    claimTask: () => ({ task: null, skill: null }),
    getTask: id => {
      const task = states.get(id);
      if (!task) return null;
      const { __skill, ...rest } = task;
      return { ...rest, tags: rest.tags ?? '[]' };
    },
    getTaskState: id => states.get(id),
    recoverAssignment,
    spawn: capturingSpawn(captured, states),
    resolveLaunchSpec,
  });
}

const STATE_TASK_ID = 7001;

// Build the single AssignedWork the dispatcher hands the runner for the
// STATE_TASK_ID card. Mirrors the shape from claude-runner.test.mjs
// fakeAssignment, with the frozen execution_context.authority that exercises
// the §13.17 --allowedTools path. execution_id is intentionally empty (see
// file header).
function assignmentForStateTask(workerId = 'w-7001', status = 'in_progress') {
  return {
    taskId: STATE_TASK_ID,
    epicId: 0,
    projectId: 70,
    status,
    skill: 'saga-developer',
    workerExecutionId: '',
    fenceToken: '',
    runId: 'test-run',
    workerId,
    machineId: 'test-host',
    repository: null,
    executionContext: {
      authority: { allowed_saga_tools: ['task_get', 'worker_done', 'Read', 'Edit'] },
    },
  };
}

function seedSkill(root, skillName, content) {
  const dir = path.join(root, 'skills', skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), content);
}

test('W5-A6 fix #1 (§0.2.7/§10.12): launch spec resolveSkill resolves the pinned installation path, NOT the global skill root', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-pinned-'));
  const captured = [];
  const states = new Map();
  // Global skill root: put a DECOY semantic skill there.
  seedSkill(temp, 'saga-product', 'GLOBAL-DECOY-PRODUCT-SKILL');
  // Pinned installation store: put the REAL semantic skill there.
  const installRoot = path.join(temp, 'install-store', 'pkg-abc');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(installRoot, 'real-product.md'), 'PINNED-REAL-PRODUCT-SKILL');

  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'author task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-product',
  });

  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => ({
      installationId: 42,
      role: {
        executionSkill: 'saga-product',
        semanticSkill: 'saga-product',
        reviewSkill: null,
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      // §0.2.7/§10.12: resolve the pinned path from the installation, not the
      // global skill root. The decoy at skills/saga-product/SKILL.md must NOT
      // be read.
      resolveSkill: (skillName) => {
        if (skillName === 'saga-product') return path.join(installRoot, 'real-product.md');
        if (skillName === 'saga-process-module-worker-protocol') {
          return path.join(installRoot, 'real-product.md'); // reuse for protocol inline
        }
        return null;
      },
      allowedToolIds: null,
    }),
  });

  try {
    runner.start({ projectId: 70, concurrency: 1, assignment: assignmentForStateTask('w-70') });
    await waitFor(() => runner.status(70)?.status === 'completed');
    assert.equal(captured.length, 1, 'one worker should have been spawned');
    const { prompt } = captured[0];
    assert.ok(prompt.includes('PINNED-REAL-PRODUCT-SKILL'),
      'prompt must inline the PINNED installation skill content');
    assert.ok(!prompt.includes('GLOBAL-DECOY-PRODUCT-SKILL'),
      'prompt must NOT inline the global skill root decoy');
    assert.ok(prompt.includes('launch_spec_installation=42'),
      'prompt must surface the pinned installation id');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 fix #2 (§13.18): review task with a launch-spec reviewSkill inlines the REVIEWER skill, not the author semanticSkill', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-reviewer-'));
  const captured = [];
  const states = new Map();
  const installRoot = path.join(temp, 'install-store', 'pkg-abc');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(installRoot, 'protocol.md'), 'PROTOCOL-CONTENT');
  writeFileSync(path.join(installRoot, 'reviewer.md'), 'REVIEWER-WHAT-TO-VERIFY');
  writeFileSync(path.join(installRoot, 'author.md'), 'AUTHOR-WHAT-TO-PRODUCE');

  // A review task: status==='review'. The dispatcher assigned saga-reviewer.
  // The launch spec role.semanticSkill (author) is 'saga-product'; reviewSkill
  // is 'saga-requirements-reviewer'. §13.18 fix: the REVIEWER skill must win.
  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'review', title: 'review task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-reviewer',
  });

  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => ({
      installationId: 7,
      role: {
        executionSkill: 'saga-product',
        semanticSkill: 'saga-product',
        reviewSkill: 'saga-requirements-reviewer',
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      resolveSkill: (skillName) => {
        const map = {
          'saga-product': path.join(installRoot, 'author.md'),
          'saga-requirements-reviewer': path.join(installRoot, 'reviewer.md'),
          'saga-process-module-worker-protocol': path.join(installRoot, 'protocol.md'),
        };
        return map[skillName] ?? null;
      },
      allowedToolIds: null,
    }),
  });

  try {
    runner.start({ projectId: 71, concurrency: 1, assignment: assignmentForStateTask('w-71', 'review_in_progress') });
    await waitFor(() => runner.status(71)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { prompt } = captured[0];
    // §13.18: reviewer skill content is inlined, author content is NOT.
    assert.ok(prompt.includes('REVIEWER-WHAT-TO-VERIFY'),
      'review prompt must inline the REVIEWER skill');
    assert.ok(!prompt.includes('AUTHOR-WHAT-TO-PRODUCE'),
      'review prompt must NOT inline the author semantic skill');
    // The prompt metadata names the effective reviewer skill.
    assert.ok(prompt.includes('effective_skill=saga-requirements-reviewer'),
      'prompt must surface effective_skill=<reviewer>');
    assert.ok(prompt.includes('reviewer_skill=saga-requirements-reviewer'),
      'prompt must surface reviewer_skill=<name>');
    // The reviewer section marker is used, and rule 4 references REVIEWER SKILL.
    assert.ok(prompt.includes('REVIEWER SKILL BEGIN'),
      'REVIEWER SKILL BEGIN marker must be present');
    assert.ok(prompt.includes('the REVIEWER SKILL (what to verify)'),
      'rule 4 must reference the reviewer skill for review tasks');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 fix #2 (§13.18): non-review task still uses the author semantic skill even when a reviewSkill is declared', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-author-'));
  const captured = [];
  const states = new Map();
  const installRoot = path.join(temp, 'install-store', 'pkg-abc');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(installRoot, 'protocol.md'), 'PROTOCOL-CONTENT');
  writeFileSync(path.join(installRoot, 'reviewer.md'), 'REVIEWER-WHAT-TO-VERIFY');
  writeFileSync(path.join(installRoot, 'author.md'), 'AUTHOR-WHAT-TO-PRODUCE');

  // A non-review (todo) task: even though reviewSkill is declared, the author
  // semantic skill is the correct selection.
  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'author task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-product',
  });

  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => ({
      installationId: 7,
      role: {
        executionSkill: 'saga-product',
        semanticSkill: 'saga-product',
        reviewSkill: 'saga-requirements-reviewer',
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      resolveSkill: (skillName) => {
        const map = {
          'saga-product': path.join(installRoot, 'author.md'),
          'saga-requirements-reviewer': path.join(installRoot, 'reviewer.md'),
          'saga-process-module-worker-protocol': path.join(installRoot, 'protocol.md'),
        };
        return map[skillName] ?? null;
      },
      allowedToolIds: null,
    }),
  });

  try {
    runner.start({ projectId: 72, concurrency: 1, assignment: assignmentForStateTask('w-72') });
    await waitFor(() => runner.status(72)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { prompt } = captured[0];
    assert.ok(prompt.includes('AUTHOR-WHAT-TO-PRODUCE'),
      'non-review prompt must inline the author semantic skill');
    assert.ok(!prompt.includes('REVIEWER-WHAT-TO-VERIFY'),
      'non-review prompt must NOT inline the reviewer skill');
    assert.ok(!prompt.includes('effective_skill='),
      'non-review prompt must not surface an effective_skill override line');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 fix #3 (§13.17): launch spec allowedToolIds narrows the granted Claude builtins', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-builtin-'));
  const captured = [];
  const states = new Map();
  const installRoot = path.join(temp, 'install-store', 'pkg-abc');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(installRoot, 'protocol.md'), 'PROTOCOL-CONTENT');
  writeFileSync(path.join(installRoot, 'author.md'), 'AUTHOR-CONTENT');

  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'narrow builtin task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-product',
  });

  // Profile declares ONLY Read + Edit as builtins. The frozen execution_context
  // authority carries allowed_saga_tools=['task_get','worker_done','Read','Edit'].
  // §13.17 fix: the granted builtins must be exactly Read,Edit (the
  // intersection of the default set and the profile's allowedTools), NOT the
  // full hard-coded [Bash,Read,Write,Edit,Glob,Grep,MultiEdit,Task].
  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => ({
      installationId: 9,
      role: {
        executionSkill: 'saga-product',
        semanticSkill: 'saga-product',
        reviewSkill: null,
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      resolveSkill: (skillName) => {
        const map = {
          'saga-product': path.join(installRoot, 'author.md'),
          'saga-process-module-worker-protocol': path.join(installRoot, 'protocol.md'),
        };
        return map[skillName] ?? null;
      },
      allowedToolIds: ['Read', 'Edit'],
    }),
  });

  try {
    runner.start({ projectId: 73, concurrency: 1, assignment: assignmentForStateTask('w-73') });
    await waitFor(() => runner.status(73)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { args } = captured[0];
    const allowedIdx = args.indexOf('--allowedTools');
    assert.ok(allowedIdx >= 0, '--allowedTools must be present (frozen authority path)');
    const allowed = args[allowedIdx + 1].split(',');
    // The saga tools are prefixed mcp__saga__ and come from the frozen authority.
    assert.ok(allowed.includes('mcp__saga__task_get'), 'task_get saga tool granted');
    assert.ok(allowed.includes('mcp__saga__worker_done'), 'worker_done saga tool granted');
    // §13.17: builtins are NARROWED to Read,Edit only.
    assert.ok(allowed.includes('Read'), 'Read builtin granted (declared by profile)');
    assert.ok(allowed.includes('Edit'), 'Edit builtin granted (declared by profile)');
    assert.ok(!allowed.includes('Bash'), 'Bash builtin must NOT be granted (not in profile allowedTools)');
    assert.ok(!allowed.includes('Write'), 'Write builtin must NOT be granted');
    assert.ok(!allowed.includes('Glob'), 'Glob builtin must NOT be granted');
    assert.ok(!allowed.includes('Grep'), 'Grep builtin must NOT be granted');
    assert.ok(!allowed.includes('MultiEdit'), 'MultiEdit builtin must NOT be granted');
    assert.ok(!allowed.includes('Task'), 'Task builtin must NOT be granted');
    // Read/Edit appear in BOTH the saga list (no prefix) and builtin list; the
    // saga entries are filtered out by the builtinSet, so the only unprefixed
    // 'Read'/'Edit' entries are the granted builtins.
    const builtinEntries = allowed.filter(t => !t.startsWith('mcp__saga__'));
    assert.deepEqual(builtinEntries.sort(), ['Edit', 'Read'],
      'granted Claude builtins must be exactly Read,Edit');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 fix #3 (§13.17): no launch spec allowedToolIds → legacy default builtin set preserved', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-legacy-builtin-'));
  const captured = [];
  const states = new Map();
  const installRoot = path.join(temp, 'install-store', 'pkg-abc');
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(installRoot, 'protocol.md'), 'PROTOCOL-CONTENT');
  writeFileSync(path.join(installRoot, 'author.md'), 'AUTHOR-CONTENT');

  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'legacy builtin task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-product',
  });

  // allowedToolIds is null/absent → §13.17 legacy path: the full default
  // builtin set is granted.
  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => ({
      installationId: 9,
      role: {
        executionSkill: 'saga-product',
        semanticSkill: 'saga-product',
        reviewSkill: null,
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      resolveSkill: (skillName) => {
        const map = {
          'saga-product': path.join(installRoot, 'author.md'),
          'saga-process-module-worker-protocol': path.join(installRoot, 'protocol.md'),
        };
        return map[skillName] ?? null;
      },
      allowedToolIds: null,
    }),
  });

  try {
    runner.start({ projectId: 74, concurrency: 1, assignment: assignmentForStateTask('w-74') });
    await waitFor(() => runner.status(74)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { args } = captured[0];
    const allowedIdx = args.indexOf('--allowedTools');
    const allowed = args[allowedIdx + 1].split(',');
    const builtinEntries = allowed.filter(t => !t.startsWith('mcp__saga__'));
    assert.deepEqual(
      builtinEntries.sort(),
      ['Bash', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'Read', 'Task', 'Write'],
      'legacy path grants the full default builtin set',
    );
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 legacy preservation: no resolveLaunchSpec callback → full legacy path (global skill root, author skill for review, default builtins)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-no-spec-'));
  const captured = [];
  const states = new Map();
  // Global skill root carries the real skill (legacy resolution).
  seedSkill(temp, 'saga-product', 'GLOBAL-PRODUCT-SKILL');
  seedSkill(temp, 'saga-worker', 'GLOBAL-WORKER-SKILL');

  // A review task. With NO launch spec, §13.18 is NOT applied: the legacy
  // precedence picks assignment.skill (saga-reviewer) → saga-reviewer/SKILL.md,
  // which does not exist → falls back to saga-worker. There is no protocol
  // profile resolution here (no resolveProfile wired), so the single-skill
  // path is used.
  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'review', title: 'legacy review task',
    task_kind: 'formalization.prd', workflow_stage: 'formalization', execution_mode: 'git_change',
    __skill: 'saga-reviewer',
  });

  // resolveLaunchSpec NOT passed to the constructor at all.
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(temp, 'saga.db'),
    sagaEntry: path.join(temp, 'dist', 'index.js'),
    sagaSkillRoot: path.join(temp, 'skills'),
    logRoot: path.join(temp, 'logs'),
    getProject: id => ({ id, name: 'w5-a6-legacy', tags: '[]' }),
    resolveWorkspace: () => temp,
    // Slice 1: claimTask is no longer called by the runner; the pre-assigned
    // card is supplied via start({ assignment }). Kept for shape compat.
    claimTask: () => ({ task: null, skill: null }),
    getTask: id => {
      const task = states.get(id);
      if (!task) return null;
      const { __skill, ...rest } = task;
      return { ...rest, tags: '[]' };
    },
    getTaskState: id => states.get(id),
    recoverAssignment: () => { throw new Error('recovery should not run'); },
    spawn: capturingSpawn(captured, states),
    // No resolveLaunchSpec, no resolveProfile.
  });

  try {
    runner.start({ projectId: 75, concurrency: 1, assignment: assignmentForStateTask('w-75', 'review_in_progress') });
    await waitFor(() => runner.status(75)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { prompt, args } = captured[0];
    // Legacy single-skill path: no PROTOCOL/REVIEWER sections.
    assert.ok(!prompt.includes('PROTOCOL SKILL BEGIN'),
      'legacy path must not emit PROTOCOL section (no profile resolved)');
    assert.ok(!prompt.includes('REVIEWER SKILL BEGIN'),
      'legacy path must not emit REVIEWER section');
    assert.ok(!prompt.includes('launch_spec_installation='),
      'legacy path must not surface launch_spec_installation');
    // Legacy default builtin set is granted.
    const allowedIdx = args.indexOf('--allowedTools');
    const allowed = args[allowedIdx + 1].split(',');
    const builtinEntries = allowed.filter(t => !t.startsWith('mcp__saga__'));
    assert.deepEqual(
      builtinEntries.sort(),
      ['Bash', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'Read', 'Task', 'Write'],
      'legacy path grants the full default builtin set',
    );
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 legacy preservation: resolveLaunchSpec returns null → legacy path', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-null-spec-'));
  const captured = [];
  const states = new Map();
  seedSkill(temp, 'saga-worker', 'GLOBAL-WORKER-SKILL');

  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'null spec task',
    task_kind: 'legacy.kind', workflow_stage: 'development', execution_mode: 'git_change',
    __skill: 'saga-developer',
  });

  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    // Resolver present but returns null (legacy fallback path).
    resolveLaunchSpec: () => null,
  });

  try {
    runner.start({ projectId: 76, concurrency: 1, assignment: assignmentForStateTask('w-76') });
    await waitFor(() => runner.status(76)?.status === 'completed');
    assert.equal(captured.length, 1);
    const { prompt } = captured[0];
    assert.ok(!prompt.includes('launch_spec_installation='),
      'null launch spec must not surface launch_spec_installation');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W5-A6 robustness: resolveLaunchSpec that throws → legacy path (no crash)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-throw-spec-'));
  const captured = [];
  const states = new Map();
  seedSkill(temp, 'saga-worker', 'GLOBAL-WORKER-SKILL');

  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'throwing resolver task',
    task_kind: 'legacy.kind', workflow_stage: 'development', execution_mode: 'git_change',
    __skill: 'saga-developer',
  });

  const runner = makeRunner({
    temp, captured, states,
    claimedFlag: { value: false },
    resolveLaunchSpec: () => { throw new Error('registry offline'); },
  });

  try {
    runner.start({ projectId: 77, concurrency: 1, assignment: assignmentForStateTask('w-77') });
    await waitFor(() => runner.status(77)?.status === 'completed');
    assert.equal(captured.length, 1, 'worker must still spawn despite resolver throwing');
    const { prompt } = captured[0];
    assert.ok(!prompt.includes('launch_spec_installation='),
      'throwing resolver must fall back to legacy (no launch_spec_installation)');
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('pinned launch spec fails closed when a required package skill is absent', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a6-strict-spec-'));
  const captured = [];
  const states = new Map();
  states.set(STATE_TASK_ID, {
    id: STATE_TASK_ID, status: 'todo', title: 'strict pinned task',
    task_kind: 'discovery.work', workflow_stage: 'discovery', execution_mode: 'tracker_only',
    __skill: 'saga-discovery-worker',
  });

  // Slice 1: when launch() throws (strict pinned skill missing), pump()'s
  // catch calls markExecutionSpawnFailed(this.dbPath, ...) which writes to
  // worker_executions. The other tests never hit that catch (they spawn
  // successfully); this one does. So it needs a real saga.db carrying the
  // worker_executions + tasks tables, plus a non-empty workerExecutionId with
  // a matching reserved row. Pattern mirrors tests/dispatcher-race/parallel-
  // concurrency.mjs (SCHEMA_SQL bootstrap).
  const { SCHEMA_SQL } = await import('../dist/schema.js');
  const Database = (await import('better-sqlite3')).default;
  const dbPath = path.join(temp, 'saga.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  // A project/epic/task + reserved worker_execution so markExecutionSpawnFailed
  // has a row to flip and the foreign keys resolve.
  db.prepare("INSERT INTO projects (id, name) VALUES (78, 'strict-proj')").run();
  db.prepare("INSERT INTO epics (id, project_id, name) VALUES (1, 78, 'strict-epic')").run();
  db.prepare(
    "INSERT INTO tasks (id, epic_id, title, status) VALUES (?, 1, 'strict pinned task', 'todo')",
  ).run(STATE_TASK_ID);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, phase, state)
     VALUES ('exec-w-78', 'test-run', 78, 1, ?, 'w-78', 'test-host', 'executing', 'reserved')`,
  ).run(STATE_TASK_ID);
  db.close();

  const runner = makeRunner({
    temp,
    captured,
    states,
    claimedFlag: { value: false },
    recoverAssignment: () => {},
    resolveLaunchSpec: () => ({
      installationId: 91,
      strictResources: true,
      role: {
        executionSkill: 'saga-discovery-worker',
        semanticSkill: 'saga-discovery-worker',
        reviewSkill: null,
        protocolSkill: 'saga-process-module-worker-protocol',
      },
      resolveSkill: () => null,
      allowedToolIds: [],
    }),
  });

  try {
    // Non-empty workerExecutionId so markExecutionSpawnFailed resolves the
    // reserved row created above (the spawn-failed path needs a real fence).
    const assignment = assignmentForStateTask('w-78');
    assignment.workerExecutionId = 'exec-w-78';
    assignment.fenceToken = 'exec-w-78';
    runner.start({ projectId: 78, concurrency: 1, assignment });
    await waitFor(() =>
      /PINNED_SKILL_NOT_RESOLVED/.test(runner.status(78)?.last_error ?? ''),
    );
    assert.equal(captured.length, 0, 'worker must not spawn with a missing pinned skill');
    assert.match(
      runner.status(78)?.last_error ?? '',
      /PINNED_SKILL_NOT_RESOLVED/,
    );
  } finally {
    runner.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});
