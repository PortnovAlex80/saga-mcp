# Development task-graph proposal checklist

Before `process_node_submit`:

- The schema is exactly `saga3.development-task-graph-proposal.v1`.
- Every placeholder is replaced with the correct JSON type; ids are integers,
  and a missing repository binding is JSON `null`, not a string.
- Work-item keys are non-empty and unique across both arrays.
- Implementation items cover every AC marked `implementationRequired`.
- There is exactly one required verification item for every accepted AC.
- Every dependency names another proposed item; there are no cycles.
- Implementation items depend only on implementation items.
- Integration targets exactly equal the repositories in the frozen input.
- Each target branch and base commit are copied exactly from that input.
- No `task_create`, dependency write, Git mutation or CI action was attempted.
- `process_node_submit` is called before `worker_done`.

The kernel may reject the proposal. Only a policy-valid graph is materialized.
