# Formalization Process Module Tracker

> This file is the external execution frame for one Formalization LM node.
> Read it before every action. Update it after every completed step, rejected
> submission, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-formalization@1.0.0`
- process_run_id: `{PROCESS_RUN_ID}`
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- node_id: `{NODE_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- project_repository_id: `{PROJECT_REPOSITORY_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `{OUTPUT_SCHEMA}`

## Authority snapshot

- allowed_tools: `{ALLOWED_TOOLS}`
- authority_scope: `{AUTHORITY_SCOPE}`
- authority_enforcement: `runtime`

The worker must not add tools, widen the scope or change immutable binding values.
On `AUTHORITY_DENIED`, record the error and do not call that tool again.

## Current node program counter

- current_step: `1`
- current_action: `read assigned task and frozen input`
- attempt: `1`
- max_attempts: `{MAX_ATTEMPTS}`
- checkpoint_status: `ready`

## Step progress

- [ ] 1. Read this tracker and `task_get({ id: task_id })`.
- [ ] 2. Verify task metadata matches every machine-filled binding above.
- [ ] 3. Read the frozen input artifacts and existing trace graph.
- [ ] 4. Copy the required document/template; do not recreate it from memory.
- [ ] 5. Produce or update only the artifacts owned by this node.
- [ ] 6. Materialize every MCP write in a call JSON file.
- [ ] 7. Read the node checklist and validate every materialized call.
- [ ] 8. Execute the verified MCP calls.
- [ ] 9. Re-read created artifacts and trace links from Saga MCP.
- [ ] 10. Materialize and verify `worker_done`.
- [ ] 11. Call `worker_done`, update checkpoint to `completed`, then exit.

## Artifact register

| Role | Artifact type | Artifact id | Code/path | Hash/status | Notes |
|---|---|---:|---|---|---|
| input | `{INPUT_ARTIFACT_TYPE}` | `{INPUT_ARTIFACT_ID}` | `{INPUT_ARTIFACT_REF}` | `{INPUT_ARTIFACT_HASH}` | immutable |
| output |  |  |  |  |  |

## Trace register

| From | Relation | To | Recorded | Verified |
|---|---|---|---|---|
|  |  |  | no | no |

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
6. If `recovery-feedback.json` exists in this execution directory, READ IT FIRST — it carries the gate's findings about what to fix. If `review-feedback.json` exists, READ IT FIRST — it carries the reviewer's findings (changes_requested) about what to fix. Never rework blind.
