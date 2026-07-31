# Discovery Readiness Advisor Tracker

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
- [ ] 2. Call `readiness_get` and use only its canonical proposal and allowed source refs.
- [ ] 3. Fill only the advisory fields in the machine-provisioned readiness call JSON.
- [ ] 4. Read the readiness checklist and call JSON back; verify proposal id/hash and all required rationales.
- [ ] 5. Call `readiness_submit` once using the verified JSON.
- [ ] 6. Record assessment id/hash, update this tracker, call `worker_done` once and exit.

## Durable results

- proposal_id:
- proposal_content_hash:
- assessment_id:
- assessment_hash:

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |


Rework rules (CGAD P18 — a rework worker arrives at the workplace and must see the feedback):

- If `recovery-feedback.json` exists in this execution directory, READ IT FIRST — it carries the gate's findings about what to fix.
- If `review-feedback.json` exists, READ IT FIRST — it carries the reviewer's findings (changes_requested) about what to fix.
- Never rework blind.
