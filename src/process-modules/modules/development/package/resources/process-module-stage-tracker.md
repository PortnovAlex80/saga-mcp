# Development Task-Graph Planner Tracker

> External checkpoint for one managed planning execution. The planner proposes;
> it never creates tracker tasks or dependencies itself.

## Machine binding

- process_module_ref: `solution-development@1.0.0`
- process_run_id: `{PROCESS_RUN_ID}`
- node_id: `{NODE_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `saga3.development-task-graph-proposal.v1`

## Program counter

- current_step: `1`
- attempt: `1`
- checkpoint_status: `ready`

## Steps

- [ ] 1. Read this tracker and the assigned task with `task_get`.
- [ ] 2. Verify the machine binding against immutable task metadata.
- [ ] 3. Read the frozen DevelopmentCase and exact workspace paths from task metadata.
- [ ] 4. Propose implementation work covering every implementation-required AC.
- [ ] 5. Propose one required verification item for every accepted AC.
- [ ] 6. Match integration targets exactly to the bound repositories and bases.
- [ ] 7. Check unique keys, closed dependencies and an acyclic graph.
- [ ] 8. Fill and validate the submission call template.
- [ ] 9. Call `process_node_submit` exactly once.
- [ ] 10. Record its submission ref/hash, then call `worker_done` and exit.

## Submission checkpoint

- submission_ref: `{SUBMISSION_REF}`
- submission_hash: `{SUBMISSION_HASH}`
- submission_state: `{SUBMISSION_STATE}`

If submission is rejected, do not invent ids or widen tool authority. Record the
error and let the controller start a fresh fenced execution.
