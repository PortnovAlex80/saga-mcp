# Discovery Proposal Worker Tracker

## Machine binding

- process_module_ref: `{PROCESS_MODULE_REF}`
- process_run_id: `{PROCESS_RUN_ID}`
- node_id: `{NODE_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `{OUTPUT_SCHEMA}`
- allowed_tools: `{ALLOWED_TOOLS}`

## Current Step: 1

## Step progress

- [ ] 1. Read this tracker and `task_get({ id: task_id })`; verify every machine binding.
- [ ] 2. Inspect only the allowed repository/artifact context needed for the product idea.
- [ ] 3. Fill the machine-provisioned discovery document.
- [ ] 4. Fill the machine-provisioned proposal call JSON without changing machine-owned fields.
- [ ] 5. Read the proposal checklist and call JSON back; verify every field and no unresolved required placeholder.
- [ ] 6. Call `proposal_submit` once using the verified JSON.
- [ ] 7. Re-read the accepted result, update this tracker, call `worker_done` once and exit.

## Durable results

- discovery_document:
- raw_submission_id:
- proposal_id:
- proposal_content_hash:

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
