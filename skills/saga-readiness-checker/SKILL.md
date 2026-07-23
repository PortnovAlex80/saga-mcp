---
name: saga-readiness-checker
description: "Adversarial review of the PLAN before code starts (BMAD B1). Triggered between planning and development. Reads SRS §D2 (AC→Implementation map), Decision Log §12, and PRD; verifies each dev-task has scaffold, public_protocol, and AC coverage; runs a pre-mortem (top-3 risks) and a Red Team (how could a dev worker break this plan?). Verdict: PASS | CONCERNS | FAIL."
---

## saga-readiness-checker — adversarial plan review before code

**Source plan:** `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G1, BMAD B1)
**Audit motivation:** `docs/research/audit-2026-07-20-cannon-1000-score.md`
§5 — Cannon's planner created dev tasks whose target_files did not exist in
the scaffold, an unverifiable NFR (Lighthouse) that triggered 38 retry
cycles, and type drift between SRS Port Registry and code. A pre-mortem
would have caught all three.

## Why this skill exists

The pipeline has gates between every stage, but the **planning → development**
transition is the most expensive mistake point. Once development starts,
every defect costs 10× more to fix than catching it 30 minutes earlier at
plan time.

Today the planner creates tasks and the orchestrator immediately dispatches
them to workers. There is no adversarial review of the plan itself. The
result (Cannon): dev workers discover mid-task that the scaffold is missing,
the AC is unverifiable in the test environment, or the public_protocol
declared in the SRS doesn't match anything in the code. Each discovery costs
a retry cycle (~50 min). Cannon burned 8 cycles on #31 alone.

This skill is the **pre-mortem** gate. It assumes the plan WILL fail and
asks: how? Then it returns a verdict that either greenlights development,
sends the plan back for revision, or flags specific concerns the orchestrator
must mitigate.

## Product-board contract

Same as `saga-worker` — use the assignment's product, epic, repository.
Resolve `project_id` from `.saga/project.json`. This skill is invoked by
the orchestrator between `episode_transition(to_stage='planning', ...)` and
`episode_transition(to_stage='development', ...)`.

It is dispatched as a **claimed task** with `task_kind='planning.readiness'`.
Use `worker_next({ role: 'reviewer' })` to claim, `worker_done` to release.

If no `planning.readiness` task exists in the queue, this skill has nothing
to do — exit. (Some episodes skip readiness check if the orchestrator
determines S-size + low complexity. Don't second-guess that.)

## Flow position

- **Stage:** 3-Planning (review buffer, after planner finishes)
- **Precondition:** the `planning.readiness` task exists and is unclaimed.
  The plan (SRS §D + tasks) is drafted. The SRS has been accepted by
  `saga-architecture-reviewer`. The dev tasks have been created by
  `saga-planner` but NOT yet dispatched.
- **Postcondition:** task transitions to `done`. The `result` field carries
  the verdict and the orchestrator reads it to decide:
  - PASS → proceed to `episode_transition(to_stage='development')`.
  - CONCERNS → proceed but with risk-mitigation notes attached to specific
    tasks (`task.metadata.readiness_concerns`).
  - FAIL → do NOT transition. The planner must re-plan. The orchestrator
    sends the plan back to `saga-planner` with the failure modes listed.

## When to use

Triggered automatically by `saga-orchestrator` between planning and
development stages. Manual invocation is rare but allowed:

```
saga-readiness-checker --epic-id=42
```

Use manually when:
- An operator wants a sanity check before kicking off a long autonomous run.
- A planner re-planned after a FAIL verdict and wants a re-check before
  re-transitioning.

Do NOT use:
- Before formalization (no plan exists yet).
- During development (the gate has already passed — use saga-code-reviewer
  per-task instead).
- On `cancelled` episodes.

## What to check

| # | Check | Source | Hard / soft |
|---|---|---|---|
| 1 | Every dev-task has a target_file that exists in the scaffold (or is the scaffold task itself) | SRS §D1 + task.source_ref | HARD |
| 2 | Every public file (in SRS §2b Port Registry) has a public_protocol declared | SRS §2b | HARD |
| 3 | Every accepted AC is implemented by ≥1 dev-task and covered by ≥1 FR or NFR in the PRD | artifact_list + trace_list | HARD |
| 4 | Every dev-task has source_artifact_ids (atomic provenance) | task_get | HARD |
| 5 | Every dev-task lists L1-L3 test obligations (T-014b) | task.metadata.test_layers | SOFT (warn) |
| 6 | Decision Log §12 has ≥3 decisions with alternatives (ГОСТ G3) | SRS §12 | SOFT (warn) |
| 7 | No two active dev-tasks share a conflict_key (file_path / schema) | conflict_check | HARD |
| 8 | Every `blocker` criticality AC has a verification task | tasks + artifacts | HARD |
| 9 | SRS §10 (Supporting Systems) and §11 (External Integrations) non-empty if PRD declares ops/integration needs | SRS + PRD | SOFT (warn) |
| 10 | Pre-mortem: top-3 risks identified + mitigation owner assigned | (synthesized) | HARD |
| 11 | Red Team: ≥3 "how could a dev worker break this plan?" scenarios identified | (synthesized) | HARD |
| 12 | Pattern inheritance: voyager-skill notes from prior episodes reviewed | note_list({tag:'voyager-skill'}) | SOFT (warn) |

<!-- source: EXT-15 https://mcpmarket.com/tools/skills/best-practices-audit (levnikolaevich ln-61-skill-reviewer) -->
**Structural-validation axes** (supplemental — borrow from best-practices-audit; these do NOT replace our CGAD checks 1-12 above, they add a structural-integrity pass over the plan as a *skill/document*):

| # | Axis | Check | Source | Hard / soft |
|---|---|---|---|---|
| 13 | Mutation-boundary match | Every dev-task's mutation boundary (what files it writes) matches its declared outcome — no read-only task has acquired implicit write authority, and no bounded writer (e.g. a test-builder) can repair product code outside its declared contract | task.source_ref + task.description | HARD |
| 14 | Description precision | Every task description states capability, positive trigger, and near-negative boundary (what it does AND what it does NOT do) — vague "implement X" descriptions fail | task.description | SOFT (warn) |
| 15 | Tool-path existence | Every capability the plan declares has an available tool path, a credible fallback, or an explicit BLOCKED outcome — no task references an MCP tool / CLI / file that doesn't exist | task.metadata + repo inventory | HARD |
| 16 | Output-contract fidelity | Every task's `worker_done` result distinguishes facts, inferences, missing evidence, verdict, and residual risk (mirrors EXT-15 evidence rules) | task.result template | SOFT (warn) |
| 17 | Stale / draft markers | No stale names, deleted paths, `TODO`/`FIXME`/`STATUS: DRAFT` markers, or generated copies in the plan artifacts | artifact.path docs | SOFT (warn) |
| 18 | Trigger-overlap | Neighboring task descriptions do not overlap in triggering scope (two dev-tasks that would both claim the same work) | task_list cross-check | SOFT (warn) |

## What to do (step-by-step)

### Step 1. Claim the task

```
worker_next({
  worker_id: '<readiness-NN>',
  project_id,
  role: 'reviewer'
})
```

If task is null → no readiness check queued for this episode; exit.
If task's `task_kind` is not `planning.readiness` → release via `worker_done`
with `result='wrong skill for task_kind=<X>'`.

### Step 2. Load the plan

```
task_get({ id })                         # the readiness task itself
episode_status({ epic_id })              # episode state
artifact_list({ epic_id, type: 'SRS' })  # the SRS
artifact_list({ epic_id, type: 'PRD' })  # the PRD
artifact_list({ epic_id, type: 'AC', status: 'accepted' })  # all ACs
artifact_list({ epic_id, type: 'decision' })                # Decision Log
task_list({ epic_id, workflow_stage: 'development' })       # dev tasks
```

Read each. The SRS document (at `artifact.path`) is the primary input —
open it and read §D1 (File Tree), §D2 (AC→Implementation Map), §D4 (Pattern
Selection), §2b (Port Registry), §10 (Supporting Systems), §11 (External
Integrations), §12 (Decision Log).

### Step 3. Check 1 — scaffold coverage (HARD)

For every dev-task with `task_kind='development.code'`:
- Read `task.source_ref.file` (or `task.metadata.scaffold_files` for the
  scaffold task itself).
- Verify the file exists in the worktree (or, for Pattern B clusters, that
  the scaffold task is `depends_on` by every Pattern A task in the cluster).

For every file referenced in SRS §D2 `files:` field:
- Either it exists in the worktree already (created by scaffold), OR
- It is the target of exactly one dev-task, AND that dev-task's source_ref
  matches.

**FAIL examples:**
- Dev-task #20 targets `src/ui/calculator-form.tsx` but the scaffold task
  was never created or never created that file.
- Two dev-tasks both target `src/physics-engine/orbital.ts` without
  `depends_on` ordering — they will collide.

### Step 4. Check 2 — public_protocol (HARD)

Read SRS §2b Port Registry. For each port listed:
- The `file_path` exists (or will exist via a dev-task).
- The `public_protocol` field is non-empty and references a real schema
  (e.g. `ICalculatorForm`, `PhysicsEnginePort`).
- The schema is declared in §2.3 (Invariant Registry) or in the source code
  of the port file itself.

**FAIL examples:**
- §2b declares port `TrajectoryResult` but no file in §D1 defines it. (This
  was Cannon's exact failure.)
- §2b lists a port with `file_path='src/physics/orbital.ts'` but the code
  lives at `src/physics-engine/orbital.ts`. Conflict key mismatch.

### Step 5. Check 3 — AC coverage (HARD)

```
artifact_coverage({ epic_id, type: 'AC', link_type: 'implements' })
```

For every accepted AC:
- There is ≥1 dev-task implementing it (`trace_add(source=AC, target=task,
  link_type='implements')`).
- There is ≥1 FR or NFR in the PRD that the AC `derived_from`.

**FAIL examples:**
- AC-9 has no dev-task implementing it (planner missed a row).
- AC-9 is `derived_from` UC-3, but UC-3 is not `covers`'d by any FR.
  (Traceability gap — formalization was incomplete.)

### Step 6. Check 4 — provenance (HARD)

For every dev-task:
```
task_get({ id }).source_artifact_ids
```

Must be non-empty. Each entry must be an accepted AC. Empty source_artifact_ids
= "Builder invented this task from nothing" — fails the CGAD provenance rule.

### Step 7. Check 5 — L1-L3 test obligations (SOFT)

For every dev-task, `task.metadata.test_layers` should list ≥1 of:
- `L1` (unit, fast)
- `L2` (integration, builder-side)
- `L3` (property, verifier-side — usually omitted because verifier generates
  these automatically)

Per T-014b, every dev-task must declare at least L1 + L2 if it implements
logic. Pure type/declaration tasks can be exempt.

**WARN examples (do not FAIL):**
- Dev-task implements algorithmic logic but lists no test_layers.
- Dev-task lists only L1 (no L2) for code with side effects.

### Step 8. Check 6 — Decision Log (SOFT)

Read SRS §12. Per ГОСТ G3, ≥3 decisions with:
- A name
- Alternatives considered (≥2)
- The choice + rationale

**WARN examples:**
- §12 has < 3 decisions.
- §12 has decisions but no alternatives listed (just "we chose X").

### Step 9. Check 7 — conflict keys (HARD)

```
conflict_check({ epic_id })
```

The returned collision set must be empty. If two active dev-tasks share a
`file_path`, `schema`, `public_protocol`, or `integration_branch` conflict
key, they WILL collide during merge.

**FAIL examples:**
- Dev-task #20 and #21 both have `file_path=src/physics-engine/orbital.ts`
  (Pattern A violated — should be Pattern B with scaffold).
- Two tasks both declare `schema=PhysicsEnginePort` for different files.

### Step 10. Check 8 — blocker AC verification (HARD)

For every AC with `metadata.criticality='blocker'`:
- There must exist a `verification.ac` task in the epic.
- That task's `verification_target_artifact_id` must point to this AC.

**FAIL examples:**
- AC-3 is `blocker` criticality but no verification task was created for it.
  (Planner forgot — T-014 says every AC gets a verification task, but bugs
  happen.)

### Step 11. Check 9 — Supporting Systems / External Integrations (SOFT)

If the PRD declares:
- Deployment needs (cloud, on-prem, edge) → SRS §10 must be non-empty.
- External service integration (3rd-party API, DB, message bus) → SRS §11
  must declare each integration with `external_protocol`.

**WARN examples:**
- PRD says "deployed to AWS Lambda" but SRS §10 is empty or generic.
- PRD mentions "Stripe integration" but SRS §11 has no Stripe entry.

### Step 12. Check 10 — pre-mortem (HARD)

Synthesize the **top-3 risks** of this plan, using:
- The pattern categories from prior episodes' retros:
  `note_list({ tag: 'voyager-skill', limit: 50 })`.
- The SRS's own risk section (if present).
- The conflict_check output (any near-misses).
- The PRD's NFR section (NFRs are common failure points — Cannon's Lighthouse
  + 60fps).

For each risk:
- Name it (1 line).
- Probability (low/medium/high) — based on historical pattern frequency.
- Impact (low/medium/high).
- Mitigation owner (which skill will handle it).
- Mitigation action (concrete — what should the owner do).

**Top-3 minimum.** More is fine if warranted. Less than 3 = FAIL.

Example pre-mortem for Cannon-style episode:
```
RISK 1: NFR-1 (Lighthouse ≥80) is unverifiable in headless test env.
  Probability: HIGH (prior episode hit this exact failure).
  Impact: HIGH (blocks Integration if marked blocker).
  Mitigation owner: saga-analyst (re-baseline), saga-orchestrator (route).
  Mitigation: Set AC criticality=degradable for NFR-1. Verifier records
              `unknown`; episode proceeds to Integration per T-010 §3.1.

