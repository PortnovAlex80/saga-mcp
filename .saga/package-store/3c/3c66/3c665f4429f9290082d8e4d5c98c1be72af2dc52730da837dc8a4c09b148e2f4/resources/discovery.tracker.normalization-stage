# Discovery Normalization Advisor Tracker

## Machine binding

- process_module_ref: `{PROCESS_MODULE_REF}`
- process_run_id: `{PROCESS_RUN_ID}`
- node_id: `{NODE_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- control_intent_id: `{CONTROL_INTENT_ID}`
- source_submission_id: `{SOURCE_SUBMISSION_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `{OUTPUT_SCHEMA}`

## Current Step: 1

## Step progress

- [ ] 1. Read this tracker and `task_get({ id: task_id })`; verify every machine binding.
- [ ] 2. Call `normalization_get` for the bound control intent and read the immutable raw source.
- [ ] 3. Fill only the semantic payload in the machine-provisioned normalization call JSON.
- [ ] 4. Read the normalization checklist and call JSON back; verify source id/hash and allowed refs exactly.
- [ ] 5. Call `normalization_submit` once using the verified JSON.
- [ ] 6. Record the accepted proposal id/hash, call `worker_done` once and exit.

## Durable results

- normalization_proposal_id:
- normalized_proposal_id:
- normalized_proposal_hash:

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
