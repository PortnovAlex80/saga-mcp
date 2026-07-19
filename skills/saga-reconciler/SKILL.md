---
name: saga-reconciler
description: "Reconciler for the formalization→planning transition. Claims the formalization.reconciliation task, accepts draft PRD/SRS/UC/AC artifacts, repairs missing traceability edges, and stamps the AC baseline hash. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 3.5-Formalization-reconciliation
- **Precondition:** AC task done (formalization.ac), all formalization artifacts written to disk
- **Postcondition:** all formalization artifacts accepted; AC baseline hash stamped;
  every canonical lineage edge exists in `artifact_traces`; episode ready for planning
- **Called by (вызывается):** saga-engine via `ac_accepted` workflow transition
  (workflow.ts: `formalization.ac` done → spawns `formalization.reconciliation`)
- **Next enables (что разблокирует):** episode_transition(formalization → planning)

## Why this skill exists

The formalization pyramid has 6 artifact types linked by canonical edges:

```
brief
  └── PRD   (derived_from → brief)
        ├── SRS   (derived_from → PRD)
        │     ├── FR-N   (derived_from → PRD)
        │     └── NFR-N  (derived_from → PRD)
        └── UC-N  (derived_from → PRD, covers → ≥1 FR)

UC-N + FR-N
  └── AC-N  (derived_from → ≥1 UC AND ≥1 FR/NFR)
```

Producer-skills (saga-product/architect/analyst) are supposed to create these
edges via `trace_add` at artifact creation time. In practice, edges sometimes
get skipped (LLM omits a step, worker crashes mid-task, manual edits). The
formalization→planning gate (`assertTraceability` in lifecycle.ts) then
rejects the transition with a specific gap message.

This skill is the repair path. It:
1. Enumerates every artifact in the epic.
2. Checks each canonical edge against `artifact_traces`.
3. Adds missing edges via `trace_add` where the parent is unambiguous.
4. Accepts draft artifacts after traces are complete.
5. Stamps the AC baseline hash.
6. Reports what it did via `worker_done`.

## Procedure

1. **Read the task** via `task_get({id})` to get `epic_id`, `project_id`.
2. **List all formalization artifacts** by type:
   ```
   artifact_list({ epic_id, type:'brief' })
   artifact_list({ epic_id, type:'PRD' })
   artifact_list({ epic_id, type:'SRS' })
   artifact_list({ epic_id, type:'UC' })
   artifact_list({ epic_id, type:'FR' })
   artifact_list({ epic_id, type:'NFR' })
   artifact_list({ epic_id, type:'AC' })
   ```
3. **Verify/repair each canonical edge** (see table below). Use `trace_list`
   to check, `trace_add` to repair.

### Edge matrix

| Source | Target | link_type | When to add |
|---|---|---|---|
| PRD | brief | derived_from | Always (one brief per epic) |
| SRS | PRD | derived_from | Always (one PRD per epic) |
| FR-N | PRD | derived_from | Always (FR parent is the PRD) |
| NFR-N | PRD | derived_from | Always (NFR parent is the PRD) |
| UC-N | PRD | derived_from | Always (UC parent is the PRD) |
| UC-N | FR-M | covers | Only if the UC document names a specific FR — read the UC body. If you cannot tell which FR it covers, **do not guess** — escalate via `worker_ask_need`. |
| AC-N | UC-M | derived_from | Read the AC body. Given/When/Then usually names the UC. If ambiguous, escalate. |
| AC-N | FR-M or NFR-M | derived_from | Read the AC body. The property block usually names the FR/NFR. |

4. **Accept draft formalization artifacts.** For each artifact with
   `status='draft'` AND a real document on disk at its `path`:
   ```
   // First refresh the content_hash from disk (so drift_state is 'clean'):
   artifact_save({ id, <fields from existing artifact with refreshed path content> })
   // Then accept:
   artifact_update({ id, status:'accepted' })
   ```
   Skip if the .md file does not exist or is empty — that is a real gap,
   escalate via `worker_ask_need({ reason:"<artifact type> <code> has no
   document on disk at <path>" })`.

5. **Stamp the AC baseline.** The engine's `acceptedBaseline` (lifecycle.ts)
   will compute the baseline hash from all accepted ACs after this task
   completes. You do not need to compute it manually — just ensure:
   - Every AC has `status='accepted'`
   - Every AC has `content_hash` (refreshed from disk via `artifact_save`)
   - `accepted_hash` matches `content_hash` (artifact_save stamps this when status='accepted')

6. **Final verification.** Call `artifact_coverage` for each type and
   `link_type` to confirm zero gaps:
   ```
   artifact_coverage({ epic_id, type:'PRD', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'SRS', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'UC',  link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'AC',  link_type:'derived_from' })
   ```
   All must return `gaps: []`.

7. **Complete the task** via `worker_done({task_id, worker_id, result,
   execution_id})`. The `result` MUST list:
   - How many traces you added (per type: PRD→brief, SRS→PRD, UC→PRD, UC→FR, AC→UC, AC→FR).
   - How many artifacts you accepted (per type).
   - Whether the baseline stamp succeeded.

## Rules

- **Do NOT call `worker_next`** — you already have exactly one task assigned.
- **Do NOT call `episode_transition`** — the engine will attempt it after you finish.
- **Do NOT modify artifact content** — your job is to link and accept, not rewrite.
  If a document is wrong, escalate via `worker_ask_need`.
- **Do NOT guess edges.** If a UC body does not name a specific FR, or an AC
  does not name a specific UC/FR, escalate. A wrong edge is worse than a missing one.
- **Idempotent.** Re-running this skill on an already-reconciled epic must be a no-op.
  `trace_add` is idempotent (UNIQUE constraint on source+target+link_type).
  `artifact_update({status:'accepted'})` on an already-accepted artifact is safe.
- **One task = one launch.** After `worker_done`, exit. Do not claim another task.

## Failure modes

| Symptom | Action |
|---|---|
| No brief artifact in epic | `worker_ask_need` — discovery.kickstart may have crashed before registering brief |
| No PRD artifact | `worker_ask_need` — saga-product never ran |
| AC document missing on disk | `worker_ask_done` with reason — saga-analyst registered artifact but did not write file |
| Multiple PRDs in one epic | `worker_ask_need` — only one PRD per epic is supported |
| `artifact_coverage` still shows gaps after repair | Re-check; if persistent, `worker_ask_need` with the gap details |
