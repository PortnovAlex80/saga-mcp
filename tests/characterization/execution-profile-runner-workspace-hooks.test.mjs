/**
 * W0-A2 — Characterization: execution-profile, runner, workspace, hooks.
 *
 * This file ASSERTS CURRENT BEHAVIOR. It does NOT improve anything. It is the
 * safety net for Wave 3 (execution envelope) and Wave 5 (tracker/assistance)
 * to change behavior deliberately. Every "surprising" assertion here is a
 * future fix target, not a desired contract.
 *
 * Plan ref: §0.3.3, §10 (LM Execution Cell), §13.1–13.6, §13.16–13.18.
 * Frozen input: commit fd26fd1.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveExecutionProfile, resolveProtocolSkill, resolveSemanticSkill } from '../../dist/process-modules/application/execution-profile-resolver.js';
import * as legacyWorkspace from '../../dist/process-modules/application/process-execution-workspace.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
// W13-A2: the legacy tracker-reminder.mjs hook path constant was removed
// along with the file (replaced by tracker-view/structured-context-hook.mjs).
// The full section-4 characterization of the legacy hook was deleted too.

// =============================================================================
// 1. execution-profile-resolver.ts — exact-match only (Wave 13 removed prefix/first-match)
// =============================================================================

test('execution-profile-resolver: exact task_kind match returns that exact profile', () => {
  const resolved = resolveExecutionProfile('formalization.ac');
  assert.equal(resolved?.profile?.id, 'formalization-acceptance');
  assert.equal(resolved?.profile?.taskKind, 'formalization.ac');
  assert.equal(resolved?.module?.identity?.name, 'solution-formalization');
  assert.equal(resolved?.module?.identity?.version, '1.0.0');
});

test('execution-profile-resolver: discovery.work exact-matches discovery-proposal-worker', () => {
  // The first profile in the discovery module is also its exact taskKind.
  const resolved = resolveExecutionProfile('discovery.work');
  assert.equal(resolved?.profile?.id, 'discovery-proposal-worker');
  assert.equal(resolved?.profile?.taskKind, 'discovery.work');
});

test('execution-profile-resolver: Wave 13 removed the kind-prefix fallback — unknown discovery.* resolves to null', () => {
  // Wave 13 (W13-A1) removed the kind-prefix heuristic: an unknown taskKind
  // like 'discovery.foo' no longer silently resolves to the first discovery
  // profile. It now resolves to null so a typo in a task_kind is detectable
  // instead of being routed to the proposal worker.
  assert.equal(resolveExecutionProfile('discovery.foo'), null);
});

test('execution-profile-resolver: Wave 13 removed the kind-prefix fallback — unknown formalization.* resolves to null', () => {
  // 'formalization.unknown' previously fell back to formalization-product
  // (executionProfiles[0]). Wave 13 removed that fallback; it is now null.
  assert.equal(resolveExecutionProfile('formalization.unknown'), null);
});

test('execution-profile-resolver: every declared task_kind resolves to its exact profile', () => {
  // With the prefix/first-match heuristics gone, the resolver is driven
  // purely by exact taskKind equality. Pin every declared task_kind so a
  // future reorder or rename is visible.
  const allTaskKinds = [
    'discovery.work', 'discovery.normalize', 'discovery.assess', 'discovery.diagnose',
    'formalization.prd', 'formalization.uc', 'formalization.ac',
    'formalization.reconciliation', 'formalization.srs',
    'planning.decomposition',
  ];
  for (const kind of allTaskKinds) {
    const resolved = resolveExecutionProfile(kind);
    assert.ok(resolved, `expected a profile for task_kind '${kind}'`);
    assert.equal(resolved.profile.taskKind, kind);
  }
});

test('execution-profile-resolver: delivery has no profiles — delivery.* resolves to null', () => {
  // The delivery module declares executionProfiles: [], so no delivery.*
  // task_kind matches. (Wave 13: this is no longer a prefix-fallback quirk;
  // it is the same exact-match result for any kind with no matching profile.)
  assert.equal(resolveExecutionProfile('delivery.x'), null);
  assert.equal(resolveExecutionProfile('delivery.release'), null);
});

test('execution-profile-resolver: returns null for null/undefined/empty/non-string taskKind', () => {
  assert.equal(resolveExecutionProfile(null), null);
  assert.equal(resolveExecutionProfile(undefined), null);
  assert.equal(resolveExecutionProfile(''), null);
  assert.equal(resolveExecutionProfile(123), null);
});

test('execution-profile-resolver: returns null for unknown kind (no exact match)', () => {
  assert.equal(resolveExecutionProfile('unknownkind.something'), null);
  assert.equal(resolveExecutionProfile('does.not.exist'), null);
});

test('execution-profile-resolver: resolver is callable with no setup — known task_kind returns its profile', () => {
  // Wave 13: the resolver imports the production module definitions directly
  // (no built-in catalog). Calling resolveExecutionProfile with no preparation
  // returns a real profile for a known task_kind.
  const resolved = resolveExecutionProfile('formalization.prd');
  assert.equal(resolved?.profile?.id, 'formalization-product');
});

test('execution-profile-resolver: resolveProtocolSkill / resolveSemanticSkill return the profile skills', () => {
  assert.equal(resolveProtocolSkill('discovery.work'), 'saga-process-module-worker-protocol');
  assert.equal(resolveSemanticSkill('discovery.work'), 'saga-discovery-worker');
  // Unknown kinds → null (no fallback string).
  assert.equal(resolveProtocolSkill('unknown.x'), null);
  assert.equal(resolveSemanticSkill('unknown.x'), null);
});

// =============================================================================
// 2. process-execution-workspace.ts — saga4 cutover: legacy creator REMOVED
// =============================================================================
//
// saga4 cutover (LEGO-CONTRACTS.md §"Слой 1: СТОЛ"): the legacy
// `prepareProcessExecutionWorkspace` function and the loose
// `ProcessExecutionWorkspace` interface were REMOVED. The whole
// section-2 characterization block (§13.3 workspace materialization,
// per-task tracker pattern, per-stage shared tools dir, recovery_feedback
// leak) characterised the LEGACY path and is therefore deleted with it.
//
// The equivalent characterization for the new strict `WorkplaceDesk` contract
// lives in tests/process-modules/process-execution-workspace.test.mjs (covers
// materializePinnedWorkspace + assertDeskInvariants I1–I5 + surviving helpers).
// What remains HERE is a single ratchet that pins the removal: the legacy
// symbols must not return.

test('saga4 cutover: legacy prepareProcessExecutionWorkspace and ProcessExecutionWorkspace are GONE from the public surface', () => {
  // The cutover deletes the legacy desk creator + loose interface; only the
  // reusable helpers + the task shape survive. A future re-introduction of
  // these symbols would re-open the silent-fallback hole D2 closed.
  assert.equal(
    typeof legacyWorkspace.prepareProcessExecutionWorkspace,
    'undefined',
    'prepareProcessExecutionWorkspace must be removed after the saga4 cutover',
  );
  assert.equal(
    legacyWorkspace.ProcessExecutionWorkspace,
    undefined,
    'ProcessExecutionWorkspace interface must be removed (replaced by WorkplaceDesk)',
  );
  // The reusable helpers ARE still exported (single-source for the pinned
  // materializer). Pin them so an accidental cleanup does not strand the
  // pinned creator.
  for (const helper of [
    'parseMetadata',
    'buildMachineBindings',
    'fillKnownPlaceholders',
    'refreshMarkdownMachineBindings',
    'refreshJsonMachineBindings',
    'materializedName',
    'relativeWorkspacePath',
    'recoveryFeedbackFromMetadata',
    'reviewFeedbackFromMetadata',
  ]) {
    assert.equal(
      typeof legacyWorkspace[helper],
      'function',
      `surviving helper ${helper} must remain exported for the pinned materializer`,
    );
  }
});

// =============================================================================
// 3. tracker-view/claude-runner.mjs — roleFromTask + effectiveSemanticSkill + tool set
// =============================================================================
//
// buildPrompt and roleFromTask are NOT exported by claude-runner.mjs. They are
// only reachable via the ClaudeBoardRunner.launch method, which spawns a real
// subprocess. To characterize the pure-function slices (plan §0.3.3 / §13.16–
// 13.18) we extract the same logic in a small parallel implementation that is
// kept in lock-step with the runner by reading the runner source as text and
// asserting the locked literals are still present. A future Wave 3 must change
// BOTH the runner and these assertions together.

test('claude-runner.mjs: source still contains the locked literals being characterized', () => {
  // This guards against silent drift: if the runner is edited, this test fails
  // and forces the editor to update the parallel assertions below.
  //
  // W5-A6 (plan §13.17–§13.18): the §13.17 hardcoded-builtin literal and the
  // §13.18 author-overwrites-reviewer precedence were the FIX TARGETS of this
  // wave. The literals they pinned are gone; the guard now pins the FIXED
  // behavior: (a) the DEFAULT_BUILTIN fallback set is still present for the
  // legacy path, (b) a launch-spec allowedToolIds branch narrows it (§13.17),
  // (c) the reviewer-skill selection branch exists (§13.18), and (d) the
  // legacy effectiveSemanticSkill precedence is still present as the fallback
  // when no launch spec resolves. The legacy PROTOCOL/SEMANTIC markers and
  // roleFromTask branches are unchanged.
  const src = readFileSync(path.join(repoRoot, 'tracker-view/claude-runner.mjs'), 'utf8');
  // roleFromTask: role:<value> tag → value; else 'reviewer' if fallbackSkill is saga-reviewer; else 'developer'.
  assert.match(src, /roleTag\.slice\('role:'\.length\)/, 'roleFromTask role-tag slice missing');
  assert.match(src, /fallbackSkill === 'saga-reviewer' \? 'reviewer' : 'developer'/,
    'roleFromTask reviewer/developer fallback missing');
  // Legacy effectiveSemanticSkill precedence is still the fallback branch
  // (after the launch-spec pick). W5-A6 prepended `launchPickedSkill ??` to it.
  assert.match(src, /semanticSkillName\s*\n\s*\?\? assignment\.skill\s*\n\s*\?\? `saga-\$\{role\}`/,
    'effectiveSemanticSkill legacy precedence fallback missing');
  // §13.17 fix: the default builtin set is now named DEFAULT_BUILTIN (still the
  // legacy fallback), AND a launch-spec allowedToolIds branch narrows it.
  assert.match(src, /const DEFAULT_BUILTIN = \['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'Task'\];/,
    'DEFAULT_BUILTIN fallback set missing');
  assert.match(src, /const profileAllowed = Array\.isArray\(launchSpec\?\.allowedToolIds\)/,
    '§13.17 profile allowedToolIds branch missing');
  // §13.18 fix: reviewer skill selection branch exists for review tasks.
  assert.match(src, /const effectiveReviewerSkill = \(isReview && reviewerSkillName\)/,
    '§13.18 reviewer skill selection missing');
  // Prompt assembly: protocol skill section BEFORE semantic/reviewer section.
  assert.match(src, /PROTOCOL SKILL BEGIN/, 'protocol skill section marker missing');
  assert.match(src, /SEMANTIC SKILL BEGIN/, 'semantic skill section marker missing');
  assert.match(src, /REVIEWER SKILL BEGIN/, 'reviewer skill section marker missing');
});

/**
 * Re-implemented roleFromTask for characterization. This mirrors the exact
 * branches in tracker-view/claude-runner.mjs. If the runner's branches change,
 * the source-text assertion above will fail first.
 */
