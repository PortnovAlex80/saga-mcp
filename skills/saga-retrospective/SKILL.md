---
name: saga-retrospective
description: "Post-episodic pattern extractor (BMAD B2). Triggered on episode completed.transition. Reads worker_executions + verification_evidence for the episode, groups by pattern (retry loops, time waste, missing specialists, model swap candidates), writes a summary.retro artifact and persists patterns to project.notes with tag 'voyager-skill'. The only skill whose ROI compounds over time."
---

## saga-retrospective — extract lessons from a completed episode

**Source plan:** `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G2, BMAD B2)
**Audit motivation:** `docs/research/audit-2026-07-20-cannon-1000-score.md`
§5 — Cannon's #31 Lighthouse retry loop ran 38 cycles (~95 min waste), #36
ran 6+. These are patterns that repeat across episodes. Without a
retrospective skill, every episode re-discovers them.

## Why this skill exists

Saga learns only if it remembers. Today the `activity_log` records events but
nobody reads them. A new episode starts cold, hits the same wall (unverifiable
NFR, retry loop, missing scratch cleanup), and burns the same tokens.

This skill closes that loop. After every `completed` episode, it reads the
worker execution trace, identifies patterns, and writes them down where the
next planning/architecture phase will find them. The patterns become
**voyager-skills** (reusable heuristics) accumulated in `project.notes`.

This is the **only** saga skill whose ROI compounds over time. The first
retrospective adds 0 value. The 10th adds 10 episodes worth of patterns. The
100th turns saga into a learning system.

## Product-board contract

- Project: the completed episode's product.
- Epic: the completed episode's epic (REQ-NNN).
- Repository: the episode's physical repository (where the code lives).

No `worker_next` — this skill is **not** dispatched through the kanban. It is
triggered by the orchestrator on `episode_transition(to_stage='completed')`
and runs as a one-shot, not as a claimed task.

If you are running this skill via direct invocation (operator command,
saga-orchestrator sub-step), pass `--epic-id=<N>` or read it from
`.saga/last-completed-episode.json`.

## Flow position

- **Stage:** post-`completed` (after the episode transitions from
  `integration` to `completed`).
- **Precondition:** episode's `episode_workflows.current_stage='completed'`
  AND no existing `summary.retro` artifact for this epic.
- **Postcondition:** one `summary.retro` artifact created + N notes saved to
  `project.notes` with tag `voyager-skill`.

The skill is **idempotent** within an episode. If a `summary.retro` artifact
already exists for this epic → exit without re-writing.

## When to use

Triggered automatically by `saga-orchestrator` after a successful
`episode_transition(to_stage='completed')`. Can also be invoked manually:

```
saga-retrospective --epic-id=42
```

Use manually when:
- An episode was marked `completed` but the retrospective failed (transient
  error). Re-run is safe (idempotent).
- An operator wants to regenerate the retro after fixing data issues.
- A researcher is auditing old episodes to back-fill patterns.

Do NOT use:
- Mid-episode (no data yet to extract patterns from).
- On `cancelled` episodes (insufficient signal — they were killed, not
  completed).

## What to do (step-by-step)

### Step 1. Load episode context

```
episode_status({ epic_id })
```

Extract:
- `current_stage` — must be `completed` (or `integration` if user is running
  manually post-success).
- `stage_task_counts` — total tasks by stage.
- `baseline_artifact_id` — the AC baseline that drove development.

If `current_stage` is not `completed` and not `integration` → exit with
`result='episode not finished, nothing to retro'`.

### Step 2. Read all worker executions

```
SELECT * FROM worker_executions WHERE epic_id = ? ORDER BY started_at;
```

(Or equivalent via tracker_export / activity_log filtered to this epic.)

For each execution, collect:
- `task_id`, `task_kind`, `worker_id`
- `started_at`, `ended_at`, `duration_ms`
- `exit_status` (success / failure / killed / timed_out)
- `tokens_in`, `tokens_out`
- `model_id` (if recorded)
- `result` (the worker's done-summary)

Aggregate:
- Total wall clock = max(ended_at) − min(started_at)
- Total active GPU time = sum(durations)
- Overhead ratio = (wall − active) / wall
- Tasks per worker (load balance check)
- Per-kind average duration

### Step 3. Read verification evidence

```
observation_list({ epic_id, observation_type: 'benchmark' })
SELECT * FROM verification_evidence WHERE task_id IN (SELECT id FROM tasks WHERE epic_id = ?);
```

Aggregate:
- Counts by outcome: passed / failed / unknown / error
- ACs by readiness: blocker-passed, blocker-failed, degradable-unknown,
  nice-to-have-skipped
- Top-3 most-retried ACs (count of evidence records per AC)
- ACs that ended `unknown` — were they `degradable` (acceptable) or
  `blocker` (should not happen)?

### Step 4. Read activity log for high-signal events

```
activity_log({ entity_type: 'epic', entity_id: <epic_id>, limit: 200 })
```

Filter for:
- `status_changed` events on tasks (count of transitions per task — high
  count = retry loop).
- `created` events for `recovery.*` task kinds (recovery was triggered).
- `updated` events where `metadata.needs_human` flipped true (operator
  interventions).
- Comments with `ASK:` prefix (worker_ask_need calls).

### Step 5. Identify patterns

Group findings into the canonical pattern categories. For each category,
count occurrences and total waste (time or tokens).

#### Pattern P1 — Retry loops

A task with > 3 status transitions `in_progress → review → todo → in_progress`
(or `in_progress → review_in_progress → todo`).

Extract:
- task_id, task_kind
- cycle count
- total wall time spent
- whether it was eventually solved (and by what — hint? different worker?
  operator intervention?)
- candidate root cause from the worker comments

Cannon's #31 (38 cycles on Lighthouse NFR) and #36 (6 cycles on success rate)
are textbook P1.

#### Pattern P2 — Time waste

Tasks whose `duration_ms` is > 2× the per-kind median. Includes:
- Verifier tasks that ran property tests in headless env and recorded
  `unknown` for ACs that need a browser (NFR-1 Lighthouse, NFR-3 60fps).
- Recovery tasks that detected nothing actionable.
- Workers that retried the same edit 5+ times before commit.

Extract per offender: task_id, duration, what the worker was doing.

#### Pattern P3 — Missing specialists

Tasks tagged `needs-specialist` but routed to a generalist worker, OR tasks
where the AC's `domain` (perf, types, security) had no matching specialist
skill loaded. Cannon's renderer.ts lazy-load fix needed `saga-perf-tuner`;
without it, the worker burned 38 cycles.

Extract:
- domain tags that appeared without a matching specialist
- tasks that would have benefited from `saga-perf-tuner`, `saga-type-fixer`,
  etc.

#### Pattern P4 — Model swap candidates

Tasks where a stronger model would have helped (or a weaker model would have
sufficed):

- Verification on a complex AC where a strong model is needed but a weak one
  ran (P95 context > 100k = model is drowning).
- Simple mechanical tasks (import cleanup, lint fix) where a fast weak model
  would have been 5× cheaper for the same outcome.

Extract per offender: task_id, current model, suggested model, reason.

#### Pattern P5 — Tooling gaps

Errors in worker logs of the form:
- `command not found: jscpd` (specialist wanted a tool not installed)
- `tsc not configured` (build-gate could not run)
- `coverage reporter missing`

These are infrastructure issues the next episode should fix before kickoff.

#### Pattern P6 — Process anti-patterns

- Builder committed scratch files (Cannon `_calc.awk`).
- Verifier read Builder's tests (CGAD P7 violation).
- Reviewer rubber-stamped TS errors.
- Planner created tasks without source_artifact_ids.

These map to skill gaps. Each becomes a `voyager-skill` note tagged
`process-anti-pattern` so the next planning phase can add an AC preventing
recurrence.

#### Pattern P7 — Wins (positive patterns)

Don't only record failures. Record what worked unusually well so it can be
repeated:
- Scaffold task that enabled 4 parallel dev tasks without conflict.
- Recovery that succeeded on first retry after a diagnostic.
- Architectural decision that prevented a class of bugs.

These are `voyager-skill` notes tagged `process-pattern` (positive).

### Step 6. Write the `summary.retro` artifact

```
artifact_create({
  project_id,
  epic_id,
  type: 'summary',
  title: `Retrospective — REQ-NNN (<epic name>)`,
  code: 'RETRO-1',
  status: 'accepted',
  path: 'docs/retro/REQ-NNN-retro.md',
  tags: ['retrospective', 'voyager-skill'],
  metadata: {
    episode_wall_clock_ms,
    episode_active_ms,
    overhead_ratio,
    tasks_total,
    tasks_done,
    evidence_outcomes: { passed, failed, unknown, error },
    pattern_counts: { P1, P2, P3, P4, P5, P6, P7 }
  }
})
```

The artifact's document content (the .md file) has this structure:

```markdown
# Retrospective — REQ-NNN (<epic name>)

