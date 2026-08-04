---
name: saga-code-reviewer
description: "Real code reviewer for development.code tasks entering the review buffer. Applies four semantic axes (security/performance/maintainability/correctness) plus a framework profile (TypeScript default; React 19, Vue 3, Rust, TanStack Query v5 overlays) on top of the deterministic craft checks (tsc --noEmit, file-size, scratch detection, duplication, ESLint delta, coverage delta, build). Verdict: approved | changes_requested. Replaces the phantom reviewer that rubber-stamped every task. One task = one launch."
---

## saga-code-reviewer — code review for `development.code` tasks

**Source plan:** `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G3, audit §7.5 N1)
**Audit motivation:** `docs/research/audit-2026-07-20-cannon-1000-score.md` §7.5 —
"36 TS errors in `src/`, scratch-file `_calc.awk` in git, type drift SRS↔code.
Code-reviewer skill is phantom — reviewer falls back to `saga-worker` and
rubber-stamps." This skill closes that hole.

## Product-board contract

Same as `saga-worker` — use the assignment's product, epic, repository. Resolve
`project_id` from `.saga/project.json` (or `projectname.txt` legacy fallback).
Use `worker_next({ role: 'reviewer' })` to claim, `worker_done` to release.

## Flow position

- **Stage:** 4-Development, review buffer
- **Precondition:** a `development.code` task in this product is `review` and
  unassigned. The Builder has `worker_done(verdict='approved', result=<summary>)`
  — wait, no: the Builder calls `worker_done` with NO verdict (it's the
  developer). The task transitions `in_progress` → `review`. The reviewer
  claims it via `worker_next`.
- **Postcondition:** task transitions `review_in_progress` → `done`
  (approved) OR `review_in_progress` → `todo` (changes_requested, fresh
  Builder picks it up).

The reviewer does NOT merge. Merging is the original Builder's
responsibility (T-008 reviewer-does-merge is owned by saga-worker). This
skill only produces the verdict.

## When to use

Triggered automatically when `worker_next({ role: 'reviewer' })` returns a
task with `task_kind='development.code'` (or any `development.*` kind that
produces code).

The orchestrator / dispatch loop calls this skill for every code task that
enters the review buffer. Do NOT claim:
- `verification.ac` tasks — those are saga-verifier's territory.
- `formalization.*` tasks — those go to requirements/architecture reviewers.
- `planning.*` tasks — those are tracker-only.

If `worker_next` returns a non-code task, call `worker_done` immediately with
`result='wrong skill for task_kind=<X>'`, `verdict='approved'` (to release
it back without prejudice).

## What to review — two layers

The reviewer audits the **diff** between the integration branch (`dev`) and
the task's worktree branch (`task/<id>`), NOT the artifact tree. Concrete
code, concrete files.

Review is **two layers**, run in order. Both layers must be clean for
`approved`. A hard failure on EITHER layer forces `changes_requested`.

### Layer A — Deterministic craft checks (run first, cheap, unambiguous)

| Check | Tool | Hard rule |
|---|---|---|
| 1. Static types | `npx tsc --noEmit` in the worktree | exit 0 in `src/` for files touched by the diff |
| 2. File size | `wc -l` on changed files | no file > 500 lines without inline justification comment |
| 3. Scratch detection | `git diff --name-only` + grep patterns | zero matches |
| 4. Duplication | `npx jscpd src/` (or `npx @eslint/css jscpd` equivalent) | < 5% duplicated lines in changed files |
| 5. ESLint warnings | `npx eslint <changed-files>` | 0 new warnings vs `dev` baseline |
| 6. Coverage delta | `npm test -- --coverage` on changed lines | no regression > 5% on touched files (if project has coverage) |
| 7. Build sanity | `npm run build` (if defined) | exit 0 |

Each check is independent — one failure does not skip the others.

### Layer B — Semantic axes + framework profile (the read)

After the deterministic layer, apply the **four review axes** from
[`axes.md`](./axes.md) and a **framework profile** from
[`frameworks.md`](./frameworks.md).

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

The axes are:

1. **Security** (S1–S6) — input validation at trust boundaries, injection
   surface, secret handling, authn/authz on new endpoints, dependency
   provenance, prompt/tool-abuse for agentic code.
2. **Performance** (P1–P6) — algorithmic complexity, N+1 queries / repeated
   I/O, resource leaks, sync-on-hot-path, reactivity/memoization, cold-start
   bloat.
3. **Maintainability** (M1–M6) — naming, dead code, file cohesion, magic
   values, doc on public surface, neighbor-consistency.
4. **Correctness** (craft-level, C1–C6) — error handling, nullish access,
   boundary conditions, concurrency, type-port contract, idempotency.
   (Behavior-correctness against the AC is the L3 verifier's job, NOT this
   axis — see `saga-verifier`.)

The framework profile is picked from the changed-files list:

- TypeScript profile is the **default** and always applies (saga product repos
  are TS-first). See `frameworks.md` §TypeScript for rules TS-1..TS-12.
- React 19 profile applies when the diff touches `*.tsx`/`*.jsx` (R-1..R-10).
- Vue 3 profile applies when the diff touches `*.vue` (V-1..V-9).
- Rust profile applies when the diff touches `*.rs` (RU-1..RU-9).
- TanStack Query v5 overlay applies on top of React/Vue when the diff uses
  `@tanstack/react-query` / `@tanstack/vue-query` v5 (TQ-1..TQ-8).

Profiles stack. A React + TanStack task applies React 19 PLUS the TanStack
overlay PLUS the TypeScript default. If profile selection is ambiguous, apply
the TypeScript default and flag the ambiguity as `advisory` under
maintainability — never block on profile selection.

### How layers combine into the verdict

| Outcome | Verdict |
|---|---|
| All Layer-A hard checks pass AND all four axes `pass` (advisories allowed) | `approved` (advisories go in result text) |
| Any Layer-A hard check fails OR any axis sub-check `fail` | `changes_requested` |
| 2+ axes `advisory` even if none `fail` | `changes_requested` (accumulated debt signal) |

The reviewer's `result` MUST include an **Axes** block (one line per axis)
and a **Profile** line naming the applied profile(s), so the next Builder can
read the semantic findings, not just the deterministic numbers.

## What to do (step-by-step)

### Step 1. Claim the task

```
worker_next({
  worker_id: '<reviewer-NN>',
  project_id: <resolved from .saga/project.json>,
  role: 'reviewer'
})
```

If `task` is null → exit (no work). If task's `task_kind` is not
`development.code` (or sibling code kind) → release via `worker_done` with
`result='not a code task'` and exit.

### Step 2. Read the task contract

```
task_get({ id })
```

Extract:
- `source_artifact_ids` — which AC(s) this task implements.
- `source_ref.file` — the file(s) the Builder was supposed to touch.
- `metadata.scaffold_files` — files the scaffold task created (Pattern B).
- `metadata.previous_failures` — earlier review feedback the Builder should
  have addressed.
- `metadata.hint` — operator hint if present.

Read each `source_artifact_id` via `artifact_get`. The AC's `Given/When/Then`
and `properties` block are the **acceptance oracle for behavior**. Code review
checks **craft** (types, size, duplication, scratch), not behavior — behavior
is the verifier's job (L3 property tests).

### Step 3. Enter the worktree

The task's `metadata.worktree.path` (or the registered checkout) contains the
Builder's branch. `cd` into it. Run all subsequent commands from this path.

If the worktree is missing or the branch was already merged →
`worker_done(verdict='approved', result='worktree already merged — nothing to review')`.

### Step 4. Compute the diff scope

```
git fetch origin dev
git diff --name-only origin/dev...HEAD
```

This is the **changed-files list**. If empty → `changes_requested` with
reason "Builder committed nothing."

### Step 5. Check 1 — static types

Run only on changed files (cheaper and avoids pre-existing errors in files
the Builder didn't touch):

```
npx tsc --noEmit
```

Filter the output to only lines whose file appears in the changed-files list.
Collect:
- count of errors per changed file
- the error codes (`TS2304`, `TS2552`, `TS6133`, `TS2345`, ...)

**Hard fail if** any changed file has > 0 TS errors. **Common offenders:**
- `TS6133` (declared but never read) → unused imports; trivial fix.
- `TS2304/TS2552` (cannot find name) → missing import or type drift.
- `TS2345` (argument type mismatch) → signature drift vs port.

### Step 6. Check 2 — file size

```
git diff --name-only origin/dev...HEAD | xargs wc -l
```

For every file ≥ 500 lines:
- Is there an inline justification comment like
  `// long-file-justification: <reason>`?
