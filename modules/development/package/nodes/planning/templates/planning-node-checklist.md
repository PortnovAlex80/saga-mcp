# Planning Node Pre-Submit Checklist

> Wave 9 package-local checklist for the `plan-task-graph` development node
> (W9-A3). Run before `process_node_submit` and before `worker_done`.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-development@1.0.0`.
- [ ] `node_id` is `plan-task-graph`.
- [ ] Process run, node, WorkIntent, task, execution and worker ids match `task_get`.
- [ ] Input snapshot ref/hash match the machine-filled tracker values.
- [ ] No machine-filled id, hash, schema version, repository id, branch or commit was inferred by the LM.

## Proposal shape

- [ ] The schema is exactly `saga3.development-task-graph-proposal.v1`.
- [ ] Every placeholder is replaced with the correct JSON type; ids are integers, and a missing repository binding is JSON `null`, not a string.
- [ ] Work-item keys are non-empty and unique across both arrays.
- [ ] Implementation items cover every AC marked `implementationRequired`.
- [ ] There is exactly one required verification item for every accepted AC.
- [ ] Every dependency names another proposed item; there are no cycles.
- [ ] Implementation items depend only on implementation items.
- [ ] Integration targets exactly equal the repositories in the frozen input.
- [ ] Each target branch and base commit are copied exactly from that input.

## Authority and scope

- [ ] The call uses only tools from the frozen `development-task-graph-planner` allowed list.
- [ ] No `task_create`, dependency write, Git mutation or CI action was attempted.
- [ ] No kernel-owned field (`graphHash`, `taskGraphHash`, lineage hashes) was filled by the planner.
- [ ] No downstream Process Module is started or selected.
- [ ] No lifecycle transition is requested by the worker.

## Materialized MCP call

- [ ] The call was copied from the package-local template.
- [ ] Every `FILL_` placeholder was replaced.
- [ ] Integer fields are integers and nullable fields are explicit null when required.
- [ ] Tool name and parameter names match the MCP contract exactly.
- [ ] The JSON file was read back after editing.

## Submission and completion

- [ ] `process_node_submit` is called exactly once, before `worker_done`.
- [ ] Submission ref/hash recorded in the tracker after the call.
- [ ] On rejection, the error was recorded and no id was invented or authority widened.
- [ ] Retry count is within the profile budget (`maxAttempts: 2`, `backoff: none`).
- [ ] Completion summary names the submission ref/hash and item counts truthfully.
- [ ] `worker_done` is called once, only after the submission was recorded.
- [ ] After `worker_done`, the single-use worker exits and claims no other task.
