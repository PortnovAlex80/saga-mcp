// tests/matrix/f-authority-delivery.test.mjs
//
// STAGE-16 SPACE F — authority delivery (shape S5, the DELIVERY axis).
//
// Spaces A–E enumerate the DECISION axis: does a gate resolve/narrow/
// contradict/lose/progress correctly? Every gate in the stage-15 scope
// incident decided CORRECTLY — the fence rejected rightly, the trajectory
// classifier fired rightly, contention granted rightly. The defect class
// this space enumerates lives one axis over:
//
//   For every authority the factory computes, does the actor BOUND by it
//   receive it BEFORE acting — or only as a rejection afterwards?
//
// The stage-11 blindsight census named this shape exactly ("the factory
// writes the right information and fails to deliver it to the point of
// decision") and it was not carried into the matrix until W-F1 forced it.
//
// LIVE GROUND TRUTH (stage-15 run, verified):
//   - tracker-view/claude-runner.mjs (the prompt builder): ZERO occurrences
//     of changeScopes / widening / effectiveScopes.
//   - the implementation-worker-checklist template names the constraint
//     ("lies inside this item's frozen changeScopes") and even teaches the
//     lawful exit — but never prints the VALUES (byte-identical 2938-byte
//     template across every workplace; no interpolation).
//   - the desk's node-execution doc carries no changeScopes.
//   => the only carrier of actual scope VALUES on the worker path is the
//     path-outside-authority REJECTION message. A rejection is not a
//     delivery channel: the only way to learn the constraint is to violate
//     it first. That is finding F-α1 regardless of run convergence.
//
// Findings, not fixes (brief §2). Flip-on-fix: the honest pins break the
// moment delivery lands (prompt gains scope values / the checklist gains
// interpolation) — then this registry is updated in the same commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = relative => readFileSync(join(repoRoot, relative), 'utf8');

const PROMPT_BUILDER = 'tracker-view/claude-runner.mjs';
const ASSIGNMENT = 'src/lifecycle/work-assignment-core.ts';
const CHECKLIST = 'src/process-modules/modules/development/package/resources/implementation-worker-checklist.md';
const SCOPE_PROVIDER = 'src/modules/development/application/development-check-providers.ts';

const FINDINGS = [
  {
    id: 'F-α1',
    severity: 'high',
    authority: 'changeScopes VALUES (the original carve)',
    claim: 'the worker is ordered to obey a value it is never shown: the prompt builder and the assignment seam carry zero scope vocabulary; the checklist names the constraint and teaches the exit but prints no values; the only carrier of the values is the path-outside-authority rejection message',
    home: 'tracker-view/claude-runner.mjs:109 (buildPrompt — the delivery point) — the re-staffed work order must carry the effective authority values; until then the rejection suffix remains the only channel',
  },
  {
    id: 'F-α2',
    severity: 'high',
    authority: 'changeScopes EFFECTIVE (post-widening)',
    claim: 'no freshness: even if the original values were delivered, a mid-cell widening grant changes the authority and nothing re-delivers it — the re-staffed worker keeps the first-staffing view (verified live: grant rev 1 at 12:50:54Z, card still original, round 4 passed only because the worker happened to redo the taught work)',
    home: 'tests/matrix/widening-worker-visibility.test.mjs (W-F1) — the freshness drive lives there; this registry references it',
  },
  {
    id: 'F-α3',
    severity: 'medium',
    authority: 'the check plan (the judgment the material will face)',
    claim: 'the checklist TRANSCRIBES the gate\'s rules by hand (the exact-set diff rule, the base-commit rule, the factory-managed exclusions) — a manual copy of a derived authority: if the plan changes, the copy goes stale silently',
    home: 'src/process-modules/modules/development/package/resources/implementation-worker-checklist.md vs src/modules/development/application/development-check-providers.ts:717-917 — the transcription should be derived from the check plan, not hand-maintained',
  },
  {
    id: 'F-α4',
    severity: 'low',
    authority: 'recovery budget / attempt number',
    claim: 'the worker never learns its attempt number or remaining budget — the prompt mentions attempts only inside repair feedback text ("wastes a repair attempt"), so a first-staffing author cannot know the price of a wasted round',
    home: 'tracker-view/claude-runner.mjs:337 (feedback text) — the assignment carries token/retry budgets for BINDING validation only (work-assignment-core.ts:234-237), never as delivered text',
  },
];