**Date:** YYYY-MM-DD
**Wall clock:** Nh Nm | **Active GPU:** Nh Nm | **Overhead:** N%
**Tasks:** X done / Y total | **Evidence:** A passed / B failed / C unknown

## 1. Executive summary

<2-3 sentences. What went well, what went badly, what surprised us.>

## 2. Pattern findings

### P1 — Retry loops (<count> occurrences, <total waste>)

| Task | Cycles | Waste | Root cause | Resolution |
|---|---|---|---|---|
| #31 | 38 | 95 min | Lighthouse NFR unverifiable in headless env | Operator hint; should use saga-arbiter or saga-perf-tuner |

### P2 — Time waste ...

### P3 — Missing specialists ...

### P4 — Model swap candidates ...

### P5 — Tooling gaps ...

### P6 — Process anti-patterns ...

### P7 — Wins ...

## 3. Lessons learned

<3-5 bullet points, distilled. These are the highest-signal output.>

- Lesson: For NFR-1 (Lighthouse) and NFR-3 (60fps), mark AC criticality=
  degradable in the baseline; verification will record `unknown` and the
  episode will reach Integration without operator intervention.
- Lesson: When a worker hits ≥3 retries on the same AC, auto-spawn
  saga-diagnostician. The diagnostician reads `worker_executions.attempt_history`
  and proposes a hypothesis; this is cheaper than operator hint.

