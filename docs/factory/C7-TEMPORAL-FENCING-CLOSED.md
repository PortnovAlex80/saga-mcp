# C7 — Temporal Obligation Fencing: CLOSED

> Scope: **C7 lane only.** The Factory as a whole is **NOT** complete. This note
> marks the C7 lane (transition-obligation temporal fencing) closed by C7-07.
> Owner of the rollup ledger: integrator (this file does not edit
> `COMPLETION-LEDGER.md`).

## What C7 delivered (ADR-053 §"temporal ownership")

The transition-obligation ledger is the durable, fenced, idempotent record that
makes every conveyor handoff (CandidateSet→Gate→Effects→FinalAcceptance→Route)
owned by a monotonic lease generation. The lane landed in seven cards:

| Card | Commit subject theme | Concern |
|---|---|---|
| C7-01 | brands | `CausalSourceRevision` (provenance) ≠ `LeaseFence` (ordering token) — disjoint brands at the seams |
| C7-02 | storage | durable, monotonic `lease_fence` column; MAX-CAS so the stored value never decreases |
| C7-03 | atomic allocate | `allocateLeaseFence` — store-minted, atomic, strictly-increasing under contention |
| C7-04 | fenced complete | completion requires owner + fence; rejects a stale (lower) fence |
| C7-05 | fenced fail/reclaim | failure + lease-loss reclaim fenced symmetrically; distinct markers |
| C7-06 | production cutover | real fences allocated on creation; reclaim wired into the sweep |
| **C7-07** | **temporal proof** | **deterministic end-to-end proof of monotonic temporal fencing; closes C7** |

## C7-07 — the temporal fencing proof

File: `tests/infrastructure/transition-obligation-temporal-fencing.test.mjs`
(worker: `tests/infrastructure/temporal-fencing-worker.mjs`).

The proof is **deterministic**: real concurrency (K `worker_threads`, each with
its own connection to a shared WAL database — the genuine cross-process shape),
but every assertion is on **order-invariant** invariants that the store's write
lock + MAX-based CAS make independent of interleaving. No wall-clock races; no
reliance on the flaky `tests/factory-temporal/*` child-process suite.

Proven outcomes:

1. **Monotonic & distinct under concurrent takeover** — K workers allocating on
   one obligation receive exactly the contiguous strictly-increasing set
   `{seedMax+1 .. seedMax+K·rounds}`; all distinct.
2. **Stale fence cannot act** — a lower fence is rejected for **all three**
   mutating transitions (complete / fail / reclaim) after a newer fence takes
   over; proven concurrently (every attack rejected, zero mutations).
3. **Stored fence never decreases** — across complete / fail / reclaim /
   stale-rejection (sampled non-decreasing over the full lifecycle and under
   concurrent allocation pressure).
4. **Lease-loss ≠ business failure** — reclaim writes `LEASE_LOSS_RECLAIM_MARKER`;
   fail writes the business error; a reader can tell them apart.
5. **Terminal state is immutable** — a converged obligation is never altered by a
   stale **or** current transition; proven concurrently.

Determinism gate: the suite passes identically on every run (3× verified).

## Residual note for the integrator

C7 is self-contained (tests + docs only on this card; production behavior landed
in C7-01..C7-06). Safe to cherry-pick onto the rollup. The flaky
`tests/factory-temporal/*` suite is a pre-existing, out-of-scope condition and is
not touched.
