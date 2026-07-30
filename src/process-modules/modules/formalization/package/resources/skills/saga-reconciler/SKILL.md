---
name: saga-reconciler
description: "Reconciler for the WHAT-side of formalization. Claims the formalization.reconciliation task, verifies the kernel-accepted PRD/FR/NFR/RULE/UC/AC set, repairs permitted traceability edges, and prepares it for the kernel-owned AC baseline snapshot. SRS comes LATER. One task = one launch."
---

## Product-board contract
Same as saga-worker — use the assignment's product, epic, repository.

## Flow position
- **Stage (этап):** 4.5-Formalization-reconciliation (between AC done and SRS spawn)
- **Precondition:** AC task done (`formalization.ac`), PRD + UC + AC artifacts
  written to disk. SRS does NOT exist yet at this stage.
- **Postcondition:** the already kernel-accepted WHAT-side set has complete
  required traces; contradictions are reported; the AC baseline is ready for
  the kernel snapshot. The episode is then ready for the `baseline_accepted`
  transition, which spawns the `formalization.srs` task (HOW side).
- **Called by (вызывается):** the Formalization Process Module flow. After AC
  work is done, the `resolve-reconciliation` kernel node runs and drives this
  reconciliation task.
- **Next enables (что разблокирует):** when the reconciliation kernel node
  returns `domain.reconciled`, the AC baseline is frozen and the
  `settle-formalization` kernel node runs the settlement policy. If the full
  graph (including SRS, written after baseline) is complete and consistent, the
  settlement issues a `formalized` certificate and the Lifecycle Orchestrator
  routes to Development.

> **Pipeline (reordered, ADR-013).** Baseline AC is frozen BEFORE SRS exists.
> The architect then writes SRS with full knowledge of the frozen AC + the
> brief's complexity.tshirt. The Formalization settlement policy
> (`findFirstTraceabilityGap` in `sqlite-formalization-kernel.ts`) runs at
> certificate time — it checks ALL edges including SRS → PRD (the architect
> must add that edge when registering SRS). If any edge is missing, the
> decision is `inconsistent` and no `formalized` certificate is issued.

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
(LLM omits a step, worker crashes mid-task, manual edits). The Formalization
settlement policy (`findFirstTraceabilityGap` in `sqlite-formalization-kernel.ts`)
then detects the gap at certificate time and returns `inconsistent` — no
`formalized` certificate is issued until the gap is repaired.

This skill is the repair path for the WHAT side. It:
1. Enumerates every WHAT-side artifact in the epic (brief, PRD, FR, NFR, RULE,
   UC, AC — NOT SRS, which does not exist yet).
2. Checks each canonical edge against `artifact_traces`.
3. Adds missing edges via `trace_add` where the parent is unambiguous.
4. Accepts draft WHAT-side artifacts after traces are complete.
5. Stamps the AC baseline hash (computed by `readAcceptanceBaselineHash` from
   all accepted AC `accepted_hash` values).
6. Reports what it did via `worker_done`.

SRS lineage (SRS → PRD) is repaired LATER by saga-architect when registering
the SRS, and checked by the settlement policy's `findFirstTraceabilityGap` at
certificate time.

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

4. **Verify acceptance authority.** Every WHAT artifact entering this node
   must already be `accepted+clean` by its preceding common kernel gate. Never
   call `artifact_update(... status:'accepted')`. If a draft or drifted item is
   present, report its exact id/hash as a gap; it must return through its owning
   author/resolver gate.

5. **Stamp the AC baseline.** The engine's `acceptedBaseline` (lifecycle.ts)
   computes the baseline hash from all accepted ACs after this task completes.
   The baseline is:
   ```
   baseline_hash = sha256(concat of all accepted AC accepted_hash values, ordered by AC id)
   ```
   You do not need to compute or stamp it manually — the kernel snapshot node
   does that. Ensure:
   - Every AC has `status='accepted'`
   - Every AC has `content_hash` (refreshed from disk via `artifact_save`)
   - `accepted_hash` matches `content_hash`

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
- **Do NOT modify artifact content** — your job is to verify/link, not accept or rewrite.
  If a document is wrong, escalate via `worker_ask_need`.
- **Do NOT guess edges.** If a UC body does not name a specific FR, or an AC
  does not name a specific UC/FR, escalate. A wrong edge is worse than a missing one.
- **Do NOT touch SRS.** The SRS does not exist at this stage. If an SRS artifact
  is somehow already present, escalate — the pipeline order is wrong.
- **Idempotent.** Re-running this skill on an already-reconciled epic must be a no-op.
  `trace_add` is idempotent (UNIQUE constraint on source+target+link_type).
  Never call `artifact_update({status:'accepted'})`; acceptance belongs to the
  common kernel gate.
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
