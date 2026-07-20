---
name: autonomous-recovery
description: "Autonomous recovery skill — runs a structured decision loop (Cynefin triage + MCDA + pre-mortem + Red Team) to FIX saga engine failures without escalating to a human. Used by recovery.heal tasks when a stage gate fails or a producer worker left artifacts in a bad state. Can move tasks backwards (status=todo) to force rework. The agent has more context than the human sponsor — asking the human to rubber-stamp an engineering trade-off is an anti-pattern."
---

## What this skill is for

The saga engine's default failure mode is **stop and ask the human** every time a stage gate fails, a worker leaves artifacts in a bad state, or traces are missing. Each stop breaks the pipeline, costs a round-trip, and usually the human either rubber-stamps whatever the agent proposed or has less context than the agent does.

This skill replaces "ask the human" with a **structured self-decision loop** that produces a real fix AND leaves an audit trail. Use it inside any `recovery.heal` task when the temptation is to call `worker_ask_need`.

**What this skill is NOT for:**
- Genuine blockers that only a human can resolve: credentials, business intent, external authority approval, irreversible destructive actions (deleting user data, dropping tables, force-push to main).
- For those, `worker_ask_need` is correct — but they are <5% of recovery scenarios.

## The 6-step recovery loop

```
  recovery.heal task claimed
       │
       ▼
  1. DIAGNOSE  ──── read the gate error + DB state, identify the exact defect
       │
       ▼
  2. CYNEFIN TRIAGE  ──── Clear? Complicated? Complex? Chaotic? Genuine-human-only?
       │  (Clear → just fix it; Chaotic → stabilize first)
       ▼
  3. OPTION GENERATION  ──── 3 candidate fixes with trade-offs
       │
       ▼
  4. MCDA MATRIX  ──── score: correctness, minimal-blast-radius, reversibility, audit-trail-clarity
       │
       ▼
  5. APPLY + VERIFY  ──── execute the fix, re-check the gate condition
       │
       ▼
  6. RECORD  ──── task comment with diagnosis, options considered, fix applied
```

---

## Step 1 — Diagnose the exact defect

Read the task description (the engine put the gate error there). Then **query the DB to confirm the exact defect** before fixing.

> **Gate contract (reordered pipeline, ADR-013).** The formalization stage now
> runs in this order:
>
> ```
> PRD(+FR/NFR/RULE children) → UC → AC → Reconciliation(baseline freeze)
>   → SRS(architect reads frozen AC + complexity) → planning
> ```
>
> The `formalization → planning` episode_transition gate requires:
> 1. `assertTasksReady('formalization')` — ALL formalization tasks done,
>    INCLUDING `formalization.srs` (SRS task spawned by `baseline_accepted`,
>    not by `prd_accepted`).
> 2. `assertTraceability(epicId)` — canonical lineage edges:
>    - PRD → brief (derived_from)
>    - SRS → PRD (derived_from) — added by saga-architect, NOT by reconciler
>    - Each UC → PRD (derived_from) AND ≥1 FR (covers)
>    - Each AC → ≥1 FR/NFR (derived_from, REQUIRED) AND ≥1 UC (derived_from,
>      REQUIRED for FR-derived ACs; NFR-only ACs are exempt)
> 3. `acceptedBaseline` — every AC status='accepted', content_hash set,
>    accepted_hash matches, drift_state='clean'.
>
> Note: AC → FR/NFR edges target FR/NFR artifacts that are **children of the
> PRD** (saga-product registers them). The gate queries by `target.type` within
> the epic — it does not care whether the FR's parent is PRD or SRS. So a gate
> failure on "AC has no derived_from to FR" means the AC↔FR edge is missing,
> NOT that the FR is in the wrong place. Same for UC → FR covers.

