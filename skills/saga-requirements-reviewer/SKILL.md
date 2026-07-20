---
name: saga-requirements-reviewer
description: "Reviewer for PRD, UC, AC, and reconciliation artifacts. Verifies structural completeness, traceability edges, and parent lineage before approving. Adapts to the reordered pipeline (ADR-013): FR/NFR/RULE live under the PRD (created by saga-product); UC/AC are written against the PRD before SRS exists. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 3-Formalization (review buffer) — covers PRD review, UC
  review, AC review, reconciliation review
- **Precondition:** producer (saga-product / saga-analyst / saga-reconciler)
  completed the artifact and the task moved to `review`
- **Postcondition:** artifact either accepted (status='accepted', traces
  complete) or returned to producer via `verdict:'changes_requested'`
- **Called by:** saga-engine via `review_skill` field on the task

> **Pipeline (reordered, ADR-013).** FR/NFR/RULE are now children of the PRD
> (registered by saga-product). UC and AC are written against the PRD — they
> are accepted BEFORE SRS exists. The traceability graph edges are unchanged;
> only their physical location in the pyramid shifted. SRS is reviewed by
> `saga-architecture-reviewer`, NOT by this skill.

## What this skill reviews

This is **not** a code diff review (use saga-worker for that). This is a
**requirements / artifact** review. You verify that the producer created a
complete, traceable artifact — not that the prose is pretty.

| Producer | Artifact type | What you check |
|---|---|---|
| saga-product | PRD | `derived_from` → brief edge; FR/NFR/RULE children registered with `derived_from` → PRD; Hypotheses section if product-classification |
| saga-analyst | UC | `derived_from` → PRD edge; `covers` → ≥1 FR edge (FR is a child of PRD); structural completeness (actor, flow, postconditions) |
| saga-analyst | AC | `derived_from` → ≥1 UC; `derived_from` → ≥1 FR/NFR (FR/NFR are children of PRD — link to the artifact id directly); Given/When/Then form; properties block for algorithmic ACs |
| saga-reconciler | reconciliation result | `artifact_coverage` returns 0 gaps for PRD/UC/AC types (NOT SRS — it does not exist yet at reconciliation time); all WHAT-side artifacts accepted |

> **Why the AC→FR check still works after the reorder.** The edge in
> `artifact_traces` is `source_id=AC.id, target_id=FR.id, link_type='derived_from'`.
> The gate queries by `target.type='FR'` within the epic — it does not care
> whether that FR's parent is the PRD or the SRS. After ADR-013 the FR's parent
> is the PRD; the edge itself is identical. **No change to `assertTraceability`
> is required for AC→FR.** The only thing that changed is WHO creates the FR
> (saga-product instead of saga-architect) and WHERE in the pyramid it lives.

## Review procedure

1. **Read the task** via `task_get({id})`. Note `task_kind`:
   - `formalization.prd` → review PRD (and verify FR/NFR/RULE children exist)
   - `formalization.uc` → review one UC document (all UCs from the same producer)
   - `formalization.ac` → review all ACs
   - `formalization.reconciliation` → review the reconciler's work

2. **Read the artifact(s)** via `artifact_list({epic_id, type:'<X>'})` and
   `artifact_get({id})` for details. Read the .md file at `artifact.path`
   (resolve via the project repository path) for content.