RISK 2: vendor-three.js bundle exceeds Lighthouse budget.
  Probability: MEDIUM.
  Impact: MEDIUM (perf regression).
  Mitigation owner: saga-perf-tuner (specialist).
  Mitigation: Tag dev-task #15 with needs-specialist + domain:perf.
              saga-perf-tuner will diagnose bundle and emit hint for code-
              splitting before review.

RISK 3: orbital.ts file size > 500 lines (current SRS §D2 estimates 800+).
  Probability: HIGH.
  Impact: LOW (review will catch, but slow).
  Mitigation owner: saga-architect (re-spec), saga-planner (split task).
  Mitigation: Either re-spec §D2 to split orbital.ts into orbital-core.ts
              + orbital-validators.ts, OR mark it as a known long-file with
              inline justification.
```

### Step 13. Check 11 — Red Team (HARD)

Imagine you are a malicious or incompetent dev worker. How would you break
this plan? Synthesize ≥3 scenarios:

```
RED TEAM SCENARIOS:

S1 — "I'll just put all the logic in one file."
  Dev-task #20 says implement calculator-form.tsx. A lazy Builder puts all
  validation, formatting, and API calls in the same 800-line file. Reviewer
  catches it (file > 500 lines) but only after a 50-min cycle.
  Defense: §D4 Pattern Selection should pre-decompose clusters of >1 AC
  sharing a module into separate files. Currently §D4 has no entry for the
  ui module — add one.