| Gate error pattern | What to query |
|---|---|
| `AC <code> has no 'derived_from' trace to any UC/FR/NFR` | `trace_list({source_id: <AC id>})` — see what traces exist. FR/NFR are children of PRD; link to the artifact id directly. |
| `AC <code> traces to FR but has no 'derived_from' trace to any UC` | `trace_list({source_id: <AC id>})` — FR-derived ACs MUST also trace to a UC; NFR-only ACs are exempt. |
| `UC <code> has no 'derived_from' trace to PRD` | `trace_list({source_id: <UC id>})` — UC must trace to PRD. |
| `UC <code> has no 'covers' trace to any FR` | `trace_list({source_id: <UC id>})` — UC must cover ≥1 FR (FR is child of PRD). |
| `PRD has no 'derived_from' trace to a brief` | `trace_list({source_id: <PRD id>})` |
| `SRS has no 'derived_from' trace to PRD` | `trace_list({source_id: <SRS id>})` — SRS is now added by saga-architect AFTER baseline. If this fails post-reorder, the architect forgot the trace_add. |
| `AC baseline is not accepted and clean` | `artifact_list({epic_id, type:'AC'})` — check status, content_hash, accepted_hash, drift_state |
| `formalization gate failed: tasks not completed/integrated: #N` | `task_get({id: N})` — check status, integration_state. Could be the SRS task (`formalization.srs`) that hasn't reached done — the architect must finish before formalization→planning. |
| `formalization gate failed: no formalization tasks exist` | `task_list({epic_id, workflow_stage:'formalization'})` — if empty, the `baseline_accepted` transition may have failed to spawn the SRS task; check workflow_generate_next logs. |
| `no <stage> tasks exist` | `task_list({epic_id, status:'todo'})` — see what's queued |

Do not fix what you have not diagnosed. The gate error is a symptom; the defect is in the DB.

### Common ADR-013-specific recovery scenarios

| Symptom | Likely cause | Fix |
|---|---|---|
| `SRS has no 'derived_from' trace to PRD` after architect ran | saga-architect forgot `trace_add(SRS → PRD, 'derived_from')` at registration | Add the edge directly — saga-architect is the canonical owner, but the edge itself is unambiguous (one SRS, one PRD per epic). |
| `formalization gate failed: tasks not completed: #<srs task id>` | SRS task crashed mid-write or is in `review` not `done` | Check `task_get(<srs task id>)`. If status=`review`, dispatch the reviewer. If crashed, `task_update({status:'todo'})` to force re-run. |
| `AC has no 'derived_from' trace to any FR` post-reorder | saga-analyst wrote AC before saga-product registered FR children | Verify FR artifacts exist under the PRD. If yes → `trace_add(AC → FR)`. If no → escalate: saga-product did not register FR (pipeline-order violation). |
| SRS exists in the epic but baseline hash not stamped | reconciler ran before architect; pipeline-order violation | Reconciler should have stopped with `worker_ask_need`. If somehow SRS is present at reconciliation time, escalate — the order is wrong. |
| `baseline_accepted` transition did not spawn `formalization.srs` task | Workflow transition failed silently | Check `task_list({epic_id, workflow_stage:'formalization', task_kind:'formalization.srs'})`. If empty after reconciler done, call `workflow_generate_next({epic_id, source_task_id: <reconciler task id>, transition: 'baseline_accepted'})` manually to re-trigger. |

---

## Step 2 — Cynefin triage

Classify the recovery scenario:

| Domain | Example | Approach |
|---|---|---|
| **Clear** | Missing trace edge — obvious parent, obvious link_type. | Fix it directly. No MCDA needed. |
| **Complicated** | Multiple traces missing, or AC needs hash refreshed from a file that may have changed. | Run the loop; 3 candidate fixes. |
| **Complex** | Worker produced semantically wrong artifact (wrong FR code, mismatched UC). | Run the loop; consider moving task back to `todo` for full rework. |
| **Chaotic** | DB in inconsistent state (orphan task, broken FK). | Stabilize first (e.g., delete the orphan, fix the FK), then re-classify. |
| **Genuine human-only** | Security-sensitive decision, business intent, external approval. | `worker_ask_need` — but state in the comment why this qualifies. |

**Default to fixing it yourself.** Most recovery scenarios are Clear or Complicated — engineering trade-offs the agent has more context on than the sponsor.

---

## Step 3 — Generate candidate fixes (3 options)

For non-Clear cases, generate **3 distinct candidate fixes**. Each candidate must be a coherent end-to-end approach, not a fragment.

Differentiate the candidates by lens:
- **Candidate A**: Minimal fix — closest to the existing state, smallest blast radius.
- **Candidate B**: Rework — move the offending task back to `todo` and let the producer skill re-run with the gate feedback as guidance.
- **Candidate C**: Restructure — change the artifact graph (e.g., split an AC, merge two FRs, add a missing parent).

For each candidate, write down:
- What it changes (files / DB rows / task statuses).
- Reversibility: can it be undone if it makes things worse?
- Blast radius: how many other artifacts/tasks does it touch?
- Audit cost: how easy is it for a human reviewer to understand what happened?

---

## Step 4 — MCDA scoring matrix

Score each candidate on these criteria (weights are guidelines — adjust per situation):