function roleFromTask(task, fallbackSkill) {
  let tags = [];
  try { tags = JSON.parse(task.tags || '[]'); } catch {}
  const roleTag = tags.find(tag => typeof tag === 'string' && tag.startsWith('role:'));
  if (roleTag) return roleTag.slice('role:'.length);
  return fallbackSkill === 'saga-reviewer' ? 'reviewer' : 'developer';
}

test('claude-runner roleFromTask: role:<value> tag wins', () => {
  assert.equal(roleFromTask({ tags: JSON.stringify(['role:analyst']) }, 'saga-reviewer'), 'analyst');
  assert.equal(roleFromTask({ tags: JSON.stringify(['role:architect']) }, 'saga-product'), 'architect');
  // Multiple role tags → first wins.
  assert.equal(roleFromTask({ tags: JSON.stringify(['role:analyst', 'role:architect']) }, null), 'analyst');
});

test('claude-runner roleFromTask: saga-reviewer fallbackSkill → reviewer', () => {
  assert.equal(roleFromTask({ tags: '[]' }, 'saga-reviewer'), 'reviewer');
  assert.equal(roleFromTask({}, 'saga-reviewer'), 'reviewer');
});

test('claude-runner roleFromTask: any other skill (or none) → developer', () => {
  assert.equal(roleFromTask({ tags: '[]' }, 'saga-product'), 'developer');
  assert.equal(roleFromTask({ tags: '[]' }, null), 'developer');
  assert.equal(roleFromTask({ tags: null }, undefined), 'developer');
});

