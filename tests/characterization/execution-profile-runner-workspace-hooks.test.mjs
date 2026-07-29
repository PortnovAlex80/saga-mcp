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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveExecutionProfile, resolveProtocolSkill, resolveSemanticSkill } from '../../dist/process-modules/application/execution-profile-resolver.js';
import { prepareProcessExecutionWorkspace } from '../../dist/process-modules/application/process-execution-workspace.js';

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
// 2. process-execution-workspace.ts — materialization + MachineBindings + return fields
// =============================================================================

/**
 * Build a workspaceRoot tmpdir containing the asset paths the discovery-proposal
 * profile references. W13-A2 moved the discovery resources out of the legacy
 * global root (`tool-templates/discovery/`) into the discovery package resources
 * directory; the profile now references these repo-root-relative paths:
 *   - src/process-modules/modules/discovery/package/resources/discovery-doc-template.md
 *   - src/process-modules/modules/discovery/package/resources/proposal-call-template.json
 *   - src/process-modules/modules/discovery/package/resources/proposal-stage-tracker.md
 *   - src/process-modules/modules/discovery/package/resources/proposal-checklist.md
 * We copy the real ones from the repo so the materializer fills the same
 * placeholders it would in production. The same relative path serves as both the
 * repo-root source (under repoRoot) and the workspace-relative target (under the
 * tmp workspaceRoot) — the materializer resolves it under workspaceRoot.
 */
function makeWorkspaceRootWithDiscoveryAssets() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-w0a2-ws-'));
  const assetRelativePaths = [
    'src/process-modules/modules/discovery/package/resources/discovery-doc-template.md',
    'src/process-modules/modules/discovery/package/resources/proposal-call-template.json',
    'src/process-modules/modules/discovery/package/resources/proposal-stage-tracker.md',
    'src/process-modules/modules/discovery/package/resources/proposal-checklist.md',
  ];
  for (const rel of assetRelativePaths) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(root, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src, 'utf8'));
  }
  return root;
}