## 4. Action items for the next episode

| Action | Owner skill | When |
|---|---|---|
| Pre-install jscpd in CI image | saga-start | Before kickoff |
| Add `playwright-report/` to repo .gitignore template | saga-architect | SRS §10 |
| Mark all NFR-1/NFR-3 style ACs as criticality=degradable | saga-analyst | AC drafting |

## 5. Traceability

- Artifacts reviewed: <count> via artifact_list
- Worker executions analyzed: <count>
- Evidence records analyzed: <count>
- Activity log events scanned: <count>
```

The artifact's `content_hash` should be the SHA-256 of the .md file content.

### Step 7. Persist patterns as `project.notes`

For each non-trivial pattern (every P1 retry loop, every P3 specialist gap,
every P6 anti-pattern, every P7 win), create a separate note:

```
note_save({
  title: `voyager-skill: <short heuristic>`,
  content: `# Pattern: <name>

**Episode:** REQ-NNN (<epic name>, YYYY-MM-DD)
**Category:** P1 retry-loop | P3 specialist-gap | P6 anti-pattern | ...
**Frequency:** observed 1 time so far

## Symptom
<what happened, concretely>

## Root cause
<why>

## Heuristic (reusable)
<the rule the next episode should apply>

## Where to apply
- saga-planner: <how planner should change task creation>
- saga-architect: <how architect should change SRS>
- saga-analyst: <how analyst should change AC>
- saga-code-reviewer: <how reviewer should change verdict criteria>

## Trace
- task_id: <id>
- evidence: <link or quote>
`,
  note_type: 'technical',
  related_entity_type: 'project',
  related_entity_id: <project_id>,
  tags: ['voyager-skill', '<pattern-category>', 'retrospective']
})
```

Each note is independently searchable via `note_search({ query: 'voyager-skill' })`
or `note_list({ tag: 'voyager-skill' })`.

### Step 8. Print summary

Output a short summary (operator-facing):

```
RETROSPECTIVE COMPLETE — REQ-NNN
- Wall clock: 22h, Active: 12h, Overhead: 45%
- Tasks: 37 done / 41 total
- Evidence: 27 passed / 42 failed / 21 unknown
- Patterns found: P1×2, P2×5, P3×1, P4×3, P5×1, P6×4, P7×2
- Artifact: docs/retro/REQ-NNN-retro.md (RETRO-1)
- Voyager-skill notes written: 7
```

Exit. No `worker_done` (this skill is not a claimed task).

## Verdict / Output

This skill has no verdict — it is a post-hoc analysis tool. Its outputs are:

1. **`summary.retro` artifact** in the episode's artifact tree.
2. **`project.notes` entries** tagged `voyager-skill` (the compounding asset).
3. **Console summary** for the operator.

The next episode's planner/architect/analyst skills SHOULD query
`note_list({ tag: 'voyager-skill' })` before kickoff to inherit lessons. This
is the **compounding mechanism** — each episode's retro enriches the
knowledge base for all future episodes.

## Examples

### Example 1 — Cannon episode retro (condensed)

Triggered after REQ-001-Cannon reaches `completed`.

```
episode_status({ epic_id: 1 }) → current_stage='completed'