S2 — "I'll stub the unverifiable test and claim it passes."
  Verifier on NFR-1 (Lighthouse) cannot run in headless env. A lazy Verifier
  could record `outcome='passed'` with `evidence='assumed'`. This violates
  CGAD P14 but might slip through if the verifier skill is misloaded.
  Defense: Blocker ACs require deterministic evidence (L0/L3). The gate
  should reject `outcome='passed'` without a deterministic provider. Add
  this rule to the orchestrator's gate logic, OR ensure NFR-1 is marked
  criticality=degradable so 'unknown' is acceptable.

S3 — "I'll commit scratch files; reviewer won't notice."
  Builder leaves _calc.awk in the diff. Reviewer (if phantom) rubber-stamps.
  Cannon's exact failure.
  Defense: saga-code-reviewer (NEW) runs scratch detection. Verify it's in
  the dispatch queue for every development.code task. If not — orchestator
  must be configured.
```

### Step 14. Check 12 — voyager-skill inheritance (SOFT)

```
note_list({ tag: 'voyager-skill', limit: 50 })
```

Filter to notes whose pattern matches this episode's stack/complexity. If
prior episodes hit a pattern this episode is likely to repeat (e.g.
Lighthouse-style NFR), check whether the plan addresses it.

**WARN examples:**
- A voyager-skill note says "mark Lighthouse NFRs as criticality=degradable"
  but this episode's NFR-3 is still `criticality=blocker`.
- A note says "scaffold-first for shared mutation" but this episode's plan
  uses Pattern A on a module with 3 ACs.

### Step 15. Compute verdict

Aggregate:

| Verdict | Condition |
|---|---|
| `PASS` | All HARD checks pass. SOFT checks may have warnings (noted in result). |
| `CONCERNS` | All HARD checks pass BUT ≥1 SOFT warning relates to a high-impact risk (e.g. Decision Log empty for an L-size episode). Orchestrator proceeds but attaches `metadata.readiness_concerns` to affected tasks. |
| `FAIL` | Any HARD check fails. Orchestrator must NOT transition to development. The result field lists failure modes for re-planning. |

### Step 16. Produce structured result

If PASS:
```
worker_done({
  task_id,
  worker_id,
  result: `READINESS: PASS

HARD CHECKS:
- scaffold coverage: OK (all 18 dev-tasks have valid target_files)
- public_protocol: OK (4 ports declared, all schemas resolve)
- AC coverage: OK (14/14 accepted ACs have ≥1 dev-task + ≥1 FR/NFR)
- provenance: OK (18/18 dev-tasks have source_artifact_ids)
- conflict keys: OK (no collisions)
- blocker verification: OK (5/5 blocker ACs have verification tasks)

PRE-MORTEM (top-3):
1. <risk name> — probability, impact, owner, mitigation
2. ...
3. ...

RED TEAM (top-3):
1. <scenario> — defense
2. ...
3. ...

SOFT WARNINGS (non-blocking):
- Decision Log §12 has only 2 decisions (target ≥3)
- NFR-3 (60fps) marked criticality=blocker — consider degradable if env
  cannot verify

VOYAGER-SKILL INHERITANCE:
- Reviewed 7 notes from prior episodes
- 2 applied to this plan (scaffold-first for ui module, Lighthouse as
  degradable by default)
- 1 not applicable (Kubernetes deployment — this episode is client-only)`
})
```

If CONCERNS:
```
worker_done({
  task_id,
  worker_id,
  result: `READINESS: CONCERNS

HARD CHECKS: all PASS

CONCERNS (high-impact soft warnings — orchestrator should mitigate):
- C1: Decision Log §12 is EMPTY for an L-size episode. Architect must
      draft ≥3 decisions before development starts. RECOMMEND: pause
      transition, route back to saga-architect for §12 fill-in.
- C2: 3 NFRs are marked criticality=blocker but the test environment
      cannot verify them (Lighthouse, 60fps, WebGPU). RECOMMEND: route
      to saga-analyst to re-baseline as criticality=degradable.

PRE-MORTEM / RED TEAM: <as above>

ORCHESTRATOR ACTION: proceed to development BUT attach metadata.readiness_concerns
to tasks #15, #22, #31 with the C1/C2 references. saga-worker should read
these concerns before claiming.`
})
```

If FAIL:
```
worker_done({
  task_id,
  worker_id,
  result: `READINESS: FAIL

FAILURE MODES (HARD check failures — orchestrator must NOT transition to
development):

F1 [scaffold coverage] Dev-task #20 targets src/ui/calculator-form.tsx but
   the scaffold task #10 was never created. Plan is unexecutable as-is.
   FIX: Either create the scaffold task (Pattern B), or change #20 to
   Pattern A (self-scaffold).

F2 [public_protocol] §2b declares port 'TrajectoryResult' but no file in
   §D1 defines this type. Cannon-style drift.
   FIX: Architect must rename to 'OrbitResult' (which exists) or add a
   type definition file.

F3 [conflict keys] Dev-tasks #20 and #21 both write src/physics-engine/orbital.ts
   without depends_on ordering. They will collide.
   FIX: Add #21.depends_on = [#20], OR re-plan as Pattern B with scaffold.

F4 [blocker verification] AC-3 (criticality=blocker) has no verification task.
   FIX: Planner must create verification.ac task targeting AC-3.

PLANNER ACTION: re-plan addressing F1-F4, then re-run readiness check.`
})
```

### Step 17. Side-effects on CONCERNS

If the verdict is CONCERNS and the orchestrator (next dispatcher cycle)
proceeds, it should attach `metadata.readiness_concerns` to the specific
tasks mentioned in the result. This is the orchestrator's responsibility,
not this skill's — this skill only emits the verdict. The skill does NOT
call `task_update` on dev-tasks.

## Verdict

| Verdict | Orchestrator action |
|---|---|
| `PASS` | `episode_transition(to_stage='development')`. Dev tasks become claimable. |
| `CONCERNS` | `episode_transition(to_stage='development')` + tag affected dev-tasks with `metadata.readiness_concerns`. saga-worker reads the concerns before claiming. |
| `FAIL` | Do NOT transition. Re-dispatch `saga-planner` with the failure modes. Planner re-plans. New `planning.readiness` task is created. This skill re-runs. |

The verdict is the only thing the orchestrator reads. The result text must
be parseable: lines starting with `F<n>` are failure modes (FAIL), lines
starting with `C<n>` are concerns (CONCERNS), the rest is informational.

## Examples

### Example 1 — clean S-size episode

```
READINESS: PASS

