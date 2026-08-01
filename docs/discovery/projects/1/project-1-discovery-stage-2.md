# Discovery Readiness Advisor Tracker

## Machine binding

- process_module_ref: `product-discovery@3.0.0`
- process_run_id: 1
- node_id: `assess-readiness`
- work_intent_id: 2
- control_intent_id: `1`
- project_id: 1
- epic_id: 1
- task_id: 2
- execution_id: `exec-1-3696-1785337933911-1`
- worker_id: `board-1-1785337933911-1`
- input_snapshot_hash: `387b39bc6ba1cb7c6572570158f76a68fba4393a29e8c51ed774978ff521297c`
- output_schema: `saga3.discovery-readiness-assessment.v1`

## Current Step: 3

## Step progress

- [x] 1. Read this tracker and `task_get({ id: task_id })`; verify every machine binding.
- [x] 2. Call `readiness_get` and use only its canonical proposal and allowed source refs.
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