- If yes → accept. If no → record finding with file path and line count.

The Cannon episode had `orbital.ts` at 946 lines, `renderer.ts` at 908 —
this rule would have flagged both for a split hint.

### Step 7. Check 3 — scratch detection

```
git diff --name-only origin/dev...HEAD | grep -E '(^_|/.+_|\.-?scratch|^_|-report/$|_calc|^tmp|^debug|^test_fixture|^scratch|^experimental|\.bak$|\.orig$|\.awk$|\.old$)'
```

Also scan the diff content for added blocks that look like debugging:
```
git diff origin/dev...HEAD | grep -E '^\+(console\.log|debugger|print\(|// TODO|// FIXME|// XXX|dump\(|inspect\()'
```

**Zero tolerance** for:
- Files matching `_calc*`, `*.scratch`, `*-report/` (build artifact directories
  that should be `.gitignore`'d), `_*` (underscore-prefixed scratch).
- `playwright-report/`, `coverage/`, `.jest-cache/` — should be gitignored.
- Stray `console.log` / `debugger` / `print` / `dump` in production code.

Cannon's `_calc.awk` (177 lines of awk scratch) would have been caught here.

### Step 8. Check 4 — duplication

```
npx jscpd src/ --threshold 20 --format typescript,tsx --reporters console
```

If `jscpd` is not installed:
```
npm install --no-save jscpd
```

Or fall back to ESLint plugin:
```
npx eslint <changed-files> --rule '{"no-dupe-keys": "error", "no-duplicate-imports": "error"}'
```

Record:
- total duplicated blocks across changed files
- % duplication in changed files (target < 5%)

**Hard fail if** duplication in changed files > 5% AND the duplicated blocks
are > 6 lines each (small dupes are tolerable).

### Step 9. Check 5 — ESLint warnings

```
# baseline (from dev)
git stash      # if needed
git checkout origin/dev -- <changed-files>
npx eslint <changed-files> --format json > /tmp/baseline.json
git checkout HEAD -- <changed-files>
git stash pop  # if needed

# current
npx eslint <changed-files> --format json > /tmp/current.json
```

Compute: `current.warningCount - baseline.warningCount`. Negative or zero is
fine. Positive → record the delta and the specific rule IDs.

**Hard fail if** delta > 0 new warnings (Builder should not introduce lint
regressions).

### Step 10. Check 6 — coverage delta

Only if the project has a coverage configuration (`jest.config.*` with
`coverageReporters`, or `c8`, or `vitest` with coverage). Otherwise skip.

```
npm test -- --coverage --coverageReporters=json-summary --changedFilesSince=origin/dev
```

(Or equivalent.) Compute coverage % on the changed lines of changed files.
Compare to `dev` baseline.

**Soft fail if** coverage on changed lines dropped > 5 percentage points.
Record the file and the drop.

### Step 11. Check 7 — build sanity

```
npm run build
```

(Only if `package.json` has a `build` script.) Exit 0 required. If build
fails → record the error output (first 20 lines).

### Step 12. Layer B — pick the framework profile

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Inspect the changed-files list from Step 4 and pick the profile per the table
in [`frameworks.md`](./frameworks.md) §"How to pick the profile":

- TypeScript profile **always** applies (saga repos are TS-first).
- Add React 19 if the diff has `*.tsx`/`*.jsx`.
- Add Vue 3 if the diff has `*.vue`.
- Add Rust if the diff has `*.rs`.
- Add TanStack Query v5 overlay if the diff imports `@tanstack/react-query`
  or `@tanstack/vue-query`.

Record the chosen profile(s) — the `result` MUST include a `Profile:` line.
If ambiguous, apply TypeScript only and flag the ambiguity as `advisory` under
maintainability.

### Step 13. Layer B — apply the four axes

<!-- source: EXT-3 https://github.com/awesome-skills/code-review-skill -->

Walk each axis from [`axes.md`](./axes.md), applying the chosen profile's
refinements where they exist. Produce a per-axis verdict
(`pass` / `fail` / `advisory`):

- **Security (S1–S6)** — plus profile refinements (e.g. Vue `v-html` on
  user input = security fail).
- **Performance (P1–P6)** — plus profile refinements (e.g. React `useEffect`
  with object dep = P5 advisory).
- **Maintainability (M1–M6)** — plus profile refinements.
- **Correctness (C1–C6)** — craft-level only; behavior is the verifier's job.

For each axis finding, record: axis tag (`[security S2]`, `[perf P1]`, etc.),
file:line, and one-line explanation. These go into the `result` BLOCKERS list
(if `fail`) or the ADVISORY block (if `advisory`).

**Do not invent new sub-checks.** The lists in `axes.md` and `frameworks.md`
are the contract. If a real concern is not on either list, record it as
`advisory` under the closest axis and note it for a future skill update — do
not ad-hoc block.

### Step 14. Compile the verdict

Aggregate findings across both layers:

| Verdict | Condition |
|---|---|
| `approved` | All Layer-A hard checks pass AND all four axes `pass` (advisories allowed). Soft Layer-A checks (size, coverage, duplication) and axis advisories go in the result text as **advisory**. |
| `changes_requested` | Any Layer-A hard check fails OR any axis sub-check `fail` OR ≥ 2 axes `advisory`. |

The verdict is the **only** thing the dispatch loop reads. The `result` field
must contain the structured findings (Layer-A numbers, Axes block, Profile
line) so the next Builder can act.

### Step 15. Produce structured result

If `approved`:
```
worker_done({
  task_id,
  worker_id,
  verdict: 'approved',
  result: `CODE-REVIEW: approved
Profile: typescript, react19
- tsc: clean (0 errors in <N> changed files)
- scratch: clean
- size: <max file lines> lines (largest: <path>)
- duplication: <%> in changed files
- eslint: <delta> warnings
- build: PASS
- coverage: <%> on changed lines
Axes:
- security: pass
- performance: advisory (<axis tag + file:line + one-liner> or 'none')
- maintainability: pass
- correctness: pass
Advisory: <if any soft finding>`
})
```

If `changes_requested`:
```
worker_done({
  task_id,
  worker_id,
  verdict: 'changes_requested',
  result: `CODE-REVIEW: changes_requested
Profile: typescript, react19, tanstack-v5

BLOCKERS:
1. [tsc] src/physics/orbital.ts:142 — TS2304 Cannot find name 'TrajectoryResult'. Did you mean 'OrbitResult'? See SRS §2b Port Registry.
2. [scratch] _calc.awk committed — delete or move to scripts/. Add \`*.awk\` to .gitignore.
3. [build] npm run build failed: <first 5 lines of error>
4. [correctness C5] src/ui/save.tsx:88 — mutation onSuccess does not invalidate the list query; UI will show stale data (TanStack TQ-5).

REQUIRED FIXES:
- Fix the 3 TS6133 unused-import errors in src/ui/calculator-form.tsx.
- Remove playwright-report/ from the commit; add to .gitignore.
- Add queryClient.invalidateQueries for the 'list' key in the save mutation.

ADVISORY (non-blocking):
- [perf P5 / R-5] src/ui/list.tsx:42 — child re-renders on every parent render; memoize the inline prop.
- src/physics/orbital.ts is 946 lines. Consider splitting into orbital-core.ts + orbital-validators.ts. Pattern: see SRS §D4.`
})
```

## Verdict semantics

- `approved` → task goes to `done`. The original Builder's worker skill picks
  it up next time the dispatch loop runs and **performs the merge** (T-008).
- `changes_requested` → task goes back to `todo`, fresh Builder picks it up
  on next dispatch. The `result` field is preserved as a comment on the task
  so the new Builder reads the review feedback. The new Builder MUST address
  each blocker; the reviewer will check again on the next review cycle.

## Examples

### Example 1 — clean review (Cannon done right)

Task: `#23 Implement physics-engine/orbital.ts (AC-3: Kepler solver)`.