HARD CHECKS:
- scaffold coverage: OK (4 dev-tasks, all target_files exist)
- public_protocol: OK (1 port: ICalculator)
- AC coverage: OK (4/4 ACs implemented)
- provenance: OK (4/4 with source_artifact_ids)
- conflict keys: OK (no collisions)
- blocker verification: OK (1/1 blocker AC verified)

PRE-MORTEM:
1. Test env cannot run E2E in headless — probability LOW (no E2E in plan).
2. ... etc

RED TEAM:
1. Builder might over-engineer simple form — probability LOW for S-size.

VOYAGER-SKILL: reviewed 3 notes, none directly applicable.
```

### Example 2 — Cannon-style FAIL

```
READINESS: FAIL

FAILURE MODES:

F1 [scaffold coverage] #20 targets src/ui/calculator-form.tsx — no scaffold
   task created it. Pattern A on a UI module with 3 ACs is risky.
F2 [public_protocol] §2b port 'TrajectoryResult' has no file definition.
   Cannon-style type drift — will produce TS2304 errors.
F3 [AC coverage] AC-12 (60fps) has dev-task but no FR/NFR 'derived_from'
   edge in the PRD. Formalization incomplete.
F4 [blocker verification] NFR-1 (Lighthouse) is criticality=blocker but
   no verification task was created. Verifier cannot run Lighthouse in
   headless env. Episode will deadlock at Integration gate.

