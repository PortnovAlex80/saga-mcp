# Product (PRD) Node Pre-Submit Checklist

> Wave 8 package-local checklist for the `define-product-contract` formalization
> node (W8-A2). Run before every artifact, trace, or completion MCP write.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-formalization@1.0.0`.
- [ ] `node_id` is `define-product-contract`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] Input snapshot ref/hash match the machine-filled tracker values.
- [ ] No machine-filled id, hash, schema version or authority field was inferred by the LM.

## Ownership and scope

- [ ] The artifact type is one this node owns: PRD, FR, NFR, or RULE.
- [ ] The call uses only tools from the frozen `formalization-product` allowed list.
- [ ] No downstream Process Module is started or selected.
- [ ] No lifecycle transition is requested by the worker.
- [ ] Artifacts and traces were queried before creating replacements.

## Artifact quality (WHAT side)

- [ ] Artifact path is repository-relative (e.g. `docs/requirements/REQ-NNN-<slug>/00-PRD.md`).
- [ ] FR/NFR/RULE are individual artifacts (not PRD sub-tables) with stable codes.
- [ ] Required sections are complete; no TODO/FILL placeholders remain.
- [ ] The artifact is derived only from frozen inputs and explicitly cited sources.
- [ ] Implementation detail is absent from WHAT artifacts (SRS owns HOW, post-baseline).

## Traceability

- [ ] PRD `derived_from` edge to the accepted discovery decision/brief is materialized.
- [ ] FR/NFR/RULE → PRD parent lineage is positioned for the kernel resolver.
- [ ] Source and target artifact ids were read from Saga, not remembered.
- [ ] Trace calls carry process/node/execution provenance.
- [ ] Created traces are read back before completion.

## Materialized MCP call

- [ ] The call was copied from the package-local template.
- [ ] Every `FILL_` placeholder was replaced.
- [ ] Integer fields are integers and nullable fields are explicit null when required.
- [ ] Tool name and parameter names match the MCP contract exactly.
- [ ] The JSON file was read back after editing.
- [ ] The call does not contain fields owned by the kernel.

## Acceptance and completion

- [ ] Artifacts remain in `draft`/`in_review` — the worker did NOT transition to accepted.
- [ ] Retry count is within the profile budget (`maxAttempts: 2`, `backoff: none`).
- [ ] Accepted artifacts are reused after restart; no duplicate is created.
- [ ] Tracker contains the latest error and resume step.
- [ ] Completion summary names created PRD/FR/NFR/RULE ids and trace refs truthfully.
- [ ] `worker_done` is called once, only after all outputs were read back.
- [ ] After `worker_done`, the single-use worker exits and claims no other task.
