---
name: saga-reconciler
description: "Reconciler for the WHAT-side of formalization. Claims the formalization.reconciliation task, accepts draft PRD/FR/NFR/RULE/UC/AC artifacts, repairs missing traceability edges, and stamps the AC baseline hash. SRS comes LATER, after baseline_accepted, and is reconciled separately. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 4.5-Formalization-reconciliation (between AC done and SRS spawn)
- **Precondition:** AC task done (`formalization.ac`), PRD + UC + AC artifacts
  written to disk. SRS does NOT exist yet at this stage.
- **Postcondition:** all WHAT-side artifacts accepted (PRD, FR, NFR, RULE, UC, AC);
  AC baseline hash stamped; every canonical lineage edge on the WHAT side exists
  in `artifact_traces`. The episode is now ready for the `baseline_accepted`
  transition, which spawns the `formalization.srs` task (HOW side).
- **Called by (вызывается):** saga-engine via `ac_accepted` workflow transition
  (workflow.ts: `formalization.ac` done → spawns `formalization.reconciliation`)
- **Next enables (что разблокирует):** `baseline_accepted` transition →
  spawns `formalization.srs` task → after SRS accepted → episode_transition
  (formalization → planning).

> **Pipeline (reordered, ADR-013).** Baseline AC is frozen BEFORE SRS exists.
> The architect then writes SRS with full knowledge of the frozen AC + the
> brief's complexity.tshirt. The formalization→planning episode_transition
> gate runs LATER, after the SRS task is also done — and `assertTasksReady
> ('formalization')` enforces that the SRS task reached `done`. The
> `assertTraceability` gate at formalization→planning then checks ALL edges
> including SRS → PRD (the architect must add that edge when registering SRS).

## Why this skill exists

The WHAT-side formalization pyramid has 6 artifact types linked by canonical edges:

```
brief
  └── PRD   (derived_from → brief)
        ├── FR-N   (derived_from → PRD)        ← FR/NFR/RULE now live under PRD
        ├── NFR-N  (derived_from → PRD)        ← (saga-product creates them,
        ├── RULE-N (derived_from → PRD)        ←  no longer under SRS)
        └── UC-N   (derived_from → PRD, covers → ≥1 FR)

UC-N + FR-N/NFR-N
  └── AC-N   (derived_from → ≥1 UC AND ≥1 FR/NFR)

(later, post-baseline:)
PRD
  └── SRS    (derived_from → PRD)              ← added by saga-architect AFTER baseline
```

Producer-skills (saga-product/analyst) are supposed to create these edges via
`trace_add` at artifact creation time. In practice, edges sometimes get skipped
(LLM omits a step, worker crashes mid-task, manual edits). The
formalization→planning gate (`assertTraceability` in lifecycle.ts) then rejects
the transition with a specific gap message.

This skill is the repair path for the WHAT side. It:
1. Enumerates every WHAT-side artifact in the epic (brief, PRD, FR, NFR, RULE,
   UC, AC — NOT SRS, which does not exist yet).
2. Checks each canonical edge against `artifact_traces`.
3. Adds missing edges via `trace_add` where the parent is unambiguous.
4. Accepts draft WHAT-side artifacts after traces are complete.
5. Stamps the AC baseline hash (computed by `acceptedBaseline` from all accepted
   AC `accepted_hash` values).
6. Reports what it did via `worker_done`.

SRS lineage (SRS → PRD) is repaired LATER by saga-architect when registering
the SRS, and checked by `assertTraceability` at the formalization→planning gate.

## Procedure

1. **Read the task** via `task_get({id})` to get `epic_id`, `project_id`.
2. **List all WHAT-side formalization artifacts** by type (SRS is NOT expected yet):
   ```
   artifact_list({ epic_id, type:'brief' })
   artifact_list({ epic_id, type:'PRD' })
   artifact_list({ epic_id, type:'FR' })
   artifact_list({ epic_id, type:'NFR' })
   artifact_list({ epic_id, type:'RULE' })
   artifact_list({ epic_id, type:'UC' })
   artifact_list({ epic_id, type:'AC' })
   artifact_list({ epic_id, type:'SRS' })   // expect empty — SRS comes later
   ```
3. **Verify/repair each canonical WHAT-side edge** (see table below). Use
   `trace_list` to check, `trace_add` to repair.

### Edge matrix (WHAT side)

