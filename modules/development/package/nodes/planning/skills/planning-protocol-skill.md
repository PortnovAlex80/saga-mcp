---
id: planning-protocol-skill
kind: instruction
node: plan-task-graph
module: solution-development@1.0.0
---

# Planning Node Execution Protocol — Package-Local Instruction

> Wave 9 pinned package resource (W9-A3). The reusable physical execution
> protocol for the `plan-task-graph` development node: tracker, materialized
> MCP calls, completion, and recovery. Pinned here so the node does not depend
> on a global protocol-skill lookup (exit gate §0.12.12).

This instruction governs the *physical* execution of the Planning node —
orthogonal to the semantic skill. Follow it alongside
`planning-node-checklist.md` before every read, submission, or completion write.

## Tracker is the frame of truth

- Read the stage tracker immediately before every action; update it after every
  completed step, rejected submission, retry, pause, or recovery.
- Machine-filled binding (`process_module_ref`, run/node/work-intent/task/
  execution ids, input snapshot ref/hash, output schema) comes from the runtime
  — never infer or remember an id, hash, schema version, repository id, branch,
  or commit.
- On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Materialized MCP calls

- Copy each call from the canonical package-local template
  (`planning-task-graph-submit-call.json`, `planning-worker-done-call.json`).
- Replace EVERY `FILL_` placeholder. Integer fields are integers; a missing
  repository binding is JSON `null`, not a string.
- Attach process/node/work-intent/task/execution provenance where the template
  carries it. Do not include fields the kernel owns (e.g. `graphHash`,
  `taskGraphHash` — those are filled by `resolve-task-graph`).
- Read the JSON file back after editing, then execute.

## Single authoritative write

- The planner is `tracker_only`. The ONLY mutating calls it makes are
  `process_node_submit` (exactly once) and `worker_done` (exactly once).
- It must NOT call `task_create`, write dependencies, mutate Git, run CI, or
  start the implementation workset. Those belong to the kernel resolver and the
  external execution adapter (invariant
  `development.lm-proposes-kernel-authorizes`).

## Submission and read-back

- Submit the proposal once via `process_node_submit`. Record the returned
  submission ref/hash in the tracker.
- The kernel may reject (schema-rejected / lineage-gap). On rejection, do not
  invent ids or widen tool authority; record the error and let the controller
  start a fresh fenced execution.

## Completion

- Call `worker_done` exactly once, only after the submission was recorded and
  the completion assertions pass. Summarize the submission ref/hash and the
  proposed item counts truthfully.
- After `worker_done`, the single-use worker exits and claims no other task.

## Recovery

- Retry count must stay within the `development-task-graph-planner` profile
  budget (`maxAttempts: 2`, `retryOn: ['schema-rejected','lineage-gap']`,
  `backoff: none`). Accepted outputs are reused after restart — never resubmit
  a duplicate.
- Recovery re-enters at `validate-proposal-shape`; if the proposal shape is
  incomplete, return to proposing rather than submitting.
- On exhaustion the node pauses (`onExhausted: 'pause'`); it does not start a
  downstream Process Module (invariant `development.module-does-not-route`).
