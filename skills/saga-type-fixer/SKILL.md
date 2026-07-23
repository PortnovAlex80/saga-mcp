---
name: saga-type-fixer
description: "TypeScript diagnostics specialist for domain:types tasks. Triggered when a dev-task is tagged needs-specialist + domain:types. Runs tsc --noEmit, parses diagnostics (file:line:message), categorizes (missing import, type narrowing, generic constraint, unused, drift), and emits a structured plan the dev worker follows. Does NOT edit code — emits a hint."
---

## saga-type-fixer — TypeScript diagnostics specialist

**Source plan:** `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G4)
**Audit motivation:** `docs/research/audit-2026-07-20-cannon-1000-score.md`
§1.2 — Cannon shipped with **36 TS errors in `src/`** (26 of them `TS6133`
unused imports). The phantom reviewer rubber-stamped. The verifier's tests
used `ts-jest` transpile-only, hiding the errors. This skill diagnoses type
errors en masse when a dev-task is stuck on them.

## Why this skill exists

Generalist dev workers (saga-worker) handle one file at a time and treat
type errors as isolated incidents. But type errors come in **cascades**:

- One missing import causes 5 downstream errors.
- One type-drift (SRS declares `TrajectoryResult`, code uses `OrbitResult`)
  causes 8 errors across 3 files.
- One overly-loose `any` causes 20 implicit-any errors in callers.

A worker facing 36 errors will fix them one by one, taking ~3 cycles per
error. Total: 100+ cycles. Cannon's pattern.

This specialist looks at the **whole diagnostic set** and identifies the
**root causes** (often 3-5 of them) that, when fixed, eliminate 80%+ of the
surface errors. It emits a structured plan the dev worker follows in order.

This skill does NOT edit code. It emits a hint, like saga-perf-tuner. The
dev worker applies the fixes (one fix per cycle is fine — they cascade).

## Product-board contract

Same as `saga-worker` — use the assignment's product, epic, repository.
Resolve `project_id` from `.saga/project.json`. This skill is dispatched as
a **claimed task** with `task_kind='specialist.types'` (a sub-kind of
`development.*`).

The dev-task that triggered the consultation remains in `todo` (or
`in_progress` if paused). The specialist task is a separate task that
depends on the dev-task. When the specialist completes, the dev-task's
`metadata.hint` is populated and the dev-task becomes claimable again.

## Flow position

- **Stage:** 4-Development (specialist consultation, parallel to dev-task)
- **Precondition:** A dev-task in this epic has `tags` containing both
  `needs-specialist` and `domain:types`. The orchestrator (or planner) has
  created a `specialist.types` task that `depends_on` the triggering
  dev-task.
- **Postcondition:** The specialist task transitions to `done`. The
  triggering dev-task's `metadata.hint` is updated. The dev-task becomes
  claimable; the next worker reads the hint.

## When to use

Triggered automatically when `worker_next({ role: 'specialist' })` returns
a task with `task_kind='specialist.types'`. The dispatch loop routes
specialist tasks via the task_kind → skill mapping.

Manual invocation (rare):

```
saga-type-fixer --task-id=20
```

Use manually when:
- An operator sees a dev-task looping on TS errors and wants a hint fast.
- A code-reviewer left `changes_requested` due to TS errors and the worker
  is overwhelmed.

Do NOT use:
- For perf issues → use `saga-perf-tuner`.
- For behavior bugs (algorithm wrong, tests fail) → use `saga-verifier`.
- For refactoring (not type-driven) → use saga-worker directly.

## What to do (step-by-step)

### Step 1. Claim the task

```
worker_next({
  worker_id: '<type-fixer-NN>',
  project_id,
  role: 'specialist'
})
```

If `task.task_kind` is not `specialist.types` → release via `worker_done`
with `result='wrong specialist skill'`.

### Step 2. Read the triggering dev-task

```
task_get({ id: task.metadata.trigger_task_id })
```

Extract:
- The AC being implemented (`source_artifact_ids[0]`).
- The file(s) being touched (`source_ref.file`).
- The current `metadata.hint` (may have partial hints — append).
- `metadata.previous_failures` (worker's prior TS error summaries).

### Step 3. Read the AC and the SRS Port Registry

```
artifact_get({ id: <AC id> })
artifact_list({ epic_id, type: 'SRS' })
```

Open the SRS document at `artifact.path`. Read §2b (Port Registry) and
§2.3 (Invariant Registry). These define the canonical type names — when
code disagrees, the SRS wins (or the SRS is wrong and needs an architect
fix; flag if so).

Cannon example: SRS §2b declared `TrajectoryResult`, code used `OrbitResult`.
The fix was either rename in code or update the SRS. The specialist flags
this as a drift root cause.

### Step 4. Enter the worktree

`cd` into `task.metadata.worktree.path`. All commands run from this path.
Read-only access (specialist does not commit).

If the worktree is missing → `worker_done` with `result='worktree not
found — cannot analyze'`.

