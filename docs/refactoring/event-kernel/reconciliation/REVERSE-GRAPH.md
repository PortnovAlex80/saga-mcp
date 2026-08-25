# REVERSE-GRAPH.md — WP-03 reverse derivation of the target protocol

- **Work package:** WP-03 (EK-1, "Transition and claim specification")
- **Deliverable:** `docs/refactoring/event-kernel/reverse-graph.json` (this file is its narrative)
- **Base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
- **Branch:** `ek1/wp03-reverse-graph`
- **Status:** frozen draft for coordinator reconciliation

## Method

This graph was derived **backward only**, from terminal claims and the evidence
each claim requires, per the reverse-graph law in the greenfield plan
("Non-negotiable architecture laws > Planning and idea conservation"):

> A separate reverse graph is derived from terminal claims, required evidence
> and effect receipts. … Neither derivation may read the other's output before
> both are frozen.

Concrete procedure:

1. **Enumerate the terminal-claim universe.** The target model defines
   `TerminalProof` as "Success, truthful failure, cancellation or unreachable
   proof for one exact scope". Scopes and owners were taken from the target
   relation table (`FactoryRun`, `LifecycleRun`, `StageRun`, `ProcessRun`,
   `NodeRun`, `Workplace` for both the cell material chain and the
   author/reviewer/repair loop) plus the ADR-053 production-cell chain
   (`Factory → Workshop → Production Cell → Workplace → CandidateSet → Gate →
   Effect`). Result: **7 scopes × 4 kinds = 28 terminal proofs**.
2. **For each proof, walk the required evidence backward** using exactly three
   authority sources: the plan (laws, target model, EK-4/EK-5/EK-6/EK-9/EK-11/
   EK-12 phase requirements), ADR-097 (decision rules 1–8, dependency-readiness
   predicate, unreachable/settlement semantics), and ADR-053 (accepted-material
   chain, obligation chain, authority conservation, `AcceptedCandidateAuthority`).
   Every edge carries `derivedFrom` citing its tightest source(s); the full
   source list with sections is in the JSON `derivedFrom` array.
3. **Continue recursively until every leaf is either** an immutable planning
   fact (WorkItem / dependency / claim / unknown / seam coverage), an immutable
   installed-manifest value (CheckPlan, CanonicalRoleContract), a durable
   protocol obligation/wait, or an external-input receipt (capsule ingress,
   operator command, wake discharge) — i.e. facts whose own required evidence is
   outside the workflow protocol or is another terminal proof (predecessor
   references for unreachable).
4. **Record honesty gaps immediately** wherever the walk hits a fact the source
   text does not freeze (see Gap list). No gap was papered over with an invented
   evidence kind; the edge is either omitted, included with a `gap` flag, or the
   proof's closure is marked incomplete.

**Nothing in this graph is derived from command or input structure.** No
dispatcher, no scheduler, no ingress command, no forward reachability was
consulted. Edge direction is uniformly `proof/evidence REQUIRES fact`, and
`ownedBy` names the single owner of the **required** fact (one fact, one owner,
one linearization point — ADR-097 rule 1).

**Privacy statement:** WP-02's worktree/output was never read, searched or
referenced; the legacy graphs under `docs/factory-map/` (including
`FORWARD_GRAPH.md`, `GRAPH_RECONCILIATION.md` and the legacy reverse graph) were
deliberately not opened. Sources are exactly those in the JSON `derivedFrom`
array.

## The backbone (longest backward chains)

**Cell success** (the ADR-053 accepted-material chain, deepest closure):

```
TerminalProof:cell.success
  <- CellFinalAcceptance
     <- GateDecision:accepted  (every gate over the final CandidateSet)
        <- CandidateSet:author | :reviewer  (reviewer binds subject author candidate)
           <- WorkplaceProductionRevision  (sealed: materialMembers, contributingExecutionRefs, digests)
              <- ActivityAttemptContribution
                 <- ActivityAttempt:completed
                    <- WorkIntent
                       <- WorkItem <- WorkItemObligationMapping <- TransitionObligation
                       <- CanonicalRoleContractBinding (pinned ref+digest, manifest-verified)
                       <- InputEvidenceRefs
                    <- PromptAssemblyReceipt:admitted/:refused (unbroken per-request sequence)
                    <- ProviderSendOutcome <- provider-send TransitionObligation
                    <- ProviderRoutePin
     <- EffectReceipt:success | :already-applied  (every declared effect, idempotent)
        <- AcceptedCandidateAuthority
           <- GateDecision:accepted + CandidateSet:author (authority conservation)
     <- ObligationCompletionReceipt (RecordFinalAcceptance, same transaction)
```

**Planning claims** (reverse from terminal lifecycle claims — the
idea-conservation law made graph-shaped):

```
TerminalProof:lifecycle.success
  <- ExecutableVerifierResult  <- TerminalLifecycleClaim + ConstructionSurface
     <- WorkItem
        <- TerminalClaimCoverage
           <- EpicScopeCoverage <- DeferredScopeEntry (owner + reason)
           <- DiscoveryUnknownObligation (every unknown owned)
           <- QualitativeRequirementDisposition
           <- SeamOwnership (every seam/test/integration surface owned)
  <- LifecycleRoutingReceipt (RouteLifecycle obligations)
  <- TerminalProof:stage.success <- TerminalProof:process.success
     <- TerminalProof:node.success
        <- TerminalProof:workplace.success <- CellFinalAcceptance
        <- WorkItemDependency + predecessor CellFinalAcceptance/EffectReceipt
           (readiness is a predicate over exact predecessor evidence — ADR-097)
```

