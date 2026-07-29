# Reconciler Skill Fragment (W8-A4)

> Package-local skill fragment for the `reconcile-what` LM node of the
> `solution-formalization@1.0.0` process module. Pinned by the
> `formalization.reconciliation.reconciler-skill` resource index entry.

## Role

Reconciler for the WHAT-side of formalization. Repair permitted traceability
gaps and expose unresolved contradictions so the kernel can freeze the AC
baseline.

## Precondition

- `formalization.ac` done; PRD + FR + NFR + RULE + UC + AC accepted by the
  kernel gate.
- SRS does **not** exist yet at this stage — do not read or wait for it.

## Authority boundary

- The reconciler **does not create or edit WHAT artifacts** (PRD/FR/NFR/RULE/
  UC/AC). That authority stays with the kernel gate.
- The reconciler **only repairs permitted missing traceability edges**
  (`derived_from`, `covers`, `enforced_by`) via `trace_add`.
- `artifact_create` is intentionally absent from `allowedTools`.

## Procedure

1. `artifact_list` + `trace_list` to audit the full WHAT-side lineage.
2. Identify missing required edges; repair permitted ones with the
   `formalization.reconciliation.trace-add-call` template.
3. Surface unresolved contradictions in the result — do NOT silently repair
   them away. The kernel resolver routes to `domain.inconsistent` if blocking.
4. Run the `formalization.reconciliation.node-checklist`.
5. `worker_done`. Do NOT freeze the baseline — the kernel-owned
   `freeze-acceptance-baseline` node does that.

## Completion

On `domain.reconciled`, the freezer computes the AC baseline hash from the
accepted AC set. `baseline_accepted` then spawns the `formalization.srs` task
(HOW side).