### Step 5. Run tsc with structured output

```
npx tsc --noEmit --pretty false > /tmp/tsc-output.txt 2>&1
echo "Exit: $?"
wc -l /tmp/tsc-output.txt
```

If `tsc` is not configured (no `tsconfig.json` at the root or in `src/`):
- Check `npm ls typescript`. If not installed → emit hint "TypeScript is
  not installed; run `npm i -D typescript @types/node`".
- If installed but no `tsconfig.json` → emit hint "Missing tsconfig.json;
  create one with `npx tsc --init` and add `"noEmit": true, "strict": true`".

If `tsc` runs but produces > 1000 errors → emit hint "Type system is in
critical state; consider `// @ts-nocheck` on broken files temporarily, then
fix file-by-file. Prioritize src/ over tests/."

### Step 6. Parse diagnostics

Each line of `tsc --pretty false` output looks like:
```
src/physics-engine/orbital.ts(142,10): error TS2304: Cannot find name 'TrajectoryResult'.
src/ui/calculator-form.tsx(14,3): error TS6133: 'useEffect' is declared but its value is never read.
```

Parse into structured records:
```js
{
  file: 'src/physics-engine/orbital.ts',
  line: 142,
  column: 10,
  severity: 'error',  // or 'warning' for TS suggestions
  code: 'TS2304',
  message: "Cannot find name 'TrajectoryResult'."
}
```

Group by `code`. The codes reveal root causes:

### Step 7. Categorize by error code

The common TypeScript error codes and their root-cause categories:

| Code | Category | Root cause pattern | Typical fix |
|---|---|---|---|
| `TS6133` | unused | Builder over-imported; cleanup missed | Remove the import |
| `TS2304` | missing-name | Type referenced but not imported OR type doesn't exist (drift) | Add import OR rename to existing type OR declare new type |
| `TS2552` | missing-name | Same as 2304 but for values | Same |
| `TS2688` | missing-type | Cannot find type definition file (`*.d.ts`) | `npm i -D @types/<pkg>` |
| `TS2345` | arg-mismatch | Argument doesn't match parameter type | Fix the argument or widen the parameter |
| `TS2322` | assign-mismatch | Type 'X' is not assignable to type 'Y' | Type-narrow or convert |
| `TS2339` | property-missing | Property does not exist on type | Add the property OR narrow the type OR cast |
| `TS2741` | property-missing | Property missing in object literal | Add missing required fields |
| `TS2554` | arg-count | Expected N arguments, got M | Add missing args or fix the call |
| `TS2307` | missing-module | Cannot find module | Install the package or fix the path |
| `TS2459` | missing-export | Module exports no such member | Fix the import name OR add the export |
| `TS2532` | nullable | Object is possibly undefined | Add null check or `?.` |
| `TS2531` | nullable | Object is possibly null | Same |
| `TS18046` | unknown-type | X is of type 'unknown' | Type-narrow with typeof or instanceof |
| `TS2344` | constraint-violation | Type does not satisfy constraint | Fix generic constraint |
| `TS2589` | recursion | Type instantiation is excessively deep | Simplify the generic |
| `TS7053` | indexed-access | Element implicitly has 'any' type | Add index signature or use `Record<K, V>` |
| `TS7006` | implicit-any | Parameter implicitly has 'any' type | Add type annotation |

