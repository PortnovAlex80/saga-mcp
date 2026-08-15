# ADR-072: Durable Final Presentation Commitment

- **Status:** Accepted
- **Date:** 2026-08-15
- **Decision-maker:** autonomous-decision skill

## Context

The fresh Python-010 canary reached Development planning and produced a valid,
payload-contract-accepted task graph. `product_submit` durably inserted
`managed-node-submission:10` and told the worker to call `worker_done`. The
model then made optional reads and the provider timed out. Supervision treated
the execution as lost because no `worker_done` receipt existed, launched two
replacement model executions during the provider outage, exhausted the Cell
budget, and paused the run. The accepted immutable product never reached a
CandidateSet or Gate.

This is not a retry-policy defect. It is a missing durable handoff before the
five ADR-053 post-seal obligations: an irrevocably published presentation still
depends on a second best-effort LM command before the kernel may materialize
the Workplace revision. Cynefin classification: **Complicated**.

## Considered options and MCDA

Scores use 1 (poor) through 5 (excellent).

| Driver | Weight | Submit closes immediately | Durable presentation commitment | One-shot recovery worker |
|---|---:|---:|---:|---:|
| authority correctness | 30 | 4 | 5 | 4 |
| crash/replay durability | 25 | 4 | 5 | 3 |
| compatibility/cost | 15 | 4 | 3 | 5 |
| testability | 15 | 4 | 5 | 4 |
| reversibility | 10 | 3 | 4 | 5 |
| extensibility | 5 | 3 | 5 | 3 |
| **weighted total / 500** | | **390** | **465** | **405** |

1. **Submit closes immediately.** Make `product_submit` directly perform the
   task and Workplace transition. Small, but a crash between product storage
   and transition recreates the defect unless an outbox is added, and it does
   not generalize to explicit managed-desk closure.
2. **Durable final-presentation commitment.** Atomically record the exact
   irrevocable typed ProductRef and a sixth transition obligation. One kernel
   close transaction is used by the obligation and explicit `worker_done`.
3. **One-shot recovery worker.** Give one replacement LM execution the prior
   ProductRef and ask it to call `worker_done`. This preserves the old protocol
   but still spends a provider call to transmit no new material and fails
   during provider outages, exactly the incident being repaired.

## Pre-mortem

Assumption: the commitment design shipped and later failed.

1. A partial or mutable desk was inferred as final after process termination.
   Likelihood: medium; mitigation: only an explicit ingress action may create a
   commitment. Terminal observation alone never creates one.
2. `product_submit` committed but its obligation did not. Likelihood: medium;
   mitigation: product, compatibility projection, commitment and obligation
   share one immediate SQLite transaction.
3. Explicit `worker_done` and the obligation raced and transitioned twice.
   Likelihood: high without fencing; mitigation: one idempotent close use case,
   one deterministic completion key and CAS-protected Workplace transition.
4. Reviewer routing differed between explicit and recovered closure.
   Likelihood: medium; mitigation: Production Cell disposition comes from the
   exact verdict product and Gate policy; tool prose/verdict is not material
   authority.
5. A semantic validator rejected after the irrevocable commit and left a live
   but unrepairable execution. Likelihood: low; mitigation: run every pinned
   submission/payload preflight before commitment; later semantic checks remain
   Gate decisions and create a fresh repair presentation.

## Red Team

Red Team vetoed a broad `product exists + process terminal` closure because
`worker_done` currently also freezes managed material, runs preflight and
routes the task. Cardinality alone cannot infer author intent, and managed
artifact/trace desks remain mutable until explicit closure.

The objection is accepted. The chosen design recognizes only an irrevocable
**final presentation commitment**. Current typed ingress is exactly one
immutable submission per execution, so successful pinned-contract validation
can create that commitment. Managed Workplace ingress cannot and continues to
require explicit close. Terminal observation may redrive an existing
commitment; it may never manufacture one.

## Decision

Add a sixth durable handoff:

`final-presentation-committed -> close-presentation`.

For typed Production Cell ingress, the Factory atomically persists the exact
ProductRef, all deterministic compatibility projections, an immutable
Workplace-scoped presentation commitment, and the transition obligation.
After commit it may synchronously attempt the same idempotent kernel handler
that the reconciler will redrive after a crash.

`worker_done` becomes the explicit adapter into the same close use case.
Managed Workplace material is frozen inside that use case before commitment;
typed material is already frozen by `product_submit`. Process exit is physical
drainage. If an exact commitment exists, timeout/exit redrives closure; without
one, existing crash repair remains correct.

## Load-bearing invariants

1. A typed ProductRef and its final-presentation commitment/obligation commit
   together or not at all.
2. Only the frozen WorkIntent schema, payload-contract digest and exact product
   digest authorize a commitment; task/execution IDs are authentication and
   audit coordinates only.
3. Terminal process observation never creates a commitment.
4. Explicit completion and obligation recovery invoke one idempotent close
   transaction and converge to one semantic completion receipt.
5. Closure validates the exact frozen ingress, freezes managed material when
   applicable, transitions the task/fence and Workplace, and leaves Gate as the
   sole semantic acceptance authority.
6. Post-commit tool mutations are rejected. OS drainage may continue but has no
   material authority.
7. Complete committed production does not consume another LM attempt; absent,
   malformed, ambiguous or contract-mismatched production follows normal
   repair.

## Consequences

Positive: provider outages after accepted typed submission cannot discard
material or burn retries; the pre-seal handoff gains the same fenced,
crash-replayable ownership as the five ADR-053 post-seal handoffs; `worker_done`
is no longer a second material authority.

Negative: one additive immutable table and one obligation kind are required;
the dispatcher completion transaction must become an application use case
rather than tool-only logic; managed desks do not gain implicit timeout closure.

The schema change is additive. Existing runs remain readable, but real canaries
must start on a fresh database so no active WorkIntent is reinterpreted.

## Required evidence

- Exact typed submit followed by timeout produces one closure, revision,
  CandidateSet and Gate without a replacement LM execution.
- Crash before the product/commitment transaction yields neither fact; crash
  after it is reconciled exactly once.
- Explicit `worker_done`, synchronous post-submit close and terminal recovery
  converge to the same material and transition outcome.
- Managed artifact/trace write followed by timeout remains repair-required.
- Wrong schema/digest/WorkIntent and rejected payload produce no commitment,
  obligation, CandidateSet or Gate.
- Close-vs-process-exit and close-vs-explicit-done races are idempotent.
- The scripted Docker E2E and fresh Python, TypeScript and Kotlin canaries pass.

## Decision Journal

**Date:** 2026-08-15

**Decision:** Treat an exact, pinned, one-shot typed submission as an
irrevocable final-presentation commitment and route it through a durable
pre-seal obligation; never infer completion merely from process death.

**Ex-ante expectations:**

- No accepted typed product is followed by a replacement LM invocation solely
  because `worker_done` was not observed.
- Every committed presentation has exactly one nonterminal or completed close
  obligation until a CandidateSet exists.
- Provider timeout timing cannot change the resulting revision/CandidateSet.

**Check trigger:** any run with an accepted typed submission and no downstream
CandidateSet, or any managed desk accepted solely because its process exited.

**What would change my mind:** evidence that typed ingress needs multiple
independently mutable submissions; that requires an explicit atomic batch
commit contract, not cardinality inference.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-067](067-single-productref-ingress-before-revision.md)
- [ADR-070](070-post-integration-readiness-certification-cell.md)
