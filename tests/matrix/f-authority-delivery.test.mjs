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
// Findings, not fixes (brief §2). Flip-on-fix: F-α1/F-α2 flipped GREEN on
// 2026-08-20 when STAGE-18 R1 landed the claim-time delivery + the WRITE
// AUTHORITY prompt section — the registry below records the fixed state;
// F-α3/F-α4 remain open findings.

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
    status: 'FIXED 2026-08-20 (STAGE-18 R1): the claim-time delivery — findNextClaimable resolves effective scopes, the prompt renders the WRITE AUTHORITY section with the values',
    authority: 'changeScopes VALUES (the original carve)',
    claim: 'the worker was ordered to obey a value it was never shown: the prompt builder and the assignment seam carried zero scope vocabulary; the checklist named the constraint and taught the exit but printed no values; the only carrier of the values was the path-outside-authority rejection message',
    home: 'tracker-view/claude-runner.mjs (buildPrompt — the delivery point, now buildWriteAuthorityBlock)',
  },
  {
    id: 'F-α2',
    severity: 'high',
    status: 'FIXED 2026-08-20 (STAGE-18 R1): freshness by construction — the effective set is resolved at EVERY staffing through the widening ledger, so a post-grant re-staffing sees carve ∪ grants',
    authority: 'changeScopes EFFECTIVE (post-widening)',
    claim: 'no freshness: even if the original values were delivered, a mid-cell widening grant changed the authority and nothing re-delivered it — the re-staffed worker kept the first-staffing view (verified live: grant rev 1 at 12:50:54Z, card still original, round 4 passed only because the worker happened to redo the taught work)',
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

  // DELIVERED since STAGE-18 R1 (2026-08-20, fixed live findings F-α1/F-α2):
  // the claim resolves the effective write authority through the widening
  // ledger (the fence's read path) and the prompt renders it as a WRITE
  // AUTHORITY section with the VALUES, stated as authority.
  assert.match(promptBuilder, /WRITE AUTHORITY/,
    'the prompt builder must carry the authority section (R1)');
  assert.match(promptBuilder, /effective_change_scopes/,
    'the section is fed by the claim-time effective scopes, not a re-read of the carve');
  assert.match(promptBuilder, /are yours to (write|change)/i,
    'the scopes are stated as authority (these paths are yours), not a suggestion');
  // Still NOT delivered (honest current behavior — the remaining findings):
  // acceptance-criterion values have no prompt-channel vocabulary.
  for (const word of ['acceptanceCriterionIds']) {
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
    'honest behavior: the checklist template carries no authority values (no interpolation) — the value carrier is now the R1 prompt section');
  // The rejection message remains the at-fence (enforcement-time) value
  // carrier; the R1 prompt section is the pre-act carrier.
  assert.match(provider, /outside frozen changeScopes \[\$\{effectiveScopes\.join/, 'the rejection prints the values (the at-fence carrier)');

  // eslint-disable-next-line no-console
  console.log([
    '[space F] authority → actor → channel → delivered pre-act → fresh',
    '  changeScopes values      impl author   WRITE AUTHORITY prompt section (R1)      YES  at staffing (fixed F-α1)',
    '  changeScopes effective   impl author   claim resolves carve ∪ grants (R1)      YES  at staffing (fixed F-α2/W-F1)',
    '  allowed tools            worker        runtime enforcement (shim deny) + rules    at call time (enforced)',
    '  check plan               impl author   hand-transcribed into the checklist       partial (stale risk) — F-α3',
    '  acceptance criteria      impl author   workspace file, discoverable, undirected  yes (undirected)',
    '  prior review findings    author/rev    recovery memory + LOUD delivery           YES',
    '  rejected attempt code    author        previous_attempt_patch on the desk       YES',
    '  recovery budget/attempts author        binding validation only, never as text   NO  — F-α4',
  ].join('\n'));
});

test('space F — F4: freshness is covered by the W-F1 drive (cross-pin)', () => {
  const w = src('tests/matrix/widening-worker-visibility.test.mjs');
  assert.match(w, /post-grant worker that self-limits/, 'the W-F1 freshness drive must exist');
  assert.match(w, /readEffectiveChangeScopes/, 'the drive must use the production effective-scopes port');
});

test('space F — F5: the negative — a rejection message is not a delivery channel (the pre-act carrier must exist besides it)', () => {
  const promptBuilder = src(PROMPT_BUILDER);
  const checklist = src(CHECKLIST);
  const provider = src(SCOPE_PROVIDER);
  // Violation-first discovery was the F-α1 defect: the only way to learn the
  // constraint was to violate it first. FIXED by R1: the pre-act carrier is
  // the WRITE AUTHORITY prompt section. This pin now guards BOTH carriers:
  // the pre-act section must exist AND the rejection must stay identifiable
  // as the at-fence carrier (a repair that removes either changes this).
  const valuesInPrompt = /WRITE AUTHORITY/.test(promptBuilder);
  const valuesInChecklist = /\$\{item|frozen changeScopes:\s*\[/.test(checklist);
  const valuesInRejection = provider.includes('outside frozen changeScopes [${effectiveScopes.join');
  assert.ok(valuesInPrompt,
    'the pre-act value carrier (the prompt section) must exist — F-α1 fixed by R1; if this fails, delivery regressed; update the registry');
  assert.ok(!valuesInChecklist,
    'the checklist template must stay value-free (no interpolation) — it is teaching, not delivery');
  assert.ok(valuesInRejection, 'the rejection must remain identifiable as the at-fence carrier for this pin to mean anything');
});

test('space F — registry well-formed (findings, not fixes)', () => {
  assert.equal(FINDINGS.length, 4);
  for (const finding of FINDINGS) {
    assert.ok(finding.id && finding.authority && finding.claim && finding.severity);
    assert.match(finding.home, /\.mjs|\.ts:\d+|\.md/, `${finding.id} must cite its home`);
  }
});
