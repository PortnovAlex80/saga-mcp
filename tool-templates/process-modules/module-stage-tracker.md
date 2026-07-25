# Process Module Design/Execution Tracker

## Module binding

- module_ref: `{MODULE_NAME}@{MODULE_VERSION}`
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- process_run_id: `{PROCESS_RUN_ID}`
- node_run_id: `{NODE_RUN_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `{OUTPUT_SCHEMA}`

## Program counter

- current_node: `{NODE_ID}`
- current_step: `1`
- attempt: `1`
- max_attempts: `{MAX_ATTEMPTS}`
- checkpoint: `ready`

## Content/physics boundary

### Module content

- [ ] goal/contracts/outcomes
- [ ] Flow and local policies
- [ ] artifacts and provenance
- [ ] skills/templates/checklists

### Runtime physics

- [ ] WorkIntent/task/execution binding is machine-filled
- [ ] tracker/workspace is provisioned
- [ ] MCP allowlist is runtime-enforced
- [ ] retry/recovery is durable
- [ ] module does not select downstream process

## Steps

- [ ] Read tracker and assigned task.
- [ ] Verify machine-filled binding.
- [ ] Read frozen input and allowed sources.
- [ ] Perform only the current node's semantic work.
- [ ] Materialize MCP calls from templates.
- [ ] Apply checklist and read calls back.
- [ ] Execute allowed calls.
- [ ] Verify persisted output/provenance.
- [ ] Complete once and exit.

## Outputs

| Artifact/call | Ref | State | Hash/result |
|---|---|---|---|
|  |  |  |  |

## Errors and recovery

| Step | Error | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
