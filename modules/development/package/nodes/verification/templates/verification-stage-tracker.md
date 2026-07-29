# Development — Verification Node Tracker

> Wave 9 package-local tracker for the `verify-acceptance-workset` development
> node (W9-A3). This file is the external execution frame for one LM node. Read
> it before every action. Update it after every recorded verdict, denied
> outcome, retry, pause or recovery. Never rely on conversation memory alone.

## Machine-filled binding

- process_module_ref: `solution-development@1.0.0`
- node_id: `verify-acceptance-workset`
- adapter: `development-verify-acceptance-workset`
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
- output_schema: `saga3.acceptance-verification-workset.v1`

## Frozen target binding

- candidate_ref: `{FILL_FROZEN_CANDIDATE_REF_OR_NULL}`
- candidate_hash: `{FILL_FROZEN_CANDIDATE_HASH_OR_NULL}`
- acceptance_criterion_id: `{FILL_INTEGER_AC_ARTIFACT_ID_OR_NULL}`
- accepted_criterion_hash: `{FILL_AC_ACCEPTED_HASH_OR_NULL}`
- provider_id: `{FILL_TRUSTED_PROVIDER_ID_OR_NULL}`
- provider_name: `{FILL_TRUSTED_PROVIDER_NAME_OR_NULL}`

## Authority snapshot

- allowed_tools: `{ALLOWED_TOOLS}`
- authority_scope: `verification_record | worker_done (read-only evidence, 4-valued verdict)`
- authority_enforcement: `runtime`
- artifact_acceptance_authority: `kernel-gate (settle-development)`

The verifier must not mutate source, mutate the candidate, or transition the AC
to accepted. On `AUTHORITY_DENIED`, record the error and do not call that tool
again.

## Current node program counter

- current_step: `1`
- current_action: `read assigned verification work item and frozen candidate`
- attempt: `1`
- checkpoint_status: `ready`

## Protocol step ladder (verify-acceptance-workset)

1. `bind-frozen-candidate` — read work item + frozen candidate + AC + provider.
2. `confirm-candidate-immutability` — re-observe candidateHash (recovery re-entry).
3. `generate-property-tests` — from frozen AC contract, not builder's tests.
4. `execute-verification` — 4-valued outcome per AC, pinned to both hashes.
5. `record-verification-evidence` — `verification_record` per AC; read back.
6. `complete-verification-node` — `worker_done` once; exit.

## Recovery

- recovery_entry_step: `confirm-candidate-immutability`
- retry_semantics: `runtime-implemented-linear`
- on_exhausted: `pause`
- candidate_drift_invalidates_evidence: `true (invariant development.no-post-verification-mutation)`
- downstream module started by worker: `false` (invariant development.module-does-not-route)

## Evidence records this execution

- recorded_outcomes: `[]` (one entry per AC: { ac_id, outcome, candidate_hash })
- unknown_or_error_denials: `[]`

## Errors / resume notes

- `{record every denied outcome, candidate drift, retry, and AUTHORITY_DENIED here}`
