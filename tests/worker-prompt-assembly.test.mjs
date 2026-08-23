// tests/worker-prompt-assembly.test.mjs
//
// Stage-6 TASK G1 — prove the worker prompt assembler does what it claims.
//
// tracker-view/claude-runner.mjs buildPrompt() is ~330 load-bearing lines that
// construct EVERY instruction a real model worker receives. The scripted
// executor proves the factory's physics but says nothing about these
// instructions; this suite pins the five guarantees the factory's liveness and
// completion story depends on, so they cannot drift silently:
//
//   1. the heartbeat rule (both variants, by Bash grant);
//   2. worker_next is named as explicitly disabled;
//   3. execution_id is rendered into every rule that mentions it;
//   4. pinned skills come from the installation's resolver, never from a
//      global skill root;
//   5. NO merge instruction for ANY execution mode — the factory owns
//      integration (stage-8, defect A: the merge grant was removed; the old
//      git_change-review rule-7 variant instructed a tool workers no longer
//      hold).
//
// Plus rule 6a (worker-done-call.json is not a tool call) — the instruction
// the G2.3 disobedience scenario leans on.
//
// The builder is a pure function (no spawn, no DB); the runner module has no
// import-time side effects, so it is imported directly.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPrompt, projectTaskForPrompt } from '../tracker-view/claude-runner.mjs';

const GLOBAL_ROOT_THAT_MUST_NOT_APPEAR = 'C:/DEFINITELY-NOT-USED-GLOBAL-SKILL-ROOT';

function makeFixture(overrides = {}) {
  const skillDir = mkdtempSync(join(tmpdir(), 'g1-prompt-skills-'));
  const writeSkill = (name, marker) => {
    const p = join(skillDir, `${name}.md`);
    writeFileSync(p, `G1-MARKER:${marker}\nDo the work per this skill.\n`);
    return p;
  };
  writeSkill('protocol-skill', 'protocol-from-installation');
  writeSkill('semantic-skill', 'semantic-from-installation');
  writeSkill('reviewer-skill', 'reviewer-from-installation');

  const launchSpec = {
    installationId: 'inst-g1-test',
    role: {
      protocolSkill: 'protocol-skill',
      semanticSkill: 'semantic-skill',
      reviewSkill: 'reviewer-skill',
    },
    allowedToolIds: ['Bash', 'Read', 'Write', 'Edit'],
    resolveSkill: (name) => join(skillDir, `${name}.md`),
    ...(overrides.launchSpec ?? {}),
  };
  const task = {
    id: 77,
    status: 'in_progress',
    task_kind: 'development.implement',
    workflow_stage: 'solution-development',
    execution_mode: 'git_change',
    tags: '[]',
    ...(overrides.task ?? {}),
  };
  const prompt = buildPrompt({
    assignment: {
      execution_id: 'exec-g1-0001',
      skill: 'semantic-skill',
      repository: { name: 'widgets' },
      task,
    },
    project: { id: 3, name: 'Widgets' },
    workerId: 'worker-g1',
    workspaceRoot: 'C:/tmp/g1-workspace',
    sagaSkillRoot: GLOBAL_ROOT_THAT_MUST_NOT_APPEAR,
    resolvedProfile: null,
    processWorkspace: overrides.processWorkspace ?? null,
    launchSpec,
  });
  return { prompt, skillDir };
}

test('G1.1 — heartbeat rule: model owns it when Bash is granted, runtime owns it otherwise', () => {
  const { prompt, skillDir } = makeFixture();
  try {
    assert.ok(prompt.includes(
      '0. IMMEDIATELY on startup, before any other action, run this heartbeat command exactly once (it marks you as alive for the operator):',
    ), 'hard rule 0 header must appear verbatim when Bash is granted');
    assert.ok(prompt.includes(
      `   bash -c 'echo "$(date -u +%FT%TZ) pid=$$ worker=worker-g1 project=3 task=77 CLAIMED started" >> ~/.zcode/cli/worker-heartbeat.log'`,
    ), 'the heartbeat command must render worker/project/task ids exactly');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }

  const noBash = makeFixture({ launchSpec: { allowedToolIds: ['Read'] } });
  try {
    assert.ok(noBash.prompt.includes(
      '0. Runtime owns the operator heartbeat. Do not invoke Bash or another undeclared native tool for heartbeat.',
    ), 'the runtime-owns variant must appear when Bash is not granted');
    assert.ok(!noBash.prompt.includes('worker-heartbeat.log'),
      'no heartbeat command may be offered to a profile without Bash');
  } finally {
    rmSync(noBash.skillDir, { recursive: true, force: true });
  }
});