**Run success** (FactoryRun final run proof):

```
TerminalProof:run.success
  <- TerminalProof:lifecycle.success
  <- ProductVerificationEvidence (install/build/test/start, API/CLI/browser smoke)
  <- EffectReceipt:success (local Delivery/package receipts)
  <- CapsuleIngressReceipt (capsule/certificate/requirements/claims/AC/package/build/repo digests)
  <- ContextEnvelopeComplianceEvidence (every attempt: pinned role digest + unbroken receipts)
  <- ForwardReverseReconciliationReceipt (idea/scope/unknown/terminal-claim equality)
  <- TerminalClaimCoverage
```

**Failure / cancellation / unreachable** (uniform shape at every scope):

- truthful failure ← the deepest rejecting evidence (`GateDecision:terminal-reject`
  or `EffectReceipt:policy-terminal`) — gap G1 on the terminality predicate;
- cancellation ← durable `OperatorStopCommand` + `TypedWaitDisposition`
  (+ `ActivityAttempt:cancelled` at workplace scope) — gap G6 on propagation shape;
- unreachable ← exact predecessor `TerminalProof:<scope>.failure|cancellation`
  reference + `SettlementWorkObligation` (dependants never pend behind a dead
  wake source) — gap G2 on run-scope triggers.

**Supporting closures:** obligation completion (receipt only in the target
fact's transaction, CAS lease+fence, idempotent); TypedWait discharge
(human-response command; external-availability and policy/quota kinds flagged
G3); effect idempotency (`already-applied` requires a prior `success` with the
same idempotency key); effect uncertainty (`unknown` requires send/outcome
evidence; the resolver evidence is gap G4).

## Per-scope proof counts and closure status

| Scope | Owner aggregate | success | failure | cancellation | unreachable | Root edges | Closure status |
|---|---|---:|---:|---:|---:|---:|---|
| cell | Workplace (production-cell material chain) | 1 | 1 | 1 | 1 | 7 | failure flagged G1 |
| workplace | Workplace (author/reviewer/repair loop) | 1 | 1 | 1 | 1 | 9 | failure flagged G1 |
| node | NodeRun | 1 | 1 | 1 | 1 | 9 | complete |
| process | ProcessRun | 1 | 1 | 1 | 1 | 7 | complete |
| stage | StageRun | 1 | 1 | 1 | 1 | 7 | complete (fan-in membership G7 applies to all settlement scopes) |
| lifecycle | LifecycleRun | 1 | 1 | 1 | 1 | 8 | success flagged G8 (verifier receipt kind) |
| run | FactoryRun | 1 | 1 | 1 | 1 | 13 | cancellation flagged G6; unreachable flagged G2 |
| **Total** | | **7** | **7** | **7** | **7** | **60** | **23 complete, 5 gap-flagged, 0 open** |

Totals: **88 nodes** (28 terminal proofs + 60 evidence kinds), **112 edges**,
**8 gaps**. Every terminal proof has a backward closure — none terminates
without either reaching immutable facts/obligations/external receipts or
hitting a named gap.

## Gap list (honest underspecifications in the current plan text)

These are claims whose required evidence the plan text does not fully freeze.
Each is a repair request for EK-1, never an accepted warning.

1. **G1 — truthful-failure terminality predicate (cell, workplace).** What
   proves "no lawful repair transition remains" is unnamed; the closure stops
   at the rejecting `GateDecision:terminal-reject` / `EffectReceipt:policy-terminal`
   without a terminality fact. (EK-4/EK-6/EK-1-claim-spec checked.)
2. **G2 — run-scope unreachable triggers.** No in-run predicate exists;
   ingress/protocol refusals are pre-run. The two `TerminalProof:run.unreachable`
   edges are best-effort and flagged.
3. **G3 — wake-discharge evidence kinds** for external-availability and
   policy/quota waits (human-input discharge is clearly a typed command).
4. **G4 — effect-uncertainty resolution evidence** (what receipt closes an
   `EffectReceipt:unknown`; idempotency-probe receipt is not named).
5. **G5 — `CellFinalAcceptance` field set** (whether it embeds
   `acceptanceDigest` and digest equality with the accepted revision).
6. **G6 — cancellation propagation shape** (per-member cancellation proofs vs
   one proof naming member dispositions; lease disposition across scopes).
7. **G7 — settlement fan-in membership** (workplaces-per-node,
   nodes-per-process, processes-per-stage, stages-per-lifecycle is implied by
   the relation set and the WP scope ladder, not frozen in plan text; stage
   edges are pattern-inferred).
8. **G8 — verifier/CheckPlan receipt kinds** (what an executable verifier
   emits; whether CheckPlan instances are manifest content or per-decision
   evidence) — affects `ownedBy`, not topology.

## Reconciliation notes for the coordinator

- Node identity for reconciliation is the typed `id` (`Relation:variant`);
  `ownedBy` discrepancies on the flagged nodes (G5, G8) are expected to be
  resolved by EK-1 freezes, not by graph edits.
- The `eventCoRequisite` convention (every fact commits with its exact
   `WorkflowEvent`) is a per-edge invariant, not a duplicated edge per fact;
  if the forward derivation materializes it as explicit edges, reconcile by
  convention, not by adding 112 edges here.
- Universally quantified edges carry `quantifier` ("every member/effect/gate");
  typed edge equality should compare ids plus quantifier presence.
- Physical name freezing (EK-1) may rename nodes without changing the typed
  sets; this draft is logical only.
