# Factory Temporal and Dual-Cycle Testing

Status: normative supplement to `TESTING-STRATEGY.md`  
Decision: ADR-048 and ADR-049

## Testing ladder

A lower layer cannot substitute for a higher one:

1. Contract/schema closure.
2. Pure local reducer transitions.
3. SQLite CAS, idempotency, fencing and terminal immutability.
4. Canonical-composition temporal progress with deterministic workers.
5. Fault schedules at worker, CandidateSet, Gate, effect and routing boundaries.
6. A clean Product Build E2E, followed by a monitored real-model canary.

## Scripted worker equivalence

Scripted workers are fully conforming only when they replace model inference
behind the production runner. They receive the production WorkIntent,
execution fence, package/profile, RepositoryDesk, prompt and MCP tool allowlist,
then finish through normal product submission and `worker_done`.

A test-specific `WorkerExecutorFactory` remains a useful faster double, but it
must not be described as production-host equivalence because it replaces
workspace, spawn and process-host physics in addition to inference.

## Workshop movement

Cross-workshop conformance observes and hash-checks every handoff:

```text
Discovery -> Formalization -> Development -> runnable-local
```

Product Build creates no Delivery/DevOps ProcessRun and waits for no human
approval. Human acceptance begins only after the exact frozen candidate is
started locally.

## Dual-cycle conformance

The two synchronized work cycles are tested separately and jointly:

- semantic Kanban phase (`todo`, authoring, review, terminal projection);
- engine/Workplace loop (`idle`, `queued`, `leased`, `running`, `verifying`,
  `effect_pending`, `repair_wait`, `paused`, `terminal`).

Generated shadow-model traces explore their legal cross-product, worker fences,
admission limits, repairs and terminal monotonicity. Differential tests compare
selected traces with production reducers/SQLite. The canonical temporal suite
remains the authority for real wiring and scheduling.

## Non-vacuity

A dependency test with zero durable edges is a failed fixture, not a green or
skipped proof. It must show that a dependent is not reserved before the
predecessor is finally accepted and its required integration/effect is settled.

A concurrency test must state whether it proves only an upper bound or actually
observes the requested width. The protected GLM-4.7 canary requires an effective
limit of two and rejects any durable active-execution count above two.

## Commands

```text
npm run test:factory-model
npm run test:factory-temporal
```