```
worker_next({ role: 'reviewer' }) → task #23

git diff --name-only origin/dev...HEAD:
  src/physics-engine/orbital.ts
  src/physics-engine/orbital-port.ts
  tests/orbital.test.ts

npx tsc --noEmit:
  # no output (clean)

wc -l src/physics-engine/orbital.ts:
  410 src/physics-engine/orbital.ts

scratch detection: 0 matches

jscpd: 2.1% in changed files (under 5%)

eslint delta: 0 new warnings

npm run build: PASS

Profile (Step 12): typescript (default; no tsx/vue/rs/tanstack in diff)
Axes (Step 13):
  security: pass (S1–S6 — boundary inputs validated, no injection/secret/auth surface in diff)
  performance: pass (no nested loops over unbounded input; no leaks; no sync on hot path)
  maintainability: pass (names match Port Registry; no dead code; no magic values)
  correctness: pass (error paths rethrow/marking; no nullish access; Port type matches exactly)
```

Verdict: `approved`. Result:
```
CODE-REVIEW: approved
Profile: typescript
- tsc: clean (0 errors in 2 changed src files)
- scratch: clean
- size: 410 lines (largest: src/physics-engine/orbital.ts)
- duplication: 2.1% in changed files
- eslint: 0 new warnings
- build: PASS
Axes:
- security: pass
- performance: pass
- maintainability: pass
- correctness: pass
```

