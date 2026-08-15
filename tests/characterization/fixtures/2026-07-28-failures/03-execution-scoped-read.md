---
id: execution-scoped-read
symptom: |
  When a formalization worker retried (review changes_requested, recovery
  repair, lease loss), the current execution often produced NO managed
  artifacts — they were created in an EARLIER execution of the same task. The
  resolver handlers read strictly by execution_id and found nothing, returning
  "persisted no canonical AC artifacts" even though the artifacts existed in
  the ledger under a different execution.
root_cause_class: execution-scoped-read
evidence: |
  - Commit 9229f14 "fix(formalization): retry/recovery fallback for
    execution-scoped artifact reads" (2026-07-28) added a process-run-scoped
    fallback in readExecutionWrites.
    Files touched (per commit --stat):
      src/process-modules/modules/formalization/formalization-installation.ts (+51)
      src/process-modules/persistence/sqlite-managed-production-ledger.ts (+45)
      tests/process-modules/formalization/formalization-generic-flow.test.mjs (+10)
  - The fallback uses a RELAXED fence (process+module+node+intent+task, NOT
    executionId). New ledger methods listArtifactsForNodeInProcessRun /
    listTracesForNodeInProcessRun scope by process_run_id, not execution_id.
  - The fallback mirrors Discovery's readLatestXxx(intent) fallback pattern,
    i.e. several modules already patch the same unstable boundary ad hoc.
reproduction: |
  Static: `grep -n "listArtifactsForNodeInProcessRun\|readExecutionWrites" src/process-modules/modules/formalization/formalization-installation.ts`
  Command: `git show 9229f14 -- src/process-modules/modules/formalization/formalization-installation.ts`
  Dynamic (full pipeline): run a formalization AC task, force a retry (reject
  with changes_requested), and observe that readExecutionWrites returns empty
  under strict execution_id scoping until the process-run fallback fires.
expected_after_fix: |
  Resume reconstructs state from the exact receipt/product keyed to the
  ProcessRun+Node, not from "the current execution's writes". The strict-vs-
  relaxed fence duality disappears because execution-scoped reads are not the
  authoritative channel at all — durable products are (plan §0.6.12).
fixing_waves:
  - "3"
---

# Fixture: execution-scoped-read

Captured from the 2026-07-28 failure taxonomy (plan §2.2).

## Boundary that is unstable

The resolver reads worker writes scoped to the current execution_id, but a
retry/recovery continues the SAME task under a NEW execution_id, so the prior
writes are invisible without a fallback. The fallback widens the fence,
exchanging correctness-of-scope for availability.

## Why this is a fixture, not a fix

Wave 3 (plan §0.6) makes the exact receipt and product authoritative, so
execution-scoped reads stop being a load-bearing channel and the fallback is
no longer needed. This fixture records the fallback so the Wave 3 exit gate
can prove it was removed, not widened.

## Closed by CGAD P18 (Artifact Durability Invariant)

This failure class is now closed by a formal contract, not an ad-hoc fallback.
CGAD P18 codifies that managed artifact identity is durable across recovery
cycles: kernel gates read by durable node-scope (processRunId + moduleRef +
nodeId), and task/intent/execution are durability fences only, never query
filters. The regression that reintroduced task-scoped reads
(`listArtifactsForTaskInProcessRun` + `matchesTaskFence`, with a self-defensive
"Never relax this fence" comment) violated P18 and reopened the exact
infinite repair-loop this fixture documents. The node-scope read is the
authoritative channel; the fallback duality this fixture described is
forbidden by contract.
