# Delegation Contract — one task, one subagent, one returned result

> One-page spec of how the saga-orchestrator delegates exactly one task to
> exactly one subagent (a `saga-*` worker skill), and what the worker owes
> back before the orchestrator considers the delegation complete.
>
> This is **not** a parallel protocol. It is the discipline wrapped around our
> existing `worker_next` / `worker_done` / `worker_ask_need` engine calls. If
> anything here conflicts with the engine or with CGAD, the engine + CGAD win.
>
> <!-- source: EXT-1 https://github.com/obra/superpowers — subagent-driven-development:
>      "fresh subagent per task + task review + result-return obligation". We adopt the
>      *discipline* (curated context, one task per launch, explicit result status); we
>      do NOT adopt superpowers' parallel dispatch, model-tier selection, or its status
>      vocabulary verbatim — those map onto CGAD's worker_* calls below. -->

## 1. The unit of delegation

**One task = one worker launch = one returned result.** The orchestrator
never bundles two tasks into one dispatch, and never lets a worker pick up a
second task in the same launch. A worker that finishes calls `worker_done`
(which clears its assignment and frees the task) and then **exits**; the
dispatch loop claims the next task for a *fresh* worker.

<!-- source: EXT-1 subagent-driven-development "Red Flags": "Dispatch multiple
     implementation subagents in parallel (conflicts)" and "Fresh subagent per
     task (no context pollution)". CGAD enforces the same: worker_done carries
     stop:true and clears assigned_to — a worker does not self-claim the next task. -->

Why fresh context per task: a worker must reason about its assigned task from
the task's source artifact (the AC / SRS §D2 entry / FR), not from a previous
task's accumulated history. The orchestrator (or dispatch loop) curates what
context the worker starts with; the worker does not inherit the orchestrator's
session memory.

## 2. What the orchestrator hands the worker

The orchestrator does **not** write the task's content — `workflow_generate_next`
and `saga-planner` do. The orchestrator's job, when a delegation is about to
start, is to make sure the worker can find everything it needs without
re-deriving it:

- `project_id` + `epic_id` (resolved once from `.saga/project.json`).
- The task is already created and `todo`, unassigned, with no unmet
  dependencies (otherwise `worker_next` returns nothing to claim).
- The upstream accepted artifacts the task's `source_artifact_ids` point at
  are accepted and hash-pinned (the planner set provenance; the orchestrator
  trusts `episode_status` for this).
- The repository checkout is registered for this machine.

The worker is then launched with its execution skill
(`execution_skill`, e.g. `saga-worker`, `saga-product`, `saga-analyst`). The
orchestrator's dispatch prompt names **where this task fits** (one line) and
**where to read the requirements** (the task + its source artifact), not a
restatement of the requirements themselves.

<!-- source: EXT-1 subagent-driven-development "File Handoffs / Task brief":
     "your dispatch should contain: (1) one line on where this task fits; (2) the
     brief path ... (3) interfaces ... (4) your resolution of ambiguity; (5) the
     report-file path and report contract." We keep the *shape* (curated, minimal,
     pointer-based) but the "brief path" is the task + source artifact in the tracker,
     and the "report contract" is worker_done's result string (a comment on the task). -->

## 3. The result-return obligation

A delegated worker MUST return one of the following before its launch is
considered closed. These are the CGAD-native equivalents of superpowers'
implementer statuses (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED):

<!-- source: EXT-1 subagent-driven-development "Handling Implementer Status" — the
     four-status vocabulary. We do not reuse the literal words; we map each to a
     regulated engine call so the no-self-authorization invariant (CGAD) holds. -->

| Worker situation | CGAD engine call | Superpowers analog | Worker exits? |
|---|---|---|---|
| Work complete, ready for review/merge | `worker_done(result:<summary>, verdict:"approved")` | DONE | yes |
| Work complete but reviewer requests changes (worker IS the reviewer, `review_in_progress`) | `worker_done(verdict:"changes_requested")` | (n/a — superpowers re-dispatches the same implementer; CGAD returns the task to the unassigned todo queue for a **fresh** developer) | yes |
| Genuinely blocked, needs a human answer that cannot be assumed or deferred | `worker_ask_need(reason:<question>)` | BLOCKED → "escalate to the human" | yes (terminal — Slice 3 / ADR-011) |
| Crashed / timed out / left no result | (none — execution terminalized by the engine; `worker_health` surfaces it) | (subagent crash) | yes |