### Example 2 — real Cannon-style failure

Task: `#20 Implement calculator-form.tsx (AC-7: form validation)`.

```
git diff --name-only origin/dev...HEAD:
  src/ui/calculator-form.tsx
  _calc.awk            ← SCRATCH
  playwright-report/.last-run.json

npx tsc --noEmit:
  src/ui/calculator-form.tsx:23   TS2304  Cannot find name 'TrajectoryResult'.
  src/ui/calculator-form.tsx:226  TS2552  Cannot find name 'TrajectoryResult'.
  src/ui/calculator-form.tsx:14   TS6133  'useEffect' is declared but never read.

wc -l src/ui/calculator-form.tsx:
  612 src/ui/calculator-form.tsx   ← OVER LIMIT, no justification

scratch detection:
  _calc.awk                          ← MATCH
  playwright-report/.last-run.json   ← MATCH (should be gitignored)
  diff added: console.log(result)    ← DEBUGGING

Profile (Step 12): typescript, react19 (touches .tsx)
Axes (Step 13):
  security: pass
  performance: advisory (R-2 — useEffect dep is an inline object, fires every render)
  maintainability: advisory (M2 — commented-out block at line 140)
  correctness: FAIL (C5 — 'TrajectoryResult' does not match SRS §2b Port Registry 'OrbitResult')
```