test('G1.2 — worker_next is named as explicitly disabled', () => {
  for (const fixture of [makeFixture(), makeFixture({ launchSpec: { allowedToolIds: ['Read'] } })]) {
    try {
      assert.ok(fixture.prompt.includes(
        '2. Never call worker_next; it is explicitly disabled for this process.',
      ), 'the worker_next prohibition must be stated verbatim in every prompt');
    } finally {
      rmSync(fixture.skillDir, { recursive: true, force: true });
    }
  }
});

test('G1.3 — execution_id is rendered into every rule that mentions it', () => {
  const { prompt, skillDir } = makeFixture();
  try {
    assert.ok(prompt.includes('execution_id=exec-g1-0001'), 'the header must render execution_id');
    assert.ok(prompt.includes(
      '8a. Include execution_id="exec-g1-0001" in worker_done, verification_record, worker_ask_need, and worker_ask_done.',
    ), 'rule 8a must render the value and name the four granted protocol tools');
    // Stage-8 (defect A): the merge tools left the worker protocol — rule 8a
    // must no longer name them, and the prompt must not instruct any merge.
    assert.ok(!prompt.includes('worker_merge_acquire') && !prompt.includes('worker_merge_release'),
      'the prompt must not name the fenced merge tools (stage-8 defect A removal)');
    assert.ok(prompt.includes('worker_done exactly once with a truthful result and execution_id="exec-g1-0001"'),
      'rule 6 (non-review) must append the rendered execution_id');
    const review = makeFixture({ task: { status: 'review' } });
    try {
      assert.ok(review.prompt.includes('verdict approved or changes_requested and execution_id="exec-g1-0001"'),
        'rule 6 (review variant) must append the rendered execution_id');
      assert.ok(review.prompt.includes(
        `9. Before worker_done, call verification_record only for the task's canonical AC with recorded_by="worker-g1", execution_id="exec-g1-0001", and truthful pass/fail evidence.`,
      ) === false || review.prompt.includes('execution_id="exec-g1-0001"'),
      'verification_record rule renders the value when present');
    } finally {
      rmSync(review.skillDir, { recursive: true, force: true });
    }
    const verification = makeFixture({ task: { task_kind: 'verification.ac' } });
    try {
      assert.ok(verification.prompt.includes(
        `9. Before worker_done, call verification_record only for the task's canonical AC with recorded_by="worker-g1", execution_id="exec-g1-0001", and truthful pass/fail evidence.`,
      ), 'rule 9 (verification.ac) must render workerId and execution_id');
    } finally {
      rmSync(verification.skillDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('G1.4 — skills resolve from the pinned installation, never a global skill root', () => {
  const { prompt, skillDir } = makeFixture();
  try {
    assert.ok(prompt.includes('--- PROTOCOL SKILL BEGIN'), 'protocol skill section present');
    assert.ok(prompt.includes('G1-MARKER:protocol-from-installation'),
      'the protocol skill BODY from the installation store must be inlined');
    assert.ok(prompt.includes('G1-MARKER:semantic-from-installation'),
      'the semantic skill BODY from the installation store must be inlined');
    assert.ok(prompt.includes('launch_spec_installation=inst-g1-test'),
      'the installation id must be stated in the header');
    assert.ok(!prompt.includes(GLOBAL_ROOT_THAT_MUST_NOT_APPEAR),
      'no global skill root may leak into the prompt — resolution is launchSpec.resolveSkill only');

    // Review tasks inline the REVIEWER skill in place of the author semantic.
    const review = makeFixture({ task: { status: 'review' } });
    try {
      assert.ok(review.prompt.includes('--- REVIEWER SKILL BEGIN (review role — what to verify) ---'),
        'review tasks get the reviewer section');
      assert.ok(review.prompt.includes('G1-MARKER:reviewer-from-installation'),
        'the reviewer skill body from the installation store must be inlined');
      assert.ok(!review.prompt.includes('G1-MARKER:semantic-from-installation'),
        'the author semantic skill must NOT be inlined for a review task');
    } finally {
      rmSync(review.skillDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('G1.5 — NO merge instruction for ANY execution mode; the factory owns integration', () => {
  // INVERTED in stage-8 (defect A, G3 §9): the merge grant was removed, so
  // the prompt must never instruct a merge or name the merge tools. The old
  // assertion pinned the git_change-review merge variant; it now pins its
  // ABSENCE for every mode.
  const MERGE_INSTRUCTION = 'first acquire the repository merge lock, merge into the assigned integration branch, call worker_merge_release';
  const FACTORY_OWNS = '7. After worker_done returns stop:true, do not claim another task; the factory owns integration (merge/push are fenced Factory effects — never do them yourself); finish any required terminal protocol, then return a concise summary and exit.';

  for (const mode of ['git_change', 'tracker_only', 'read_only_evidence', 'artifact_change']) {
    for (const status of ['review', 'in_progress']) {
      const fixture = makeFixture({ task: { status, execution_mode: mode } });
      try {
        assert.ok(!fixture.prompt.includes(MERGE_INSTRUCTION),
          `execution_mode=${mode}/${status} must NOT receive the merge instruction`);
        assert.ok(!fixture.prompt.includes('worker_merge_acquire') && !fixture.prompt.includes('worker_merge_release'),
          `execution_mode=${mode}/${status} must not name the fenced merge tools`);
        assert.ok(fixture.prompt.includes(FACTORY_OWNS),
          `execution_mode=${mode}/${status} must receive the factory-owns-integration rule 7`);
      } finally {
        rmSync(fixture.skillDir, { recursive: true, force: true });
      }
    }
  }
});

test('G1 (bonus pin) — rule 6a states that worker-done-call.json is not a tool call', () => {
  const { prompt, skillDir } = makeFixture();
  try {
    assert.ok(prompt.includes(
      '6a. Completion requires invoking the actual mcp__saga__worker_done tool and receiving an accepted stop:true receipt. Writing, printing, or reading worker-done-call.json is NOT a tool call and MUST NOT be followed by process exit.',
    ), 'rule 6a is the instruction the G2.3 file-faking disobedience test leans on');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLINDSIGHT Worker/Tool layer — feedback must be DELIVERED LOUDLY to the
// point of decision (the worker prompt), not buried in workspace_files JSON.
// Mirrors the ⚠️ REPAIR ATTEMPT block the gate feedback already gets.
// ---------------------------------------------------------------------------

/** Minimal WorkplaceDesk-shaped processWorkspace for delivery tests. */
function makeDesk(overrides = {}) {
  return {
    workplaceRef: 'wp-g1',
    nodeId: 'author',
    profileId: 'author-profile',
    moduleRef: 'test-module@1.0.0',
    trackerPath: 'docs/development/projects/1/executions/node-author/tracker.md',
    trackerAbsolutePath: 'C:/tmp/g1-workspace/docs/development/tracker.md',
    executionDirectory: 'docs/development/projects/1/executions/node-author/exec-g1-0001',
    callFiles: [],
    checklists: [],
    workspaceFiles: [],
    recoveryFeedback: { present: false, path: null, reasons: [] },
    reviewFeedback: { present: false, path: null, round: 0, reasons: [] },
    feedbackHistory: { present: false, path: null, rounds: 0, reviewRejections: 0, submissionRejections: 0 },
    priorAttempts: { count: 0, deaths: [] },
    agentAssistance: { required: false, path: null },
    ...overrides,
  };
}

test('G1.6 — review feedback is delivered as a LOUD block with verbatim key points, not buried in workspace_files', () => {
  const reviewDesk = makeDesk({
    workspaceFiles: ['docs/development/exec-1/review-feedback.json'],
    reviewFeedback: {
      present: true,
      path: 'docs/development/exec-1/review-feedback.json',
      round: 2,
      reasons: [
        'AC-2 verification step is missing: no assertion that the merge rejects conflicting keys',
        'src/merge.ts:42 handles null input by crashing instead of returning a typed error',
      ],
    },
  });
  const { prompt, skillDir } = makeFixture({ processWorkspace: reviewDesk });
  try {
    // The loud header must mirror the gate-feedback pattern so the worker
    // physically cannot miss it.
    assert.ok(prompt.includes('⚠️⚠️⚠️ REVIEW REJECTION — THE REVIEWER SENT YOUR PREVIOUS WORK BACK'),
      'a review rejection must produce a loud ⚠️ header block');
    assert.ok(prompt.includes('review_feedback=docs/development/exec-1/review-feedback.json'),
      'the review feedback path must be stated as its own line');
    assert.ok(prompt.includes('READ docs/development/exec-1/review-feedback.json FIRST'),
      'the worker must be ordered to read the feedback file first');
    assert.ok(prompt.includes('review rejection round 2'),
      'the block must state which rejection round is being repaired');
    // Inline verbatim key points — the semantic content, delivered.
    assert.ok(prompt.includes("The reviewer's key points, quoted verbatim from that file:"),
      'the block must announce the verbatim key points');
    assert.ok(prompt.includes('1. AC-2 verification step is missing: no assertion that the merge rejects conflicting keys'),
      'key point 1 must be inlined verbatim');
    assert.ok(prompt.includes('2. src/merge.ts:42 handles null input by crashing instead of returning a typed error'),
      'key point 2 must be inlined verbatim');
    assert.ok(prompt.includes('Address EVERY reviewer point before resubmitting'),
      'the block must demand every point be addressed');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('G1.6b — no review block when the review accepted the work (first pass)', () => {
  const { prompt, skillDir } = makeFixture({ processWorkspace: makeDesk() });
  try {
    assert.ok(!prompt.includes('REVIEW REJECTION'),
      'a first-pass author must not see a review rejection block');
    assert.ok(!prompt.includes('⚠️'));
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('G1.7 — full feedback history is pointed at in the prompt (history depth > 1 round)', () => {
  const historyDesk = makeDesk({
    reviewFeedback: {
      present: true,
      path: 'docs/development/exec-1/review-feedback.json',
      round: 3,
      reasons: ['round-3 point'],
    },
    feedbackHistory: {
      present: true,
      path: 'docs/development/exec-1/feedback-history.json',
      rounds: 5,
      reviewRejections: 3,
      submissionRejections: 2,
    },
  });
  const { prompt, skillDir } = makeFixture({ processWorkspace: historyDesk });
  try {
    assert.ok(prompt.includes('feedback_history=docs/development/exec-1/feedback-history.json'),
      'the materialized feedback-history.json path must be stated as its own line');
    assert.ok(prompt.includes('5 feedback event(s) across ALL rounds (3 review rejection(s), 2 submission validation rejection(s))'),
      'the block must summarize the accumulated history size');
    assert.ok(prompt.includes(
      'Prior rounds may contain findings that were never addressed; read the full history before resubmitting.',
    ), 'the worker must be pointed at the FULL history, not just the latest round');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('G1.8 — spawn prompt carries the card death history (prior attempts + last failure)', () => {
  const deathDesk = makeDesk({
    priorAttempts: {
      count: 3,
      deaths: [
        {
          executionId: 'exec-g1-0001-prev1',
          state: 'spawn_failed',
          lastError: 'Claude spawn failed (pre-assigned): ENOENT claude',
          finishedAt: '2026-08-17 01:00:00',
          workerId: 'worker-a',
        },
        {
          executionId: 'exec-g1-0001-prev2',
          state: 'lost',
          lastError: 'REPEATED_TOOL_LOOP: Write repeated 12 times with identical input',
          finishedAt: '2026-08-17 02:00:00',
          workerId: 'worker-b',
        },
        {
          executionId: 'exec-g1-0001-prev3',
          state: 'terminated',
          lastError: 'progress silence past cancel grace',
          finishedAt: '2026-08-17 03:00:00',
          workerId: 'worker-c',
        },
      ],
    },
  });
  const { prompt, skillDir } = makeFixture({ processWorkspace: deathDesk });
  try {
    assert.ok(prompt.includes('PRIOR ATTEMPTS ON THIS CARD: 3'),
      'the spawn prompt must open with the number of prior dead executions');
    assert.ok(prompt.includes('REPEATED_TOOL_LOOP: Write repeated 12 times with identical input'),
      'the last_error of a dead execution (incl. REPEATED_TOOL_LOOP) must be delivered in the prompt');
    assert.ok(prompt.includes('[lost]'),
      'each death must carry its terminal state');
    assert.ok(prompt.includes(
      'A card whose previous workers died is NOT a healthy card: read the failures above',
    ), 'the block must tell the worker the card is known to kill workers');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }

  // Healthy card: no prior deaths → no block, no noise.
  const fresh = makeFixture({ processWorkspace: makeDesk() });
  try {
    assert.ok(!fresh.prompt.includes('PRIOR ATTEMPTS ON THIS CARD'),
      'a card with zero prior deaths must not carry a death-history block');
  } finally {
    rmSync(fresh.skillDir, { recursive: true, force: true });
  }
});

test('G1.6 — BLINDSIGHT X2: prior-attempt memory is delivered LOUDLY in the prompt', () => {
  // A task whose metadata carries the materialized recovery memory (see
  // src/lifecycle/task-recovery-memory.ts) must surface it as an unmissable
  // block in the spawn prompt — the census X2 finding was workers starting
  // every retry from a blank context while the history sat unread in the DB.
  const metadata = JSON.stringify({
    process_run_id: 42,
    attempt_count: 2,
    hint: 'AC-NFR-1 needs Vite bundle analysis; watch vendor/three.js',
    previous_failures: [
      'Lighthouse=78 (need >=80); vendor-three.js 612KB in entry chunk',
      'axe=5 violations: missing form labels',
    ],
    attempt_history: [
      { attempt: 1, kind: 'recovery_note', recovery_summary: 'Lighthouse=78 (need >=80); vendor-three.js 612KB in entry chunk' },
      { attempt: 2, kind: 'recovery_note', recovery_summary: 'axe=5 violations: missing form labels' },
    ],
  });
  const fixture = makeFixture({ task: { metadata } });
  try {
    assert.ok(fixture.prompt.includes('PRIOR ATTEMPTS'),
      'the loud prior-attempts header must appear when attempt_count > 0');
    assert.ok(fixture.prompt.includes('hint=AC-NFR-1 needs Vite bundle analysis; watch vendor/three.js'),
      'the hint must be quoted verbatim');
    assert.ok(fixture.prompt.includes('Lighthouse=78 (need >=80); vendor-three.js 612KB in entry chunk'),
      'every previous_failures entry must be quoted verbatim');
    assert.ok(fixture.prompt.includes('axe=5 violations: missing form labels'),
      'all failure entries are delivered, not just the first');
  } finally {
    rmSync(fixture.skillDir, { recursive: true, force: true });
  }

  // Negative: a task with no attempt history gets NO block (fresh tasks must
  // not be polluted with recovery noise).
  const fresh = makeFixture({ task: { metadata: JSON.stringify({ process_run_id: 42 }) } });
  try {
    assert.ok(!fresh.prompt.includes('PRIOR ATTEMPTS'),
      'fresh tasks must not carry the prior-attempts block');
  } finally {
    rmSync(fresh.skillDir, { recursive: true, force: true });
  }

  // Corrupt metadata must not break prompt assembly (fail-soft delivery).
  const corrupt = makeFixture({ task: { metadata: '{not json' } });
  try {
    assert.ok(!corrupt.prompt.includes('PRIOR ATTEMPTS'));
  } finally {
    rmSync(corrupt.skillDir, { recursive: true, force: true });
  }
});

// REPAIR-CODE-PRESERVATION — the prompt line that opens the author's eyes to
// the rejected attempt WITHOUT binding the author to it ("see it, but do not
// be bound": no auto-merge, no rebase, no `git apply`).
function makeRepairFixture(processWorkspace) {
  const skillDir = mkdtempSync(join(tmpdir(), 'g1-prompt-skills-'));
  writeFileSync(join(skillDir, 'protocol-skill.md'), 'G1-MARKER:protocol\n');
  writeFileSync(join(skillDir, 'semantic-skill.md'), 'G1-MARKER:semantic\n');
  writeFileSync(join(skillDir, 'reviewer-skill.md'), 'G1-MARKER:reviewer\n');
  const task = {
    id: 78,
    status: 'in_progress',
    task_kind: 'development.implement',
    workflow_stage: 'solution-development',
    execution_mode: 'git_change',
    tags: '[]',
  };
  const prompt = buildPrompt({
    assignment: {
      execution_id: 'exec-repair-0002',
      skill: 'semantic-skill',
      repository: { name: 'widgets' },
      task,
    },
    project: { id: 3, name: 'Widgets' },
    workerId: 'worker-g1',
    workspaceRoot: 'C:/tmp/g1-workspace',
    sagaSkillRoot: GLOBAL_ROOT_THAT_MUST_NOT_APPEAR,
    resolvedProfile: null,
    processWorkspace,
    launchSpec: {
      installationId: 'inst-g1-test',
      role: { protocolSkill: 'protocol-skill', semanticSkill: 'semantic-skill', reviewSkill: 'reviewer-skill' },
      allowedToolIds: ['Bash', 'Read', 'Write', 'Edit'],
      resolveSkill: (name) => join(skillDir, `${name}.md`),
    },
  });
  return { prompt, skillDir };
}

const REPAIR_WORKSPACE = {
  moduleRef: 'development@1.0.0',
  profileId: 'development-implementation-worker',
  trackerPath: 'docs/development/projects/3/executions/node-x/tracker.md',
  executionDirectory: 'docs/development/projects/3/executions/node-x/wp/exec-repair-0002',
  callFiles: [],
  checklists: [],
  workspaceFiles: [],
  recoveryFeedback: {
    present: true,
    path: 'docs/development/projects/3/executions/node-x/wp/exec-repair-0002/recovery-feedback.json',
    reasons: ['scope: the submission edits 373 lines outside the frozen item scope'],
  },
  reviewFeedback: { present: false, path: null },
  agentAssistance: { required: false, path: null },
};

test('G1-REPAIR — the prompt names previous-attempt.patch and forbids binding to it', () => {
  const { prompt, skillDir } = makeRepairFixture({
    ...REPAIR_WORKSPACE,
    previousAttempt: {
      branch: 'saga/task/78/execution/abc123def45678901234',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      patchPath: 'docs/development/projects/3/executions/node-x/wp/exec-repair-0002/previous-attempt.patch',
      descriptorPath: 'docs/development/projects/3/executions/node-x/wp/exec-repair-0002/previous-attempt.json',
    },
  });
  try {
    assert.ok(prompt.includes(
      'docs/development/projects/3/executions/node-x/wp/exec-repair-0002/previous-attempt.patch',
    ), 'the patch path is delivered to the decision point (the prompt)');
    assert.ok(prompt.includes('A previous repair attempt EXISTS'),
      'the one-line existence statement is present');
    assert.ok(/see it, but do NOT be bound/i.test(prompt),
      'the see-but-not-bound rule is stated');
    assert.ok(!prompt.includes('git apply'),
      'the prompt must never instruct applying the patch (no auto-merge of the rejected attempt)');
    assert.ok(!prompt.includes('git merge') && !prompt.includes('git rebase'),
      'no merge/rebase of the previous attempt may be suggested');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }

  const bare = makeRepairFixture(REPAIR_WORKSPACE);
  try {
    assert.ok(!bare.prompt.includes('previous-attempt.patch'),
      'a first-pass desk (no previous attempt) must not mention the patch');
  } finally {
    rmSync(bare.skillDir, { recursive: true, force: true });
  }
});

// ── STAGE-18 TASK 1 (R1): the write authority is DELIVERED to the worker ────
//
// Found live in the stage-15 run: the widening grant for tsconfig.json was
// recorded at 12:50:54 and the re-staffed worker was never told — it
// self-limited to the original carve, dropped the file, and the author gate
// accepted (the silent surrender). The worker's scopes — original or widened —
// appeared nowhere on the prompt path (claude-runner.mjs had ZERO scope
// vocabulary; the checklist names the constraint but prints no values).
//
// The rule under test: the prompt states the task's EFFECTIVE write authority
// — the frozen carve plus every granted widening, resolved at staffing time —
// as an authority, not a hint. And the negative that outlives this fix: for a
// task that HAS scopes, the prompt may never be empty of them.

test('STAGE-18 R1 RED: the prompt states the task\'s effective write authority (scopes delivered, not implied)', () => {
  const metadata = JSON.stringify({
    process_run_id: 7,
    cell_input_item: { key: 'imp-1', changeScopes: ['package.json', 'aaa/'] },
  });
  const fixture = makeFixture({
    task: {
      id: 77,
      metadata,
      // Resolved at staffing (T1.2): the frozen carve plus granted widenings,
      // computed through the same effective-scope reader the check provider
      // uses. No grant yet → identical to the carve.
      effective_change_scopes: ['package.json', 'aaa/'],
    },
  });
  try {
    assert.match(fixture.prompt, /WRITE AUTHORITY/i,
      'the prompt must carry an authority section for the write scopes');
    assert.ok(fixture.prompt.includes('aaa/'),
      'the scope VALUES must be delivered, not the constraint\'s name');
    assert.match(fixture.prompt, /are yours to (write|change)/i,
      'stated as an authority (these paths are yours), not a suggestion');
  } finally {
    rmSync(fixture.skillDir, { recursive: true, force: true });
  }
});

test('STAGE-18 R1 freshness: a worker staffed AFTER a grant sees the widened set', () => {
  const metadata = JSON.stringify({
    process_run_id: 7,
    cell_input_item: { key: 'imp-1', changeScopes: ['package.json', 'aaa/'] },
  });
  const fixture = makeFixture({
    task: {
      id: 77,
      metadata,
      // The stage-15 shape one grant later: the widened authority includes
      // paths OUTSIDE the original carve. The prompt must state the WIDENED
      // value (resolved at this staffing), not the stale carve.
      effective_change_scopes: ['package.json', 'aaa/', 'zzz/shared.config'],
    },
  });
  try {
    assert.ok(fixture.prompt.includes('zzz/shared.config'),
      'the widened path must reach the re-staffed worker — the grant that is not delivered does not exist for the worker');
    // The authority section must be the effective set: the widened path is
    // present AND presented as authority, not as an incidental mention.
    const authorityMatch = fixture.prompt.match(/WRITE AUTHORITY[^\n]*\n?[^\n]*/i);
    assert.ok(authorityMatch && fixture.prompt.slice(fixture.prompt.indexOf('WRITE AUTHORITY')).includes('zzz/shared.config'),
      'the widened path lives inside the authority statement');
  } finally {
    rmSync(fixture.skillDir, { recursive: true, force: true });
  }
});

test('STAGE-18 R1 negative: a task WITH scopes must never produce a prompt empty of them (no silent regression to zero)', () => {
  const metadata = JSON.stringify({
    process_run_id: 7,
    cell_input_item: { key: 'imp-1', changeScopes: ['package.json', 'aaa/'] },
  });
  // Both delivery shapes must stay non-empty: with a grant and without.
  // DELIVERED means inside the authority statement — the raw task dump
  // already carries the scopes as an escaped JSON string (found while
  // writing this test: 'aaa/' appears in the prompt today, buried in
  // metadata-in-JSON), and the stage-15 run proved the worker does not
  // read an escaped dump as authority. The assertion is therefore tied to
  // the authority section, not to byte-existence.
  for (const effective of [['package.json', 'aaa/'], ['package.json', 'aaa/', 'zzz/shared.config']]) {
    const fixture = makeFixture({
      task: { id: 77, metadata, effective_change_scopes: effective },
    });
    try {
      const headerAt = fixture.prompt.search(/WRITE AUTHORITY/i);
      assert.ok(headerAt >= 0, 'the authority section exists for a scope-bearing task');
      const section = fixture.prompt.slice(headerAt);
      const delivered = effective.filter(scope => section.includes(scope));
      assert.equal(delivered.length, effective.length,
        `every effective scope must appear INSIDE the authority section (delivered ${delivered.length}/${effective.length}) — the delivery may never silently regress to the escaped dump`);
    } finally {
      rmSync(fixture.skillDir, { recursive: true, force: true });
    }
  }
  // A task with NO scopes at all (non-implementation work) must not grow a
  // bogus empty authority section.
  const bare = makeFixture({});
  try {
    assert.ok(!/WRITE AUTHORITY/i.test(bare.prompt),
      'no scope-bearing task → no authority section (the section is earned by the scopes, not unconditional)');
  } finally {
    rmSync(bare.skillDir, { recursive: true, force: true });
  }
});

// F-A (Elite-3 post-mortem): per-layer prompt budget — the durable history
// stays on the task row, the prompt carries a bounded projection.
test('F-A: projectTaskForPrompt drops the history arrays, keeps the semantics, adds a digest pointer', async () => {
  const { projectTaskForPrompt } = await import('../tracker-view/claude-runner.mjs');
  const task = {
    id: 13,
    title: 'planner',
    metadata: JSON.stringify({
      process_node_input: { keep: 'me' },
      attempt_count: 2,
      hint: 'h',
      previous_failures: ['failure-one', 'failure-two'],
      attempt_history: [{ attempt: 1 }, { attempt: 2 }],
      process_workspace: { workspace_files: ['a'] },
    }),
  };
  const projected = projectTaskForPrompt(task);
  const meta = projected.metadata;
  assert.equal(meta.process_node_input.keep, 'me', 'semantic material is untouched');
  assert.equal(meta.hint, 'h');
  assert.equal('previous_failures' in meta, false, 'verbatim failures are not double-delivered');
  assert.equal('attempt_history' in meta, false, 'the 50x2000 history array is dropped');
  assert.equal('process_workspace' in meta, false, 'the workspace block is not re-delivered');
  assert.equal(meta.__history_pointer.previous_failures_total, 2);
  assert.equal(meta.__history_pointer.attempt_history_entries, 2);
  assert.match(meta.__history_pointer.digest, /^[0-9a-f]{16}$/, 'content digest preserves traceability');
  // The original task object is never mutated (pure projection).
  assert.ok(JSON.parse(task.metadata).previous_failures.length === 2);
  // Corrupt metadata fails soft: the legacy payload passes through.
  assert.equal(projectTaskForPrompt({ id: 1, metadata: '{nope' }).metadata, '{nope');
});

test('F-A: buildRecoveryMemoryBlock bounds verbatim failures to the most recent entries with a digest', async () => {
  const { buildRecoveryMemoryBlock, MAX_INLINE_PREVIOUS_FAILURES } = await import('../tracker-view/claude-runner.mjs');
  const failures = Array.from({ length: 12 }, (_, i) => `failure-${i}`);
  const block = buildRecoveryMemoryBlock({
    metadata: JSON.stringify({ attempt_count: 12, previous_failures: failures }),
  });
  assert.ok(block.includes(`failure-${11}`) && block.includes(`failure-${7}`),
    `the most recent ${MAX_INLINE_PREVIOUS_FAILURES} failures stay verbatim`);
  assert.ok(!block.includes('failure-6'), 'older failures are omitted from the prompt');
  assert.ok(block.includes(`of 12`), 'the total count is delivered');
  assert.match(block, /\+7 earlier failure\(s\) omitted/, 'the omission count is explicit');
  assert.match(block, /digest=[0-9a-f]{16}/, 'the omitted history is digest-traceable');
  assert.ok(block.includes('Full attempt log: task_get'),
    'the durable path to the complete history stays in the block');
});

// ---------------------------------------------------------------------------
// G1.9 — ELITE-8 prompt snowball: recovery_feedback is summarized, never
// projected whole.
//
// The Elite-8 acceptance-contract cell died 15 times to provider 400
// ("Prompt exceeds max length") because one verbose review round put
// 17 findings x ~10.7KB into task.metadata.recovery_feedback.issue.findings
// (202KB total) and projectTaskForPrompt trimmed attempt_history /
// previous_failures / process_workspace but projected recovery_feedback
// WHOLE into every respawn prompt (taskProjection 21,732B in Elite-7 ->
// 217,533B in Elite-8). The projection must bound this field the same way
// the history is bounded: codes and bounded heads survive, the bulk rides
// the durable pointer.
// ---------------------------------------------------------------------------

test('G1.9 — recovery_feedback is bounded in the task projection (ELITE-8 snowball shape)', () => {
  const finding = i => ({
    code: 'factory.review-verdict.v1:review-finding:unscoped',
    severity: 'error',
    message: `SYSTEMATIC ISSUE (finding ${i}): the acceptance criteria document's 'Derived From' sections `
      + 'and traceability claims diverge from the recorded artifact traces. '.repeat(120),
  });
  const task = {
    id: 7,
    title: 'formalization-acceptance-contract/author',
    metadata: {
      workplace_ref: 'workplace/2/solution-formalization@1.0.0/formalization-acceptance-contract/singleton',
      recovery_feedback: {
        schemaVersion: 'factory.production-cell-recovery-feedback.v1',
        taskId: 7,
        repairTargetRole: 'author',
        attempt: 2,
        maxAttempts: 5,
        gateDecision: { verdict: 'repair_required', gate_phase: 'review' },
        findingTrajectory: {
          chain: Array.from({ length: 17 }, (_, i) => ({
            count: i + 1,
            keys: Array.from({ length: i + 1 }, (_, j) =>
              `factory.review-verdict.v1:review-finding:unscoped::AC-${j + 1} claims derivation mismatch `.repeat(8)),
          })),
        },
        issue: {
          reasonCode: 'REVIEW_REJECTED',
          summary: 'derived-from traceability mismatches across the acceptance criteria',
          findings: Array.from({ length: 17 }, (_, i) => finding(i)),
        },
        rejectedCandidateSet: {
          candidateSetRef: 'candidate-set/2/.../singleton',
          candidateSetDigest: 'd'.repeat(64),
          role: 'author',
          subjectCandidateSetRef: 'candidate-set/2/.../subject',
          productRefs: [],
        },
      },
    },
  };

  const inputBytes = Buffer.byteLength(JSON.stringify(task.metadata.recovery_feedback), 'utf8');
  assert.ok(inputBytes > 150_000, `fixture must reproduce the ELITE-8 scale (got ${inputBytes}B)`);

  const projected = projectTaskForPrompt(task);
  const rf = projected.metadata.recovery_feedback;
  assert.ok(rf && typeof rf === 'object', 'recovery_feedback stays present (summarized, not dropped)');
  const outBytes = Buffer.byteLength(JSON.stringify(rf), 'utf8');
  assert.ok(outBytes < 12_000,
    `the summarized recovery_feedback must be bounded (input ${inputBytes}B -> output ${outBytes}B)`);
  // The essentials survive: what failed, why, and per-finding identity.
  assert.equal(rf.reasonCode, 'REVIEW_REJECTED');
  assert.equal(rf.attempt, 2);
  assert.equal(rf.maxAttempts, 5);
  assert.ok(Array.isArray(rf.findings) && rf.findings.length === 17, 'every finding stays identified');
  for (const f of rf.findings) {
    assert.equal(f.code, 'factory.review-verdict.v1:review-finding:unscoped');
    assert.ok(f.message.length <= 300, 'finding messages ride as bounded heads only');
  }
  // The bulk is pointed at, not silently lost.
  assert.match(JSON.stringify(rf), /task_get/,
    'the summary must point at the durable full feedback');
  // The other trims keep working.
  assert.equal(projected.metadata.attempt_history, undefined);
  assert.equal(projected.metadata.previous_failures, undefined);
  assert.equal(projected.metadata.process_workspace, undefined);
});

test('G1.9-neg — absent recovery_feedback adds no summary block', () => {
  const projected = projectTaskForPrompt({ id: 8, metadata: { workplace_ref: 'w/8' } });
  assert.equal(projected.metadata.recovery_feedback, undefined);
});
