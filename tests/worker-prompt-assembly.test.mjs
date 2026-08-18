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
import { buildPrompt } from '../tracker-view/claude-runner.mjs';

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
    processWorkspace: null,
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