test('claude-runner roleFromTask: malformed tags JSON silently yields developer/reviewer (no throw)', () => {
  // SURPRISING: a corrupt tags string is silently swallowed (try/catch), and
  // the role degrades to developer/reviewer. A board with corrupt tag data
  // would route review tasks to a developer role without surfacing the error.
  assert.equal(roleFromTask({ tags: '{not json' }, 'saga-product'), 'developer');
  assert.equal(roleFromTask({ tags: '<xml>' }, 'saga-reviewer'), 'reviewer');
});

test('claude-runner effectiveSemanticSkill: precedence is profile > assignment.skill > saga-<role>', () => {
  // Replicates the exact line from buildPrompt:
  //   const effectiveSemanticSkill = semanticSkillName ?? assignment.skill ?? `saga-${role}`;
  function effectiveSemanticSkill({ semanticSkillName, assignmentSkill, role }) {
    return semanticSkillName ?? assignmentSkill ?? `saga-${role}`;
  }
  assert.equal(effectiveSemanticSkill({ semanticSkillName: 'saga-discovery-worker', assignmentSkill: 'saga-product', role: 'analyst' }),
    'saga-discovery-worker');
  assert.equal(effectiveSemanticSkill({ semanticSkillName: null, assignmentSkill: 'saga-product', role: 'analyst' }),
    'saga-product');
  assert.equal(effectiveSemanticSkill({ semanticSkillName: null, assignmentSkill: null, role: 'developer' }),
    'saga-developer');
  assert.equal(effectiveSemanticSkill({ semanticSkillName: null, assignmentSkill: null, role: 'reviewer' }),
    'saga-reviewer');
});

