# Three Amigos — Collaborative Worker Pattern

**Operator directive:** 2026-08-25. When rate limit > 1, spawn up to 3
concurrent workers with different semantic profiles on the same Workplace.
They negotiate and produce a shared result.

## Concept

Instead of 1 WorkerExecution per task claim, the factory may create a
**collaboration cohort** of 2-3 ActivityAttempts on one Workplace,
each with a different semantic profile (planner/implementer/tester or any
role combination). They share the desk, see each other's contributions
in real time, and their combined material forms one
WorkplaceProductionRevision submitted to the Gate as a single CandidateSet.

## Mapping to EK kernel

| Concept | EK implementation |
|---|---|
| 3 concurrent workers | 3 ActivityAttempts on one Workplace (parallel leases) |
| Different roles | Different CanonicalRoleContracts (same protocolRole=author, different semanticProfiles) |
| Shared desk | Same Workplace aggregate; contributions merge into one revision |
| Negotiation | Each attempt sees the desk's current material (pull model) |
| Shared result | One WorkplaceProductionRevision from combined contributions |
| Gate | One CandidateSet covering the merged revision |

## Why this works architecturally

The partition-invariance theorem (K10, already proven) states:
```
A(X+Y) ≡ chained A(X)→B(Y) ≡ co-presented A(X)+C(Y)
```
Translation: one worker doing everything = sequential workers = parallel
workers contributing to the same desk. The **revision identity is the same**.
The "3 Amigos" pattern is just the co-presented form.

## Implementation notes

1. **Parallel leases:** The Workplace currently allows one active
   ActivityAttempt. Extend to N (bounded by rate limit / 3).
2. **Contribution visibility:** Each attempt reads the desk's current
   material (WorkplaceProductionRevision in-progress state).
3. **No forced synthesis:** The LLM workers coordinate naturally by
   seeing each other's output. No orchestrator needed.
4. **Single submission:** Any one attempt can trigger the seal when
   the material is complete. The gate sees the merged revision.
5. **Budget:** Each attempt consumes its own context budget independently.
   The cumulative workplace budget is shared.

## Where in EK

- **EK-5** (WP-08): Development vertical — first implementation
- **EK-6** (WP-09): Planning — planner cells can use the same pattern
- **EK-8** (WP-11D/F/V/L): All workshop conversions
- **EK-9** (WP-13B): Test scenarios exercise the pattern

## Constraint

Maximum 3 concurrent collaborators per Workplace (the "3 Amigos" cap).
If rate limit is 1, fall back to single worker (current behavior).
If rate limit is 2, allow 2 collaborators. The cap is per-Workplace,
not per-factory (multiple Workplaces can each have their own trio).