### Step 8. Cluster into root causes

After grouping by code, look for **clusters** — multiple errors that share
a single underlying cause:

**Cluster pattern 1: Single missing import cascading.**
```
src/ui/calculator-form.tsx(23):   TS2304 TrajectoryResult
src/ui/calculator-form.tsx(88):   TS2304 TrajectoryResult
src/ui/calculator-form.tsx(226):  TS2304 TrajectoryResult
src/ui/result-panel.tsx(15):      TS2304 TrajectoryResult
```
→ 4 errors, 1 root cause: `TrajectoryResult` is referenced but not declared
or imported. Fix: either declare it, or rename to `OrbitResult` (SRS Port
Registry says OrbitResult), or add the import.

**Cluster pattern 2: Type drift SRS↔code.**
```
src/physics-engine/orbital.ts(12):  TS2304 TrajectoryResult (referenced)
src/physics-engine/transfers.ts(8): TS2339 'deltaV' on type 'TransferResult'
src/data-service/api.ts(45):        TS2345 argument mismatch, expected TrajectoryResult
```
→ 3 errors in 3 files, all referencing types whose definitions disagree
with the SRS Port Registry. Root cause: SRS says one thing, code says
another. Fix: align code to SRS OR file an architect task to update the SRS.

**Cluster pattern 3: Unused imports (the Cannon 26).**
```
src/ui/calculator-form.tsx(1):    TS6133 'useEffect' unused
src/ui/calculator-form.tsx(3):    TS6133 'useState' unused  (wait, that can't be right)
src/ui/result-panel.tsx(2):       TS6133 'useMemo' unused
... (23 more)
```
→ 26 errors, 26 root causes (each is independent). But they're all the
same category. Fix: bulk-remove unused imports. `eslint --fix
--rule no-unused-vars` or `ts-prune` can automate.

**Cluster pattern 4: Generic constraint failure.**
```
src/data-service/cache.ts(22):  TS2344 'T' does not satisfy constraint 'Serializable'.
src/data-service/cache.ts(58):  TS2344 same
src/data-service/cache.ts(91):  TS2344 same
```
→ 3 errors, 1 root cause: the generic constraint is too narrow. Fix: widen
the constraint OR narrow the call sites.

**Cluster pattern 5: Nullable access.**
```
src/physics-engine/orbital.ts(142):  TS2532 possibly undefined
src/physics-engine/orbital.ts(180):  TS2532 possibly undefined
src/physics-engine/orbital.ts(245):  TS2532 possibly undefined
```
→ 3 errors, 3 sites but 1 underlying issue: the function returns
`Result | undefined` and callers don't null-check. Fix: either change the
return type to throw on miss, or add `?.` / null check at each call site.

### Step 9. Prioritize fixes

Order by **leverage** (errors fixed per fix) and **importance** (blocker
file first):

```
Priority ranking for <epic>:

P0 — type drift (SRS Port Registry)
  Fix: rename TrajectoryResult → OrbitResult across src/ (3 errors in 2 files).
  Also: file an architect task to update SRS §2b if code is canonical.
  Expected: -5 errors (some are cascade).

P1 — unused imports bulk cleanup
  Fix: npx eslint --fix --rule '"@typescript-eslint/no-unused-vars": "warn"'
  Expected: -26 errors (Cannon-style TS6133 cluster).

P2 — nullable access in orbital.ts
  Fix: add ?? default at 3 call sites OR change getOrbit() return type.
  Expected: -3 errors.

P3 — generic constraint in cache.ts
  Fix: widen constraint to `extends Serializable | string | number`.
  Expected: -3 errors.

P4 — single missing module
  Fix: npm i -D @types/jest
  Expected: -X errors in tests/ (out of src/ scope but worth noting).
```

### Step 10. Synthesize the hint

The hint is a structured markdown block saved to the triggering dev-task's
`metadata.hint`. Format:

