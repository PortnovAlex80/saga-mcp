# Formalization — Product (PRD) Node Tracker

> Wave 8 package-local tracker for the `define-product-contract` formalization
> node (W8-A2). This file is the external execution frame for one LM node.
> Read it before every action. Update it after every completed step, rejected
> submission, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-formalization@1.0.0`
- node_id: `define-product-contract`
- execution_profile: `formalization-product`
- process_run_id: `{PROCESS_RUN_ID}`
- lifecycle_run_id: `{LIFECYCLE_RUN_ID}`
- stage_binding_id: `{STAGE_BINDING_ID}`
- work_intent_id: `{WORK_INTENT_ID}`
- project_id: `{PROJECT_ID}`
- epic_id: `{EPIC_ID}`
- project_repository_id: `{PROJECT_REPOSITORY_ID}`
- task_id: `{TASK_ID}`
- execution_id: `{EXECUTION_ID}`
- worker_id: `{WORKER_ID}`
- input_snapshot_ref: `{INPUT_SNAPSHOT_REF}`
- input_snapshot_hash: `{INPUT_SNAPSHOT_HASH}`
- output_schema: `saga3.formalization-product-bundle.v1`

## Authority snapshot

- allowed_tools: `{ALLOWED_TOOLS}`
- authority_scope: `artifact_create|artifact_update|trace_add|worker_done (PRD/FR/NFR/RULE candidates)`
- authority_enforcement: `runtime`
- artifact_acceptance_authority: `kernel-gate`

The worker must not add tools, widen the scope, transition artifacts to
accepted, or change immutable binding values. On `AUTHORITY_DENIED`, record the
error and do not call that tool again.

## Current node program counter

- current_step: `1`
- current_action: `read assigned task and accepted discovery decision`
- attempt: `1`
- max_attempts: `{MAX_ATTEMPTS}`
- checkpoint_status: `ready`

## Protocol step ladder (define-product-contract)

1. `bind-discovery-certificate` — read task + accepted discovery decision; fill tracker.
2. `draft-product-contract` — draft PRD + FR/NFR/RULE in the repository.
3. `register-artifacts` — materialize artifact_create calls; provenance attached.
4. `read-back-owned-artifacts` — confirm ids/hashes read from Saga.
5. `verify-what-side-lineage` — PRD→discovery + FR/NFR/RULE→PRD ready (recovery re-entry).
6. `complete-product-node` — worker_done once; exit.

## Recovery

- recovery_entry_step: `verify-what-side-lineage`
- retry_semantics: `runtime-implemented-linear`
- on_exhausted: `pause`
- accepted artifacts reused after restart: `{true|false}`
- downstream module started by worker: `false` (invariant formalization.module-does-not-route)

## Owned artifacts this execution

- prd_artifact_id: `{FILL_AFTER_READBACK_OR_NULL}`
- fr_artifact_ids: `[]`
- nfr_artifact_ids: `[]`
- rule_artifact_ids: `[]`

## Errors / resume notes

- `{record every rejected submission, retry, and AUTHORITY_DENIED here}`
