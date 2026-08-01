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
- work_intent_id: 5
- project_id: 1
- epic_id: 1
- project_repository_id: `1`
- task_id: 5
- execution_id: `exec-1-19776-1785339574657-2`
- worker_id: `board-1-1785339574657-2`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `e3d0fd419663d04ae7129d5a545d6d80f2eeba043a4ee3e8e71ee06e029ff69f`
- output_schema: `saga3.formalization-use-case-bundle.v1`

## Authority snapshot

- allowed_tools: ["task_get","artifact_list","trace_list","note_list","repository_checkout_list","Read","Glob","Grep","artifact_create","artifact_update","trace_add","worker_done","Write","Edit","Bash"]
- authority_scope: `saga-analyst`
- authority_enforcement: `runtime`

The worker must not add tools, widen the scope or change immutable binding values.
On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Current node program counter

- current_step: `completed`
- current_action: `Review complete - worker_done called with approved verdict`
- attempt: `2`
- max_attempts: 2
- checkpoint_status: `completed`

## Step progress

- [x] 1. Read this tracker and `task_get({ id: task_id })`.
- [x] 2. Verify task metadata matches every machine-filled binding above.
- [x] 3. Read the frozen input artifacts and existing trace graph.
- [x] 4. Verify UC artifacts exist with correct traceability.
- [x] 5. Re-read created artifacts and trace links from Saga MCP.
- [x] 6. Materialize and verify `worker_done`.
- [x] 7. Call `worker_done`, update checkpoint to `completed`, then exit.

## Artifact register

| Role | Artifact type | Artifact id | Code/path | Hash/status | Notes |
|---|---|---:|---|---|---|
| input | `{INPUT_ARTIFACT_TYPE}` | `{INPUT_ARTIFACT_ID}` | `{INPUT_ARTIFACT_REF}` | `{INPUT_ARTIFACT_HASH}` | immutable |
| output | UC | 27-34 | UC-1 through UC-8 | e9a6063e14e8c2f044c8785b5fe7443b5856fcd593c051a1f9a673f04e20ebc1 | draft status, 8 artifacts verified |
| document | use-cases.md | docs/requirements/REQ-001-hex-button-autism-ui/02-use-cases.md | e9a6063e14e8c2f044c8785b5fe7443b5856fcd593c051a1f9a673f04e20ebc1 | comprehensive, 460 lines |

## Trace register

| From | Relation | To | Recorded | Verified |
|---|---|---|---|---|
| UC-1 (27) | derived_from | PRD-1 (1) | yes | yes |
| UC-1 (27) | derived_from | FR-1 (2) | yes | yes |
| UC-1 (27) | covers | FR-1 (2) | yes | yes |
| UC-2 (28) | derived_from | PRD-1 (1) | yes | yes |
| UC-2 (28) | derived_from | FR-2 (3) | yes | yes |
| UC-2 (28) | covers | FR-2 (3) | yes | yes |
| ... (similar pattern for UC-3 through UC-8) |  |  |  |  |
| All 8 UCs | complete traceability | PRD + respective FRs | yes | yes |

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