worker_executions scan:
- 133 executions
- wall = 22h, active = 12h, overhead = 45%
- P95 context = 121 490 tokens
- #31 retry count: 38 status transitions
- #36 retry count: 6 status transitions
- #33 worker_ask_need: 1 (manual verify)

verification_evidence scan:
- 90 records: 27 passed, 42 failed, 21 unknown
- NFR-1 (Lighthouse) ended `unknown` (degradable - OK)
- NFR-3 (60fps) ended `unknown` (degradable - OK)
- #31 evidence: 15× failed on the same assertion

activity_log scan:
- 156 events on #31 (recovery spirals)
- 3 phantom-zombie detections (tracker-view crashes)

Patterns found:
- P1 #31 retry loop, 38 cycles, 95 min waste
- P1 #36 retry loop, 6 cycles, 30 min waste
- P3 #31 needed saga-perf-tuner (lazy-load hint)
- P4 verification on weak model (qwen-35b) too slow; swap to gemma-12b for L3
- P4 simple tasks (import cleanup) on too-strong model; swap down
- P5 jscpd not installed; code-reviewer could not run duplication check
- P6 scratch file `_calc.awk` committed (Builder did not clean up)
- P6 reviewer rubber-stamped 36 TS errors
- P6 type drift SRS↔code: TrajectoryResult vs OrbitResult
- P7 scaffold task enabled 4 parallel dev tasks without conflict
- P7 recovery (atomic-release) saved 4 tasks from lost work
```

Artifact written: `docs/retro/REQ-001-Cannon-retro.md` (RETRO-1, 240 lines).

7 voyager-skill notes saved:
1. `voyager-skill: Lighthouse-style NFRs should be criticality=degradable`
2. `voyager-skill: When dev task retries ≥3 on same AC, spawn saga-diagnostician`
3. `voyager-skill: Code-reviewer must run tsc --noEmit before approving`
4. `voyager-skill: Builder must clean scratch files before worker_done`
5. `voyager-skill: Verification should use gemma-12b for L3 property tests`
6. `voyager-skill: Architect should pre-install jscpd, eslint, tsc in repo`
7. `voyager-skill: Scaffold-first pattern enables parallel dev without conflict`

### Example 2 — small S-size episode (minimal retro)

Triggered after REQ-007-deposit-calculator (S-size, 6 tasks, 1h wall clock).

```
Patterns found:
- P1 none
- P2 none
- P3 none
- P4 verification on default model (OK for S-size)
- P5 none
- P6 none
- P7 KISS architecture right-sized for S complexity
```

Artifact written: 80 lines (much shorter). 1 voyager-skill note saved:
`voyager-skill: S-size episodes do not benefit from scaffold; KISS suffices`.

This is fine — not every episode produces 7 lessons. The retro skill's
job is to **extract what's there**, not invent.

## Anti-patterns

- ❌ **Do not blame individual workers.** Patterns are about the system, not
  the worker_id. "Worker agent-3 is bad" is useless; "L3 verification on
  weak model is slow" is actionable.
- ❌ **Do not write a novel.** The retro artifact should be 100-300 lines.
  Long retros are not read; short ones are.
- ❌ **Do not skip P7 (wins).** A retrospective that only records failures
  breeds pessimism and misses reusable strengths.
- ❌ **Do not run mid-episode.** Partial data produces misleading patterns
  (e.g. an in-progress retry looks like a P1, but might resolve cleanly).
- ❌ **Do not write voyager-skill notes for one-off quirks.** A pattern
  needs to be plausibly repeatable. Reserve notes for things the next
  episode could actually hit.
- ❌ **Do not modify the artifact tree.** No `artifact_update`, no
  `verification_record`, no `trace_add`. This skill is read-only on the
  contract graph. The only writes are: one `summary.retro` artifact_create
  and N `note_save` calls.
- ❌ **Do not re-run on the same epic.** Idempotency check: if a
  `summary.retro` artifact already exists for this epic → exit.

## Rules

- Triggered by orchestrator on `completed.transition`. Not claimed via
  `worker_next`.
- Idempotent per epic (one retro artifact per epic).
- Output language: English (so future episodes with different operators can
  read the patterns).
- Pattern notes must be **actionable** — each must name the skill that
  should apply the lesson (saga-planner / saga-architect / saga-analyst /
  saga-code-reviewer / etc.).
- Notes use the `voyager-skill` tag so they can be enumerated cheaply via
  `note_list({ tag: 'voyager-skill' })`.
- The `summary.retro` artifact's `metadata.pattern_counts` is the structured
  query key — future analytics can chart "P1 frequency over time" by scanning
  retros across episodes.
- One task = one launch (the trigger is one-shot per episode completion).

## CGAD alignment

This skill implements CGAD's "third truth axis" (runtime observation)
feedback into the contract graph. The observations are already in
`activity_log` and `worker_executions` — this skill distills them into
artifacts (the first truth axis) so the next planning round can act on them.

| Truth axis | Source | This skill's role |
|---|---|---|
| Artifacts (contract graph) | PRD/SRS/UC/AC/FR/NFR/SRS | Reads to understand intent; writes `summary.retro` |
| Tasks (kanban) | tasks/subtasks/comments | Reads to understand execution |
| Observations (runtime) | worker_executions, evidence, activity_log | **Primary input** — distills into patterns |

## References

- Plan: `docs/plans/SAGA-V2-2-CONSOLIDATED.md` §4.7 (G2, BMAD B2)
- Audit: `docs/research/audit-2026-07-20-cannon-1000-score.md` §5-7
- Related skills: `saga-readiness-checker` (pre-mortem before code —
  complements this post-mortem), `saga-orchestrator` (trigger source),
  `saga-planner` (consumer of voyager-skill notes)
