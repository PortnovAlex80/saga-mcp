# Exact candidate review epoch

## Problem

`worker_done` is a transport/lifecycle receipt. It proves that one worker
execution completed a command. It is not, by itself, a semantic review
decision for every later execution of the same task.

A task may have this valid history:

```text
author A   -> worker_done(approved), task -> review
reviewer R -> worker_done(approved), task -> done
recovery B -> worker_done(approved), task -> done
```

The last receipt belongs to recovery execution B. It must not replace reviewer
R merely because it is the newest row with `completed_new_status=done`.

## Factory invariant

Acceptance authority belongs to an exact candidate epoch:

```text
producer completion receipt
+ exact candidate artifact ids/types/content hashes
+ separate reviewer completion receipt
= reviewed candidate epoch
```

A later recovery execution has two possible meanings.

### Mechanical retry / no product change

If recovery did not introduce a new exact product version, it is only retrying
the gate. The previously reviewed candidate epoch remains authoritative. The
immutable acceptance decision records the original producer and reviewer
receipts, not the recovery execution.

### Product repair / changed hash

If recovery produced a new content hash, it created a new candidate epoch. The
old review cannot authorize it. The repaired execution must complete to
`review`, and a separate reviewer execution must approve that new epoch.

## Current migration implementation

`SqliteExactCandidateAcceptance` is still a bridge over legacy task-level
`worker_done` receipts. It therefore reconstructs a review epoch rather than
reading the latest receipt:

1. Prefer a `worker_done -> review` receipt from the submitted execution.
2. When the submitted execution is a mechanical recovery retry, find the newest
   prior producer/reviewer epoch that covers the exact candidate hashes.
3. Use the first separate approved reviewer in that epoch.
4. Reject the epoch when a later `changes_requested` supersedes its approval.
5. Persist the selected producer/reviewer command ids and receipt hashes in the
   immutable exact-acceptance decision.
6. Store the actual reviewed producer execution in decision lineage. A recovery
   execution may query/replay the task-level exact decision, but does not become
   its producer.

This is intentionally fail-closed for a changed candidate without a fresh
review.

## Target Conveyor Model

The final Production Cell implementation must remove receipt reconstruction:

```text
WorkerExecution
  -> execution_complete
  -> sealed CandidateSet
  -> Review/GateDecision(subjectCandidateSetRef)
  -> ExactCandidateAcceptance(explicit decision ref)
```

At that point ECA must consume an explicit CandidateSet-bound decision and stop
scanning `command_receipts` for semantic authority.

## Simulator rule

The deterministic Claude CLI simulator is not granted a special path. It calls
the same worker-facing handlers as the real Claude CLI. Therefore:

- a no-op recovery script may call `worker_done` without recreating products;
- runtime must replay the already reviewed exact epoch;
- a script that changes a product hash must enter a new author/reviewer epoch;
- simulator success proves runtime mechanics, not LLM quality.

Any fix that works only when `SAGA_SIM_SCENARIO` is set is invalid.
