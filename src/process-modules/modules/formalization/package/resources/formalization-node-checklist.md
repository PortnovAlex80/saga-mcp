# Formalization LM Node Pre-Submit Checklist

Run this checklist before every artifact, trace or completion MCP write.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-formalization@1.0.0`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] Input snapshot ref/hash match the machine-filled tracker values.
- [ ] No machine-filled id, hash, schema version or authority field was inferred by the LM.

## Ownership and scope

- [ ] The current node owns the artifact type being written.
- [ ] The call uses only tools from the frozen `allowed_tools` list.
- [ ] No downstream Process Module is started or selected.
- [ ] No lifecycle transition is requested by the worker.
- [ ] Existing artifacts and traces were queried before creating replacements.

## Artifact quality

- [ ] Artifact path is repository-relative.
- [ ] Stable codes are unique and follow the current episode naming convention.
- [ ] Required sections are complete; no TODO/FILL placeholders remain.
- [ ] The artifact is derived only from frozen inputs and explicitly cited sources.
- [ ] Implementation details are absent from WHAT artifacts unless the artifact contract allows them.
- [ ] SRS is created only after the acceptance baseline is frozen.

## Traceability

- [ ] Every required `derived_from`, `covers`, `enforced_by` or other canonical edge is materialized.
- [ ] Source and target artifact ids were read from Saga, not remembered.
- [ ] Trace relation is valid for the two artifact types.
- [ ] Trace calls carry process/node/execution provenance.
- [ ] Created traces are read back before completion.

## Materialized MCP call

- [ ] The call was copied from the canonical template.
- [ ] Every `FILL_` placeholder was replaced.
- [ ] Integer fields are integers and nullable fields are explicit null when required.
- [ ] Tool name and parameter names match the MCP contract exactly.
- [ ] The JSON file was read back after editing.
- [ ] The call does not contain fields owned by the kernel.

## Recovery and completion

- [ ] Retry count is within the profile budget.
- [ ] Accepted artifacts are reused after restart; no duplicate is created.
- [ ] Tracker contains the latest error and resume step.
- [ ] Completion summary names created/updated artifacts and trace refs truthfully.
- [ ] `worker_done` is called once, only after all outputs were read back.
- [ ] After `worker_done`, the single-use worker exits and claims no other task.
