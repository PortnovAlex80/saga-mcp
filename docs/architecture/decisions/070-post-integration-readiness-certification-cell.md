# ADR-070: Post-integration Readiness Certification Cell

- **Status:** Accepted
- **Date:** 2026-08-15
- **Supersedes:** ADR-069
- **Superseded by:** —
- **Decision-maker:** autonomous-decision skill

## Context

The first strict Python canary after ADR-069 completed Discovery,
Formalization, Planning, both implementation Cells, both Git effects and every
durable transition obligation. Development then failed at candidate freeze.
Two valid scoped implementation products declared different local evidence:
the data-model item was `static` with a unit-test command, while the final API
item was `served` with install, full-test and start commands. ADR-069 required
all item-local profiles to be identical and therefore rejected lawful material.

This is the explicit change-of-mind trigger recorded by ADR-069: profile
disagreement caused by scoped workers. Candidate-wide readiness is not owned by
an implementation execution or task partition. It is a property of the exact
post-integration source candidate. Cynefin classification: **Complicated**.

## Decision drivers and MCDA

| Driver | Weight | Graph owner | Certification Cell |
|---|---:|---:|---:|
| authority correctness | 30 | 4 | 5 |
| partition/topology invariance | 20 | 3 | 5 |
| repair liveness | 15 | 3 | 5 |
| implementation cost | 10 | 5 | 2 |
| extensibility | 10 | 2 | 5 |
| testability | 10 | 4 | 5 |
| reversibility | 5 | 5 | 4 |
| **weighted total / 500** | | **365** | **450** |

Red Team found a correctness veto in the cheaper graph-owner option: making a
selected implementation item a transitive sink either rejects a lawful
antichain or adds fake `dependsOnKeys`. Those edges are production authority:
they serialize admission and change effective Git bases. A pure assembly item
cannot satisfy the current implementation contract without a fake code change.

## Decision

Split Development's freeze into two exact authority steps:

1. `freeze-integrated-source` freezes repository commits, trees, build products,
   implementation workset and Git effect receipts. It contains no run profile.
2. A singleton `certify-product-readiness` Production Cell receives that exact
   source ProductRef and produces a typed `ReadinessManifest` with stable target
   keys and explicit install/test/start/environment declarations.
3. Its final Gate runs the factory-owned local-runnability provider against the
   exact source tree and manifest. Failed commands repair this Workplace; no
   acceptance-verification fan-out exists yet.
4. `bind-runnable-candidate` consumes only the accepted manifest CandidateSet,
   its exact passed CheckReceipt and the source ProductRef, then emits the
   immutable `IntegratedReleaseCandidate` used by verification and settlement.

Implementation-result readiness is non-authoritative item-local evidence. It
cannot vote, veto, or select the candidate-wide contract.

## Load-bearing invariants

1. Source ProductRef/digest/tree equals manifest subject, readiness receipt
   subject, runnable candidate source and verification subject.
2. Required target keys equal the manifest and passed receipts; missing,
   duplicate or extra targets fail closed.
3. Commands, environment, provider and policy are content-addressed; drift
   requires a new Gate and receipt.
4. Task, execution, presenter and arrival order are audit only.
5. Certification failure creates no runnable candidate and no verification
   Workplaces.
6. Consumers never fall back to implementation profiles or filename inference.

## Pre-mortem and mitigations

- Invented commands are executed by the deterministic Gate on the sealed tree
  and failures return to the readiness Cell.
- A manifest naming another source is rejected by exact ProductRef checks.
- V1 supports one required target and fails closed otherwise; stable target keys
  permit a later multi-service version without changing ownership.
- Crash after check/before bind replays immutable receipts and durable
  transition obligations to one candidate.
- The new module/payload versions leave old installed runs readable.

## Required release evidence

- The Python incident fixture (`static/unit` plus `served/full-test`) freezes the
  source, certifies the served target and starts verification.
- Completion order and execution/task/presentation aliases do not change
  source, manifest, receipt or runnable-candidate identity.
- Wrong source/tree/receipt and malformed commands create no runnable candidate.
- Crash/restart at every source/Cell/receipt/bind transition converges once.
- Scripted Docker E2E passes, then fresh sequential Python, TypeScript and
  Kotlin GLM canaries pass.

## References

- [ADR-053](053-workplace-production-revision-as-accepted-material-authority.md)
- [ADR-058](058-local-runnability-before-human-acceptance.md)
- [ADR-067](067-single-productref-ingress-before-revision.md)
- [ADR-069](069-readiness-profile-is-an-implementation-submission-contract.md)
