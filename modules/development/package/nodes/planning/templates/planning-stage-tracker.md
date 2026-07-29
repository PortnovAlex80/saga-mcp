# Development — Planning Node Tracker

> Wave 9 package-local tracker for the `plan-task-graph` development node
> (W9-A3). This file is the external execution frame for one LM node. Read it
> before every action. Update it after every completed step, rejected
> submission, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-development@1.0.0`
- node_id: `plan-task-graph`
- execution_profile: `development-task-graph-planner`
- process_run_id: `{PROCESS_RUN_ID}`
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `saga3.development-task-graph-proposal.v1`

## Authority snapshot

- allowed_tools: `{ALLOWED_TOOLS}`
- authority_scope: `process_node_submit | worker_done (advisory task-graph proposal only)`
- authority_enforcement: `runtime`
- task_materialization_authority: `kernel-gate (resolve-task-graph)`

The planner must not call `task_create`, write dependencies, mutate Git, run CI,
or start the implementation workset. On `AUTHORITY_DENIED`, record the error and
do not call that tool again.

## Current node program counter

- current_step: `1`
- current_action: `read assigned task and development case lineage`
- attempt: `1`
- max_attempts: `{MAX_ATTEMPTS}`
- checkpoint_status: `ready`

## Protocol step ladder (plan-task-graph)

1. `bind-formalization-lineage` — read task + development case; fill tracker.
2. `read-accepted-decomposition` — read exact SRS, AC set, repositories, policy.
3. `propose-work-items` — implementation + verification items + integration targets.
4. `validate-proposal-shape` — unique keys, closed deps, acyclic graph (recovery re-entry).
5. `submit-task-graph-proposal` — `process_node_submit` exactly once.
6. `complete-planning-node` — `worker_done` once; exit.

## Recovery

- recovery_entry_step: `validate-proposal-shape`
- retry_semantics: `runtime-implemented-linear`
- retry_on: `schema-rejected | lineage-gap`
- on_exhausted: `pause`
- accepted outputs reused after restart: `{true|false}`
- downstream module started by worker: `false` (invariant development.module-does-not-route)

## Frozen inputs read this execution

- formalization_certificate_ref: `{FILL_FROM_DEVELOPMENT_CASE_OR_NULL}`
- formalization_certificate_hash: `{FILL_FROM_DEVELOPMENT_CASE_OR_NULL}`
- srs_ref: `{FILL_FROM_DEVELOPMENT_CASE_OR_NULL}`
- srs_hash: `{FILL_FROM_DEVELOPMENT_CASE_OR_NULL}`
- acceptance_baseline_hash: `{FILL_FROM_DEVELOPMENT_CASE_OR_NULL}`
- accepted_ac_count: `{FILL_INTEGER_OR_NULL}`
- bound_repository_count: `{FILL_INTEGER_OR_NULL}`

## Submission checkpoint

- submission_ref:
- submission_hash:
- submission_state: `not-submitted`

If submission is rejected, do not invent ids or widen tool authority. Record the
error and let the controller start a fresh fenced execution.

## Errors / resume notes

- `{record every rejected submission, retry, and AUTHORITY_DENIED here}`
