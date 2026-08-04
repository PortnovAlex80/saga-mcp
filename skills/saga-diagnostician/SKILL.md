---
name: saga-diagnostician
description: "Phase-2 diagnostician of the T-011 adaptive-retry protocol. Claims one recovery.diagnosis task, reads the stuck task plus its .solla/attempts/task-<id>/attempt-*.json history, identifies the loop pattern (stuck-approach / zero-edit / wrong-approach / context-peak), formulates a root_cause, and emits exactly 3 formal hypotheses as JSON. Does NOT attempt to fix anything — only analyses and writes hypothesis files. One task = one launch."
---

## What this skill is for

When a worker has hit `MAX_ATTEMPTS` (25 by default) or `metadata.loop_recoveries >= 1`
on the same task, saga kills the looping execution and spawns a `recovery.diagnosis`
task instead of retrying blindly. **This skill is what that task runs.**

The diagnostician is **Phase 2 of the 5-phase T-011 adaptive-retry protocol**
(see `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §3.3 and the canonical proposal in
`docs/research/testing-2026-07-21-sollar-new-pipeline.md` around the T-011 case,
line ~876).

```
Phase 1 — Normal worker (task-specific skill), counts attempts
              │ attempts >= MAX_ATTEMPTS (25)
              ▼
Phase 2 — saga-diagnostician  ← THIS SKILL
              │ writes diagnosis.json + hypothesis-{1,2,3}.json
              ▼
Phase 3 — saga-explorer × 3 (each tests ONE hypothesis in isolated worktree)
              │ writes result-{1,2,3}.json
              ▼
Phase 4 — Synthesis worker (original task-specific skill, re-claimed with context)
              │ done=решено | done=не_решено
              ▼
Phase 5 — Resolution (closed normally | outcome=unknown, readiness=PARTIAL)
```

**What this skill is NOT for:**

- Writing or modifying product code (that is Phase 3 explorer's job, in an isolated worktree).
- Running verification checks (Phase 3).
- Deciding whether the task is "solved" (Phase 4 synthesis worker).
- Healing gate failures, broken traces, or missing merges — that is `autonomous-recovery`.
- Handling `verification.ac` review-loops — that is T-013's escape hatch
  (`src/tools/dispatcher.ts` ≥2 failed → done). The diagnostician only fires
  when the *worker itself* has burnt 25 attempts without producing a verdict.

## When to use

You are running inside a `recovery.diagnosis` task spawned by the engine. The task's
`description` contains the gate/loop reason, the stuck task's id, and the path to the
attempts directory. The task's `metadata.stuck_task_id` is set.

Trigger conditions (verified by the engine before spawn, listed here so you know
what you are dealing with):

- `stuck_task.metadata.consecutive_retries >= MAX_ATTEMPTS` (25), OR
- `stuck_task.metadata.loop_recoveries >= 1` (T-001 S1/S2 detector has tripped at
  least once on this task — see `docs/research/design-2026-07-20-worker-loop-detection.md`), OR
- Watchdog (T-015) flagged the task as silent-loop (>30 min, 0 evidence).

If none of these are true, you should not have been spawned — exit with
`worker_done(result: 'misfire: trigger conditions not met')` after leaving a comment.

## Product-board contract

Same as every worker skill: use the assignment's product, epic, repository.
Resolve them from `.saga/project.json` or from the task itself. Do **not** spawn
a parallel saga. Do **not** call `worker_next` — you already hold a task.

## Inputs

The diagnostician reads five things:

1. **The stuck task** — `task_get({id: metadata.stuck_task_id})`.
   Provides `title`, `description`, `source_artifact_ids`, `task_kind`,
   `workflow_stage`, `metadata.attempt_history` (if persisted), and any
   prior recovery comments.

2. **The attempts directory** — `<repo>/.solla/attempts/task-<stuck_task_id>/`.
   Contains one JSON file per failed attempt:
   ```json
   {
     "attempt": 7,
     "timestamp": "2026-07-21T11:42:13Z",
     "worker_id": "board-1-1784614699829-3",
     "execution_id": "exec-1-3144-1784614699829-3",
     "summary": "Tried splitting renderer.ts into port/impl — Edit failed on line 412 (old_string not unique)",
     "tools_used": [
       { "name": "Read", "count": 14 },
       { "name": "Edit", "count": 6, "succeeded": 2, "failed": 4 },
       { "name": "Bash", "count": 3, "commands": ["npm run build", "tsc --noEmit", "git status"] }
     ],
     "files_touched": ["src/renderer.ts", "src/main.tsx"],
     "error": "tsc: error TS2322: Type 'string' is not assignable to type 'CelestialBody'.",
     "context_tokens": 41200,
     "duration_ms": 184000
   }
   ```

3. **The source artifacts** — `artifact_get({id})` for each `source_artifact_id`
   on the stuck task. Usually the AC (frozen contract) and the SRS §D2 entry.
   This tells you what the task was *supposed* to deliver.

4. **The integration branch state** — `git -C <repo> log <integration_branch> --oneline -20`
   and `git -C <repo> status`. Shows what has already been merged around this task.

5. **Prior recovery comments** — `comment_list({task_id: stuck_task_id})`. Earlier
   `autonomous-recovery` or `recovery.diagnosis` runs may have left breadcrumbs.
   **Always verify git state over comments** — comments can be hallucinated
   (T-006 lesson: cascade hallucination through #37/#38/#39/#40).

If the attempts directory does not exist or is empty, that itself is a signal —
see "Edge cases" below.

## Algorithm

The diagnostician runs a strict 6-step loop. Each step produces an intermediate
artifact that the next step consumes. Do not skip steps.

### Step 1 — Load and normalise the attempt history

```
attempts_dir = `<repo>/.solla/attempts/task-<stuck_task_id>/`
files = readdir(attempts_dir).filter(name ~= /^attempt-\d+\.json$/).sort(by N)
attempts = files.map(f => JSON.parse(read(f)))
```

If `attempts.length < 3`, the trigger probably fired on `loop_recoveries` (T-001
S1/S2 detector) rather than on the attempt counter — that's fine, the 3 attempts
are still your evidence base. Note this in the diagnosis.

Normalise each attempt into a canonical shape:
```json
{
  "n": 7,
  "approach_signature": "edit-renderer-ts+run-tsc",
  "tool_profile": { "Read": 14, "Edit": "6(2ok,4fail)", "Bash": 3 },
  "edit_count": 6,
  "edit_succeeded": 2,
  "edit_failed": 4,
  "error_signature": "TS2322:string-not-assignable-to-CelestialBody",
  "context_tokens": 41200,
  "duration_ms": 184000,
  "files_touched": ["src/renderer.ts", "src/main.tsx"]
}
```

`approach_signature` is a short stable string capturing the *strategy* of the
attempt — what files it touched, what skill_hint it followed. Two attempts with
the same signature are the same strategy retried.

### Step 2 — Identify the loop pattern

Classify the failure mode by inspecting the normalised attempts. There are four
canonical patterns; each maps to a different hypothesis-generation strategy in
Step 4.

| Pattern | Detection signal | What it means |
|---|---|---|
| **P1 — Stuck approach** | ≥3 attempts share the same `approach_signature` | Worker is locked into one strategy; each retry produces byte-identical tool calls. Reflexion has failed. |
| **P2 — Zero-edit paralysis** | `edit_count = 0` AND `Read >= 5` across most attempts | Worker sees the problem, reads context, but does not know how to edit. Usually a missing concept (e.g. unfamiliar with dynamic import syntax). |
| **P3 — Wrong approach** | `edit_succeeded > 0` AND `error_signature` is non-empty AND consistent across attempts | Worker makes real edits, but they don't satisfy the contract (tsc/test/lint failure). The mental model of the AC is wrong. |
| **P4 — Context peak** | `context_tokens` is monotonically rising and the last attempt's `context_tokens > 200000` (or near the model's ctx limit) | Worker is context-burning. Even good ideas can't fit. Fresh context + surgical scope is the only fix. |
| **P5 — Infra limitation** (catch-all) | None of the above, but attempts keep failing on environment errors (`ECONNREFUSED`, `401`, `playwright: browser not found`, `ESM self-import MIME`) | The task is blocked by an external constraint, not by code knowledge. |

Record `loop_pattern` in the diagnosis as exactly one of `P1..P5`. If two apply,
pick the more specific one (P3 over P1; P5 over everything if env errors dominate).

### Step 3 — Read the contract

Load the AC artifact and SRS §D2 entry. Extract:

- **Acceptance criteria** (Given/When/Then or property block).
- **Public protocol** (function signatures the task must export).
- **Invariants** (conditions that must hold, e.g. "idempotent", "≤200ms p95").
- **Test layers** declared (L0/L2/L3/L4) and the corresponding `ac_kind`.

The hypotheses you generate in Step 4 must each be **traceable back to one of
these contract clauses**. A hypothesis that does not satisfy the AC is not a
hypothesis, it is a scope change — escalate via `worker_ask_need` instead.

### Step 4 — Generate exactly 3 hypotheses

This is the load-bearing step. The whole point of T-011 is that a single worker
in the loop cannot escape — three *structurally different* approaches, each
tested in isolation, have a much better chance. "Three slightly different edits
to the same function" is NOT three hypotheses.

Use the loop pattern to pick a generation strategy:

#### For P1 (Stuck approach)

Generate three hypotheses that differ in **what code unit** they touch:

- H1 — Refactor the entry point (top-down).
- H2 — Refactor the leaf module (bottom-up).
- H3 — Introduce a new intermediate abstraction (middle-out).

#### For P2 (Zero-edit paralysis)

Generate three hypotheses that differ in **what concept** they apply:

- H1 — Apply skill A (e.g. "dynamic import + Suspense boundary").
- H2 — Apply skill B (e.g. "manual code splitting via import maps").
- H3 — Apply skill C (e.g. "refactor to server-component / islands architecture").

Each hypothesis must include a `skill_hint` that names the specific technique,
so the explorer knows what to read up on before editing.

#### For P3 (Wrong approach)

Generate three hypotheses that differ in **what they believe the AC means**:

- H1 — Literal reading of the Given/When/Then.
- H2 — Pragmatic reading (what a reasonable reviewer would accept).
- H3 — Architectural reading (what the SRS §D2 public_protocol actually mandates).

The diagnosis should explicitly state *which* prior attempts misread the AC and
why. The explorer's job is then to validate one reading empirically.

#### For P4 (Context peak)

Generate three hypotheses that differ in **how aggressively they shrink scope**:

- H1 — Apply the same strategy as before, but with a fresh context and a 5-file scope cap.
- H2 — Split the task into two sub-tasks (introduce a planning.decomposition
        hint — explorer tests only the first half).
- H3 — Replace the failing approach with a much smaller surgical edit
        (e.g. "do not refactor; just patch the specific failing assertion").

#### For P5 (Infra limitation)

Generate three hypotheses that differ in **how they route around the limitation**:

- H1 — Replace the failing tool (e.g. switch Playwright `file://` to `http-server`).
- H2 — Restructure the code so the limitation does not apply (e.g. split ESM
        self-imports into separate `.js` files — this is the Sollar T-012 fix).
- H3 — Defer the check to runtime observation (`outcome=unknown`,
        `observation_type='shadow'`) — the AC is unverifiable in this environment.

#### Hypothesis JSON schema

Each hypothesis is a separate file. The schema is strict — the explorer depends
on every field.

```json
{
  "id": "H1",
  "statement": "Split renderer.ts into renderer-port.ts (interface) + renderer-impl.ts (vendor-three.js wrapper), expose via dynamic import in main.tsx",
  "rationale": "Across 7 attempts, tsc consistently failed on vendor-three.js (612KB) entering the entry chunk. The AC's Lighthouse ≥80 budget cannot be met while three.js is eagerly imported. Splitting enables a dynamic import that keeps the entry chunk under 250KB.",
  "expected_outcome": "Lighthouse Performance score ≥80 within 2 explorer attempts; entry chunk <250KB; three.js loaded on-demand after first user interaction with the 3D view.",
  "skill_hint": "code-splitting + React.lazy + Suspense boundary + vendor chunk separation (webpack/vite manualChunks)",
  "code_sketch": "// renderer-port.ts\nexport interface Renderer {\n  mount(el: HTMLElement, scene: SceneDescriptor): void;\n  unmount(): void;\n}\n\n// renderer-impl.ts\nimport * as THREE from 'three';\nexport const createRenderer = async (): Promise<Renderer> => { ... };\n\n// main.tsx\nconst Renderer = React.lazy(() => import('./renderer-impl').then(m => ({ default: m.createRenderer })));\n<Suspense fallback={<CanvasSkeleton/>}><Renderer .../></Suspense>",
  "touches_files": ["src/renderer.ts (split)", "src/main.tsx (rewrite import)", "vite.config.ts (manualChunks)"],
  "rejects_prior_approach": "attempts #3-#7 all eagerly imported three.js and patched around it; this hypothesis rules that out by construction",
  "trace_to_contract": "AC-1.4 'Lighthouse Performance ≥80' (file: docs/requirements/.../03-acceptance-criteria.md#AC-1.4)"
}
```

All fields are mandatory. If you cannot fill `code_sketch`, you do not understand
the hypothesis well enough — pick a different one.

### Step 5 — Write the outputs

Write four files. All paths are relative to the stuck task's repository root:

```
<repo>/.solla/hypotheses/task-<stuck_task_id>/
  ├── diagnosis.json
  ├── hypothesis-1.json
  ├── hypothesis-2.json
  └── hypothesis-3.json
```

`diagnosis.json` captures the analysis; the three `hypothesis-N.json` files
capture the proposed escapes. Keeping them separate lets the explorer load only
the hypothesis it is assigned.

#### diagnosis.json schema

```json
{
  "schema_version": 1,
  "diagnosed_at": "2026-07-21T11:51:00Z",
  "diagnostician_task_id": 72,
  "stuck_task_id": 26,
  "stuck_task_kind": "verification.ac",
  "attempt_count": 25,
  "loop_pattern": "P5",
  "loop_pattern_evidence": [
    "12 of 25 attempts failed with error_signature='playwright:esm-self-import-mime-mismatch'",
    "0 attempts produced edits to src/index.html that survived a build",
    "9 playwright launches per attempt on average, all failing at module load"
  ],
  "root_cause": "The product uses <script type='module'> with ESM self-imports from './index.html'. Browsers enforce strict MIME types and reject text/html responses for module scripts. This is an architectural defect in the product, not a verifier bug — but the verifier cannot escape it because the AC requires loading the product in a real browser.",
  "prior_approaches_tried": [
    "Rewrite the test to use static HTML snapshot (attempt #4-#8) — product still loaded the broken module",
    "Inject script via dispatchEvent (attempt #9-#14) — module never executed",
    "Patch the product's <script> tag at runtime (attempt #15-#22) — violated verifier independence",
    "Skip the AC as unverifiable (attempt #23-#25) — worker refused because AC is tagged 'blocker'"
  ],
  "contract_summary": {
    "ac_code": "AC-2.5",
    "ac_path": "docs/requirements/REQ-001-Sollar/03-acceptance-criteria.md#AC-2.5",
    "ac_criticality": "blocker",
    "test_layers_declared": ["L4"],
    "public_protocol": "loadSolarCalculator(): Promise<{render: (el: HTMLElement) => void}>"
  },
  "hypotheses": [
    { "id": "H1", "path": ".solla/hypotheses/task-26/hypothesis-1.json" },
    { "id": "H2", "path": ".solla/hypotheses/task-26/hypothesis-2.json" },
    { "id": "H3", "path": ".solla/hypotheses/task-26/hypothesis-3.json" }
  ],
  "recommendation_to_synthesis": "If all three hypotheses return verdict=fails or partial, the synthesis worker should record outcome=unknown and downgrade AC-2.5's effective criticality from 'blocker' to 'degradable' with a shadow observation — see T-010 Principle 6."
}
```

#### Per-hypothesis files

Each `hypothesis-N.json` follows the schema in Step 4. The `id` field must be
`"H1"`, `"H2"`, `"H3"` exactly — the explorer matches on it.

### Step 6 — Hand off and exit

After the four files are written:

1. `comment_add({task_id: <diagnostician task id>, content: <one-paragraph summary of loop_pattern + root_cause + 3 hypothesis statements>})`.

2. Update the stuck task's metadata so the engine knows the diagnosis exists:
   ```
   task_update({
     id: stuck_task_id,
     metadata: { ...prior,
       diagnosis_path: '.solla/hypotheses/task-<id>/diagnosis.json',
       diagnosis_task_id: <this task id>,
       diagnosis_completed_at: <ISO timestamp>
     }
   })
   ```
   Do **not** change the stuck task's status. The engine will re-spawn it as
   a Phase-4 synthesis task only after the 3 explorers have produced their
   result-N.json files.

3. `worker_done({task_id, worker_id, result: 'diagnosis complete: P5 infra-limitation; 3 hypotheses written to .solla/hypotheses/task-<id>/'})`.

4. Exit. Do **not** call `worker_next`. Do **not** call `episode_transition`.

## Evidence-chain output format (structured, not freeform)

<!-- source: EXT-8 https://mcpmarket.com/tools/skills/root-cause-analysis-8 -->

The diagnostician's output is a **structured evidence chain**, not freeform prose.
The 6-step Algorithm above produces the chain; this section defines its shape so
that downstream consumers (Phase-3 explorer, Phase-4 synthesis, and the v3
IncidentAuthority — see "Connection to incidents" below) can parse it mechanically.

EXT-8 (root-cause-analysis-8) formalises RCA as a chain that proves causation with
irrefutable data rather than asserting it: gather evidence → trace the execution
path → place discriminating observations to *eliminate* rival hypotheses → report
the chain `symptom → proximate cause → root cause`. We adopt that discipline and
adapt its five links to CGAD vocabulary (AC / episode / baseline / scope condition):

```
observation  →  source  →  correlation  →  hypothesis  →  discriminating probe
   (1)           (2)          (3)              (4)               (5)
```

Each link is populated from the attempt history and the frozen AC contract:

| Link | What it holds | Where the diagnostician gets it |
|---|---|---|
| **(1) Observation** | A concrete, falsifiable fact from a failed attempt — an `error_signature`, a tool-count, a `context_tokens` reading, a `git status` line. Never an interpretation. | `attempt-N.json` fields, `git log/status`, `comment_list` (verified against git) |
| **(2) Source** | The exact provenance of the observation: the attempt number, the file:line, the tool call, the heartbeat-log line. An observation without a source is inadmissible. | `attempt-N.json` path, tool `name`/`count`, heartbeat `reason=` |
| **(3) Correlation** | What this observation correlates with across attempts — e.g. "this `error_signature` appears in 12 of 25 attempts that share `approach_signature=X`". Correlation is not yet causation; it is the signal that narrows the hypothesis space. | cross-attempt grouping by `approach_signature` (Step 1/2) |
| **(4) Hypothesis** | A candidate root cause stated as a falsifiable claim, traceable to one AC clause (`trace_to_contract`). Must be *structurally different* from the other hypotheses (Step 4 rule), not a cosmetic variant. | Step 4 generation, constrained by the loop pattern (P1..P5) |
| **(5) Discriminating probe** | The single check that would **falsify** this hypothesis if it is wrong — i.e. the observation the Phase-3 explorer must make to accept or reject it. A hypothesis without a probe that can kill it is not a hypothesis, it is a guess. | written into each `hypothesis-N.json` as `discriminating_probe` (see schema below) |

### How the chain is written into the output files

The `loop_pattern_evidence[]` array in `diagnosis.json` (Step 5 schema) **is** the
observation→source→correlation prefix of the chain — each entry is one
observation with its source and the correlation that makes it load-bearing.

The hypothesis→probe suffix lives in each `hypothesis-N.json`. Extend the Step 4
schema with one mandatory field:

```jsonc
{
  "id": "H1",
  "statement": "...",
  "rationale": "...",
  "expected_outcome": "...",
  "skill_hint": "...",
  "code_sketch": "...",
  "touches_files": ["..."],
  "rejects_prior_approach": "...",
  "trace_to_contract": "AC-1.4 ...",
  "discriminating_probe": {
    "check": "After applying H1, run the AC's public_protocol loader once and measure the entry chunk size; if chunk >250KB OR three.js appears in the entry graph, H1 is FALSIFIED regardless of whether the symptom 'went away'.",
    "pass_supports_hypothesis": true,
    "fail_falsifies_hypothesis": true,
    "single_run_sufficient": true
  }
}
```

`discriminating_probe` is now mandatory for every hypothesis. If you cannot state
a probe whose failure falsifies the hypothesis, you do not have a hypothesis —
see "Hypothesis generation failure" in Edge cases, and fall back to `P6-unsolvable`.

### Why the chain shape matters here

The diagnostician is `execution_mode: read_only_evidence`. It cannot run the probes
it defines. The chain's value is that **each link is independently inspectable**:

- Phase 3 (explorer) consumes link (4)+(5): it runs the discriminating probe in an
  isolated worktree and records `verdict` based on the probe outcome, not on whether
  the worker "feels" the fix worked.
- Phase 4 (synthesis) consumes links (1)-(3) to decide which probe outcome actually
  addresses the root cause versus merely suppressing the symptom.
- A reviewer can reject a hypothesis whose probe is not actually discriminating
  (e.g. "rerun the build" falsifies nothing — a passing build is compatible with
  several rival hypotheses).

## Research-first discipline (probe-before-fix)

<!-- source: EXT-2 https://github.com/affaan-m/everything-claude-code (skills/agent-introspection-debugging) -->

The diagnostician never proposes a fix on a guess. EXT-2's
`agent-introspection-debugging` codifies the discipline as a four-phase loop —
*Failure Capture → Root-Cause Diagnosis → Contained Recovery → Introspection
Report* — whose cardinal rule is: **match the failure to a known pattern and run
one discriminating check before changing anything.** We adopt the discipline;
the actual fix is deferred to Phase 3 (explorer), so here the discipline governs
*hypothesis quality*, not the act of editing.

The recovery heuristics from EXT-2, mapped onto this skill's read-only role:

| EXT-2 heuristic | How the diagnostician honours it |
|---|---|
| Restate the real objective in one sentence | Step 3 reads the AC contract; each hypothesis restates the AC clause it targets (`trace_to_contract`). |
| Verify the world state instead of trusting memory | "Inputs" Step 4 + the anti-pattern "Trusting worker comments over git state": every observation's source is git state or an attempt file, never a comment's claim. |
| Shrink the failing scope | P4 (context peak) hypotheses shrink scope; P2 (zero-edit) hypotheses name the single missing concept. |
| Run one discriminating check | Every hypothesis carries a `discriminating_probe` (above). No probe ⇒ no hypothesis. |
| Only then retry | The diagnostician does not retry at all — it hands the probe to Phase 3. This is the strictest possible form of "only then". |

### The probe-before-fix gate (explicit)

Before writing any `hypothesis-N.json`, the diagnostician must be able to answer
all three for that hypothesis:

1. **What single observation would falsify this hypothesis?** (the `check`)
2. **Is that observation actually discriminating?** — i.e. does at least one rival
   hypothesis predict a *different* observation? If every rival predicts the same
   outcome, the probe distinguishes nothing and must be replaced.
3. **Can the probe be run by Phase 3 without touching the integration branch?**
   (explorer runs in an isolated worktree; a probe that requires mutating shared
   state is not runnable and must be reformulated.)

If any answer is "no", the hypothesis is a guess. Drop it or sharpen it — do not
emit it. EXT-2's failure-pattern table flags "tests still failing after 'fix' →
wrong hypothesis"; the probe-before-fix gate exists precisely to prevent the
Phase-3 explorer from spending its attempt budget confirming a wrong hypothesis.

This does **not** give the diagnostician authority to authorise a fix, a retry, or
a degradation. LM-proposes / controller-authorises / evidence-decides still holds:
the diagnostician proposes hypotheses and probes; the controller (engine) allocates
explorer slots; the explorer's probe outcome is the evidence that decides. Nothing
in the research-first loop self-authorises.

## Connection to incidents (v3 IncidentAuthority, saga-3-0 Gate 6)

The evidence chain produced here is shaped to be suitable input to the v3
**IncidentAuthority** at saga-3-0 Gate 6 — the authority that adjudicates a
runtime incident (a baseline AC whose observation contradicts its accepted
contract) by deciding `degrade | patch | revert` rather than re-opening the
episode.

When a stuck task ultimately traces to a runtime contradiction of an accepted AC
(e.g. a P3 "wrong approach" that is really a baseline whose scope condition no
longer holds in production), the chain's five links map cleanly onto what
IncidentAuthority consumes:

- links (1)-(3) `observation → source → correlation` become the incident's
  **evidence packet** (REQ-011 `observation_record` material),
- link (4) `hypothesis` becomes the candidate **root-cause claim** the authority
  must accept or reject,
- link (5) `discriminating_probe` becomes the **canary / shadow check** the
  authority uses to decide `degrade` (probe fails in production) vs `patch`
  (probe passes and the baseline is reaffirmed).

**Do not implement this integration.** The diagnostician only produces the chain;
wiring it into IncidentAuthority is a saga-3-0 concern, not an adaptive-retry
concern. The note here exists so that (a) the chain format is not accidentally
"tidied up" into freeform prose later, and (b) a future Gate-6 implementer finds
a compatible artefact already on disk at `.solla/hypotheses/task-<id>/`.

## Edge cases

### Empty or missing attempts directory

If `readdir(attempts_dir)` is empty, the trigger must have been `loop_recoveries`
(T-001 S1/S2) rather than the attempt counter. In this case:

- Set `loop_pattern: 'P0-unknown'`.
- Read the worker heartbeat log (`~/.zcode/cli/worker-heartbeat.log`) for the
  stuck task's worker_id — look for `LOOP_DETECTED` lines and extract the
  reason/counter.
- Use the heartbeat's `reason=identical_tool_use|repeated_tool_error` as
  `loop_pattern_evidence[0]`.
- Generate hypotheses as if for P1 (stuck approach) — the S1/S2 detector firing
  means the worker was byte-identical looping.

### Fewer than 3 attempts

If `attempts.length < 3`, you do not have enough evidence to identify a pattern.
This usually means the watchdog (T-015) fired prematurely. Exit with:

```
worker_done({result: 'insufficient evidence: only N attempts; request engine re-arm watchdog'})
```

And leave a comment recommending the engine either re-spawn the original worker
or escalate to `worker_ask_need`.

### Hypothesis generation failure

If you genuinely cannot produce 3 *structurally different* hypotheses (i.e.
every idea you have reduces to the same approach), that is itself a strong
signal: the task is not solvable in this environment.

In that case:

1. Write `diagnosis.json` with `loop_pattern: 'P6-unsolvable'` and
   `recommendation_to_synthesis: 'escalate — no 3 distinct hypotheses exist'`.
2. Write 1-3 `hypothesis-N.json` files anyway, marking each `expected_outcome`
   as `"unlikely to resolve within explorer budget"`.
3. `worker_done(result: 'no 3 distinct hypotheses — recommend synthesis escalate')`.

The synthesis worker (Phase 4) will then see the recommendation and route the
task to `outcome=unknown` + `worker_ask_need` rather than burning more attempts.

### Discovery / formalization tasks

The diagnostician is primarily for `development.code` and `verification.ac`
loops. If the stuck task is `formalization.*` (PRD/SRS/UC/AC writer), the
adaptive-retry protocol is overkill — those tasks should be healed by
`autonomous-recovery` instead. Exit with:

```
worker_done(result: 'misfire: formalization tasks belong to autonomous-recovery, not adaptive-retry'})
```

And leave a comment so the engine can refine its trigger.

## Anti-patterns

- **Fixing the task yourself.** You are tracker_only. Your `execution_mode` is
  `read_only_evidence`. Do not write code, do not edit .md files, do not run
  `git checkout`, do not call `task_update({status:...})` on the stuck task
  beyond the metadata handoff in Step 6. The whole protocol depends on you
  producing *hypotheses*, not fixes.

- **Generating three flavours of the same idea.** If H1/H2/H3 differ only in
  variable names or line numbers, you have not generated 3 hypotheses — you
  have generated 1 hypothesis with cosmetic variation. The explorer will
  produce 3 identical results and the synthesis worker will learn nothing.

- **Emitting a hypothesis without a discriminating probe.** A hypothesis whose
  `discriminating_probe` cannot falsify it is a guess, not a hypothesis
  (research-first discipline, see "Research-first discipline" section). "Rerun
  the build" is not a discriminating probe — a passing build is compatible with
  several rival hypotheses. If you cannot state a check whose failure kills the
  hypothesis, drop it or sharpen it.

- **Trusting worker comments over git state.** T-006 lesson: a prior recovery
  worker left a comment "код уже сделан" that was a hallucination. Always
  verify with `git log`, `git status`, `git diff`. Comments are claims; git
  is evidence.

- **Skipping the contract read.** Hypotheses generated without reading the AC
  and SRS will not be traceable to the contract, and the synthesis worker
  cannot decide whether the result satisfies the AC. Always cite the AC
  clause in `trace_to_contract`.

- **Inventing a fourth hypothesis.** The protocol specifies 3 because the
  engine allocates exactly 3 explorer slots per stuck task. Writing a 4th
  file does not cause a 4th explorer to spawn — it just confuses the
  synthesis worker. Pick your best 3.

- **Recording a verdict.** You do not decide whether the task is solved.
  Phase 4 does. If you find yourself writing `"verdict": "..."` in any
  output file, stop — that field belongs to `result-N.json`, written by
  the explorer.

## Inputs/Outputs (quick reference)

### Inputs (read-only)

| Source | Tool | Purpose |
|---|---|---|
| `.saga/project.json` or task itself | `Read` / `task_get` | product/epic/repo resolution |
| Stuck task | `task_get({id: metadata.stuck_task_id})` | title, description, source_artifact_ids, prior comments |
| Attempts directory | `Read` (bash `ls` + JSON parse) | normalised attempt history |
| AC + SRS artifacts | `artifact_get` per `source_artifact_id` | contract |
| Integration branch | `git -C <repo> log/status` | what's already merged |
| Prior comments | `comment_list({task_id: stuck_task_id})` | breadcrumbs (verify against git) |
| Worker heartbeat | `Read ~/.zcode/cli/worker-heartbeat.log` | fallback if attempts dir empty |

### Outputs (write)

| Path | Schema | Purpose |
|---|---|---|
| `<repo>/.solla/hypotheses/task-<id>/diagnosis.json` | see Step 5; `loop_pattern_evidence[]` = observation→source→correlation chain links | analysis summary + evidence-chain prefix |
| `<repo>/.solla/hypotheses/task-<id>/hypothesis-1.json` | see Step 4 + mandatory `discriminating_probe` | explorer input (hypothesis + probe) |
| `<repo>/.solla/hypotheses/task-<id>/hypothesis-2.json` | see Step 4 + mandatory `discriminating_probe` | explorer input (hypothesis + probe) |
| `<repo>/.solla/hypotheses/task-<id>/hypothesis-3.json` | see Step 4 + mandatory `discriminating_probe` | explorer input (hypothesis + probe) |

> The five-link evidence chain (`observation → source → correlation → hypothesis →
> discriminating probe`) spans `diagnosis.json` (links 1-3) and `hypothesis-N.json`
> (links 4-5). See "Evidence-chain output format" and "Research-first discipline".

### Side-effects (tracker)

| Target | Tool | Purpose |
|---|---|---|
| Stuck task metadata | `task_update({metadata})` | record diagnosis path for engine + synthesis |
| Diagnostician task | `comment_add` | audit trail |
| Diagnostician task | `worker_done` | exit |

## Examples

### Example 1 — Sollar #26 verification loop (60 min, 12 writes, 21 playwright runs)

**Setup.** AC-2.5 "Browser Compatibility" verification task. The dev worker
had merged a single-file `index.html` using `<script type="module">` with ESM
self-imports (`import {foo} from './index.html'`). Every browser except Firefox
rejects this with a MIME type error. The verifier tried 25 times over 60 minutes
to get Playwright to load the product, alternating between:

- Rewriting the test (12 writes to `tests/verifier/AC-2_5_browser_test.ts`)
- Relaunching Playwright with different launch options (21 runs)
- Patching the product at runtime (violating verifier independence)

**Diagnostician run.**

1. `task_get({id: 26})` → `task_kind=verification.ac`, `metadata.consecutive_retries=25`,
   `metadata.loop_recoveries=1` (T-001 S1/S2 tripped on byte-identical Playwright launches).

2. Read `.solla/attempts/task-26/attempt-{1..25}.json`. Normalise. Observe:
   - 12 attempts have `approach_signature='rewrite-test+run-playwright'`.
   - 9 attempts have `approach_signature='patch-product-at-runtime'`.
   - 4 attempts have `approach_signature='skip-as-unverifiable'`.
   - 21 of 25 attempts have `error_signature` matching `playwright:esm-self-import-mime-mismatch`.

3. Classify: `loop_pattern = 'P5'` (infra limitation dominates — MIME enforcement
   is a browser constraint, not a code bug).

4. Read AC-2.5 and SRS §D2 for AC-2.5. Contract requires loading the product in
   Chromium, Firefox, and Safari and asserting `document.querySelector('#calcForm')`
   is populated. AC criticality is `blocker`.

5. Generate 3 hypotheses:

   **H1 — Serve the product over HTTP.** Replace `file://` access with a
   one-line `npx http-server` started by the test harness. MIME becomes
   `text/html` correctly for the module script. **skill_hint:**
   `playwright+http-server pattern`. **expected_outcome:** test loads in all
   3 browsers within 1 attempt.

   **H2 — Split the single-file product into multi-file ESM.** Move
   `<script type="module">` contents into separate `.js` files. **skill_hint:**
   `ESM module extraction + Vite multi-entry`. **expected_outcome:** product
   loads without MIME error even over `file://`; Lighthouse improves as a
   side-effect. **rejects_prior_approach:** all 25 attempts kept the
   single-file structure.

   **H3 — Record outcome=unknown + shadow observation.** The product as-shipped
   cannot satisfy AC-2.5 in this environment. Downgrade AC criticality from
   `blocker` to `degradable`, ship with a manual-review note, and emit an
   `observation_type='shadow'` predicting that the first real cross-browser
   test in CI will either confirm (passes) or trigger an incident (fails).
   **skill_hint:** `T-010 Principle 6 + REQ-011 observation_record`.
   **expected_outcome:** pipeline advances to Integration with
   `readiness_level=PARTIAL`.

6. Write the four files under `.solla/hypotheses/task-26/`. `comment_add` with
   the summary. `task_update({id: 26, metadata: {diagnosis_path: ...}})`.
   `worker_done(result: 'P5 infra-limitation; 3 hypotheses: HTTP server / split ESM / shadow-unknown')`.

**Outcome.** The engine spawns 3 explorers. H1 (HTTP server) returns
`verdict='works'` in 1 attempt. H2 (split ESM) returns `verdict='partial'`
(works but breaks Lighthouse budget). H3 is not run because H1 already
resolved. Synthesis worker claims task 26 with the 3 results, implements
the HTTP-server fixture in the test harness, records `outcome=passed`, and
calls `worker_done`.

### Example 2 — Cannon #31 Lighthouse loop (38 retry cycles)

**Setup.** AC-1.4 "Lighthouse Performance ≥80" verification task in the Cannon
baseline. Dev had merged a single-file `index.html` that eagerly imports
`vendor-three.js` (612KB). Lighthouse score stuck at 42/100 across 38 retry
cycles — verifier recorded `outcome=failed` 15 times (T-013 caught it),
dev attempted 23 fixes that each shaved 2-5KB off the bundle without ever
crossing the 80-point threshold.

**Diagnostician run.**

1. `task_get({id: 31})` → `task_kind=verification.ac`,
   `metadata.consecutive_retries=25`, plus T-013 evidence of 15 prior
   `outcome=failed` records with identical `evidence` content_hash.

2. Read `.solla/attempts/task-31/attempt-{1..25}.json`. Normalise. Observe:
   - 18 attempts have `approach_signature='remove-unused-imports+rerun-lighthouse'`.
   - 7 attempts have `approach_signature='minify-vendor-bundle'`.
   - All 25 have `edit_succeeded > 0` (real edits, not paralysis).
   - `error_signature='lighthouse-performance-score-<50'` consistent.

3. Classify: `loop_pattern = 'P3'` (wrong approach — edits succeed, score does not).

4. Read AC-1.4 and SRS §D2 for AC-1.4. Contract: "Lighthouse Performance
   ≥80 on a cold load over HTTP." Public protocol: `loadSolarCalculator()`.
   Criticality: `blocker`.

5. Generate 3 hypotheses:

   **H1 — Code-split three.js via dynamic import.** Keep eager imports for
   the calculator UI (small), lazy-load three.js after first user interaction
   with the 3D view. **skill_hint:** `React.lazy + Suspense + vite manualChunks`.
   **expected_outcome:** entry chunk <250KB, three.js loads on-demand,
   Lighthouse ≥80 within 2 attempts.

   **H2 — Replace three.js with a lighter 3D library (e.g. Ogl).** Three.js
   is 612KB minified; Ogl is ~80KB. **skill_hint:** `Ogl migration + shader
   port`. **expected_outcome:** bundle drops below 200KB; Lighthouse ≥90.
   **rejects_prior_approach:** all 25 attempts assumed three.js was fixed.

   **H3 — Renegotiate the AC budget.** Lighthouse ≥80 was a guess; if the
   product genuinely needs three.js eagerly for UX, propose lowering to
   ≥65 with a justification in the Decision Log (SRS §12). **skill_hint:**
   `AC renegotiation + SRS §12 Decision Log + stakeholder note`.
   **expected_outcome:** AC-1.4 updated, re-verified, pipeline advances.

6. Write outputs, comment, metadata handoff, `worker_done`.

**Outcome.** Explorers run all 3 in parallel (rate-limit permitting). H1
returns `verdict='works'` (Lighthouse 82). H2 returns `verdict='partial'`
(works but shader port incomplete). H3 is moot. Synthesis worker implements
H1's dynamic-import approach, re-runs Lighthouse, records `outcome=passed`.

## References

- `docs/plans/SAGA-V2-2-CONSOLIDATED.md` — §3.3 (Adaptive retry architecture),
  §4.4 Поток D (this skill is D1), §2 (what changed vs the superseded arbiter).
- `docs/research/testing-2026-07-21-sollar-new-pipeline.md` — T-011 proposal
  (line ~876), T-010 degradation model, T-013 review-loop escape.
- `docs/research/design-2026-07-20-worker-loop-detection.md` — S1/S2 detector,
  feeds `metadata.loop_recoveries`.
- `docs/research/autonomous-decision-unverifiable-acs.md` — origin of the
  arbiter concept; T-011 supersedes it but borrows MCDA-style discipline.
- `skills/saga-explorer/SKILL.md` — Phase 3, consumes this skill's hypothesis
  JSON files.
- `skills/autonomous-recovery/SKILL.md` — sibling skill for gate failures
  (not loop failures). The two are complements: recovery heals *state*,
  adaptive-retry escapes *loops*.
- `GUARDRAILS.md` — Sign 008 ("CGAD legitimacy-wash"): the diagnostician must
  not become a rubber-stamp for downgrading ACs. Hypothesis H3 ("shadow
  observation") is a last resort, not a default.