PLANNER ACTION: re-plan addressing F1-F4. Specifically:
- Add scaffold task for ui/ module (Pattern B).
- Rename 'TrajectoryResult' to 'OrbitResult' in §2b OR add type file.
- saga-analyst must add FR covering 60fps requirement.
- Re-baseline NFR-1 as criticality=degradable.
```

### Example 3 — CONCERNS on medium episode

```
READINESS: CONCERNS

HARD CHECKS: all PASS

CONCERNS:
- C1: Decision Log §12 has 1 decision, target ≥3. (L-size episode.)
- C2: NFR-3 (WebGPU available) marked blocker but test env has no WebGPU.
      Likely to record 'unknown' repeatedly.

PRE-MORTEM:
1. WebGPU env mismatch — HIGH probability, MEDIUM impact.
   Owner: saga-analyst. Mitigation: re-baseline as degradable.
2. ... etc
```

## Anti-patterns

- ❌ **Do not approve "because the planner is usually right."** Adversarial
  review is the whole point. Be skeptical.
- ❌ **Do not invent failure modes.** Each F/C must reference a specific
  artifact, task, or SRS section. Vague concerns ("might be hard") are
  useless.
- ❌ **Do not run code.** This skill reads artifacts and tasks. It does not
  execute anything in the worktree. Code execution is for code-reviewer
  (post-build) and verifier (post-dev).
- ❌ **Do not call `worker_next` again after `worker_done`.** One task per
  launch.
- ❌ **Do not call `worker_ask_need`.** If you cannot decide (e.g. an NFR's
  testability is genuinely ambiguous), pick the more conservative verdict
  (CONCERNS) and document the ambiguity. The orchestrator will route.
- ❌ **Do not skip the pre-mortem or Red Team.** These are the highest-value
  outputs. A readiness check with only HARD checks is just a glorified lint.
- ❌ **Do not modify the plan.** No `task_create`, no `task_update`, no
  `trace_add`. The skill is read-only on the plan. Only the planner (on
  FAIL) or orchestrator (on CONCERNS) acts.
- ❌ **Do not write `summary.retro` artifacts.** That's saga-retrospective,
  post-episode. You are pre-episode.

## Rules

- One task = one launch.
- Verdict must cite specific artifact IDs, task IDs, or SRS sections in the
  `result` text.
- The result text is parsed by the orchestrator — use the F<n>/C<n> prefixes
  strictly.
- If the readiness task itself has no SRS or no accepted ACs (e.g. a
  misconfigured episode), FAIL with F1 "no accepted SRS — cannot review."
- If the SRS document is missing on disk → FAIL with F1.
- The pre-mortem must list ≥3 risks; fewer = FAIL with F<n> "pre-mortem
  incomplete."
- The Red Team must list ≥3 scenarios; fewer = FAIL.
- PASS verdict requires ALL HARD checks + ≥3 pre-mortem risks + ≥3 Red Team
  scenarios.
- CONCERNS verdict requires all HARD checks but allows informational
  warnings on SOFT checks.
- FAIL verdict requires ≥1 HARD check failure OR <3 pre-mortem risks OR
  <3 Red Team scenarios.

## CGAD alignment

This skill is the **gate between planning and development**. It implements
the CGAD principle that "the plan is a contract" — and contracts must be
adversarially reviewed before they bind anyone to expensive work.

| CGAD principle | This skill's role |
|---|---|
| P2 (status change, not destruction) | FAIL does not delete the plan; it sends it back |
| P7 (independence) | Reviewer is a separate worker from planner |
| P14 (deny-by-default) | Hard failures block transition |
| §9 (test layers) | Checks L1-L3 obligations per task |
| §34 (semantic conflict detection) | Uses conflict_check |

## References

- Plan: `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G1, BMAD B1)
- Audit: `docs/research/audit-2026-07-20-cannon-1000-score.md` §5-7
- Related skills: `saga-planner` (re-plans on FAIL), `saga-architect`
  (re-specs on F2/F4), `saga-analyst` (re-baselines ACs on F4),
  `saga-retrospective` (post-episode patterns — feeds this skill's
  voyager-skill inheritance check)