test('claude-runner effectiveSemanticSkill: §13.18 FIXED — reviewer skill wins for review tasks when launch spec resolves one', () => {
  // W5-A6 (plan §13.18): this was the §13.18 SURPRISING test. The bug — that a
  // reviewer assignment was overwritten by the author semanticSkill — is FIXED
  // for tasks whose launch spec resolved a package-pinned AgentLaunchSpec with
  // a non-null reviewSkill. The runner's pickLaunchSpecSkillName now returns
  // role.reviewSkill for review tasks. Replicates the fixed branch.
  function pickLaunchSpecSkillName(role, isReview) {
    if (!role) return null;
    if (isReview && typeof role.reviewSkill === 'string' && role.reviewSkill.length > 0) {
      return role.reviewSkill;
    }
    if (typeof role.semanticSkill === 'string' && role.semanticSkill.length > 0) {
      return role.semanticSkill;
    }
    return null;
  }
  // A formalization.prd review task with a pinned launch spec: the reviewer
  // skill is selected, NOT the author semanticSkill.
  const skill = pickLaunchSpecSkillName(
    { semanticSkill: 'saga-product', reviewSkill: 'saga-requirements-reviewer' },
    true,
  );
  assert.equal(skill, 'saga-requirements-reviewer');
  assert.notEqual(skill, 'saga-product');
  // A non-review task still gets the author semantic skill.
  assert.equal(
    pickLaunchSpecSkillName({ semanticSkill: 'saga-product', reviewSkill: 'saga-requirements-reviewer' }, false),
    'saga-product',
  );
  // A review task whose profile declares NO reviewSkill falls through to the
  // author semantic skill (legacy generic-reviewer behavior preserved).
  assert.equal(
    pickLaunchSpecSkillName({ semanticSkill: 'saga-product', reviewSkill: null }, true),
    'saga-product',
  );
});

