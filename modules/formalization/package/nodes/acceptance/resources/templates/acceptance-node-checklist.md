# Acceptance Contract Node Pre-Submit Checklist (W8-A4)

> Package-local checklist for the `define-acceptance-contract` LM node. Pinned
> by the `formalization.acceptance.node-checklist` resource index entry. Run
> before every artifact, trace or completion MCP write.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-formalization@1.0.0`.
- [ ] `node_id` is `define-acceptance-contract`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] No machine-filled id, hash, schema version or authority field was inferred.

## Ownership and scope

- [ ] This node owns the `AC` artifact type only.
- [ ] `artifact_create` is used with `type: "AC"` and `parent_artifact_id` set
      to the parent UC.
- [ ] SRS is NOT created here — it is created only after the AC baseline is frozen.
- [ ] No downstream Process Module is started or selected.

## Artifact quality (contract data)

- [ ] Each AC is testable contract data (given/when/then or equivalent), not prose.
- [ ] AC is architecture-agnostic — no implementation detail leaked in.
- [ ] AC is derived only from accepted UC/FR/NFR/RULE lineage.
- [ ] Stable codes unique within the episode; no TODO/FILL placeholders remain.

## Traceability

- [ ] Every AC has a `derived_from` edge to its parent UC.
- [ ] Required `covers` edges to FR/NFR are present where the AC contract demands.
- [ ] Source and target artifact ids were read from Saga, not remembered.
- [ ] Created traces are read back before completion.

## Completion

- [ ] `worker_done` called once, only after all AC + traces were read back.
- [ ] No lifecycle transition requested — the kernel resolver owns routing.
