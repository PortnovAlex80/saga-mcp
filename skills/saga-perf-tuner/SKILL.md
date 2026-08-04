---
name: saga-perf-tuner
description: "Performance/bundle specialist for domain:perf tasks. Triggered when a dev-task is tagged needs-specialist + domain:perf. Analyzes bundle (npm run build, du -sh dist/assets), finds heavy imports (vendor-three.js 612KB etc.), proposes code-splitting/lazy-import/port-impl split patterns. Does NOT edit code — emits a hint consumed by the dev worker."
---

## saga-perf-tuner — performance & bundle diagnosis specialist

**Source plan:** `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G4)
**Audit motivation:** `docs/research/audit-2026-07-20-cannon-1000-score.md`
§5 — Cannon's #31 burned 38 retry cycles (~95 min) on the Three.js lazy-load
fix. A generalist worker could not diagnose the bundle; an operator hint
solved it in 5 minutes. This skill replaces the operator with a specialist.

**Augmented by** the measure-first loop and anti-premature-optimization
checklist (see "Measure-first discipline" below) borrowed from the
performance-optimization external skill, and by the profiler command catalog
in the sibling file `profiler-catalog.md` borrowed from the performance-profiler
external skill. Borrowed sections are marked inline with `<!-- source: EXT-N -->`.

## Why this skill exists

Generalist dev workers (saga-worker) can write feature code but are bad at
performance diagnosis. The reasons:

1. **Bundle analysis is not in the dev loop.** Workers run `npm test`, not
   `npm run build && du -sh dist/assets/*`. They don't see bundle size.
2. **Heavy-import detection requires reading the build output**, not the
   source. A `import * as THREE from 'three'` looks innocent in code but
   pulls 612KB into the bundle.
3. **Code-splitting patterns are non-obvious.** `React.lazy`, dynamic
   `import()`, manualChunks, port/impl split — choosing the right one
   requires looking at the dependency graph.

When a worker hits a perf-tagged AC (Lighthouse budget, 60fps, bundle size),
it loops. Cannon's #31 hit this exact wall 38 times. Each loop costs ~3 min
of wall clock plus tokens. The operator's hint ("split renderer.ts into
port and impl, lazy-load the impl") unblocked it instantly.

This skill is the **operator's hint, automated**. It runs as a one-shot
consultation: reads the bundle, finds the heavy spots, emits a structured
hint that the dev worker consumes on its next retry.

## Product-board contract

Same as `saga-worker` — use the assignment's product, epic, repository.
Resolve `project_id` from `.saga/project.json`. This skill is dispatched as
a **claimed task** with `task_kind='specialist.perf'` (a sub-kind of
`development.*`).

The dev-task that triggered the consultation remains in `todo` (or
`in_progress` if the worker paused). The specialist task is a separate task
that depends on the dev-task. When the specialist completes, the dev-task's
`metadata.hint` is populated and the dev-task becomes claimable again.

## Flow position

- **Stage:** 4-Development (specialist consultation, parallel to dev-task)
- **Precondition:** A dev-task in this epic has `tags` containing both
  `needs-specialist` and `domain:perf`. The orchestrator (or planner) has
  created a `specialist.perf` task that `depends_on` the triggering
  dev-task's *current attempt*.
- **Postcondition:** The specialist task transitions to `done`. The
  triggering dev-task's `metadata.hint` is updated (via
  `task_update({ id, metadata: { hint: <structured hint> } })` or via
  patchTaskMetadata helper B1). The dev-task becomes claimable; the next
  worker reads the hint.

## When to use

Triggered automatically when `worker_next({ role: 'specialist' })` returns
a task with `task_kind='specialist.perf'`. The dispatch loop routes
specialist tasks to this skill via the task_kind → skill mapping maintained
by the orchestrator.

Manual invocation (rare):

```
saga-perf-tuner --task-id=31
```

Use manually when:
- An operator sees a dev-task looping on a perf AC and wants a hint fast.
- A code-reviewer flagged a perf concern and wants the specialist to weigh
  in before approving.

Do NOT use:
- For type errors → use `saga-type-fixer`.
- For security concerns → there is no specialist yet; route to
  saga-code-reviewer with `domain:security` tag.
- For behavior bugs → use `saga-verifier` (L3 property tests).

## Measure-first discipline

<!-- source: EXT-9 https://claudemarketplaces.com/skills/akillness/oh-my-skills/performance-optimization
     (the "scientific debugging applied to performance" measure-first loop:
      hypothesis -> profile -> interpret -> change -> re-profile) -->

This skill is **measure-first**. You never emit a hint naming a fix unless a
profile (or a build-size measurement) shows that fix's bottleneck. Guesses are
how Cannon #31 burned 38 retry cycles — the operator's *measured* hint ended it
in 5 minutes.

The measure-first loop, applied to a perf consultation:

1. **Hypothesis** — Read the AC's perf budget and the prior failure summaries.
   State one falsifiable hypothesis, e.g. "the initial bundle exceeds 150KB
   gzip because `three.js` is imported eagerly into the entry point." Write it
   in the hint's `Diagnosis` before you measure.
2. **Profile** — Run the profiler that matches the hypothesis. Bundle-size
   hypothesis -> `du`/`source-map-explorer`. CPU hypothesis -> `--cpu-prof`
   or `0x`. Memory hypothesis -> `--heap-prof`. Pick commands from
   `profiler-catalog.md`. Capture a **baseline** profile *before* describing
   any fix.
3. **Interpret** — Read the profile, not your prior belief. A flame graph is
   read by sample mass, not tallest bar (see `profiler-catalog.md` ->
   "Interpreting a flame graph"). If the profile contradicts the hypothesis,
   revise the hypothesis; do not ship the original guess.
4. **Change (as a hint)** — Propose the concrete fix (file path, import line,
   code snippet) in the hint. The specialist does not apply it; the dev worker
   does.
5. **Re-profile** — State in the hint's `Verification` section what the dev
   worker must re-measure, and the target number (e.g. "re-run `du -sh
   dist/assets/*`; expect vendor-three.js to move out of the initial bundle").
   Compare before/after with the **same** profiler and workload. If the
   re-profile does not show the expected improvement, the hypothesis was wrong.

### Anti-premature-optimization checklist

<!-- source: EXT-9 — anti-premature-optimization checklist -->

Run this before writing the `Recommended fixes` section of any hint. Every item
must be satisfiable, or you stop and say so in the hint instead of guessing.

- [ ] **There is a measured bottleneck.** A profile or build-size number shows
      the hot spot. No number -> no fix.
- [ ] **The bottleneck is on the AC's perf-critical path.** Optimizing code
      that is not in the budget's scope is wasted work (and re-reading it burns
      the dev worker's context).
- [ ] **The budget is known.** "Lighthouse ≥80", "≤150KB gzip", "60fps" — a
      number from the AC or PRD NFR. No budget -> emit "no perf budget declared;
      nothing to tune" and exit (see Anti-patterns).
- [ ] **The fix is specific.** A file path, an import line, a code snippet.
      "Consider lazy-loading" fails this check.
- [ ] **The expected improvement is quantified.** "vendor-three.js drops out of
      the initial bundle, ~612KB -> ~0KB eager, ~190KB gzip -> ~60KB gzip."
- [ ] **The fix is not below the noise floor.** A 2KB saving on a 612KB bundle
      is noise; don't propose it as a top fix.

If any checkbox fails, the proposed change is premature optimization. Drop it,
or gather the missing measurement first. The specialist measures; it does not
speculate.

## What to do (step-by-step)

### Step 1. Claim the task

```
worker_next({
  worker_id: '<perf-tuner-NN>',
  project_id,
  role: 'specialist'
})
```

If `task.task_kind` is not `specialist.perf` → release via `worker_done`
with `result='wrong specialist skill'`.

### Step 2. Read the triggering dev-task

```
task_get({ id: task.metadata.trigger_task_id })
```

Extract:
- The AC being implemented (`source_artifact_ids[0]`).
- The file(s) being touched (`source_ref.file`).
- The current `metadata.hint` (may already have partial hints — append,
  don't overwrite).
- The previous attempts (`metadata.previous_failures`).
- The worker's `result` summaries from prior cycles.

### Step 3. Read the AC and its perf budget

```
artifact_get({ id: <AC id> })
```

Extract the AC's performance contract:
- NFR-1: "Lighthouse score ≥80" → budget on JS bundle size (~150KB
  initial), CSS, runtime.
- NFR-3: "60fps on mid-tier hardware" → budget on per-frame work
  (<16ms), render loop, allocations.
- NFR-X: "Bundle size ≤ 250KB gzipped" → hard size budget.

If the AC has no perf contract (just a generic "should be fast"), infer
from the PRD's NFR section:
```
artifact_list({ epic_id, type: 'NFR' })
```

### Step 4. Enter the worktree

`cd` into `task.metadata.worktree.path` (or the registered checkout). All
commands run from this path. The worktree is the dev-task's worktree —
the specialist shares it read-only (does not commit).

If the worktree is missing → `worker_done` with `result='worktree not
found — cannot analyze'`. The orchestrator will reschedule.

### Step 5. Build the project

The build is the first measurement — it produces the bundle the budget is
measured against. This step is part of the measure-first loop
("Profile" phase for a bundle-size hypothesis).

```
npm run build 2>&1 | tee /tmp/build.log
```

Capture:
- Exit code (0 = success).
- Build warnings (especially "module too large", "tree-shaking skipped").
- Build output directory (usually `dist/`).

If build fails → analyze the failure. If the failure is itself a perf
problem (e.g. "module larger than 500KB limit" via Webpack performance
hints), record it. If the failure is unrelated (TS error, missing dep),
emit hint "fix build first; perf diagnosis deferred" and exit.

### Step 6. Measure the bundle

This is the "Profile" phase of the measure-first loop for a bundle-size
hypothesis. Bundle measurement is a profiler too — see `profiler-catalog.md`
-> "How to choose a profiler" (row: "Bundle size over budget").

```
du -sh dist/ dist/assets/* 2>/dev/null | sort -h
```

Or for gzipped size (more accurate for budget comparison):
```
find dist/assets -name '*.js' -exec gzip -c {} \; | wc -c
```

Or use `webpack-bundle-analyzer` / `rollup-plugin-visualizer` if installed:
```
ANALYZE=true npm run build  # if the build script honors this env
```

Identify:
- Total bundle size (raw + gzip).
- Top-5 largest assets.
- Per-vendor breakdown: three.js, react, lodash, moment, etc.

### Step 7. Find heavy imports

For each large vendor chunk, trace which source file imports it:
```
grep -rn "from 'three'" src/ tests/ 2>/dev/null
grep -rn "from 'lodash'" src/ tests/ 2>/dev/null
grep -rn "from 'moment'" src/ tests/ 2>/dev/null
```

Common offenders and known mitigations:

| Library | Typical size | Mitigation |
|---|---|---|
| `three` (whole) | ~612KB | `import * as THREE` → named imports; or dynamic `import()` for scenes |
| `lodash` (whole) | ~70KB | `import _ from 'lodash'` → `import debounce from 'lodash/debounce'` |
| `moment` | ~230KB | Replace with `date-fns` (tree-shakeable) |
| `rxjs` (whole) | ~150KB | `import { of } from 'rxjs'` (named) |
| `@fortawesome/free-solid-svg-icons` (whole) | ~1MB | Import icons individually |
| `core-js` (whole) | ~200KB | Use `.browserslistrc` to scope polyfills |

### Step 8. Detect code-splitting opportunities

Identify routes/views that could be lazy-loaded:
```
grep -rn "import .* from '\\./" src/ | grep -v "import type"
```

For each route/view imported eagerly in the entry point, ask:
- Is this view needed at bootstrap? If not → `React.lazy(() => import('./X'))`.
- Is this view's data dependency heavy (e.g. three.js scene)? If yes →
  dynamic `import()` inside an effect.

For each port/impl pair (per SRS §2b Port Registry):
- Is the port (types only) imported in the entry? Good — cheap.
- Is the impl imported in the entry? Bad — should be lazy-loaded or
  injected via DI.

Cannon pattern: split `renderer.ts` into `renderer-port.ts` (types, ~50
lines, eager) and `renderer-impl.ts` (three.js code, ~800 lines, lazy).

### Step 9. Detect runtime perf issues

If the AC is a 60fps / per-frame budget (not a bundle budget), switch from
bundle measurement to a **runtime profiler**. Do not diagnose a CPU/frame
problem from source alone — capture a profile first (measure-first loop).

For the TS/Node stack the relevant profilers are `node --cpu-prof`, `0x`,
`clinic flame`, and `clinic doctor`; for event-loop stalls use
`--trace-event-categories` or `clinic bubbleprof`; for native frames use Linux
`perf`. Full command catalog and "when to use each":
`profiler-catalog.md`.

A representative run is required. If the worktree has a benchmark script
(`npm run bench`, a `bench/` dir), use it. If not, capture the profile during
the smoke/startup path and note in the hint that the dev worker must re-profile
on the real workload before trusting the numbers.

Then look at the render loop code:

```
grep -rn "requestAnimationFrame\\|setInterval\\|render(" src/
```

Common offenders:
- Allocations inside the render loop (GC pauses).
- Synchronous heavy work per frame (e.g. recomputing matrices).
- Unbatched DOM mutations (React re-rendering whole tree per frame).
- Unoptimized shaders (compilation per frame, uniform updates per frame).

If Chrome DevTools Performance panel is available (it's not in headless
env), note that the operator may need to run it manually. Otherwise,
synthesize advice based on code patterns.

### Step 10. Synthesize the hint

The hint is a structured markdown block saved to the triggering dev-task's
`metadata.hint`. Format:

```markdown
# PERF HINT — <AC code> (<AC title>)

## Diagnosis

**Bundle size:** 612KB raw / 187KB gzip (target ≤ 150KB gzip).
**Largest offenders:**
1. dist/assets/vendor-three.js — 612KB (three.js imported wholesale)
2. dist/assets/index.js — 145KB (your code; OK)
3. dist/assets/vendor-react.js — 45KB (unavoidable)

**Root cause:** `src/visualization/renderer.ts:14` imports
`* as THREE from 'three'`. The entire library ships to the client even
though only Scene, PerspectiveCamera, and WebGLRenderer are used.

## Recommended fixes (in priority order)

### Fix 1: Split renderer.ts into port + impl (Pattern: port/impl split)

Create:
- `src/visualization/renderer-port.ts` — types and the `RendererPort`
  interface only (~50 lines, no three.js import).
- `src/visualization/renderer-impl.ts` — the actual three.js code
  (~800 lines, imports three.js).

Update imports:
- `src/app-shell/main.tsx` imports `renderer-port.ts` eagerly (cheap).
- `src/visualization/scene-loader.ts` dynamic-imports `renderer-impl.ts`
  inside `useEffect`:
  ```ts
  useEffect(() => {
    let cancelled = false;
    import('./renderer-impl').then(({ createRenderer }) => {
      if (cancelled) return;
      const renderer = createRenderer(canvas);
      // ...
    });
    return () => { cancelled = true; };
  }, []);
  ```

Expected effect: vendor-three.js moves out of initial bundle, lazy-loaded
on demand. Initial bundle drops to ~190KB raw / 60KB gzip. Lighthouse
score improves by ~20-30 points.

### Fix 2: Configure manualChunks in vite.config.ts (Pattern: vendor split)

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-three': ['three'],
        'vendor-react': ['react', 'react-dom'],
      }
    }
  }
}
```

This is a complement to Fix 1, not a substitute. It lets the browser cache
vendor chunks separately.

### Fix 3: Tree-shake lodash (if applicable)

`src/data-service/calc.ts:3` imports `import _ from 'lodash'`. Change to:
```ts
import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
```
Expected effect: -70KB from initial bundle.

## Verification

After applying Fix 1+2:
- `npm run build` should produce separate chunks for vendor-three,
  vendor-react, index.
- Initial JS load ≤ 200KB raw / 65KB gzip.
- Lighthouse audit (manual — needs Chrome) should show Performance score
  ≥ 80.

## References

- SRS §2b Port Registry: RendererPort declared at src/visualization/renderer-port.ts
- SRS §9 Technology Stack: Vite + React 18 + three.js
- Prior episode voyager-skill note: "vendor-three.js lazy-load for any 3D
  view" (REQ-001-Cannon retro)
```

### Step 11. Save the hint

Two options depending on what helper is available:

**Option A (preferred, B1 helper):**
```
patchTaskMetadata({
  task_id: <triggering dev-task id>,
  path: 'hint',
  value: <hint markdown>
})
```

**Option B (fallback):**
```
const triggerTask = task_get({ id: <triggering dev-task id> });
const newMetadata = { ...triggerTask.metadata, hint: <hint markdown> };
task_update({
  id: <triggering dev-task id>,
  metadata: newMetadata
});
```

Either way, the dev-task now has `metadata.hint` populated. The dev worker
claiming it next will consume the hint per saga-worker skill (C3 in the
v2.2 plan).

### Step 12. Complete the specialist task

```
worker_done({
  task_id,
  worker_id,
  result: `PERF-TUNER: hint emitted for task #<dev-task-id>
- Diagnosis: <1-line summary>
- Top fix: <1-line summary>
- Hint saved to metadata.hint (<length> chars)
The dev worker should re-attempt with the hint. Expected improvement:
<metric>.`
})
```

## Verdict / Output

This skill does not approve or reject. It emits a **hint**. The dev worker
decides whether to apply it. If the worker applies the hint and the AC
still fails verification, the worker can re-trigger this specialist (a new
`specialist.perf` task is created with a more focused scope).

The hint format is prescriptive (concrete code snippets, file paths, expected
metrics) — not vague ("consider lazy-loading"). Vague hints cause the worker
to loop again. Concrete hints end the loop.

## Examples

### Example 1 — Three.js bundle (Cannon #31)

Triggering task: `#31 Implement visualization/renderer.ts (AC-12: 60fps)`.
Worker has retried 5 times; verifier keeps recording `unknown` because
Lighthouse cannot run in headless env, but the build is also over budget.

```
worker_next({ role: 'specialist' }) → task #31-S1 (specialist.perf)

npm run build:
  dist/assets/vendor-three.js   612.34 KB
  dist/assets/index.js          145.12 KB
  dist/assets/vendor-react.js    45.67 KB
  dist/assets/index.css           8.21 KB
  Total                         811.34 KB (gzip: 248 KB)

grep "from 'three'" src/:
  src/visualization/renderer.ts:14:  import * as THREE from 'three';

Diagnosis: three.js imported wholesale, all 612KB ships eagerly.

Hint emitted (condensed):
- Split renderer.ts → renderer-port.ts + renderer-impl.ts
- Dynamic import renderer-impl.ts in scene-loader.ts
- Expected: initial bundle 811KB → 200KB (-75%)
```

Worker applies the hint on retry 6. Build succeeds, bundle drops, verifier
records `passed` (or `unknown` for Lighthouse specifically, which is now
`degradable` per readiness-checker). Loop ends.

### Example 2 — Lodash tree-shaking

Triggering task: `#42 Implement data-service/calc.ts (AC-8: calc API)`.

```
npm run build:
  dist/assets/index.js    178 KB  (suspicious — calc API should be small)

grep "from 'lodash'" src/:
  src/data-service/calc.ts:3:  import _ from 'lodash';
  src/data-service/calc.ts:45: _.debounce(...)
  src/data-service/calc.ts:80: _.throttle(...)

Diagnosis: full lodash import for 2 functions. 70KB wasted.

Hint emitted:
- Replace `import _ from 'lodash'` with named imports.
- Expected: -70KB from initial bundle.
```

### Example 3 — 60fps render loop

Triggering task: `#55 Implement scene-loop.ts (AC-15: 60fps)`.

```
grep "requestAnimationFrame" src/:
  src/visualization/scene-loop.ts:22:  function loop() {
    matrix.compute();      // heavy: 8ms
    scene.traverse(...);   // heavy: 5ms
    renderer.render();     // 2ms
    requestAnimationFrame(loop);
  }

Diagnosis: 15ms compute+traverse per frame → 60fps budget (16ms) exceeded.

Hint emitted:
- Cache matrix computation outside the loop (depends on view, not per-frame).
- Batch scene.traverse updates; avoid per-frame allocations.
- Expected: 15ms → 3ms per frame; 60fps achievable.
```

## Anti-patterns

- ❌ **Do not edit code.** The specialist emits hints; the dev worker applies
  them. Editing code from a specialist task creates a merge conflict with
  the dev task's worktree.
- ❌ **Do not emit vague hints.** "Consider lazy-loading" is useless. Name
  the file, name the import, give the code snippet. The dev worker has
  limited context — spoon-feed the fix.
- ❌ **Do not propose >3 fixes.** The dev worker will get overwhelmed and
  apply none. Pick the top-3 by impact/cost.
- ❌ **Do not call `worker_done` with `verdict='changes_requested'`.** This
  is a specialist consultation, not a review. Always `approved` (or no
  verdict — see worker_done spec).
- ❌ **Do not run `npm test`.** Tests are the verifier's job. The specialist
  measures bundle and code patterns only.
- ❌ **Do not run Lighthouse.** It needs Chrome, which the headless env
  lacks. The specialist diagnoses from code + build output, not from a
  Lighthouse run. If Lighthouse is truly required, mark the AC
  `criticality=degradable` and let the verifier record `unknown`.
- ❌ **Do not invent numbers.** If you cannot measure the bundle (build
  broken), say so in the hint. Fabricated metrics will mislead the dev
  worker.
- ❌ **Do not propose a fix without a profile showing its bottleneck.** This is
  the core measure-first rule (see "Measure-first discipline"). A guess dressed
  up as a hint sends the dev worker back into the retry loop — exactly what
  Cannon #31 suffered. If you cannot measure, the honest hint is "could not
  profile <reason>; perf diagnosis deferred," not a fabricated fix.

## Rules

- One task = one launch.
- **Every fix in the hint must trace to a measured bottleneck** (measure-first
  discipline). "Measured numbers" means a profiler or build-size reading taken
  in this consultation, not a remembered or assumed value.
- Hint must include: (a) diagnosis with measured numbers, (b) ≥1 concrete
  fix with code snippet, (c) expected metric improvement, (d) verification
  step that names the profiler/command to re-run for the before/after
  comparison (see `profiler-catalog.md` -> "Re-profile").
- Hint must cite the SRS sections it depends on (Port Registry, Tech Stack).
- Hint should reference prior voyager-skill notes if applicable:
  `note_list({ tag: 'voyager-skill' })` filtered to perf patterns.
- Hint must NOT modify code. Save to `metadata.hint` only.
- If build fails → emit minimal hint "fix build first" + the build error
  (first 10 lines). Do not attempt perf diagnosis on broken build.
- If the AC has no perf contract and the PRD has no NFR → emit hint "no
  perf budget declared; nothing to tune" and exit. Don't fabricate a
  budget.
- Specialist task's `worker_done` result must include the triggering
  dev-task ID so the orchestrator can verify the hint was delivered.

## CGAD alignment

This skill is a **specialist layer** on top of CGAD's standard pipeline. It
does not replace any gate; it enriches the dev worker's context for a
specific domain (perf). The hint it emits is consumed by saga-worker's
hint-reading step (C3 in the v2.2 plan), which is a CGAD-compliant way to
inject external knowledge without breaking provenance.

| CGAD principle | This skill's role |
|---|---|
| P7 (independence) | Specialist is a separate worker; hint is advisory |
| P14 (deny-by-default) | Specialist does not approve ACs; verifier does |
| §9 (test layers) | Specialist does not generate tests; verifier does |
| T-010 (degradation) | Hint may include "mark AC as degradable" recommendation |

## References

- Plan: `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G4)
- Audit: `docs/research/audit-2026-07-20-cannon-1000-score.md` §5 (Cannon #31)
- **Sibling file: `profiler-catalog.md`** — Node/V8/clinic/0x/perf/JFR command
  catalog and "when to use each." Referenced from the measure-first loop and
  Steps 5/6/9.
- Related skills: `saga-worker` (consumes hint via C3), `saga-type-fixer`
  (sister specialist for type domain), `saga-code-reviewer` (runs tsc +
  size checks post-build; this skill runs deeper perf analysis pre-fix)
