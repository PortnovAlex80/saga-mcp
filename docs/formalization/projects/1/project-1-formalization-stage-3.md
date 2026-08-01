# Formalization Process Module Tracker

> This file is the external execution frame for one Formalization LM node.
> Read it before every action. Update it after every completed step, rejected
> submission, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-formalization@1.0.0`
- process_run_id: 2
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- node_id: `model-use-cases`
- work_intent_id: 3
- project_id: 1
- epic_id: 1
- project_repository_id: `1`
- task_id: 3
- execution_id: `exec-1-19776-1785338618378-2`
- worker_id: `board-1-1785338618378-2`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `d6ff31723ffcb79b716f68965e1f1ccb54e4eea765d480f6f6917d7b329adfaf`
- output_schema: `saga3.formalization-use-case-bundle.v1`

## Authority snapshot

- allowed_tools: ["task_get","artifact_list","trace_list","note_list","repository_checkout_list","Read","Glob","Grep","artifact_create","artifact_update","trace_add","worker_done","Write","Edit","Bash"]
- authority_scope: `saga-analyst`
- authority_enforcement: `runtime`

The worker must not add tools, widen the scope or change immutable binding values.
On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Current node program counter

- current_step: `11`
- current_action: `verifying outputs and preparing completion`
- attempt: `1`
- max_attempts: 2
- checkpoint_status: `completed`

## Step progress

- [x] 1. Read this tracker and `task_get({ id: task_id })`.
- [x] 2. Verify task metadata matches every machine-filled binding above.
- [x] 3. Read the frozen input artifacts and existing trace graph.
- [x] 4. Copy the required document/template; do not recreate it from memory.
- [x] 5. Produce or update only the artifacts owned by this node.
- [x] 6. Materialize every MCP write in a call JSON file.
- [x] 7. Read the node checklist and validate every materialized call.
- [x] 8. Execute the verified MCP calls.
- [x] 9. Re-read created artifacts and trace links from Saga MCP.
- [x] 10. Materialize and verify `worker_done`.
- [x] 11. Call `worker_done`, update checkpoint to `completed`, then exit.

## Artifact register

| Role | Artifact type | Artifact id | Code/path | Hash/status | Notes |
|---|---|---:|---|---|---|
| input | PRD | 1 | docs/requirements/REQ-001-hex-button-autism-ui/00-PRD.md | 93a6f2b6 | immutable |
| output | UC | 27 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-1 | e9a6063e/draft | created |
| output | UC | 28 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-2 | e9a6063e/draft | created |
| output | UC | 29 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-3 | e9a6063e/draft | created |
| output | UC | 30 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-4 | e9a6063e/draft | created |
| output | UC | 31 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-5 | e9a6063e/draft | created |
| output | UC | 32 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-6 | e9a6063e/draft | created |
| output | UC | 33 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-7 | e9a6063e/draft | created |
| output | UC | 34 | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md#UC-8 | e9a6063e/draft | created |

## Trace register

| From | Relation | To | Recorded | Verified |
|---|---|---|---|---|
| UC-1 (27) | derived_from | FR-1 (2) | yes | yes |
| UC-2 (28) | derived_from | FR-2 (3) | yes | yes |
| UC-3 (29) | derived_from | FR-3 (4) | yes | yes |
| UC-3 (29) | derived_from | FR-5 (6) | yes | yes |
| UC-4 (30) | derived_from | FR-4 (5) | yes | yes |
| UC-5 (31) | derived_from | FR-5 (6) | yes | yes |
| UC-6 (32) | derived_from | FR-6 (7) | yes | yes |
| UC-7 (33) | derived_from | FR-7 (8) | yes | yes |
| UC-8 (34) | derived_from | FR-8 (9) | yes | yes |

## Materialized MCP calls

| Call file | Tool | State | Result/ref |
|---|---|---|---|
|  |  | draft |  |

## Errors and recovery

| Time | Step | Error/code | Action taken | Resume step |
|---|---:|---|---|---:|
|  |  |  |  |  |

Recovery rules:

1. Reuse this tracker, the same WorkIntent and accepted artifacts.
2. Do not create duplicate artifacts or trace links before querying existing state.
3. Resume from the last verified checkpoint, not from the start by default.
4. Machine-filled ids, hashes and schema versions are immutable.
5. If attempts are exhausted, follow the profile policy: pause or escalate; never fake completion.