3. **Verify the canonical lineage edge** for the artifact type:

   ### PRD review
   - `trace_list({ source_id: <PRD id>, link_type:'derived_from' })` must
     contain ≥1 trace to a `brief` artifact. If missing → `changes_requested`
     with reason: "PRD missing derived_from → brief. Call trace_add(PRD → brief)."
   - Verify FR/NFR/RULE children exist (saga-product registers them):
     ```
     artifact_list({ epic_id, type:'FR' })   → ≥1, each with derived_from → PRD
     artifact_list({ epic_id, type:'NFR' })  → ≥1 if any capacity targets
     artifact_list({ epic_id, type:'RULE' }) → ≥1 if any business rules
     ```
     For each FR/NFR/RULE found: `trace_list({source_id: <FR id>})` must
     include `derived_from` → this PRD. If a child is missing the edge, return
     `changes_requested`: "FR-N missing derived_from → PRD."
   - Hypotheses section present in the PRD if the brief's classification is
     product/modular.

   ### UC review (per UC)
   - `trace_list({ source_id: <UC id> })` must include:
     - `derived_from` → PRD
     - `covers` → ≥1 FR
   - The FR being covered is a child of PRD (saga-product created it). The
     edge target is the FR artifact id; the gate verifies `target.type='FR'`
     within the epic, regardless of FR's parent. This check is unchanged from
     pre-reorder.
   - Document must contain: Actor, Precondition, Main flow, ≥1 Alternate flow,
     Postcondition.
   If any missing → `changes_requested` listing each gap.

   ### AC review (per AC)
   - `trace_list({ source_id: <AC id> })` must include:
     - `derived_from` → ≥1 UC
     - `derived_from` → ≥1 FR or NFR
   - The FR/NFR being derived from is a child of PRD. The edge target is the
     FR/NFR artifact id directly; the gate queries `target.type IN ('FR','NFR')`
     within the epic. **SRS is NOT required and NOT checked here** — AC is
     written before SRS exists; invariants come from RULE artifacts under the
     PRD, not from any SRS Invariant Registry.
   - Document must contain Given/When/Then.
   - For algorithmic ACs (formulas, calculations): must contain a `properties`
     block. Derivation source for properties is the RULE artifacts under PRD
     (no SRS exists yet at AC review time).
   If any missing → `changes_requested` listing each gap.

   ### Reconciliation review
   Run `artifact_coverage` for each WHAT-side type/link_type combination:
   ```
   artifact_coverage({ epic_id, type:'PRD', link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'UC',  link_type:'derived_from' })
   artifact_coverage({ epic_id, type:'AC',  link_type:'derived_from' })
   ```
   All must return `gaps: []`.

   **Do NOT check SRS coverage at reconciliation time.** The SRS does not
   exist yet — it is spawned by the `baseline_accepted` transition AFTER the
   reconciler finishes. SRS lineage (SRS → PRD) is checked much later, by
   `assertTraceability` at the formalization→planning episode gate, and the
   SRS document itself is reviewed by `saga-architecture-reviewer` (a
   different skill).

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

- **Do not invent edges.** If a trace is missing, return `changes_requested`
  and let the producer fix it. You are a reviewer, not an editor.
- **Do not approve "because parent_artifact_id is set."** The
  `parent_artifact_id` column is hierarchy metadata; it does NOT create a
  row in `artifact_traces`. The formalization gate requires an actual edge.
  This was the exact failure mode in epic 129 (moscito) — reviewer saw
  `parent_artifact_id: 813` and approved, missing that no `derived_from`
  trace existed.
- **Do not approve "because the document looks good."** Without trace edges,
  the artifact is an orphan in the traceability graph.
- **Do not require SRS for UC/AC review.** SRS comes AFTER AC in the reordered
  pipeline. If you reject UC/AC because "SRS not yet accepted," you are
  enforcing the OLD pipeline order and blocking the episode. The rule that
  AC must read SRS §2.3 Invariant Registry is gone — invariants now come from
  RULE artifacts under the PRD.
- **Do not require FR/NFR to be children of SRS.** FR/NFR are children of PRD
  (saga-product registers them). The `target.type='FR'` check in
  `assertTraceability` does not care about the FR's parent.
- **Do not call `worker_next`.** You have exactly one task.
- **Do not modify the artifact document.** If content is wrong, return
  `changes_requested` with file:line specifics.

## Rules

- One task = one launch. Exit after `worker_done`.
- Verdict must be backed by `trace_list` / `artifact_coverage` evidence —
  cite the tool output in `result`.
- If the artifact document is missing on disk → `changes_requested` with
  reason "document not found at <path>".
- If multiple producers wrote conflicting versions of the same artifact
  (rare) → `worker_ask_need` to disambiguate.
- For AC review: accept AC that derives from FR/NFR children of PRD without
  requiring SRS — this is the post-ADR-013 contract.