test('claude-runner effectiveSemanticSkill: §13.18 legacy path still overwrites reviewer when no launch spec resolves', () => {
  // W5-A6: the LEGACY path (no launch spec) is preserved byte-for-byte. When
  // resolveLaunchSpec is absent or returns null, the runner still uses the
  // pre-fix precedence `semanticSkillName ?? assignment.skill ?? saga-<role>`,
  // so a review task with a resolved profile.semanticSkill still gets the
  // author skill. This is intentional — the fix is feature-detected.
  function effectiveSemanticSkill({ semanticSkillName, assignmentSkill, role }) {
    return semanticSkillName ?? assignmentSkill ?? `saga-${role}`;
  }
  const skill = effectiveSemanticSkill({
    semanticSkillName: 'saga-product',
    assignmentSkill: 'saga-reviewer',
    role: 'reviewer',
  });
  assert.equal(skill, 'saga-product');
  assert.notEqual(skill, 'saga-requirements-reviewer');
});

test('claude-runner buildPrompt: when a profile resolves, prompt inlines PROTOCOL section BEFORE SEMANTIC/REVIEWER section', () => {
  // W5-A6: the structural invariant is unchanged for author tasks (PROTOCOL
  // before SEMANTIC). For review tasks with a resolved reviewer skill, the
  // second section is REVIEWER instead of SEMANTIC (§13.18).
  //
  // The assembled prompt array literal in buildPrompt places PROTOCOL markers
  // first, then the semanticSectionTitle/semanticSectionEnd variables (which
  // resolve to either SEMANTIC or REVIEWER markers). Because the ternaries
  // that DEFINE those markers sit textually above the array, a plain indexOf
  // ordering check on the source no longer reflects the assembled order. We
  // instead assert: (a) all six marker literals are present, (b) the array
  // literal order is PROTOCOL BEGIN ... PROTOCOL END ... semanticSectionTitle
  // ... semanticSectionEnd (the runtime join order).
  const src = readFileSync(path.join(repoRoot, 'tracker-view/claude-runner.mjs'), 'utf8');
  const markers = [
    '--- PROTOCOL SKILL BEGIN (universal execution physics — apply to every action) ---',
    '--- PROTOCOL SKILL END ---',
    '--- SEMANTIC SKILL BEGIN (domain role — what to produce) ---',
    '--- SEMANTIC SKILL END ---',
    '--- REVIEWER SKILL BEGIN (review role — what to verify) ---',
    '--- REVIEWER SKILL END ---',
  ];
  for (const m of markers) {
    assert.ok(src.indexOf(m) >= 0, `marker missing in source: ${m}`);
  }
  // The array literal that joins into skillInline must place the PROTOCOL
  // markers before the semanticSectionTitle/semanticSectionEnd variables.
  const arrayStart = src.indexOf("'--- PROTOCOL SKILL BEGIN");
  assert.ok(arrayStart >= 0, 'PROTOCOL SKILL BEGIN array entry not found');
  const arrayEnd = src.indexOf('semanticSectionEnd,', arrayStart);
  assert.ok(arrayEnd >= 0, 'semanticSectionEnd array entry not found after PROTOCOL BEGIN');
  const protoEndInArray = src.indexOf("'--- PROTOCOL SKILL END ---',", arrayStart);
  const semanticTitleInArray = src.indexOf('semanticSectionTitle,', arrayStart);
  assert.ok(protoEndInArray > arrayStart && protoEndInArray < semanticTitleInArray,
    'in the skillInline array, PROTOCOL END must come before semanticSectionTitle');
});

