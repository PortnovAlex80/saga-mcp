# Discovery Readiness Advisor Tracker

## Machine binding

- process_module_ref: `product-discovery@3.0.0`
- process_run_id: 11
- node_id: `assess-readiness`
- work_intent_id: 10276
- control_intent_id: `1219`
- project_id: 45
- epic_id: 45
- task_id: 6296
- execution_id: `exec-45-14680-1785137019723-1`
- worker_id: `board-45-1785137019723-1`
- input_snapshot_hash: `b01bea06695eccc71d7a91ad5d3b56a0db4386de040b425f57253e0332b396fd`
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

- proposal_id: 143
- proposal_content_hash: b035508e6efb71b4b9737ddab2e0d02c609e8180089cbe01b7c402936ca36bfc
- assessment_id: 82
- assessment_hash: 985d368db7c79364ec285e7c17c5b0366f51516d925bfff933a4998d7a18af4b

## Errors and recovery

| Step | Error/code | Durable state found | Resume action |
|---:|---|---|---|
|  |  |  |  |
