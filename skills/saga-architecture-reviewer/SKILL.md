---
name: saga-architecture-reviewer
description: "Reviewer for SRS artifacts. Verifies Invariant Registry, FR/NFR completeness, and derived_from → PRD edge before approving. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 3-Formalization (review buffer)
- **Precondition:** saga-architect completed the SRS, task moved to `review`
- **Postcondition:** SRS either accepted (status='accepted', traces complete)
  or returned to architect via `verdict:'changes_requested'`

## What this skill reviews

The SRS is the architectural contract — it must be traceable to the PRD and
must declare the invariants that downstream ACs will verify.

| Check | How |
|---|---|
| SRS has `derived_from` → PRD edge | `trace_list({source_id:<SRS id>, link_type:'derived_from'})` |
| Every FR has `derived_from` → PRD | `artifact_coverage({epic_id, type:'FR', link_type:'derived_from'})` → 0 gaps |
| Every NFR has `derived_from` → PRD | `artifact_coverage({epic_id, type:'NFR', link_type:'derived_from'})` → 0 gaps |
| SRS document contains §2.3 Invariant Registry | Read the .md file, grep for "Invariant Registry" or equivalent |
| Each invariant has at least one FR or NFR that references it | Cross-check invariant names against FR/NFR bodies |

## Review procedure

1. **Read the task** via `task_get({id})`. Confirm `task_kind='formalization.srs'`.

2. **List the SRS artifacts:**
   ```
   artifact_list({ epic_id, type:'SRS' })
   artifact_list({ epic_id, type:'FR' })
   artifact_list({ epic_id, type:'NFR' })
   ```

3. **Verify the SRS → PRD traceability edge:**
   ```
   trace_list({ source_id: <SRS id>, link_type:'derived_from' })
   ```
   Must include ≥1 trace to a `PRD` artifact. If missing → `changes_requested`
   with reason: "SRS missing derived_from → PRD. Call trace_add(SRS → PRD)."

4. **Verify every FR and NFR traces back to PRD:**
   ```
   gaps = artifact_coverage({ epic_id, type:'FR', link_type:'derived_from' })
   ```
   If `gaps.length > 0` → `changes_requested` listing the orphan FRs.

5. **Read the SRS document** at `artifact.path`. Verify:
   - §1 — System overview exists
   - §2 — Functional requirements (each FR-N has description + acceptance)
   - §2.3 — **Invariant Registry** (REQUIRED for any episode with algorithmic logic).
     Each invariant has a name, formula/property, and the FR that implements it.
   - §3 — Non-functional requirements

6. **Accept the SRS if all checks pass:**
   ```
   artifact_update({ id:<SRS id>, status:'accepted' })
   ```

7. **Complete the task** via `worker_done`:
   - `verdict:'approved'` — SRS traceable, complete, accepted.
   - `verdict:'changes_requested'` — list each gap with file:line.

## Anti-patterns

- ❌ **Do not invent edges.** If `derived_from` is missing, return `changes_requested`.
- ❌ **Do not approve "because parent_artifact_id is set."** Same trap as
  requirements-reviewer — column ≠ trace edge.
- ❌ **Do not skip the Invariant Registry check.** Without it, AC writers
  cannot derive `properties` blocks, and downstream verification fails.
- ❌ **Do not call `worker_next`.**

## Rules

- One task = one launch.
- Verdict must cite `trace_list` / `artifact_coverage` evidence in `result`.
- If the SRS document is missing on disk → `changes_requested`.
- If the architect did not declare any invariants but the episode has
  algorithmic logic (formulas, calculations) → `changes_requested` with
  reason "§2.3 Invariant Registry missing — saga-architect must declare
  invariants for algorithmic FRs."
