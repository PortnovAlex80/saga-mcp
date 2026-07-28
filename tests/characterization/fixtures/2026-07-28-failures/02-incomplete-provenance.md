---
id: incomplete-provenance
symptom: |
  A worker production whose managed-production lineage is partially absent.
  Workers calling managed-production tools (artifact_create, process_node_submit,
  ...) under SAGA_MANAGED_EXECUTION=1 hit
  MANAGED_PRODUCTION_CONTEXT_INVALID: "process provenance binding is incomplete"
  because only 3 of the 5 required process keys were stamped onto the projected
  task metadata.
root_cause_class: incomplete-provenance
evidence: |
  - Commit fd52982 "fix(development): stamp full provenance on projected tasks
    + real dev ports" (2026-07-28): findOrCreateProjectedTask stamped only
    process_run_id, process_node_id, process_module_ref but missed
    process_input_hash and work_intent_id.
  - Current state: src/process-modules/modules/development/sqlite-development-runtime.ts:669-680
    stamps all five keys, but process_input_hash and work_intent_id still fall
    back to `?? null` when the ProcessRun/planner-intent lookups miss (lines
    673-674: `processRun?.input_hash ?? null`, `plannerIntent?.work_intent_id ?? null`).
  - The five-key managed-production fence is enforced by
    src/process-modules/persistence/sqlite-managed-production-ledger.ts
    (managed_artifact_productions / managed_trace_productions rows keyed by
    process_run_id + module_ref + node_id + intent_id + task_id + execution_id).
reproduction: |
  Static: `grep -n "process_input_hash\|work_intent_id" src/process-modules/modules/development/sqlite-development-runtime.ts`
  shows the two keys are best-effort (`?? null`). Inject a projected task whose
  ProcessRun row or planner WorkIntent lookup returns undefined and call any
  managed-production MCP tool under SAGA_MANAGED_EXECUTION=1: the context
  validator rejects with MANAGED_PRODUCTION_CONTEXT_INVALID.
  Command (read-only): `grep -rn "MANAGED_PRODUCTION_CONTEXT_INVALID" src/ | head`
expected_after_fix: |
  Provenance is reconstructed from durable receipt/product state, not from
  best-effort metadata lookups. Wave 3 (plan §0.6.12) makes a crash resume from
  the exact receipt and product with no task-metadata or magic-binding
  reconstruction — meaning the five managed-production keys are carried by the
  ExecutionContextEnvelope/NodeExecutionReceipt, not by mutable task.metadata
  that can be partially null.
fixing_waves:
  - "3"
  - "1"
---

# Fixture: incomplete-provenance

Captured from the 2026-07-28 failure taxonomy (plan §2.2).

## Boundary that is unstable

Provenance keys travel through task.metadata (a mutable worker projection),
partially populated by a projection adapter. They are not carried by the
execution receipt/product contract, so any lookup miss leaves a worker unable
to fence its own production.

## Why this is a fixture, not a fix

Wave 3 owns the durable execution-envelope/receipt contract (plan §0.6). This
fixture pins the current partial-stamp behavior so the Wave 3 exit gate can
prove provenance is complete by construction, not by best-effort lookup.
