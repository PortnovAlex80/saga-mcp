# ADR-045: Product revisions, Change Requests, and the DevOps split

- Status: accepted
- Date: 2026-08-10
- Supersedes: ADR-044 as the default MVP start path (ADR-044 remains valid for legacy release continuations)

## Context

The MVP factory is expected to autonomously produce a committed, verified,
locally runnable product. Deployment does not exist yet. Stopping every normal
order at `approval-required` conflates product construction with release
authority. Human evaluation happens after the factory finishes and becomes a
new request for change.

## Decision drivers

- terminal history and accepted products are immutable;
- no human approval is required to finish a local MVP product;
- `ready-to-run` must be machine-observed, not an LM assertion;
- deployment remains an independently authorized external effect;
- subsequent changes reuse exact artifacts and repository lineage without
  treating old decisions as current authority;
- runtime machinery remains module/request-kind neutral.

## Options and MCDA

Weights: authority/correctness 30, conveyor alignment 25, change-lineage 20,
delivery speed 15, reversibility 10.

| Option | Authority | Alignment | Lineage | Speed | Reversibility | Weighted / 500 |
|---|---:|---:|---:|---:|---:|---:|
| Keep Delivery; make local readiness an automatic release | 2 | 2 | 3 | 5 | 3 | 280 |
| Three-stage build + loose ReadyProduct projection | 3 | 4 | 3 | 5 | 5 | 375 |
| FactoryRequest + finalized ProductRevision; separate Deployment | 5 | 5 | 5 | 3 | 4 | 460 |

## Decision

Introduce an immutable `FactoryRequest` envelope and `ProductRevision` lineage.
The default new-product lifecycle constructs a product and terminates only after
a Factory-owned finalization effect and exact RunReceipt:

```text
new-product/change request
  -> Discovery
  -> Formalization
  -> Development (managed source, review, staging integration, verification)
  -> immutable product ref + machine RunReceipt
  -> ProductRevision
  -> ready-to-run
```

Delivery/Release becomes a separate future DevOps request consuming an exact
ProductRevision. It retains approval, publication, observation and deployment
semantics. Product construction never fabricates a ReleaseRecord.

A human finding after running the program creates a new `change` FactoryRequest
and a new FactoryOrder in the same Project. It pins the exact baseline revision
and creates fresh run/stage/process/workplace/gate identities. Prior artifacts
and code are immutable evidence; compatible production may replay only through
current CandidateSets and current gates. The resulting revision links its exact
parent revision. Concurrent changes from one parent require expected-parent CAS;
a stale result becomes `rebase-required`, never implicit latest-wins.

The first delivery slice is versioned and additive. Legacy
`product-delivery@1.0.0` runs remain readable and resumable under their pinned
definition. No old `approval-required` outcome is rewritten.

## Required authority objects

- `factory.order-request.v1`: request kind (`new-product|change|release`), exact
  payload/hash, project, actor, optional baseline revision.
- `factory.product-revision.v1`: request/order/run lineage, predecessor refs,
  Formalization and Development certificates, verified bundle/candidate,
  repository commit/tree, final immutable product ref, RunContract/RunReceipt,
  limitations, and revision hash.
- `factory.change-request.v1`: human feedback/delta intent bound to one baseline
  ProductRevision.
- future `factory.deployment-request.v1`: exact revision + environment/policy.

## Pre-mortem and mitigations

1. **“Ready” product does not start.** Require a typed RunContract and a
   deterministic successful RunReceipt bound to candidate commit/tree.
2. **Unverified code becomes canonical.** Treat integration as staging; create
   the immutable ready ref only after verification and observe it idempotently.
3. **Change silently loses old behavior.** Formalization must produce delta,
   retained/superseded requirements, impact scope and regression obligations.
4. **Parallel changes overwrite each other.** Every revision pins a parent and
   activates by expected-parent CAS.
5. **Old authority is laundered.** Baseline products are inputs only; all
   affected acceptance decisions are current-run decisions.
6. **Deployment semantics leak back into build.** Product-build creates no
   approval request, ReleaseRecord, publication or deployment EffectAttempt.

Red-team identified that the existing normal Development path still grants the
LM task-branch Git authority and integrates before final verification. The
decision therefore includes managed-source as the target default and a
post-verification Factory finalization receipt; these are release blockers for
claiming the stronger `ready-to-run` outcome.

## Consequences

Product creation, modification and deployment become three explicit business
intents sharing one conveyor grammar. The model may repeat cognitive work only
when the new request changes its semantic input; accepted history is never
reopened. The implementation is larger than simply skipping Delivery, but it
avoids a second migration when Change Requests and DevOps arrive.

## Decision journal

- **Expectation (30 days):** ordinary MVP orders create no Delivery approval or
  publication rows; every ready revision has one exact machine RunReceipt.
- **Expectation (90 days):** a Change Request can produce R2 from R1 in the same
  Project while R1 remains fully queryable and Git ancestry proves descent.
- **Check trigger:** first green `new-product -> ready-to-run -> change ->
  ready-to-run` scripted E2E and first monitored real-model E2E.
