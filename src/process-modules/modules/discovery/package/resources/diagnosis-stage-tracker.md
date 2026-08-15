# Discovery Diagnosis Advisor Tracker

## Machine binding

- process_module_ref: `{PROCESS_MODULE_REF}`
- process_run_id: `{PROCESS_RUN_ID}`
- node_id: `{NODE_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- control_intent_id: `{CONTROL_INTENT_ID}`
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
- [ ] 2. Call `diagnosis_get` and read the immutable certificate, policy trace and allowed refs.
- [ ] 3. Fill only explanatory fields in the machine-provisioned diagnosis call JSON.
- [ ] 4. Read the diagnosis checklist and call JSON back; copy certificate binding verbatim and cite only contributing conditions.
- [ ] 5. Call `diagnosis_submit` once using the verified JSON.
- [ ] 6. Record report id/hash, update this tracker, call `worker_done` once and exit.

## Durable results

- certificate_id:
- certificate_hash:
- diagnosis_report_id:
- diagnosis_report_hash:

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