| Source | Target | link_type | When to add |
|---|---|---|---|
| PRD | brief | derived_from | Always (one brief per epic) |
| FR-N | PRD | derived_from | Always (FR parent is the PRD — saga-product created it this way) |
| NFR-N | PRD | derived_from | Always (NFR parent is the PRD) |
| RULE-N | PRD | derived_from | Always (RULE parent is the PRD) |
| UC-N | PRD | derived_from | Always (UC parent is the PRD) |
| UC-N | FR-M | covers | Only if the UC document names a specific FR — read the UC body. If you cannot tell which FR it covers, **do not guess** — escalate via `worker_ask_need`. |
| AC-N | UC-M | derived_from | Read the AC body. Given/When/Then usually names the UC. If ambiguous, escalate. |
| AC-N | FR-M or NFR-M | derived_from | Read the AC body. The property block usually names the FR/NFR. FR/NFR are children of PRD; the trace target is the FR/NFR artifact id directly. |

**SRS → PRD is NOT in this matrix** — the SRS does not exist yet. The architect
adds that edge later when registering the SRS. `assertTraceability` will check
it at the formalization→planning gate.

4. **Accept draft WHAT-side artifacts.** For each artifact with
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
   computes the baseline hash from all accepted ACs after this task completes.
   The baseline is:
   ```
   baseline_hash = sha256(concat of all accepted AC accepted_hash values, ordered by AC id)
   ```
   You do not need to compute it manually — just ensure:
   - Every AC has `status='accepted'`
   - Every AC has `content_hash` (refreshed from disk via `artifact_save`)
   - `accepted_hash` matches `content_hash` (artifact_save stamps this when status='accepted')

   This frozen baseline is the input the architect consumes to choose the SRS
   §2.1 architectural style and to write the §D2 AC→Implementation Map.

6. **Final verification (WHAT side only).** Call `artifact_coverage` for each
   WHAT-side type and `link_type` to confirm zero gaps:
   ```
   artifact_coverage({ epic_id, type:'PRD', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'UC',  link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'AC',  link_type:'derived_from' })
   ```
   All must return `gaps: []`.

   Do NOT check SRS coverage here — SRS does not exist yet. The SRS lineage
   check happens later at the formalization→planning episode gate, after the
   architect has registered SRS with `trace_add(SRS → PRD, 'derived_from')`.

7. **Complete the task** via `worker_done({task_id, worker_id, result,
   execution_id})`. The `result` MUST list:
   - How many traces you added (per type: PRD→brief, FR→PRD, NFR→PRD, RULE→PRD,
     UC→PRD, UC→FR, AC→UC, AC→FR/NFR).
   - How many artifacts you accepted (per type).
   - Whether the baseline stamp succeeded.

   The engine then fires `baseline_accepted` → spawns `formalization.srs`.
   The architect runs and registers SRS with SRS → PRD edge. The episode then
   transitions formalization → planning once the SRS task is also done.

## Rules

- **Do NOT call `worker_next`** — you already have exactly one task assigned.
- **Do NOT call `episode_transition`** — the engine will attempt it after you finish
  (and only after the SRS task is also done).
- **Do NOT modify artifact content** — your job is to link and accept, not rewrite.
  If a document is wrong, escalate via `worker_ask_need`.
- **Do NOT guess edges.** If a UC body does not name a specific FR, or an AC
  does not name a specific UC/FR, escalate. A wrong edge is worse than a missing one.
- **Do NOT touch SRS.** The SRS does not exist at this stage. If an SRS artifact
  is somehow already present, escalate — the pipeline order is wrong.
- **Idempotent.** Re-running this skill on an already-reconciled epic must be a no-op.
  `trace_add` is idempotent (UNIQUE constraint on source+target+link_type).
  `artifact_update({status:'accepted'})` on an already-accepted artifact is safe.
- **One task = one launch.** After `worker_done`, exit. Do not claim another task.

## Failure modes

| Symptom | Action |
|---|---|
| No brief artifact in epic | `worker_ask_need` — discovery.kickstart may have crashed before registering brief |
| No PRD artifact | `worker_ask_need` — saga-product never ran |
| No FR artifacts under PRD | `worker_ask_need` — saga-product did not register FR/NFR/RULE children (new responsibility per ADR-013) |
| AC document missing on disk | `worker_ask_done` with reason — saga-analyst registered artifact but did not write file |
| Multiple PRDs in one epic | `worker_ask_need` — only one PRD per epic is supported |
| An SRS artifact already exists | `worker_ask_need` — pipeline order violation; SRS should not exist before baseline |
| `artifact_coverage` still shows gaps after repair | Re-check; if persistent, `worker_ask_need` with the gap details |