```markdown
# TYPE-FIXER HINT — <AC code> (<AC title>)

## Diagnosis

**Total TS errors:** 36 in src/ (target: 0).
**Clustered root causes:** 5 (fixing all 5 eliminates 34/36 errors).
**Remaining 2 errors:** isolated, fix individually.

## Root cause clusters (fix in priority order)

### Cluster P0: Type drift (SRS ↔ code) — 5 errors

**Files affected:**
- src/physics-engine/orbital.ts:142,180 — references `TrajectoryResult`
- src/ui/calculator-form.tsx:23,226 — references `TrajectoryResult`
- src/data-service/api.ts:45 — function signature uses `TrajectoryResult`

**Root cause:** SRS §2b Port Registry declares `OrbitResult`. Code uses the
non-existent `TrajectoryResult`. Either code drifted, or SRS is wrong.

**Recommended fix (code → match SRS):**
```bash
# rename across src/
find src -name '*.ts' -o -name '*.tsx' | xargs sed -i 's/TrajectoryResult/OrbitResult/g'
```
Then verify with `npx tsc --noEmit` — 5 errors should disappear.

**Alternative (SRS → match code):** If `TrajectoryResult` is the better name,
file a `formalization.srs` task to update §2b. Slower route; only choose if
the code name is materially clearer.

### Cluster P1: Unused imports — 26 errors

**Pattern:** TS6133 across 14 files. Cannon-style cleanup miss.

**Recommended fix:**
```bash
npx eslint --fix \\
  --rule '"@typescript-eslint/no-unused-vars": ["warn", {"argsIgnorePattern": "^_"}]' \\
  'src/**/*.{ts,tsx}'
```
Then re-run `npx tsc --noEmit`. Expected: -26 errors.

**Manual fallback** (if eslint auto-fix is incomplete):
- src/ui/calculator-form.tsx:14 — remove `useEffect` import (unused).
- src/ui/result-panel.tsx:2 — remove `useMemo` import (unused).
- ... (full list in /tmp/unused-imports.txt)

### Cluster P2: Nullable access — 3 errors

**Files affected:**
- src/physics-engine/orbital.ts:142 — `getOrbit()` returns `OrbitResult | undefined`
- src/physics-engine/orbital.ts:180 — same
- src/physics-engine/orbital.ts:245 — same

**Recommended fix (call-site null check):**
```ts
// Before
const orbit = getOrbit(input);
console.log(orbit.deltaV);  // TS2532

// After
const orbit = getOrbit(input);
if (!orbit) throw new Error(`no orbit for input: ${input}`);
console.log(orbit.deltaV);
```

**Alternative (change return type):** If callers never handle undefined
gracefully, change `getOrbit` to throw on miss. Then undefined branch
disappears. This is a contract change — update SRS §2b if so.

### Cluster P3: Generic constraint — 3 errors

**Files affected:**
- src/data-service/cache.ts:22,58,91 — `T does not satisfy Serializable`

**Recommended fix:** Widen the constraint:
```ts
// Before
class Cache<T extends Serializable> { ... }

// After
class Cache<T extends Serializable | string | number | boolean> { ... }
```

### Isolated errors (fix individually)

- src/app-shell/router.tsx:45 — TS2554 expected 2 args, got 1. Add the
  missing `key` arg to `navigate()`.
- src/app-shell/store.ts:12 — TS7053 indexed access implicit any. Add
  `Record<string, Widget>` instead of `{ [k: string]: Widget }`.

## Verification

After applying P0-P3 + isolated fixes:
- `npx tsc --noEmit` should report 0 errors in src/.
- `npm test` continues to pass (these are type-only changes).
- `npm run build` succeeds.

If P0 is the SRS-update route (not code-rename), file the formalization task
before applying P1-P3 — code rename is blocked on SRS decision.

## References

- SRS §2b Port Registry: OrbitResult (NOT TrajectoryResult)
- SRS §2.3 Invariant Registry: INV-PHYS-1 (orbit positivity)
- Prior episode voyager-skill note: "Builder must clean unused imports
  before worker_done (TS6133 cluster pattern)" (REQ-001-Cannon retro)
```

