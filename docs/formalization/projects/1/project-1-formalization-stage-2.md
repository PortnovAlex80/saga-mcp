# Formalization Process Module Tracker

> This file is the external execution frame for one Formalization LM node.
> Read it before every action. Update it after every completed step, rejected
> submission, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-formalization@1.0.0`
- process_run_id: 2
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- node_id: `define-product-contract`
- work_intent_id: 2
- project_id: 1
- epic_id: 1
- project_repository_id: `1`
- task_id: 2
- execution_id: `exec-1-19776-1785338290926-2`
- worker_id: `board-1-1785338290926-2`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `3b6d1608d5acfe850ba74f22152cb3090ea9d44f1ce595544e13469d2b7cf6b3`
- output_schema: `saga3.formalization-product-bundle.v1`

## Authority snapshot

- allowed_tools: ["task_get","artifact_list","trace_list","note_list","repository_checkout_list","Read","Glob","Grep","artifact_create","artifact_update","trace_add","worker_done","Write","Edit","Bash"]
- authority_scope: `saga-product`
- authority_enforcement: `runtime`

The worker must not add tools, widen the scope or change immutable binding values.
On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Current node program counter

- current_step: `11`
- current_action: `task completed - approved by review`
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
| input | `{INPUT_ARTIFACT_TYPE}` | `{INPUT_ARTIFACT_ID}` | `{INPUT_ARTIFACT_REF}` | `{INPUT_ARTIFACT_HASH}` | immutable |
| output | PRD | 1 | docs/requirements/REQ-001-hex-button-autism-ui/00-PRD.md | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | created |
| output | FR | 2 | FR-1 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 3 | FR-2 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 4 | FR-3 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 5 | FR-4 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 6 | FR-5 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 7 | FR-6 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 8 | FR-7 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | FR | 9 | FR-8 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 10 | NFR-1 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 11 | NFR-2 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 12 | NFR-3 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 13 | NFR-4 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 14 | NFR-5 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 15 | NFR-6 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 16 | NFR-7 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | NFR | 17 | NFR-8 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 18 | RULE-1 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 19 | RULE-2 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 20 | RULE-3 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 21 | RULE-4 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 22 | RULE-5 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 23 | RULE-6 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 24 | RULE-7 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |
| output | RULE | 25 | RULE-8 | 93a6f2b6fbe2246c9e469003958b56dbbcbcd6e0a5444b13ed93094748923ca3 draft | parent: PRD-1 |

## Trace register

| From | Relation | To | Recorded | Verified |
|---|---|---|---|---|
| FR-1 | derived_from | PRD-1 | yes | yes |
| FR-2 | derived_from | PRD-1 | yes | yes |
| FR-3 | derived_from | PRD-1 | yes | yes |
| FR-4 | derived_from | PRD-1 | yes | yes |
| FR-5 | derived_from | PRD-1 | yes | yes |
| FR-6 | derived_from | PRD-1 | yes | yes |
| FR-7 | derived_from | PRD-1 | yes | yes |
| FR-8 | derived_from | PRD-1 | yes | yes |
| NFR-1 | derived_from | PRD-1 | yes | yes |
| NFR-2 | derived_from | PRD-1 | yes | yes |
| NFR-3 | derived_from | PRD-1 | yes | yes |
| NFR-4 | derived_from | PRD-1 | yes | yes |
| NFR-5 | derived_from | PRD-1 | yes | yes |
| NFR-6 | derived_from | PRD-1 | yes | yes |
| NFR-7 | derived_from | PRD-1 | yes | yes |
| NFR-8 | derived_from | PRD-1 | yes | yes |
| RULE-1 | derived_from | PRD-1 | yes | yes |
| RULE-2 | derived_from | PRD-1 | yes | yes |
| RULE-3 | derived_from | PRD-1 | yes | yes |
| RULE-4 | derived_from | PRD-1 | yes | yes |
| RULE-5 | derived_from | PRD-1 | yes | yes |
| RULE-6 | derived_from | PRD-1 | yes | yes |
| RULE-7 | derived_from | PRD-1 | yes | yes |
| RULE-8 | derived_from | PRD-1 | yes | yes |

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