Verdict: `changes_requested` (Layer-A hard fails on tsc AND correctness C5 fails).
Result:
```
CODE-REVIEW: changes_requested
Profile: typescript, react19

BLOCKERS:
1. [scratch] _calc.awk — delete from commit. Add `*.awk` to .gitignore.
2. [scratch] playwright-report/.last-run.json — remove from commit. Add `playwright-report/` to .gitignore.
3. [scratch] src/ui/calculator-form.tsx:88 — `console.log(result)` left in production code. Remove or use a guarded logger.
4. [tsc] src/ui/calculator-form.tsx:23,226 — TS2304/TS2552 'TrajectoryResult' does not exist. The SRS §2b Port Registry declares `OrbitResult`. Fix the import and rename. (Also correctness C5 — type-port contract violation.)
5. [tsc] src/ui/calculator-form.tsx:14 — TS6133 unused import 'useEffect'. Remove or use.
6. [size] src/ui/calculator-form.tsx is 612 lines, limit 500. Either:
   (a) add a justification comment at top of file, OR
   (b) split into calculator-form.tsx (form only) + calculator-validation.ts (validators).

REQUIRED FIXES:
- Delete scratch files and update .gitignore.
- Fix the 3 TS errors.
- Address file size (split or justify).

ADVISORY (non-blocking):
- [perf R-2] useEffect at src/ui/calculator-form.tsx:120 dep is an inline object; fires every render. Memoize or derive inside the effect.
- [maintainability M2] Commented-out block at src/ui/calculator-form.tsx:140 — delete.

This is the 2nd review of #20. metadata.previous_failures noted the TS2304
issue was already flagged on review #1 — Builder must address ALL previous
review feedback, not just one item.
```

### Example 3 — soft advisory only

Task: `#31 Refactor renderer.ts (AC-12: 60fps target)`.

```
tsc: clean
scratch: clean
size: renderer.ts 908 lines (over limit, BUT has
      `// long-file-justification: three.js renderer + scene graph + camera rig; split planned in #45`)
eslint: 0 new warnings
duplication: 8.2% in changed files (over 5% soft target)
build: PASS

Profile (Step 12): typescript
Axes (Step 13):
  security: pass
  performance: advisory (P1 — duplicated three.js setup runs O(scenes) per resize; bounded)
  maintainability: advisory (M3 — renderer.ts mixes scene graph + camera rig + resize handler)
  correctness: pass
```

Verdict: `approved` (2 advisories, both non-blocking — the file has a documented
split plan in #45 and the perf concern is bounded by scene count; if the two
advisories were both unbounded/clear-cut, route to `changes_requested` instead).
Result:
```
CODE-REVIEW: approved
Profile: typescript
- tsc: clean
- scratch: clean
- size: 908 lines (justified inline — see comment line 1)
- duplication: 8.2% — advisory: duplicated three.js setup blocks in
  init-scene() and resize-handler(). Extract to setup-three-context().