**The obligation is: exactly one of these calls fires, and then the worker
process exits.** A worker that neither calls `worker_done` nor
`worker_ask_need` and simply stops talking is a stuck execution — the
orchestrator/dispatch loop treats it as a crash, not as "still working". There
is no fifth "I'll keep going and pick up more tasks" outcome.

> **Critical difference from superpowers.** In superpowers, a BLOCKED
> implementer is re-dispatched by the controller with more context or a
> stronger model, in the same session. In CGAD, `worker_ask_need` is
> **terminal**: it opens a `human_request`, releases the execution, and clears
> the assignment. The orchestrator/dispatch does **not** wait for a result
> from that launch — it will not arrive. A fresh worker later claims the
> answered task and reads the persisted question + answer. Do not spin on a
> delegation whose worker called `worker_ask_need`.

## 4. What "result returned" means concretely

A delegation is **complete** when the worker has called `worker_done` (any
verdict) or `worker_ask_need`, OR the engine has terminalized the execution.
For typed `git_change` tasks, `worker_done(verdict:"approved")` from a
`review_in_progress` task only sets `integration_state=pending` — the work is
*done* but not yet *integrated*. Downstream generation and dependency release
stay gated until `worker_merge_release(result:"merged")` fires. So:

- **Done (reviewable):** `worker_done` called → task in `review` or `done`.
- **Integrated (releases dependents):** `worker_merge_release(result:"merged")`
  called on a `done` task → `metadata.worktree.merged_into="dev"`.

The orchestrator's per-stage checkpoint (`episode_transition`) requires the
*integrated* state, not merely `done`. A delegation whose worker called
`worker_done` but never merged has **not** unblocked the next stage.

<!-- This is a CGAD invariant superpowers lacks: superpowers merges at the end via
     "finishing-a-development-branch" as a single branch-wide step. CGAD gates every
     typed task behind an integration lock with idempotent downstream generation. -->

## 5. What the orchestrator NEVER does during a delegation

- Does not call `worker_next` / `worker_done` itself — that is the worker's
  and the dispatch loop's domain (the orchestrator spawns `saga-dispatch`,
  which owns the loop; or spawns the role skill inline). The orchestrator's
  own guardrail: "НЕ вызывай worker_next/worker_done сам".
- Does not pre-judge the worker's verdict or instruct a reviewer to ignore a
  finding. (Superpowers makes the same point about reviewer prompts: never
  write "do not flag X".) If the orchestrator believes a finding is a false
  positive, it lets the review loop raise it and adjudicates via
  `worker_done(verdict:"changes_requested")` or a comment, never by gagging
  the reviewer upfront.

<!-- source: EXT-1 subagent-driven-development "Constructing Reviewer Prompts":
     "never instruct a reviewer to ignore or not flag a specific issue ... If the
     prompt you are writing contains 'do not flag' ... you are pre-judging." Adopted
     verbatim in spirit — it reinforces our review_in_progress → done gate. -->

- Does not authorize its own retry, completion, or degradation. R5 of the work
  order: no self-authorization. The orchestrator proposes (dispatches); the
  worker proposes (worker_done); the engine + evidence + (for critical risk)
  the human decide.
- Does not invent a second worker for the same task while one is in flight —
  `worker_next` is atomic and fenced by `execution_id`; two workers on one
  task is a structural error, not parallelism.

## 6. Durable progress (borrowed, adapted)

Superpowers tracks progress in a ledger file because conversation memory does
not survive compaction, and controllers that lost their place have
re-dispatched entire completed task sequences. CGAD already solves this
**structurally**: task status lives in the tracker (`task.status`,
`integration_state`, `verified_by` evidence), not in the orchestrator's
memory. So the CGAD-native "ledger" is:

- `task_list({epic_id, status})` — what is todo / in_progress / done.
- `episode_status({epic_id})` — which stage the episode is in, and drift state.
- `artifact_coverage({epic_id, link_type:"implements"|"verified_by"})` — gaps.
- `worker_health({project_id})` — zombies, never-merged, stuck merges.

After any context loss, the orchestrator trusts **the tracker + `git log`**
over its own recollection — exactly superpowers' rule, but the ledger is the
database, not a scratch file. Re-dispatching a task the tracker already marks
`done`/`merged` is the single most expensive orchestrator failure; guard
against it by reading `task_list` before dispatching.

<!-- source: EXT-1 subagent-driven-development "Durable Progress": "After compaction,
     trust the ledger and git log over your own recollection." Adopted; the tracker
     IS the ledger. We do not add a separate progress.md file. -->