test('space F — F1/F2/F6: the authority-delivery table (enumerated from code, honest current state)', () => {
  const promptBuilder = src(PROMPT_BUILDER);
  const assignment = src(ASSIGNMENT);
  const checklist = src(CHECKLIST);
  const provider = src(SCOPE_PROVIDER);

  // DELIVERED authorities (the positive contrast — delivery exists where the
  // blindsight trees fixed it):
  // 1. Prior review findings: recovery memory materialization + journal.
  assert.match(assignment, /materializeTaskRecoveryMemory/, 'recovery memory materialization must exist (work-assignment-core)');
  assert.match(assignment, /recovery\.memory_delivered/, 'the delivery must be journalled');
  // 2. The rejected attempt's code: the patch is delivered LOUDLY.
  assert.match(promptBuilder, /previous_attempt_patch=/, 'previous-attempt patch path must be delivered (claude-runner)');
  assert.match(promptBuilder, /Address EVERY finding in that file/, 'the findings file must be pointed at');
  // 3. Allowed tools: runtime enforcement translates the deny list.
  const shim = src('tools/agent-proxy/claude-shim.mjs');
  assert.match(shim, /OPENCODE_PERMISSION/, 'the shim must enforce the tool deny list at call time');

  // NOT DELIVERED (honest current behavior — the findings):
  // The prompt builder has NO authority-value vocabulary at all.
  for (const word of ['changeScopes', 'widening', 'effectiveScopes', 'acceptanceCriterionIds']) {
    assert.ok(!promptBuilder.includes(word),
      `honest behavior: the prompt builder does not deliver '${word}' — if this fails, delivery landed; update the registry`);
  }
  // The checklist names the constraint and teaches the exit...
  assert.match(checklist, /frozen `changeScopes`/, 'the checklist names the constraint');
  assert.match(checklist, /Scope insufficiency is a lawful exit/, 'the checklist teaches the lawful exit');
  // ...but prints no VALUES: the template has no interpolation and no
  // per-task value slots (byte-identical across workplaces, live-verified).
  // (The `[<the honestly needed paths/dirs>]` inside the lawful-exit
  // TEACHING sentence is a placeholder the worker fills, not a delivered
  // authority value — excluded explicitly.)
  assert.ok(!/\$\{item|item\.changeScopes|frozen changeScopes:\s*\[/.test(checklist),
    'honest behavior: the checklist template carries no authority values (no interpolation) — finding F-α1');
  // The rejection message is the ONLY value carrier on the worker path.
  assert.match(provider, /outside frozen changeScopes \[\$\{effectiveScopes\.join/, 'the rejection prints the values (the only carrier)');

  // eslint-disable-next-line no-console
  console.log([
    '[space F] authority → actor → channel → delivered pre-act → fresh',
    '  changeScopes values      impl author   checklist names it, prompt omits it        NO   —  F-α1',
    '  changeScopes effective   impl author   none                                          NO   —  F-α2 (W-F1)',
    '  allowed tools            worker        runtime enforcement (shim deny) + rules    at call time (enforced)',
    '  check plan               impl author   hand-transcribed into the checklist       partial (stale risk) — F-α3',
    '  acceptance criteria      impl author   workspace file, discoverable, undirected  yes (undirected)',
    '  prior review findings    author/rev    recovery memory + LOUD delivery           YES',
    '  rejected attempt code    author        previous_attempt_patch on the desk       YES',
    '  recovery budget/attempts author        binding validation only, never as text   NO  —  F-α4',
  ].join('\n'));
});

test('space F — F4: freshness is covered by the W-F1 drive (cross-pin)', () => {
  const w = src('tests/matrix/widening-worker-visibility.test.mjs');
  assert.match(w, /post-grant worker that self-limits/, 'the W-F1 freshness drive must exist');
  assert.match(w, /readEffectiveChangeScopes/, 'the drive must use the production effective-scopes port');
});

test('space F — F5: the negative — a rejection message is not a delivery channel', () => {
  const promptBuilder = src(PROMPT_BUILDER);
  const checklist = src(CHECKLIST);
  const provider = src(SCOPE_PROVIDER);
  // The constraint values exist in exactly one worker-reachable place: the
  // rejection. Violation-first discovery. This is a finding EVEN THOUGH the
  // stage-15 run converged (round 4 passed): convergence depended on the
  // worker re-attempting the taught work, not on knowing the authority.
  const valuesInPrompt = /\[.*(?:changeScopes|scopes).*\]/.test(promptBuilder);
  const valuesInChecklist = /\$\{item|frozen changeScopes:\s*\[/.test(checklist);
  const valuesInRejection = provider.includes('outside frozen changeScopes [${effectiveScopes.join');
  assert.ok(!valuesInPrompt && !valuesInChecklist,
    'values are (unexpectedly) delivered pre-act — findings F-α1/F-α2 changed; update the registry');
  assert.ok(valuesInRejection, 'the rejection must remain identifiable as the sole value carrier for this pin to mean anything');
});

test('space F — registry well-formed (findings, not fixes)', () => {
  assert.equal(FINDINGS.length, 4);
  for (const finding of FINDINGS) {
    assert.ok(finding.id && finding.authority && finding.claim && finding.severity);
    assert.match(finding.home, /\.mjs|\.ts:\d+|\.md/, `${finding.id} must cite its home`);
  }
});
