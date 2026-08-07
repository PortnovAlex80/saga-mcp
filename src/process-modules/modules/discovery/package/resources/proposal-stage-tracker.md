# Discovery Proposal Cell Tracker

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

## Step progress

- [ ] 1. Read this tracker and `task_get({id: task_id})`; verify the machine binding.
- [ ] 2. If gate/recovery feedback is present, read it before changing the product.
- [ ] 3. Inspect only the bounded evidence/context required for this DiscoveryCase.
- [ ] 4. Fill the machine-provisioned discovery document.
- [ ] 5. Fill and re-read the machine-provisioned product call JSON.
- [ ] 6. Verify the Proposal product checklist and remove every placeholder.
- [ ] 7. Call `product_submit` exactly once with the verified schema/content.
- [ ] 8. Record the returned exact ProductRef, call `worker_done` exactly once, exit.

## Durable result

- product_schema:
- product_ref:
- product_digest:

## Repair rule

A rejected CandidateSet never becomes accepted by editing task status. A repair
is a new fenced execution in this same Workplace. Reuse accepted context, change
only what the GateDecision/feedback identifies, submit a new immutable product.
