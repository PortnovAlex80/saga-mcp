# Discovery Readiness Advisor Tracker

## Machine binding

- process_module_ref: `product-discovery@3.0.0`
- process_run_id: 10
- node_id: `assess-readiness`
- work_intent_id: 10274
- control_intent_id: `1218`
- project_id: 44
- epic_id: 44
- task_id: 6294
- execution_id: `exec-44-21548-1785134386768-1`
- worker_id: `board-44-1785134386768-1`
- input_snapshot_hash: `5ff7fed34a0eb31838209b296321d82838828052f3e6ef4fbb79757826b86195`
- output_schema: `saga3.discovery-readiness-assessment.v1`

## Current Step: readiness_done

## Step progress

- [x] 1. Read this tracker and `task_get({ id: task_id })`; verify every machine binding.
- [x] 2. Call `readiness_get` and use only its canonical proposal and allowed source refs.
- [x] 3. Fill only the advisory fields in the machine-provisioned readiness call JSON.
- [x] 4. Read the readiness checklist and call JSON back; verify proposal id/hash and all required rationales.
- [x] 5. Call `readiness_submit` once using the verified JSON.
- [x] 6. Record assessment id/hash, update this tracker, call `worker_done` once and exit.

## Durable results

- proposal_id: 142
- proposal_content_hash: ab8538ad009ede4173996981281645f916e8a8e4ab372ae807a3ca067d7e74e3
- assessment_id: 81
- assessment_hash: 2f10a0e16680fdcbe4f62602f9e8d95138fd31e195f1a7fa1c4baa966bd11e52

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
