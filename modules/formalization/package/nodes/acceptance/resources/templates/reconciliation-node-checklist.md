# Reconciliation Node Pre-Submit Checklist (W8-A4)

> Package-local checklist for the `reconcile-what` LM node. Pinned by the
> `formalization.reconciliation.node-checklist` resource index entry. Run
> before every trace repair or completion MCP write.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-formalization@1.0.0`.
- [ ] `node_id` is `reconcile-what`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] No machine-filled id, hash, schema version or authority field was inferred.

## Authority boundary

- [ ] No WHAT artifact (PRD/FR/NFR/RULE/UC/AC) was created or edited.
- [ ] Only `trace_add` was used to repair permitted missing edges.
- [ ] `artifact_create` was NOT called (absent from `allowedTools`).

## WHAT-side closure

- [ ] Every accepted PRD/FR/NFR/RULE/UC/AC was audited.
- [ ] Every required `derived_from` / `covers` / `enforced_by` edge is present.
- [ ] Every repaired edge was read back.
- [ ] Unresolved contradictions are surfaced in the result, not silently repaired.

## Scope discipline

- [ ] SRS was NOT read or waited for (it does not exist at this stage).
- [ ] The AC baseline was NOT frozen by this worker — the kernel freezer owns that.
- [ ] No lifecycle transition requested — the kernel resolver owns routing.

## Completion

- [ ] `worker_done` called once, with a truthful summary including repaired edge
      refs and any unresolved contradiction.
