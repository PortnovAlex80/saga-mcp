---
name: saga-explorer
description: "Phase-3 hypothesis explorer of the T-011 adaptive-retry protocol. Claims one recovery.exploration task, reads ONE hypothesis-N.json (path in task.metadata.hypothesis_path), creates an isolated git worktree on task/<stuck_id>-hypo-<N>, reverse-engineers a scoped architecture map of the touched surface, applies the hypothesis's code_sketch + skill_hint, runs the verification or static check, and writes result-N.json (verdict=works|partial|fails + a filled-in architecture_map grounding the experiment). Does NOT decide whether the original task is solved — only whether this specific hypothesis is viable. One task = one launch."
---

## What this skill is for

The explorer is **Phase 3 of the 5-phase T-011 adaptive-retry protocol**
(see `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §3.3 and the canonical proposal in
`docs/research/testing-2026-07-21-sollar-new-pipeline.md` around the T-011 case).

```
Phase 1 — Normal worker counts attempts
              │ attempts >= MAX_ATTEMPTS (25)
              ▼
Phase 2 — saga-diagnostician
              │ writes diagnosis.json + hypothesis-{1,2,3}.json
              ▼
Phase 3 — saga-explorer × 3   ← THIS SKILL (one explorer per hypothesis)
              │ writes result-{1,2,3}.json
              ▼
Phase 4 — Synthesis worker (original task re-claimed with diagnosis + 3 results)
              │ done=решено | done=не_решено
              ▼
Phase 5 — Resolution (closed normally | outcome=unknown, readiness=PARTIAL)
```

The explorer's job is narrow and clear: **take one hypothesis, try it in
isolation, record whether it works**. The explorer does not synthesise across
hypotheses, does not decide whether the task is solved, does not merge into
the integration branch.

**What this skill is NOT for:**

- Picking which hypothesis to run — the engine assigns the task with
  `metadata.hypothesis_path` already set. You run THAT one.
- Running more than one hypothesis — one explorer = one hypothesis.
- Merging your worktree into `dev` — you leave the worktree in place; the
  Phase-4 synthesis worker decides whether to cherry-pick from it.
- Writing the final verdict on the stuck task — that is Phase 4.

## When to use

You are running inside a `recovery.exploration` task. The engine spawned
exactly 3 of these per stuck task (sequentially or rate-limited parallel,
at the engine's discretion). Your task's metadata contains:

```json
{
  "stuck_task_id": 26,
  "hypothesis_id": "H2",
  "hypothesis_path": ".solla/hypotheses/task-26/hypothesis-2.json",
  "diagnosis_path": ".solla/hypotheses/task-26/diagnosis.json",
  "explorer_index": 2,
  "explorer_total": 3
}
```

If any of these are missing, exit immediately with
`worker_done(result: 'misfire: hypothesis_path missing from task metadata')`
and a comment describing the malformed assignment.

## Product-board contract

Same as every worker skill: use the assignment's product, epic, repository.
Resolve them from `.saga/project.json` or from the task itself.

## Inputs

The explorer reads four things:

1. **The hypothesis file** — `Read <repo>/<task.metadata.hypothesis_path>`.
   Contains `id`, `statement`, `rationale`, `expected_outcome`, `skill_hint`,
   `code_sketch`, `touches_files`, `rejects_prior_approach`, `trace_to_contract`.

2. **The diagnosis file** — `Read <repo>/<task.metadata.diagnosis_path>`.
   Provides the `loop_pattern`, `root_cause`, and `prior_approaches_tried` so
   you understand *why* this hypothesis exists and what to avoid repeating.

3. **The stuck task** — `task_get({id: metadata.stuck_task_id})`.
   Provides `task_kind`, `source_artifact_ids`, `project_repository_id`,
   and the original `description`. You need the description to know what
   "done" looks like for the original task.

4. **The source artifacts** — `artifact_get` for each AC/SRS artifact referenced
   in the hypothesis's `trace_to_contract`. This is the contract you are
   testing the hypothesis against.

You do **not** read the other two hypotheses. Cross-contamination defeats the
purpose of running 3 independent explorations.

## Algorithm

The explorer runs a strict 5-step loop. Each step has a hard contract with the
synthesis worker downstream — do not improvise.

### Step 1 — Parse the hypothesis and plan the experiment

Read `hypothesis-N.json`. Extract the load-bearing fields:

- `statement` — what concrete change to make.
- `code_sketch` — the seed code to start from. You may refine it, but the
  shape should remain recognisable.
- `skill_hint` — the technique to apply. If you are unfamiliar with it, look
  it up *before* touching the worktree.
- `touches_files` — the files you are allowed to edit. Do not edit files
  outside this list unless the hypothesis is unambiguously broken without it;
  in that case, note the deviation in the result.
- `rejects_prior_approach` — what prior attempts did wrong. Internalise this
  so you do not repeat it.

Plan a short experiment:

1. What is the smallest edit that applies the hypothesis?
2. What is the fastest check that tells me if it worked? (build, test, lint,
   manual assertion, AC verification.)
3. What is my attempt budget? **The explorer gets 3 attempts, not 25.**
   If you cannot make the hypothesis work in 3 edits, the hypothesis is
   `partial` or `fails` — record that honestly.

### Step 2 — Create an isolated worktree

The explorer must not touch the integration branch (`dev`). Create a dedicated
worktree:

```bash
cd <repo>
git fetch origin
git worktree add -b task/<stuck_task_id>-hypo-<N> <repo>/../worktrees/task-<stuck_task_id>-hypo-<N> origin/dev
```

Or, if your saga runner manages worktrees via `worker_merge_acquire`, follow
the runner's contract. The branch name **must** be
`task/<stuck_task_id>-hypo-<N>` so the synthesis worker can find it by convention.

Record the worktree path — you will need it for `artifact_path` in the result.

### Step 2.5 — Reverse-engineer a scoped architecture map

Before editing anything, orient yourself in the worktree by producing a
**scoped architecture map** of the surface the hypothesis touches. This is not
whole-repo onboarding — it is the minimum map needed to (a) apply the sketch
faithfully and (b) know which modules the change ripples into. The map becomes
the `architecture_map` field of `result-N.json` (see §"Output spec").

The procedure follows the reverse-engineering discipline of EXT-12
(codebase-exploration): start broad, then narrow down to the touched surface.

<!-- source: EXT-12 https://skillsdirectory.com/skills/rsmdt-codebase-exploration
   (reverse-engineering procedure: project layout → source organization →
   configuration; glob-first, grep-second; map layers, identify patterns,
   note conventions, document boundaries) -->

1. **Layout recon (glob-first).** `Glob` the top-level tree and the directories
   containing every file in `touches_files`. Note the layer shape (src/test/docs,
   monorepo packages, etc.). Do not read file bodies yet — just the shape.
   <!-- source: EXT-12 ("Project Layout" step) -->

2. **Source organisation (grep-second).** For each `touches_files` entry, `Grep`
   its importers and importees. Build the directed edge list
   (`from → to`, kind = imports|calls|implements|extends). This is the
   `dependency_graph` of the map.
   <!-- source: EXT-12 ("Source Organization" + "map layers / document boundaries") -->

3. **Identify the entry points.** Trace from each touched module outward to the
   nearest execution entry (CLI, HTTP handler, browser bootstrap, test harness,
   build config). Record each as `entry_points[]` with a CGAD-aligned `kind`
   (cli|http|browser|test|build) and one-line `relevance` to the hypothesis.
   <!-- source: EXT-2 https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md
      ("Key Entry Points" section) -->

4. **Note conventions.** While reading the touched surface, record the patterns
   you must respect for the sketch to land idiomatically (naming, file layout,
   export style, error-handling shape). These are observations, not
   prescriptions — you follow conventions so the change is reviewable.
   <!-- source: EXT-2 ("Conventions") + EXT-12 ("note conventions") -->

5. **Record gotchas.** Capture the non-obvious risks a second explorer or the
   synthesis worker would hit (chunk-splitting footguns, circular-import traps,
   env-dependent behaviour). Empty list is fine; do not invent gotchas.
   <!-- source: EXT-2 ("Where to Look / gotchas") -->

6. **Bound the map.** If step 2 surfaces more than ~6 modules in
   `dependency_graph`, the hypothesis has scope drift — record
   `verdict: 'fails'` per the anti-patterns below rather than producing an
   unbounded map.
   <!-- source: EXT-12 ("start broad, then narrow down" — the narrowing is the discipline) -->

The full section template with field-by-field guidance lives in
`architecture-map-template.md` (sibling file). Fill it in and embed the result
as `architecture_map` in `result-N.json`. **Do not** produce freeform notes
instead of the map — the synthesis worker parses the map to decide whether the
hypothesis stayed in its lane.

### Step 3 — Apply the hypothesis

`cd` into the worktree. Make the edits described in `code_sketch`. Use the
`skill_hint` to fill in the gaps the sketch leaves open.

Rules:

- You may iterate the sketch, but stay faithful to the `statement`. If the
  sketch says "dynamic import of three.js", do not pivot to "replace three.js
  with Ogl" — that was a different hypothesis and a different explorer's job.
- Stay within `touches_files`. If the hypothesis genuinely requires touching
  another file, record the deviation in the result's `notes` field with a
  one-sentence justification.
- Commit after each successful build/test cycle. Use conventional commit
  messages prefixed with `[hypo-<N>]`:
  ```
  [hypo-2] split renderer.ts into port + impl
  [hypo-2] wire dynamic import in main.tsx
  [hypo-2] configure vite manualChunks for vendor split
  ```

### Step 4 — Run the check

Pick the cheapest check that resolves the hypothesis:

| Hypothesis type | Cheapest check | Fallback |
|---|---|---|
| Code-splitting / bundle size | `npm run build` + `du -h dist/` or `vite build --report` | Lighthouse if available |
| Type correctness | `tsc --noEmit` | `npm run typecheck` |
| Test pass | `npm test -- <pattern>` | `npm run test:integration` |
| Browser compatibility | `npx playwright test` over HTTP server | Manual DOM assertion |
| Performance budget | Lighthouse CLI | Manual timing |
| AC renegotiation (H3-class) | n/a — verdict is recorded by inspection, not by running code | — |

Record the actual command output (truncated to ~500 chars) as `evidence` in
the result file. Do not paraphrase — copy the key numbers (score, error count,
bundle size in KB).

**Attempt budget:** 3. If the first attempt fails:
- Diagnose the failure.
- Decide if it is a fixable error (wrong import path, missing type) or a
  fundamental mismatch (hypothesis is just wrong).
- For fixable: try once more.
- For fundamental: record `verdict='fails'` and exit. Do not burn attempt 3
  on a hypothesis you have already disproven.

### Step 5 — Write result-N.json and exit

Write the result file to:
```
<repo>/.solla/hypotheses/task-<stuck_task_id>/result-<N>.json
```

The schema is strict:

```json
{
  "schema_version": 2,
  "explored_at": "2026-07-21T12:08:00Z",
  "explorer_task_id": 74,
  "stuck_task_id": 26,
  "hypothesis_id": "H2",
  "verdict": "works",
  "artifact_path": "<repo>/../worktrees/task-26-hypo-2",
  "artifact_branch": "task/26-hypo-2",
  "artifact_commit_sha": "a1b2c3d",
  "evidence": "Lighthouse Performance = 82 after dynamic-import split (entry chunk 218KB, vendor chunk 394KB loaded on-demand); tsc --noEmit clean; 0 failing jest tests",
  "attempt_count": 2,
  "duration_ms": 184000,
  "deviations_from_sketch": [
    "hypothesis named 'renderer-port.ts' but I used 'renderer/types.ts' to match existing module conventions — functionally equivalent"
  ],
  "architecture_map": {
    "overview": {
      "product": "sollar",
      "repository": "sollar-web",
      "map_scope": "render + main-entry surface touched by H2's three.js dynamic-import split",
      "map_purpose": "Confirm the split unblocks the entry chunk without breaking the browser bootstrap path"
    },
    "module_map": [
      {"module": "src/main.tsx", "responsibility": "browser bootstrap; mounts the app", "touched_by_hypothesis": true, "role_in_experiment": "entry-point"},
      {"module": "src/renderer/index.ts", "responsibility": "render port; re-exports renderer impl", "touched_by_hypothesis": true, "role_in_experiment": "target"},
      {"module": "src/renderer/three-scene.ts", "responsibility": "three.js scene impl", "touched_by_hypothesis": true, "role_in_experiment": "target"}
    ],
    "dependency_graph": {
      "edges": [
        {"from": "src/main.tsx", "to": "src/renderer/index.ts", "kind": "imports"},
        {"from": "src/renderer/index.ts", "to": "src/renderer/three-scene.ts", "kind": "imports"}
      ],
      "external_deps_relevant": ["three", "vite"],
      "notes": "three-scene.ts is the sole importer of three.js; splitting it onto a dynamic import is what moves the 394KB vendor chunk off the entry path"
    },
    "entry_points": [
      {"entry": "src/main.tsx:12", "kind": "browser", "relevance": "the bootstrap that dynamically imports the renderer after H2"}
    ],
    "conventions": [
      "all render modules export a single init() called from main.tsx",
      "vite manualChunks is configured in vite.config.ts — vendor split must be listed explicitly"
    ],
    "gotchas": [
      "vite manualChunks must name three.js explicitly or it lands back in the entry chunk, undoing the split"
    ]
  },
  "notes": "Three.js now loads on first user interaction with the 3D view. Initial page render does not block on the 394KB vendor chunk. AC-1.4 Lighthouse ≥80 satisfied. Entry chunk 218KB is within the implicit <250KB budget inferred from the AC rationale."
}
```

#### Output spec — architecture_map is required

<!-- source: EXT-2 https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md
   (onboarding guide as a structured artifact, not freeform notes) -->
<!-- source: EXT-12 https://skillsdirectory.com/skills/rsmdt-codebase-exploration
   (reverse-engineering output: codebase overview + key directories +
   conventions + dependencies, as a structured map) -->

`result-N.json` MUST contain an `architecture_map` object produced by Step 2.5.
The explorer's output is a **filled-in architecture map**, not freeform notes.
The map has six sections — `overview`, `module_map`, `dependency_graph`,
`entry_points`, `conventions`, `gotchas` — defined field-by-field in
`architecture-map-template.md` (sibling file).

Why the map is required, not optional:

- **It grounds the verdict.** A `works` verdict that names no modules or entry
  points is uncheckable. The map lets the synthesis worker confirm the change
  stayed inside `touches_files` and reached the right entry point.
- **It scopes the experiment.** Building the map is how you notice scope drift
  *before* burning attempts (Step 2.5 step 6).
- **It is reusable.** If synthesis cherry-picks your worktree, the map is the
  mini-onboarding guide for whoever reviews the merge.

`schema_version` is bumped to `2` to signal the added `architecture_map` field.
A synthesis worker that only knows schema_version 1 should treat a missing
`architecture_map` as a malformed result for explorations emitted by this skill.

#### Verdict semantics

| Verdict | When to use | What synthesis does |
|---|---|---|
| `works` | Hypothesis applied cleanly AND check passed within budget | Synthesis worker cherry-picks from your worktree and merges into `dev`, records `outcome=passed` (or equivalent) on the stuck task |
| `partial` | Hypothesis applied but check is inconclusive — some assertions met, some not | Synthesis worker decides: cherry-pick the working parts + record partial, OR combine with another hypothesis, OR record `outcome=unknown` |
| `fails` | Hypothesis did not satisfy the check within budget — fundamental mismatch | Synthesis worker rules out this approach; if all 3 fail, records `outcome=unknown` + escalates |

**Be honest.** A `works` verdict on a hypothesis that didn't actually pass the
check sabotages the synthesis worker. If Lighthouse returned 78 and the AC
asks for ≥80, the verdict is `partial`, not `works`.

### Step 6 — Hand off and exit

1. **Do NOT merge your worktree into `dev`.** Leave the branch in place —
   synthesis will cherry-pick or abandon based on its full view of all 3
   results.

2. **Do NOT delete the worktree.** Same reason — the synthesis worker may
   want to inspect the diff or cherry-pick a subset of commits.

3. `comment_add({task_id: <explorer task id>, content: <one-paragraph summary: hypothesis id, verdict, key evidence number>})`.

4. `worker_done({task_id, worker_id, result: 'exploration complete: <hypothesis_id> verdict=<works|partial|fails>; result written to <path>'})`.

5. Exit. Do **not** call `worker_next`. Do **not** call `episode_transition`.

## Edge cases

### Hypothesis file is malformed or missing

If `hypothesis-N.json` is missing required fields (`statement`, `code_sketch`,
`skill_hint`, `trace_to_contract`), exit immediately:

```
worker_done({result: 'malformed hypothesis: missing fields <list>'})
```

Write a `result-N.json` with `verdict: 'fails'` and
`evidence: 'hypothesis file malformed — missing fields: <list>'` so the
synthesis worker has a complete result set.

### Worktree creation fails

If `git worktree add` fails (e.g. branch already exists, disk full, lock held):

1. If branch already exists from a previous run — `cd` into it, `git reset --hard origin/dev`, and proceed. Note this in `deviations_from_sketch`.
2. For any other failure — exit with `verdict: 'fails'`,
   `evidence: 'worktree creation failed: <error>'`. Do not attempt to work
   directly in the integration branch.

### Check cannot run in this environment

If the hypothesis requires a check the environment cannot provide (no browser,
no GPU, no production API), that is itself information. Record:

```json
{
  "verdict": "partial",
  "evidence": "static analysis only: bundle size 218KB < 250KB budget; dynamic-import split confirmed via build output; Lighthouse could not run (no Chrome DevTools available in explorer environment)",
  "notes": "Hypothesis is structurally sound but runtime confirmation deferred. Synthesis worker should either (a) re-verify with Lighthouse if available, or (b) emit shadow observation per autonomous-decision-unverifiable-acs §6.3."
}
```

Do **not** record `verdict: 'works'` without running the check. The synthesis
worker trusts your verdict — if it says `works`, it expects the AC to be
satisfied.

### Hypothesis touches a different AC than expected

If `trace_to_contract` references AC-X but your implementation satisfies a
*different* AC-Y, record the deviation:

```json
{
  "deviations_from_sketch": [
    "hypothesis targeted AC-1.4 (Lighthouse) but the change also satisfies AC-NFR-2 (bundle size <500KB) — record as bonus coverage"
  ]
}
```

Synthesis will route the bonus coverage appropriately.

## Anti-patterns

- **Running multiple hypotheses.** You have ONE hypothesis. Reading another
  explorer's hypothesis file or trying to combine approaches contaminates the
  independence the protocol depends on. Synthesis is allowed to combine —
  you are not.

- **Editing outside `touches_files`.** The hypothesis named the files it
  intended to touch for a reason. If you find yourself editing 12 files,
  you have drifted from the hypothesis — record `verdict: 'fails'` with
  `notes: 'scope drift — hypothesis requires more invasive changes than its sketch suggested'`.

- **Burning more than 3 attempts.** The explorer is cheap-and-cheerful —
  3 attempts, then verdict. If the hypothesis needs 10 attempts, it is not
  a clean hypothesis and `verdict: 'partial'` or `'fails'` is the honest
  call. Do not become a second normal worker.

- **Merging into `dev`.** Never. Your worktree is a sandbox. The synthesis
  worker chooses what survives. If you merge, you bypass its judgment and
  potentially ship an unreviewed approach.

- **Recording `works` on a failing check.** The single worst anti-pattern.
  It converts the explorer from a useful signal into noise. If the check
  returns a number below threshold, the verdict is `partial` or `fails`,
  full stop.

- **Skipping the result file.** Even if your exploration fails on step 2
  (worktree creation), write a result file with `verdict: 'fails'`. The
  synthesis worker expects exactly 3 result files; a missing one looks
  like an in-flight explorer and blocks synthesis indefinitely.

- **Trusting prior comments over git state.** Same lesson as diagnostician.
  Always verify what is in your worktree with `git status` and `git diff`
  before recording a verdict.

## Inputs/Outputs (quick reference)

### Inputs (read-only)

| Source | Tool | Purpose |
|---|---|---|
| Hypothesis file | `Read` | the thing you are testing |
| Diagnosis file | `Read` | context: why the hypothesis exists |
| Stuck task | `task_get` | what "done" looks like |
| Source artifacts | `artifact_get` per `trace_to_contract` | the contract |
| Integration branch | `git log origin/dev` | starting point for worktree |

### Outputs (write)

| Path | Schema | Purpose |
|---|---|---|
| Worktree `<repo>/../worktrees/task-<id>-hypo-<N>` | git branch `task/<id>-hypo-<N>` | isolated experiment, preserved for synthesis |
| `<repo>/.solla/hypotheses/task-<id>/result-<N>.json` | schema_version 2 (Step 5); **`architecture_map` required** — template in `architecture-map-template.md` | synthesis input |

### Side-effects (tracker)

| Target | Tool | Purpose |
|---|---|---|
| Explorer task | `comment_add` | audit trail |
| Explorer task | `worker_done` | exit |

### NEVER call

- `worker_next` — you already hold a task; one task = one launch.
- `worker_merge_acquire` / `worker_merge_release` — your worktree is **not**
  destined for `dev`. Synthesis handles merging.
- `episode_transition` — the engine drives stage transitions.
- `task_update({status:...})` on the stuck task — you do not decide its fate.
- `verification_record` on the stuck task — that's the synthesis worker's job
  (or the original verifier's, after synthesis).

## Examples

### Example 1 — H2 on Sollar #26 (split single-file product into multi-file ESM)

**Setup.** Stuck task #26 (AC-2.5 Browser Compatibility) went through
diagnosis (P5 infra-limitation). Diagnostician wrote 3 hypotheses. You are
the explorer assigned H2: "split single-file `index.html` into multi-file ESM
so that `file://` MIME enforcement doesn't block the module script."

**Explorer run.**

1. Read `hypothesis-2.json`. `code_sketch`:
   ```html
   <!-- index.html -->
   <script type="module" src="./main.js"></script>
   ```
   ```js
   // main.js
   import { initCalculator } from './calculator.js';
   import { initSolarView } from './solar-view.js';
   initCalculator(); initSolarView();
   ```
   `skill_hint: "ESM module extraction"`.
   `touches_files: ["index.html", "src/main.js", "src/calculator.js", "src/solar-view.js"]`.

2. Create worktree:
   ```bash
   git worktree add -b task/26-hypo-2 ../worktrees/task-26-hypo-2 origin/dev
   ```

3. Apply: extract the inline `<script type="module">` contents from
   `index.html` into `src/main.js`, `src/calculator.js`, `src/solar-view.js`.
   Update `index.html` to reference `./main.js`.

4. Check:
   ```bash
   npx playwright test tests/verifier/AC-2_5_browser_test.ts
   ```
   Output: `3 passed (3) in 4.2s`. All three browsers (Chromium, Firefox,
   WebKit) loaded the product and found `#calcForm` populated.

5. Write `result-2.json`:
   ```json
   {
     "schema_version": 2,
     "explored_at": "2026-07-21T12:15:00Z",
     "explorer_task_id": 74,
     "stuck_task_id": 26,
     "hypothesis_id": "H2",
     "verdict": "works",
     "artifact_path": "../worktrees/task-26-hypo-2",
     "artifact_branch": "task/26-hypo-2",
     "artifact_commit_sha": "b3c4d5e",
     "evidence": "playwright tests/verifier/AC-2_5_browser_test.ts: 3 passed (3) in 4.2s; Chromium + Firefox + WebKit all populated #calcForm; no MIME errors in console",
     "attempt_count": 1,
     "duration_ms": 96000,
     "deviations_from_sketch": [
       "extracted 4 modules (main + calculator + solar-view + shared-types) instead of 3 — needed to factor out shared CelestialBody type"
     ],
     "architecture_map": {
       "overview": {
         "product": "sollar",
         "repository": "sollar-web",
         "map_scope": "index.html + the 3 ESM modules H2 extracts it into",
         "map_purpose": "Confirm the ESM split resolves the file:// MIME block without breaking the browser bootstrap"
       },
       "module_map": [
         {"module": "index.html", "responsibility": "single-file product entry", "touched_by_hypothesis": true, "role_in_experiment": "entry-point"},
         {"module": "src/main.js", "responsibility": "bootstrap; imports calculator + solar-view", "touched_by_hypothesis": true, "role_in_experiment": "target"},
         {"module": "src/calculator.js", "responsibility": "calculator init", "touched_by_hypothesis": true, "role_in_experiment": "target"},
         {"module": "src/solar-view.js", "responsibility": "solar view init", "touched_by_hypothesis": true, "role_in_experiment": "target"}
       ],
       "dependency_graph": {
         "edges": [
           {"from": "index.html", "to": "src/main.js", "kind": "imports"},
           {"from": "src/main.js", "to": "src/calculator.js", "kind": "imports"},
           {"from": "src/main.js", "to": "src/solar-view.js", "kind": "imports"}
         ],
         "external_deps_relevant": [],
         "notes": "No external deps; pure ESM extraction. Shared CelestialBody type factored into a 4th module to avoid a circular import between calculator and solar-view."
       },
       "entry_points": [
         {"entry": "index.html:1", "kind": "browser", "relevance": "the product entry that loads main.js as a module"}
       ],
       "conventions": [
         "each module exports a single init() invoked from main.js",
         "shared types live in their own module, not inlined in a feature module"
       ],
       "gotchas": [
         "file:// serving blocks <script type=module> in Chromium — the whole point of H2; verify with playwright over file://, not a dev server"
       ]
     },
     "notes": "Single-file structure was the root cause. Splitting into 4 ESM files resolves both AC-2.5 (browser compat) and incidentally helps AC-1.4 (bundle size). Recommend synthesis cherry-pick commit b3c4d5e directly."
   }
   ```

6. `comment_add`, `worker_done(result: 'H2 verdict=works; playwright 3/3 pass')`.

**Outcome.** Synthesis worker sees H1 (HTTP server) `works`, H2 (split ESM)
`works`, H3 (shadow) not run. Picks H2 because it fixes the root cause rather
than papering over with a test-harness workaround. Cherry-picks `b3c4d5e`
into `dev`, re-runs verifier, records `outcome=passed`.

### Example 2 — H3 on Cannon #31 (renegotiate Lighthouse budget from ≥80 to ≥65)

**Setup.** Stuck task #31 (AC-1.4 Lighthouse ≥80) went through diagnosis
(P3 wrong-approach — 25 attempts to shave KB off bundle, never crosses 80).
Hypothesis H3: "renegotiate the AC budget down to ≥65 with a Decision Log
justification."

**Explorer run.**

1. Read `hypothesis-3.json`. `code_sketch`: n/a (this is a contract change,
   not a code change). `skill_hint: "AC renegotiation + SRS §12 Decision Log"`.
   `touches_files: ["docs/requirements/.../03-acceptance-criteria.md", "docs/.../srs.md#§12"]`.

2. Create worktree (even though no code changes — keeps the `.md` edits isolated).

3. Apply: edit AC-1.4 in `03-acceptance-criteria.md` to change "≥80" to "≥65".
   Add a Decision Log entry in SRS §12 explaining the trade-off:
   three.js is required for the 3D solar view; ≥80 is unachievable without
   dropping the 3D feature; ≥65 is achievable with the existing bundle and
   still meets the spirit of the AC (good UX).

4. Check: this hypothesis cannot be verified by running code. Verdict is
   reached by inspection:
   - Does the new AC-1.4 (≥65) actually pass? Run Lighthouse: score = 68.
     Yes, ≥65 satisfied.
   - Is the Decision Log entry well-formed? Yes — cites the three.js size,
     the UX cost of dropping 3D, and the alternative (H1/H2 dynamic import).
   - Is the AC still `blocker`? Yes, but with a renegotiated threshold.

5. Write `result-3.json`:
   ```json
   {
     "hypothesis_id": "H3",
     "verdict": "partial",
     "evidence": "Lighthouse score 68 ≥ new threshold 65; AC-1.4 threshold renegotiated from ≥80 to ≥65 in docs/requirements/.../03-acceptance-criteria.md; Decision Log entry added in SRS §12 citing three.js size as justification; alternative H1 (dynamic import) was not tested by this explorer",
     "notes": "H3 is viable but should be combined with H1 or H2 if those return verdict=works. Renegotiating down is the fallback if all code-fix hypotheses fail. Stakeholder sign-off on the threshold change may be required — flag for synthesis worker to decide whether to worker_ask_need or proceed with autonomous acceptance."
   }
   ```

6. `comment_add`, `worker_done(result: 'H3 verdict=partial; threshold renegotiable to ≥65; recommend synthesis combine with H1/H2')`.

**Outcome.** H1 returned `works` (dynamic import gets Lighthouse 82).
Synthesis chooses H1 over H3 — code fix beats contract renegotiation when
both are viable. H3's result is preserved in `result-3.json` as a fallback
if H1 turns out to be flaky in integration.

## References

- `docs/plans/SAGA-V2-2-CONSOLIDATED.md` — §3.3 (Adaptive retry architecture),
  §4.4 Поток D (this skill is D2).
- `docs/research/testing-2026-07-21-sollar-new-pipeline.md` — T-011 proposal
  (line ~876), T-012 (ESM/file:// incompatibility), T-015 (silent-loop
  watchdog).
- `docs/research/design-2026-07-20-worker-loop-detection.md` — S1/S2 detector
  that triggers the upstream diagnostician.
- `skills/saga-diagnostician/SKILL.md` — Phase 2, produces the hypothesis
  files this skill consumes.
- `skills/autonomous-recovery/SKILL.md` — sibling skill; recovery heals state
  after a worker exits, adaptive-retry escapes loops before the worker exits.
- `skills/saga-verifier/SKILL.md` — verifier independence rules. The explorer
  is *not* the verifier and may edit product code, but should respect the
  same "don't read Builder's tests" discipline when the hypothesis is a
  verification-side change.
- `skills/saga-explorer/architecture-map-template.md` — the output template
  the explorer fills in as `architecture_map` in `result-N.json`. Section set
  (overview, module map, dependency graph, entry points, conventions, gotchas)
  borrowed from EXT-2 codebase-onboarding; reverse-engineering discipline from
  EXT-12 codebase-exploration. CGAD terminology preserved.