- eslint: 0 new warnings
- build: PASS
Axes:
- security: pass
- performance: advisory (P1 — duplicated three.js setup; bounded by scene count)
- maintainability: advisory (M3 — file mixes 3 responsibilities; split planned in #45)
- correctness: pass

Advisories noted but non-blocking (split plan documented). Next PR for this file
should address the duplication and the M3 split.
```

## Anti-patterns

- ❌ **Do not approve without running `tsc --noEmit`.** This was the Cannon
  failure mode — phantom reviewer rubber-stamped 36 TS errors into `dev`.
- ❌ **Do not approve without applying the four axes.** Layer A (deterministic)
  is necessary but not sufficient. Walk every axis in `axes.md` (security,
  performance, maintainability, correctness) with the chosen `frameworks.md`
  profile applied. A clean tsc + clean eslint does NOT mean `approved` if an
  axis sub-check (e.g. correctness C5 — type-port contract, or security S2 —
  injection) fails.
- ❌ **Do not check the artifact tree.** You are reviewing code, not the AC
  or SRS. The artifact tree is the requirements reviewers' job. If the AC
  and the code disagree on a type name (Cannon's `TrajectoryResult` drift),
  the right call is `changes_requested` citing the SRS §2b Port Registry —
  but you find this in `tsc` output and the correctness C5 axis, not in
  artifact_get.
- ❌ **Do not call `worker_next` again after `worker_done`.** One task per
  launch.
- ❌ **Do not call `worker_ask_need`.** If you cannot decide (e.g. jscpd is
  not installed and network is down), `approved` with an advisory note.
  Reviewer must never block the pipeline on a human.
- ❌ **Do not merge.** T-008 reviewer-does-merge is for the original Builder
  (saga-worker) on the post-approval cycle. Your job ends at verdict.
- ❌ **Do not invent new standards.** The thresholds in this skill (500 lines,
  5% duplication, 0 lint regression) and the sub-checks in `axes.md` /
  `frameworks.md` are the contract. If you want to tighten them, update those
  files, do not ad-hoc enforce.
- ❌ **Do not skip checks.** Run all 7 Layer-A checks AND all 4 axes even if
  Layer-A check 1 already fails. The Builder needs the full picture to fix
  everything in one rework cycle.
- ❌ **Do not invent an external "approve" shortcut.** The four axes and the
  framework profile exist to inform the `worker_done` verdict, not to bypass
  it. R5: the reviewer never self-authorizes completion — only evidence
  (clean Layer A + clean axes) permits `approved`, and the transition is
  enacted by `worker_done`.

## Rules

- One task = one launch.
- Verdict must cite concrete file:line evidence in `result`.
- `changes_requested` result must enumerate blockers as a numbered list —
  the next Builder parses this format.
- If the same blocker appears in `metadata.previous_failures` and the Builder
  did not address it → escalate severity in the result text (this is a
  repeat offender).
- If the worktree is missing OR the branch was already merged → `approved`
  with note (idempotent safety).
- If the task is not a code task → `approved` with `result='not a code task'`
  to release it without prejudice.
- Never call `worker_merge_acquire` / `worker_merge_release` — that is the
  Builder's job post-approval.
- This skill is read-only on the artifact tree. Only `verification_record`
  and `worker_done` are writes (and only `worker_done` for the review
  verdict).

## CGAD alignment

This skill implements the L0 type-checker gate that CGAD §9 requires but
that Cannon lacked (audit §7.5 recommendation N1). It is the **deterministic
evidence** layer for code craft, parallel to `saga-verifier`'s L3 property
tests for behavior. Together:

| Concern | Skill | Layer |
|---|---|---|
| Behavior (AC contract) | saga-verifier | L3 fast-check property tests |
| Craft (types, size, scratch) | saga-code-reviewer | L0 tsc + linter + duplication |

Neither substitutes for the other. A task can have clean types but fail its
property tests (correct types, wrong algorithm) — `code-reviewer: approved`
+ `verifier: failed`. Or it can pass property tests but be full of unused
imports — `verifier: passed` + `code-reviewer: changes_requested`.

## References

- Plan: `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G3)
- Audit: `docs/research/audit-2026-07-20-cannon-1000-score.md` §7.5
- Related skills: `saga-worker` (Builder + merger), `saga-verifier` (L3 tests),
  `saga-type-fixer` (specialist for cascading tsc failures)