test('claude-runner launch: §13.17 FIXED — profile allowedTools narrows Claude builtins; legacy path keeps the default set', () => {
  // W5-A6 (plan §13.17): this was the §13.17 SURPRISING test. The bug — that a
  // fixed Claude builtin set was granted UNCONDITIONALLY even when a profile
  // declared a narrower set — is FIXED. The runner now:
  //   - keeps DEFAULT_BUILTIN as the LEGACY fallback (no launch spec, or a
  //     profile that declares no allowedToolIds → grant all defaults);
  //   - narrows the granted builtins to the intersection of DEFAULT_BUILTIN and
  //     the launch spec's allowedToolIds when the profile constrains them.
  const src = readFileSync(path.join(repoRoot, 'tracker-view/claude-runner.mjs'), 'utf8');
  // The default builtin set is now named DEFAULT_BUILTIN (legacy fallback).
  assert.match(src, /const DEFAULT_BUILTIN = \['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'Task'\];/,
    'DEFAULT_BUILTIN legacy fallback set missing');
  // §13.17 narrowing branch: profileAllowed from the launch spec intersects
  // DEFAULT_BUILTIN to compute the granted builtins.
  assert.match(src, /builtin = DEFAULT_BUILTIN\.filter\(b => profileSet\.has\(b\)\)/,
    '§13.17 builtin narrowing (intersection) missing');
  assert.match(src, /if \(frozenAuthority && Array\.isArray\(frozenTools\)\)/,
    'empty managed authority must not fall back to the legacy catalog');
  assert.doesNotMatch(src, /if \(builtin\.length === 0\) builtin = \[\.\.\.DEFAULT_BUILTIN\]/,
    'an intentionally empty managed builtin surface must remain empty');
  assert.match(src, /!knownBuiltinSet\.has\(t\)/,
    'known builtins excluded by the profile must not be rewritten as Saga MCP names');
  // The args.push order is unchanged: [...sagaAllowed, ...builtin].
  assert.match(src, /args\.push\('--allowedTools', \[\.\.\.sagaAllowed, \.\.\.builtin\]\.join\(','\)\)/,
    '--allowedTools push order changed');
});

// =============================================================================
// 4. PostToolUse context hook — characterization removed (W13-A2)
// =============================================================================
//
// W13-A2 deleted the legacy tracker-reminder.mjs (C027 violation — regex
// parsing of Markdown checkboxes) and wired tracker-view/structured-context-hook.mjs
// (W5-A5) in its place. The full characterization of the legacy hook's exact
// regex semantics, fail-closed surface, env vars (SAGA_PROCESS_TRACKER_PATH /
// SAGA_PROCESS_CHECKLIST_PATHS), and 100-char truncation was removed with it.
// The replacement hook's contract is covered by
// tests/execution/structured-context-hook.test.mjs (reads
// SAGA_AGENT_ASSISTANCE_PATH, bounded + deduped, fail-closed '{}', never scans
// docs/, escapes untrusted text).

test('claude-runner wires the structured hook with the current Claude settings schema for success and failure', () => {
  const src = readFileSync(path.join(repoRoot, 'tracker-view/claude-runner.mjs'), 'utf8');
  assert.match(src, /PostToolUse: \[commandHook\]/);
  assert.match(src, /PostToolUseFailure: \[commandHook\]/);
  assert.match(src, /matcher: '\*'/,
    'the runner should use the documented explicit wildcard for all tools');
  assert.match(src, /type: 'command'/);
  assert.match(src, /command: 'node'/,
    'the hook must use exec form so Unicode Windows paths survive');
  assert.match(src, /data:text\/javascript;base64/,
    'the hook loader argv must remain ASCII-only');
  assert.match(src, /SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64:/,
    'the trusted hook bytes must cross the Claude hook boundary as ASCII base64');
  assert.match(src, /hooks: \[\{/);
  assert.match(src, /SAGA_AGENT_ASSISTANCE_PATH: processWorkspace\?\.agentAssistanceAbsolutePath \|\| ''/);
});