### Step 11. Save the hint

```
patchTaskMetadata({
  task_id: <triggering dev-task id>,
  path: 'hint',
  value: <hint markdown>
})
```

Or fallback via `task_update` with merged metadata (see saga-perf-tuner
Step 11 for fallback pattern).

### Step 12. Complete the specialist task

```
worker_done({
  task_id,
  worker_id,
  result: `TYPE-FIXER: hint emitted for task #<dev-task-id>
- Total errors: 36
- Root causes identified: 5 clusters (cover 34/36 errors)
- Top fix: <Cluster P0 summary>
- Hint saved to metadata.hint (<length> chars)
The dev worker should apply P0 first (cascade), then P1, P2, P3.
Expected after all fixes: 0 TS errors in src/.`
})
```

## Verdict / Output

Like `saga-perf-tuner`, this skill does not approve or reject. It emits a
**hint** containing a prioritized fix plan. The dev worker applies the
fixes in order.

If the worker applies the hint and new errors appear (the cascade revealed
more), the worker can re-trigger this specialist with a more focused scope.

The hint format is concrete: each cluster has a code snippet, an expected
error reduction, and an alternative if applicable. Vague hints ("improve
types") cause loops; concrete hints end them.

## Examples

### Example 1 — Cannon-style 36 errors (condensed)

Triggering task: `#20 Implement calculator-form.tsx (AC-7)`. Worker has
retried 4 times; code-reviewer keeps returning `changes_requested` on
TS errors.

```
worker_next({ role: 'specialist' }) → task #20-S1 (specialist.types)

npx tsc --noEmit --pretty false | wc -l
  36

Parse + cluster:
  TS6133 unused: 26 (cluster P1)
  TS2304 TrajectoryResult: 5 (cluster P0 — drift)
  TS2532 nullable: 3 (cluster P2)
  TS2554 arg-count: 1 (isolated)
  TS7053 indexed-access: 1 (isolated)

Hint emitted with P0-P3 + isolated.
```

Worker applies P0 (rename) → 5 errors gone. Then P1 (eslint --fix) → 26
gone. Then P2 (null checks) → 3 gone. Then 2 isolated fixes. Final tsc:
0 errors. Code-reviewer approves on retry 5.

### Example 2 — generic constraint cascade

Triggering task: `#38 Implement data-service/cache.ts (AC-9)`.

```
npx tsc --noEmit:
  src/data-service/cache.ts:22  TS2344 T does not satisfy 'Serializable'
  src/data-service/cache.ts:58  TS2344 same
  src/data-service/cache.ts:91  TS2344 same
  src/data-service/api.ts:12    TS2344 Cache<User> fails constraint
  src/data-service/api.ts:34    TS2344 Cache<Order> fails constraint

Cluster: 5 errors, 1 root cause (overly-narrow constraint).

Hint: widen `T extends Serializable` to `T extends Serializable | string | number`.
Expected: -5 errors.
```

### Example 3 — missing @types package

Triggering task: `#15 Implement tests/setup.ts (AC-2)`.

```
npx tsc --noEmit:
  tests/setup.ts:1  TS2688 Cannot find type definition file for 'jest'.
  ... 100+ cascade errors in tests/

Cluster: 1 root cause (missing @types/jest).

Hint:
  npm i -D @types/jest @types/node
  Add to tsconfig.json:
    "types": ["jest", "node"]
  Add to tsconfig.test.json (if separate):
    "compilerOptions": { "types": ["jest"] }

Expected: -100+ errors.
```

### Example 4 — minor isolated errors

Triggering task: `#28 Implement ui/result-panel.tsx (AC-8)`. Only 2 errors.

```
npx tsc --noEmit:
  src/ui/result-panel.tsx:42  TS2339 'deltaV' does not exist on 'OrbitResult'
  src/ui/result-panel.tsx:88  TS2554 expected 1 arg, got 0

Diagnosis: not a cluster — 2 isolated errors. No cascade to exploit.

Hint: fix each directly.
- Line 42: OrbitResult doesn't have deltaV; it's TransferResult. Either
  change the type or change the property.
- Line 88: format() takes a format string; pass it.
```

## Anti-patterns

- ❌ **Do not edit code.** Specialist emits hints; dev worker applies. Edit
  conflicts are not worth the speed.
- ❌ **Do not propose "rewrite the file."** Even if a rewrite is technically
  cleaner, the dev worker's job is incremental. Propose minimal diffs.
- ❌ **Do not propose >5 clusters.** Pick the top-5 by error count. The rest
  go in "isolated errors" with one-line fixes.
- ❌ **Do not invent type names.** Every type referenced in a fix must exist
  in the SRS §2b Port Registry OR be declared in the hint (with code).
  Cannon's TrajectoryResult drift came from someone inventing a type name.
- ❌ **Do not call `worker_done` with `verdict='changes_requested'`.**
  Specialist consultation, not review. Always approved (or no verdict per
  worker_done spec).
- ❌ **Do not run `npm test`.** Tests are verifier's job. Specialist runs
  `tsc` only.
- ❌ **Do not suppress errors with `// @ts-ignore` or `any`.** These hide
  the problem; code-reviewer will reject. Propose real fixes.
- ❌ **Do not skip the SRS Port Registry check.** Half of type drift comes
  from code disagreeing with the SRS. Always check §2b before recommending
  a type name.
- ❌ **Do not recommend `tsconfig` loosening (strict: false) as a fix.**
  Lowering strictness is a regression. The fix is to make the code
  type-correct.

## Rules

- One task = one launch.
- Hint must include: (a) total error count, (b) clustered root causes with
  leverage (errors fixed per cluster), (c) prioritized fix order, (d)
  concrete code snippets, (e) expected post-fix error count.
- Hint must cite SRS §2b Port Registry for any type-name recommendation.
- Hint must NOT recommend `any`, `@ts-ignore`, or strictness loosening.
- Hint should reference prior voyager-skill notes if applicable
  (e.g. "TS6133 cluster pattern — apply eslint --fix").
- Hint must NOT modify code. Save to `metadata.hint` only.
- If tsc is not installed → emit minimal hint "install TypeScript" and exit.
- If tsc reports > 1000 errors → emit hint "critical type system state;
  consider file-by-file triage with `// @ts-nocheck` on tests/ first."
- Specialist task's `worker_done` result must include the triggering
  dev-task ID so the orchestrator can verify the hint was delivered.
- If the dev-task's previous hint already addressed some clusters, append
  (do not overwrite). Note "P0 from prior hint: applied. New clusters: ..."

## CGAD alignment

This skill is a **specialist layer** for the type domain. It complements
`saga-code-reviewer` (which runs `tsc` as a gate) by providing the
diagnosis when `tsc` fails. Together:

| Stage | Skill | Action |
|---|---|---|
| Review (gate) | saga-code-reviewer | Runs `tsc --noEmit`, returns `changes_requested` on errors |
| Specialist (consultation) | saga-type-fixer | Diagnoses the errors, emits fix plan |
| Dev (rework) | saga-worker | Applies the fix plan |
| Verification | saga-verifier | Independent property tests (different concern) |

| CGAD principle | This skill's role |
|---|---|
| P7 (independence) | Specialist is a separate worker; hint is advisory |
| P14 (deny-by-default) | Specialist does not approve ACs |
| §9 (test layers) | Specialist does not generate tests |
| L0 (type-checker) | This skill is the L0 diagnosis layer |

## References

- Plan: `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G4)
- Audit: `docs/research/audit-2026-07-20-cannon-1000-score.md` §1.2 (TS errors)
- Related skills: `saga-worker` (consumes hint), `saga-code-reviewer`
  (runs tsc as a gate; triggers this specialist on `changes_requested`),
  `saga-perf-tuner` (sister specialist for perf domain), `saga-architect`
  (owns SRS §2b Port Registry — file drift here if code is canonical)
