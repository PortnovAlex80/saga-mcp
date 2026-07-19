---
name: saga-requirements-reviewer
description: "Reviewer for PRD, UC, AC, and reconciliation artifacts. Verifies structural completeness, traceability edges, and parent lineage before approving. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 3-Formalization (review buffer)
- **Precondition:** producer (saga-product / saga-analyst) completed the
  artifact and the task moved to `review`
- **Postcondition:** artifact either accepted (status='accepted', traces
  complete) or returned to producer via `verdict:'changes_requested'`
- **Called by:** saga-engine via `review_skill` field on the task

## What this skill reviews

This is **not** a code diff review (use saga-worker for that). This is a
**requirements / artifact** review. You verify that the producer created a
complete, traceable artifact — not that the prose is pretty.

| Producer | Artifact type | What you check |
|---|---|---|
| saga-product | PRD | derived_from → brief edge; Hypotheses section if product-classification |
| saga-analyst | UC | derived_from → PRD edge; covers → ≥1 FR edge; structural completeness (actor, flow, postconditions) |
| saga-analyst | AC | derived_from → ≥1 UC; derived_from → ≥1 FR/NFR; Given/When/Then form; properties block for algorithmic ACs |
| saga-reconciler | reconciliation result | artifact_coverage returns 0 gaps for all formalization types; all artifacts accepted |

## Review procedure

1. **Read the task** via `task_get({id})`. Note `task_kind`:
   - `formalization.prd` → review PRD
   - `formalization.uc` → review one UC document (all UCs from the same producer)
   - `formalization.ac` → review all ACs
   - `formalization.reconciliation` → review the reconciler's work

2. **Read the artifact(s)** via `artifact_list({epic_id, type:'<X>'})` and
   `artifact_get({id})` for details. Read the .md file at `artifact.path`
   (resolve via the project repository path) for content.

3. **Verify the canonical lineage edge** for the artifact type:

   ### PRD review
   ```
   trace_list({ source_id: <PRD id>, link_type:'derived_from' })
   ```
   Must contain ≥1 trace to a `brief` artifact. If missing → `changes_requested`
   with reason: "PRD missing derived_from → brief. Call trace_add(PRD → brief)."

   ### UC review (per UC)
   - `trace_list({ source_id: <UC id> })` must include:
     - `derived_from` → PRD
     - `covers` → ≥1 FR
   - Document must contain: Actor, Precondition, Main flow, ≥1 Alternate flow, Postcondition.
   If any missing → `changes_requested` listing each gap.

   ### AC review (per AC)
   - `trace_list({ source_id: <AC id> })` must include:
     - `derived_from` → ≥1 UC
     - `derived_from` → ≥1 FR or NFR
   - Document must contain Given/When/Then.
   - For algorithmic ACs (formulas, calculations): must contain a `properties` block.
   If any missing → `changes_requested` listing each gap.

   ### Reconciliation review
   Run `artifact_coverage` for each type/link_type combination:
   ```
   artifact_coverage({ epic_id, type:'PRD', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'SRS', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'UC',  link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'AC',  link_type:'derived_from' })
   ```
   All must return `gaps: []`. If any gap → `changes_requested` with the gap list.

4. **Accept the artifact if all checks pass:**
   ```
   artifact_update({ id, status:'accepted' })
   ```
   (Only for the artifact under review — not for unrelated ones. The
   reconciliation task is the only one that bulk-accepts.)

5. **Complete the task** via `worker_done({task_id, worker_id, verdict, result, execution_id})`:
   - `verdict:'approved'` — all checks passed, artifact accepted.
   - `verdict:'changes_requested'` — list each specific gap in `result`.

## Anti-patterns (do NOT do these)

- ❌ **Do not invent edges.** If a trace is missing, return `changes_requested`
  and let the producer fix it. You are a reviewer, not an editor.
- ❌ **Do not approve "because parent_artifact_id is set."** The
  `parent_artifact_id` column is hierarchy metadata; it does NOT create a
  row in `artifact_traces`. The formalization gate requires an actual edge.
  This was the exact failure mode in epic 129 (moscito) — reviewer saw
  `parent_artifact_id: 813` and approved, missing that no `derived_from`
  trace existed.
- ❌ **Do not approve "because the document looks good."** Without trace edges,
  the artifact is an orphan in the traceability graph.
- ❌ **Do not call `worker_next`.** You have exactly one task.
- ❌ **Do not modify the artifact document.** If content is wrong, return
  `changes_requested` with file:line specifics.

## Rules

- One task = one launch. Exit after `worker_done`.
- Verdict must be backed by `trace_list` / `artifact_coverage` evidence —
  cite the tool output in `result`.
- If the artifact document is missing on disk → `changes_requested` with
  reason "document not found at <path>".
- If multiple producers wrote conflicting versions of the same artifact
  (rare) → `worker_ask_need` to disambiguate.