test('process-execution-workspace: materializes tracker and templates at project-scoped paths under workspaceRoot', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 42,
      task: { id: 999, epic_id: 42, metadata: {} },
      executionId: 'exec-1',
      workerId: 'w-1',
    });

    // Stage directory is derived from module.identity.kind = 'discovery'.
    // Project directory is keyed by epicId. Execution directory by task.id.
    assert.equal(result.trackerPath, 'docs/discovery/projects/42/project-42-discovery-stage-999.md');
    assert.equal(result.executionDirectory, 'docs/discovery/projects/42/executions/task-999');
    // workspaceFiles live under executionDirectory; checklists/tools live under docs/<stage>/tools/.
    for (const f of result.workspaceFiles) {
      assert.ok(f.startsWith('docs/discovery/projects/42/executions/task-999/'),
        `workspaceFile not under execution dir: ${f}`);
      assert.ok(existsSync(path.join(workspaceRoot, f)), `materialized workspace file missing: ${f}`);
    }
    for (const f of result.callFiles) {
      assert.ok(existsSync(path.join(workspaceRoot, f)), `materialized call file missing: ${f}`);
    }
    for (const f of result.checklists) {
      assert.ok(f.startsWith('docs/discovery/tools/'), `checklist not in tools dir: ${f}`);
      assert.ok(existsSync(path.join(workspaceRoot, f)), `checklist file missing: ${f}`);
    }
    assert.ok(existsSync(result.trackerAbsolutePath), 'tracker absolute path not written');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: returns EXACTLY the documented field set', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 42,
      task: { id: 999, epic_id: 42, metadata: {} },
      executionId: 'exec-1',
      workerId: 'w-1',
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      ['callFiles', 'checklists', 'executionDirectory', 'moduleRef', 'profileId',
        'trackerAbsolutePath', 'trackerPath', 'workspaceFiles'].sort(),
    );
    assert.equal(result.profileId, 'discovery-proposal-worker');
    assert.equal(result.moduleRef, 'product-discovery@3.0.1');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: tracker filename pattern is project-<epic>-<stage>-stage-<task>.md', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 42,
      task: { id: 999, epic_id: 42, metadata: {} },
      executionId: 'exec-1',
      workerId: 'w-1',
    });
    // SURPRISING (§13.3): tracker is per-epic per-stage per-task — every
    // (epic,task) pair gets its own tracker file. There is no per-run tracker
    // rollup; a board with N tasks materializes N trackers.
    assert.equal(path.basename(result.trackerAbsolutePath),
      'project-42-discovery-stage-999.md');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: MachineBindings filled from task.metadata render into the materialized tracker', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    // Metadata may be a JSON string OR an object — the parser accepts both.
    const metadataObject = {
      process_run_id: 'run-1',
      process_node_id: 'node-7',
      work_intent_id: 'wi-3',
      process_node_input: { bindings: { input_snapshot_hash: 'abc123' } },
    };
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 42,
      task: { id: 999, epic_id: 42, metadata: metadataObject },
      executionId: 'exec-1',
      workerId: 'w-1',
    });

    // The discovery stage tracker has a `## Machine binding` block with one
    // `- <key>: <value>` line per binding. refreshMarkdownMachineBindings
    // replaces each line whose key matches a known binding. The metadata-
    // sourced values must show up there.
    //
    // SURPRISING (§13.3): the renderer wraps STRING values in backticks but
    // emits NUMBERS and JSON-ARRAY values BARE. So `project_id: 7` (no ticks)
    // vs `process_module_ref: \`product-discovery@3.0.1\`` (ticks). This makes
    // the tracker's machine-binding block look inconsistent to a human reader
    // but it is the locked current behavior.
    const trackerContent = readFileSync(result.trackerAbsolutePath, 'utf8');
    assert.match(trackerContent, /- process_module_ref: `product-discovery@3\.0\.1`/);
    assert.match(trackerContent, /- process_run_id: `run-1`/);
    assert.match(trackerContent, /- node_id: `node-7`/);
    assert.match(trackerContent, /- work_intent_id: `wi-3`/);
    assert.match(trackerContent, /- project_id: 7\r?\n/);          // number → bare
    assert.match(trackerContent, /- epic_id: 42\r?\n/);            // number → bare
    assert.match(trackerContent, /- task_id: 999\r?\n/);           // number → bare
    assert.match(trackerContent, /- execution_id: `exec-1`/);
    assert.match(trackerContent, /- worker_id: `w-1`/);
    assert.match(trackerContent, /- input_snapshot_hash: `abc123`/);
    // allowed_tools is JSON.stringify-ed → starts with '[' → bare (no backticks).
    assert.match(trackerContent, /- allowed_tools: \["task_get"/);

    // The JSON call file gets intent_id/task_id/execution_id overwritten via
    // the JSON machine-binding machinery (recognized key list).
    const callContent = readFileSync(path.join(workspaceRoot, result.callFiles[0]), 'utf8');
    assert.match(callContent, /"intent_id": "wi-3"/);
    assert.match(callContent, /"task_id": 999/);
    assert.match(callContent, /"execution_id": "exec-1"/);

    // No recovery feedback for this fixture.
    assert.ok(!result.workspaceFiles.some(f => f.endsWith('recovery-feedback.json')),
      'no recovery_feedback expected for this fixture');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: accepts string metadata (JSON) the same as object metadata', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const metadataObject = {
      process_run_id: 'run-2',
      process_node_id: 'node-8',
      work_intent_id: 'wi-4',
    };
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 42,
      task: { id: 1000, epic_id: 42, metadata: JSON.stringify(metadataObject) },
      executionId: 'exec-2',
      workerId: 'w-2',
    });
    const trackerContent = readFileSync(result.trackerAbsolutePath, 'utf8');
    assert.match(trackerContent, /- process_run_id: `run-2`/);
    assert.match(trackerContent, /- node_id: `node-8`/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: SURPRISING — missing metadata bindings leave the {PLACEHOLDER} intact in the tracker', () => {
  // SURPRISING (§13.3): when a metadata-sourced binding is null (absent from
  // metadata), refreshMarkdownMachineBindings skips the line rewrite, leaving
  // the literal `{PROCESS_RUN_ID}` placeholder in the worker-facing tracker.
  // The worker is expected to either fill it themselves or treat it as
  // "not applicable for this execution mode".
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 70,
      task: { id: 4001, epic_id: 70, metadata: {} },
      executionId: 'exec-empty',
      workerId: 'w-empty',
    });
    const trackerContent = readFileSync(result.trackerAbsolutePath, 'utf8');
    // process_run_id and node_id were not provided → placeholder survives,
    // INCLUDING the surrounding backticks from the template literal.
    assert.match(trackerContent, /- process_run_id: `\{PROCESS_RUN_ID\}`/);
    assert.match(trackerContent, /- node_id: `\{NODE_ID\}`/);
    // But path-level bindings (project_id, epic_id, task_id) ARE always filled
    // (numbers render bare — see the binding-renderer test above).
    assert.match(trackerContent, /- project_id: 7\r?\n/);
    assert.match(trackerContent, /- task_id: 4001\r?\n/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: performs REAL filesystem writes (tracker + tools are on disk)', () => {
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 43,
      task: { id: 1001, epic_id: 43, metadata: {} },
      executionId: 'exec-3',
      workerId: 'w-3',
    });
    // Real fs writes happened — files exist with non-zero size.
    const trackerStat = readFileSync(result.trackerAbsolutePath, 'utf8');
    assert.ok(trackerStat.length > 0, 'tracker file is empty');
    // The shared tools directory receives the proposal-checklist.md (basename only).
    const toolChecklist = path.join(workspaceRoot, 'docs/discovery/tools/proposal-checklist.md');
    assert.ok(existsSync(toolChecklist), 'shared tools dir checklist was not materialized');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: SURPRISING — shared tools dir is per-stage, NOT per-epic or per-task', () => {
  // SURPRISING (§13.3): the path `docs/<stage>/tools/<basename>` is shared
  // across all epics/tasks of the same stage. Two tasks with templates that
  // share a basename would silently overwrite each other's tool copy on the
  // SECOND task (the writer checks existsSync and skips). The existence check
  // means the first materialization wins forever.
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');

    // First materialization writes proposal-checklist.md to docs/discovery/tools/.
    prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 50,
      task: { id: 2001, epic_id: 50, metadata: {} },
      executionId: 'exec-a',
      workerId: 'w-a',
    });
    const sharedChecklist = path.join(workspaceRoot, 'docs/discovery/tools/proposal-checklist.md');
    const firstContent = readFileSync(sharedChecklist, 'utf8');

    // Mutate the source template on disk to simulate a different content version.
    const sourceTemplate = path.join(workspaceRoot, 'src/process-modules/modules/discovery/package/resources/proposal-checklist.md');
    writeFileSync(sourceTemplate, '# DIFFERENT CONTENT\n');

    // Second materialization for a different epic — the shared file is NOT
    // overwritten because existsSync(sharedTarget) is true. The first write wins.
    prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 51,
      task: { id: 2002, epic_id: 51, metadata: {} },
      executionId: 'exec-b',
      workerId: 'w-b',
    });
    const secondContent = readFileSync(sharedChecklist, 'utf8');
    assert.equal(secondContent, firstContent,
      'shared tool dir was not first-write-wins (existence check changed)');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('process-execution-workspace: SURPRISING — recovery_feedback in metadata triggers recovery-feedback.json write', () => {
  // SURPRISING (§13.3): the workspace peeks into metadata.recovery_feedback
  // (or process_node_input.bindings.recoveryFeedback) and writes a
  // board-shaped JSON file. This is board-specific vocabulary leaking into the
  // supposedly module-agnostic workspace service.
  const workspaceRoot = makeWorkspaceRootWithDiscoveryAssets();
  try {
    const resolved = resolveExecutionProfile('discovery.work');
    const result = prepareProcessExecutionWorkspace({
      workspaceRoot,
      module: resolved.module,
      profile: resolved.profile,
      projectId: 7,
      epicId: 60,
      task: {
        id: 3001, epic_id: 60,
        metadata: { recovery_feedback: { issue_id: 'ISSUE-1', severity: 'blocking' } },
      },
      executionId: 'exec-r',
      workerId: 'w-r',
    });
    const recoveryFile = result.workspaceFiles.find(f => f.endsWith('recovery-feedback.json'));
    assert.ok(recoveryFile, 'recovery-feedback.json was not added to workspaceFiles');
    const recovery = JSON.parse(readFileSync(path.join(workspaceRoot, recoveryFile), 'utf8'));
    assert.deepEqual(recovery, { issue_id: 'ISSUE-1', severity: 'blocking' });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
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
  assert.match(src, /type: 'command'/);
  assert.match(src, /hooks: \[\{/);
  assert.match(src, /SAGA_AGENT_ASSISTANCE_PATH: processWorkspace\?\.agentAssistanceAbsolutePath \|\| ''/);
});
