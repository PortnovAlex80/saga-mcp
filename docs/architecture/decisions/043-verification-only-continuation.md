# ADR-043: Verification-only continuation from an adopted candidate

Date: 2026-08-10  
Status: accepted

## Context

LifecycleRun 6 stopped after Development production had already been accepted,
integrated and frozen. Its repository subject is commit
`805c95e89a1be1b6cb0c1661411ca2d588988e8f`, tree
`cce17b2cd9539cb5750694a62f6d544e15a88349`, candidate hash
`8e0884d6868ee52abad225d5f73a2356317d6a7821741ce4168e85eba763e9ab`.
The failure was in verification authority: LM-authored observations were not
independent executable evidence. Re-running Discovery, Formalization,
planning, implementation, review, Git integration or candidate freezing would
discard valid factory production and spend model calls without changing the
verification subject.

Normal resume cannot reopen a terminal lifecycle. The existing full
Development continuation is also unsafe here: without an eligible author
carry-forward receipt it would hire a new implementation author.

## Decision drivers

- Terminal lifecycle, stage and process records remain immutable.
- No accepted upstream workshop or accepted implementation is repeated.
- Old LM verification claims never become current acceptance authority.
- Recovery uses the existing lifecycle-continuation and Production Cell
  grammar; universal runtime code must not branch on Development.
- The current Formalization verification methods, not Run 6's lossy verifier
  projection, define the obligations.
- The recovery is fail-closed, idempotent and reversible before launch.

## Options considered

Weights: authority and terminal purity 25, production preservation 20,
universal conveyor fit 20, time to safe restart 15, testability 10,
reversibility 10. Scores are 1-5; totals are out of 500.

| Option | Authority | Preservation | Conveyor fit | Restart | Tests | Reversible | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A. Versioned verification-only module + exact candidate adoption | 5 | 5 | 4 | 4 | 5 | 5 | 460 |
| B. Generic process-prefix recovery epoch | 5 | 5 | 5 | 2 | 3 | 3 | 410 |
| C. Carry old verifier products through authorized presentation | 3 | 5 | 4 | 5 | 4 | 5 | 415 |

Option B is the strongest strategic generalization but expands the generic
flow executor, product-frame union and recovery lineage during a live
incident. Option C is fast, but carrying old verifier products risks semantic
laundering and is unnecessary: the executable providers can inspect the exact
adopted candidate directly. Option A is selected as the smallest
authority-complete vertical.

## Decision

Create a new append-only child LifecycleRun from Run 6. It inherits the exact
certified Discovery and Formalization prefix and executes a new pinned
`solution-development-verification-continuation` module followed by the normal
Delivery stage.

The Development suffix is:

```text
adopt-verification-baseline
  -> verify-acceptance
  -> settle-development
  -> Delivery
```

It contains no planning, graph-resolution, implementation, implementation
review, Git integration or candidate-freeze node.

The package consumes a single-use immutable verification-baseline adoption.
The adoption binds the source lifecycle/stage/process and package digests,
task graph, reconstructed implementation workset, implementation
CandidateSets and final decisions, successful CellFinalAcceptance and effect
receipts, integrated candidate payload/hash, repository commit/tree, accepted
AC identities/hashes, and current repository observation. It establishes only
the immutable verification subject; it does not assert that the subject is
verified.

The verification method plan is reconstructed as a new current, hash-pinned
contract from the exact accepted Formalization artifacts/certificate. Run 6's
old verification tasks, products, CandidateSets and GateDecisions are excluded.
Fresh provider receipts bind the adopted candidate, obligation, accepted AC,
method plan, provider and environment. ADR-042 remains authoritative: LM
assessment is advisory; executable or authorized-observer receipts determine
the outcome.

The module is a versioned domain package over generic runtime ports. Core
continuation, ProductFrame, gate and settlement machinery must not contain a
module-name, stage-id, task-kind or Git-specific recovery branch. If the
implementation cannot consume the adoption through a generic immutable
authorized-product presentation/input port, launch is forbidden.

## Recovery preconditions

- Run 6 is still the unique terminal order leaf and has no active lease or
  worker.
- `dev`, commit and tree match the frozen candidate exactly.
- Every adopted ProductRef, digest, CandidateSet, final decision,
  CellFinalAcceptance and effect receipt re-resolves exactly.
- Parent and child package/schema/payload-contract compatibility is explicit
  and digest-pinned; `latest` lookup is forbidden.
- The method plan covers every accepted AC obligation exactly, including
  manual and screen-reader methods.
- Preflight proves zero upstream, planner, implementation, review and Git
  effect executions.

## Premortem and mitigations

- **The old incomplete verification graph is reused.** Rebuild the current
  method plan from accepted Formalization and compare complete obligation
  coverage before materialization.
- **Commit identity is mistaken for correctness.** Adoption binds the entire
  accepted implementation and integration proof chain but grants no
  verification verdict.
- **Repository or package drifts after authorization.** Re-observe and
  re-hash at consumption and immediately before settlement; drift blocks.
- **Old LM authority leaks into the child.** New Workplaces, gates, receipts
  and decisions only; source verifier rows are explicitly ineligible.
- **A dedicated module becomes a fifth runtime.** Static architecture tests
  reject Development-specific branches in universal continuation, executor,
  gate and presentation code.
- **Manual capability is unavailable.** The line pauses as human-required;
  it never fabricates success.
- **Delivery cannot consume the result.** The suffix must emit the standard
  verified integration bundle and certificate, proven by an end-to-end test.

## Required fitness tests

1. Runs 1-6 remain byte-identical; the child creates no inherited StageRuns.
2. The child has zero planner, implementation, reviewer, merge and freeze
   executions and effects.
3. Adoption rejects every source/hash/receipt/head/tree/package/AC drift.
4. No old verification CandidateSet or GateDecision can satisfy a child gate.
5. Method-plan coverage is exact; missing, duplicate or unsupported methods
   block before acceptance.
6. Provider receipts bind the same candidate and current AC/method hashes;
   partial, inactive or unbound providers fail closed.
7. Crash/replay at authorization, consumption and receipt boundaries is
   idempotent and creates one active order leaf.
8. A real browser/storage/DOM fixture and authorized-observer fixture exercise
   the same WorkIntent, tool and receipt contracts as real operation.
9. The standard Delivery route consumes the new certificate and reaches its
   declared terminal outcome.

## Consequences

The recovery repeats only the invalid inspection and downstream settlement.
It adds a versioned Development package and immutable adoption record, but no
new scheduler or workshop-specific runtime. The more general process-prefix
recovery epoch remains a future platform option; this incident does not need
that blast radius.

After a child is created it is never deleted or collapsed into Run 6. A failed
child remains evidence and a later recovery is another append-only child.

## Decision Journal

- **2026-08-10 — Trigger:** dry-run of full Development continuation reported
  no eligible author carry-forward and would have repeated accepted code.
- **Cynefin:** complex; recovery authority, external effects and verification
  fidelity interact and required parallel option probes plus red-team review.
- **Assumptions:** source refs remain resolvable; repository head is unchanged;
  the lifecycle continuation chain supports Run 6 as the latest leaf.
- **Evidence that would reverse this decision:** adoption proof cannot be
  reconstructed exactly, package compatibility cannot be pinned, or the
  accepted Formalization method plan cannot be recovered without changing its
  semantics. In that case remain stopped and use a broader process-prefix
  continuation or a fresh Development attempt; never infer missing authority.
- **Review trigger:** after the clean-room second factory run, assess whether
  the generic process-prefix epoch should replace this bounded package.

