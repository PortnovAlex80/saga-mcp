# W0-A2 — Characterization: execution-profile, runner, workspace, hooks

**Wave:** 0 · **Lane:** A2 · **Plan ref:** §0.3.3, §13.1–13.6, §13.16–13.18
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a2`

## Context (read first)

- Plan: `docs/refactor-management/00-PLAN.md` (§13 findings, §10 LM Execution Cell).
- Baseline: `docs/refactor-management/01-CODEBASE-BASELINE.md` (sections: `execution-profile-resolver.ts`, `process-execution-workspace.ts`, `tracker-view/claude-runner.mjs`, `tracker-reminder.mjs`).

## Architecture rule this serves

Lock current behavior of the LM Execution Cell stack so Waves 3 and 5 can change
it deliberately. A characterization test ASSERTS WHAT THE CODE DOES TODAY, even
when it is ugly. It is the safety net for refactoring.

## What you OWN (only you may create/edit)

- `tests/characterization/execution-profile-runner-workspace-hooks.test.mjs` — NEW, single file.
- You MAY add small helper modules under `tests/characterization/_helpers/` IF needed (and only you touch that subdir this wave).

## What to characterize (assert current behavior, do not improve)

For each, write tests that pin the OBSERVED behavior with the real modules
(import from `dist/` after `npm run build`, or from `src/` via the compiled
output). Use `node:test` + `node:assert`.

1. **`execution-profile-resolver.ts`** (`resolveProfile(taskKind)`):
   - Exact-match on `taskKind` returns that module's profile.
   - **Prefix heuristic:** a `taskKind` like `'discovery.foo'` resolves via `taskKind.split('.')[0] === 'discovery'` to the discovery module's first profile. Assert which profile wins.
   - **First-match fallback:** when multiple profiles exist, `executionProfiles[0]` is returned. Assert the order.
   - It imports the built-in catalog as a module-level singleton (assert the resolver function is callable with no args and returns a profile for a known kind like `'formalization.ac'`).

2. **`process-execution-workspace.ts`** (the workspace projection):
   - For a sample profile with `trackerTemplate`/`workspaceTemplates`/`callTemplates`/`checklists` path literals, assert that the workspace materializes files at the project-scoped path under the configured workspace root.
   - Assert `MachineBindings` are filled from task metadata (`epic_id`, `metadata`).
   - Assert it performs real filesystem writes (you may use a tmpdir).
   - Pin the exact set of fields it returns (trackerPath, executionDirectory, workspaceFiles, callFiles, checklists).

3. **`tracker-view/claude-runner.mjs`** (`ClaudeBoardRunner.buildPrompt` / `roleFromTask` / `launch` tool list — the parts that are pure functions or near-pure):
   - `roleFromTask`: with `tags=['role:analyst']` → `'analyst'`; with `assignment.skill==='saga-reviewer'` and no role tag → `'reviewer'`; otherwise `'developer'`.
   - `effectiveSemanticSkill`: profile.semanticSkill wins over assignment.skill wins over `saga-${role}`.
   - When a Process Module profile resolves, the prompt contains BOTH the `saga-process-module-worker-protocol` section AND the semantic skill section, in that order.
   - The granted built-in tools include the hard-coded set `['Bash','Read','Write','Edit','Glob','Grep','MultiEdit','Task']` in addition to saga tools (assert the set).
   - (If `buildPrompt`/`launch` need a live host/runner instance, construct the minimum stub from the real constructor signature; do NOT spin a real subprocess.)

4. **`tracker-reminder.mjs`** (PostToolUse hook):
   - Given a tracker file at `SAGA_PROCESS_TRACKER_PATH` with a `## Current Step:` line and `- [x]`/`- [ ]` checkboxes, the hook emits `{"additionalContext": "<reminder>"}` containing the file path, current step, completed steps, and next unchecked step.
   - Given a missing/relative/nonexistent tracker path, emits `{}`.
   - It does NOT scan `docs/` (assert: even if `docs/` contains a tempting match, only the env-bound path is read).
   - Checklist paths come from `SAGA_PROCESS_CHECKLIST_PATHS` (path-delimited).

## Anti-scope

- Do NOT edit production source.
- Do NOT edit `tests/architecture/saga2-boundaries.test.mjs` or any other lane's file.
- Do NOT "improve" the resolver heuristics or the hook. If behavior is surprising, that is exactly what to lock in.
- If a behavior cannot be tested without a full runtime, write a narrower test that pins the pure-function slice and add a `// TODO W3/W5: full integration characterization` comment. Better a narrow passing characterization than a skipped broad one.

## Exit criteria

- [ ] Single test file passes today (`node --test tests/characterization/execution-profile-runner-workspace-hooks.test.mjs`).
- [ ] Each of the 4 areas above has at least one assertion pinning observed behavior.
- [ ] No production source modified (`git diff --stat` shows only your new test file + optional helper).

## Return to integrator

1. Branch name.
2. `git diff --stat`.
3. Passing test summary.
4. A bullet list of every "surprising" behavior you locked in (these become Wave 3/5 fix targets).
5. Confirmation: no frozen contract change, no production semantics change.
