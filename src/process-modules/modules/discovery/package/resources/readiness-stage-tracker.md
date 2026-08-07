# Discovery Readiness Cell Tracker

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

## Step progress

- [ ] 1. Read this tracker and `task_get({id: task_id})`; verify the machine binding.
- [ ] 2. Read the exact accepted Proposal ProductRef from `process_node_input`.
- [ ] 3. Call `product_read` using that exact schema_id/ref/digest and record the immutable Proposal + submission_id.
- [ ] 4. Fill the readiness product JSON from that Proposal only; cite exact source refs.
- [ ] 5. Read the checklist and product JSON back; verify proposal id/hash and all seven dimensions.
- [ ] 6. Call `product_submit` exactly once.
- [ ] 7. Record the returned ProductRef, call `worker_done` exactly once and exit.

## Durable result

- source_proposal_schema:
- source_proposal_ref:
- source_proposal_digest:
- product_schema:
- product_ref:
- product_digest:

## Repair rule

If the Cell gate requests repair, a fresh execution receives the durable
feedback. Read it first, reuse the exact Proposal ProductRef, correct only the
rejected assessment fields and submit a new immutable product.
