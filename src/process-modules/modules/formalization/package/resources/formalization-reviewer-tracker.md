# Formalization Reviewer Tracker

> This file is the external execution frame for one Formalization REVIEWER node.
> Read it before every action. Update it after each completed step.
> You are a REVIEWER, not an author. Do NOT create artifacts, traces, or files.

## Machine-filled binding

- process_module_ref: `solution-formalization@1.0.0`
- process_run_id: `{PROCESS_RUN_ID}`
- node_id: `{NODE_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- output_schema: `factory.review-verdict.v1`

## Reviewer program counter

- [ ] 1. Read this tracker and `task_get({ id: task_id })`.
- [ ] 2. Read the frozen author CandidateSet via `candidate_read`.
- [ ] 3. Read each product in the CandidateSet via `product_read`.
- [ ] 4. Evaluate against the node checklist and domain contract.
- [ ] 5. Submit review verdict via `product_submit(factory.review-verdict.v1)`.
- [ ] 6. Call `worker_done` exactly once with the bound execution ids.

## Reviewer constraints

- Do NOT create, update, or delete artifacts or traces.
- Do NOT write files, edit files, or run shell commands.
- Do NOT re-open or modify the author's tracker.
- Your ONLY output is one `factory.review-verdict.v1` product + one `worker_done` call.