| Criterion | Weight | What it measures |
|---|---|---|
| **correctness** | 0.30 | Does the fix actually resolve the gate error? Will the gate pass after? |
| **minimal-blast-radius** | 0.25 | How few other things does it touch? Prefer narrow fixes. |
| **reversibility** | 0.20 | Can it be undone cleanly if it's wrong? |
| **audit-clarity** | 0.15 | Will a human reviewer understand it from the comment alone? |
| **no-data-loss** | 0.10 | Does it preserve the producer's work, or throw it away? |

Score 1-5 per cell, multiply by weight, sum. Output as a Markdown table in the task comment.

**The matrix is an aid, not the decider.** If the top-scoring candidate has a fatal flaw the matrix didn't capture, pick the next one and explain why.

---

## Step 5 — Apply the fix + verify

### Powers available to the recovery agent

You can:
- `trace_add({source_id, target_type:'artifact', target_id, link_type})` — add missing trace edges.
- `artifact_update({id, status})` — accept draft artifacts after fixing them.
- `artifact_save({id, ...})` — refresh content_hash from disk (when saga-reconciler forgot to).
- `task_update({id, status})` — **move a task backwards**: `done → review` (force re-review) or `review → todo` / `done → todo` (force full rework). Use this when the producer's output is fundamentally wrong, not just incomplete.
- `task_create({epic_id, title, task_kind, workflow_stage, ...})` — spawn a new producer task if the original is unrecoverable.
- `comment_add({task_id, content})` — document your decision.

You cannot:
- Modify artifact content (.md files) — that's the producer's job. If the document is wrong, move the task back to `todo`.
- Call `episode_transition` — the engine does that after `worker_done`.
- Call `worker_next` — you already have a task.
- Force-push git, drop tables, or anything destructive — those are genuine human-only.

### After applying

Re-check the gate condition **manually** (the engine will re-check too, but you should know whether your fix worked before calling `worker_done`):

```
// Example: after adding a missing trace
trace_list({source_id: <AC id>})  // verify the edge now exists

// Example: after accepting an artifact
artifact_get({id: <AC id>})  // verify status='accepted', drift_state='clean'
```

If the fix is incomplete, either iterate (apply another candidate) or move the producer task back to `todo` for rework.

---

## Step 6 — Record the decision

Call `comment_add({task_id, content})` with this structure:

```markdown
## Recovery decision

**Diagnosis**: <one sentence — what was the actual defect>

**Cynefin domain**: <Clear | Complicated | Complex | Chaotic>

**Options considered**:
| # | Approach | Score | Notes |
|---|---|---|---|
| A | <minimal fix> | 4.2 | <one-line pro/con> |
| B | <rework task #N> | 3.5 | <one-line pro/con> |
| C | <restructure> | 3.1 | <one-line pro/con> |

**Applied**: <which option, and what specifically was done>
- trace_add(...)
- artifact_update(...)
- task_update({id: N, status: 'todo'})  ← if you moved a task back

**Verify**: <what you checked to confirm the fix works>
```

Then `worker_done({task_id, worker_id, result: '<one-line summary>'})`.

---

## Anti-patterns

- **Rubber-stamping**: running the loop with a pre-chosen answer and tilting the matrix to confirm it. The "3 distinct candidates" requirement exists to break this.
- **Asking the human for engineering trade-offs**: "which library?", "which metric?", "standalone or backend?" — these are NOT genuine human-only blockers. Decide and document.
- **Fixing symptoms, not defects**: if the gate says "AC-5 has no UC trace", don't just `trace_add(AC-5 → UC-1)` blindly — read AC-5 and UC-1 to find the RIGHT UC (or determine that AC-5 is NFR-only and the gate should exempt it).
- **Skipping the record**: "the fix was obvious, no need to write it down". The audit trail is the whole point — without it, the next recovery agent (or human reviewer) cannot tell what happened.
- **Modifying artifact content**: if the .md is wrong, move the producer task back to `todo`. Do not edit the file yourself.

---

## When to actually call `worker_ask_need`

Only when ALL of these hold:
1. **Cynefin triage = genuine human-only** (not just "Complicated").
2. The defect concerns **irreversible consequences** (security, compliance, data migration, external API contract).
3. The agent's domain knowledge does NOT cover it (truly novel context).
4. A wrong default would propagate and break downstream ACs in a way that cannot be detected later.

For routine engineering choices (missing trace, draft artifact not accepted, content_hash stale, worker crashed mid-task) — **always auto-resolve**.
