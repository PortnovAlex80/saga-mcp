# Conveyor Transition and Fault Checklist — event-projected kernel (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). The transition + fault
> checklist for the target protocol. Use it top-down, evaluating all
> applicable conditions at the current landmark in one consistent snapshot;
> rank the earliest root unmet invariant; do not run downstream checks whose
> prerequisites are unknown. Every condition is
> `met | unmet | unknown | not_applicable`. Record identifiers and digests,
> never only prose.
> Companions: `WORKFLOW-KERNEL.md` (vocabulary),
> `CONVEYOR-TRANSITION-DIAGNOSTICS.md` (the "why not advanced" walk).

## A. Protocol, run and ingress boundary

- [ ] `ProtocolMetadata` exists with the exact supported protocol identifier
      and schema fingerprint; otherwise the database is refused with
      `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` and was **not mutated**.
- [ ] The database path was empty at bootstrap; no migration, adoption,
      backfill, dual read or dual write path exists anywhere in the process.
- [ ] `FactoryRun` resolves to exactly one active run for the identity; pinned
      build/package/capsule digests match the launched kit.
- [ ] Capsule import went through public ingress
      (`factoryRun.importCapsule` → `CapsuleIngressReceipt` with verified
      digests); capsule bytes were never applied as authority rows directly.
- [ ] Continuation lineage is append-only: the failed parent is visible, one
      active leaf carries authority, inherited stages appear only as immutable
      prefix descriptors.

## B. Planning and dependency readiness

- [ ] `WorkItem`s and `WorkItemDependency` edges are immutable planning facts;
      no mutable board status exists on them.
- [ ] Epic scope equality holds: covered claims + explicit `DeferredScopeEntry`
      items (with owner and reason) = declared scope.
- [ ] Terminal-claim equality holds: owned + verifiable = required; every
      claim has a `ConstructionSurface` and an executable verifier.
- [ ] Every open unknown is a durable `DiscoveryUnknownObligation` with an
      owner (D10); qualitative requirements are parameterized or explicitly
      deferred.
- [ ] Forward and reverse observed graphs (from committed events/evidence)
      reconcile exactly with the independently declared protocol graphs
      (`ForwardReverseReconciliationReceipt`); a non-empty difference is a
      repair request, not a warning.
- [ ] No cyclic, jointly unsatisfiable, homeless or zero-obligation planning
      graph was accepted.

## C. Aggregate transition mechanics

- [ ] The transition names its owner, command, event, obligations and proofs —
      all five, from the frozen universe vocabulary.
- [ ] The command carried the expected revision; the CAS succeeded or was
      refused with a typed reason; no "latest wins" fallback exists.
- [ ] Facts, `WorkflowEvent`, next obligations/waits/proofs committed in one
      transaction; a failed transaction left neither fact nor orphan
      obligation.
- [ ] Idempotency: replaying the command key cannot create a second fact or
      effect.
- [ ] The write-time progress invariant holds: the nonterminal scope now has
      a runnable obligation, a typed wait with a durable wake source, or a
      same-transaction successor.
- [ ] No workshop-name branch was introduced in the kernel, driver or
      reconciler.

## D. Obligation consumer and fault rules

- [ ] The obligation was leased by CAS with a fence; two consumers cannot own
      one obligation; a stale consumer cannot complete after its fence is
      lost.
- [ ] Completion happened only in the transaction that committed the target
      result and next progress witness.
- [ ] Retrying the same obligation is idempotent (exactly-once logical
      outcome after crash/restart at any fault point).
- [ ] Fan-out created explicit obligations; fan-in checked exact predecessor
      `CellFinalAcceptance`/`EffectReceipt` evidence.
- [ ] A terminally failed predecessor produced
      `obligation:markDependantsUnreachable` settlement work; no dependant
      remains pending on a dead wake source.
- [ ] Watchdogs observed and issued commands only (`factoryRun.observeWatchdog`
      evidence, D9); no watchdog or recovery tool wrote SQL directly.

## E. Workplace and the material chain (ADR-053)

- [ ] `WorkIntent` pinned the exact role-contract reference + digest;
      `activityAttempt.create` copied it from the exact WorkIntent and
      atomically verified equality, package digest, protocolRole and current
      Workplace transition.
- [ ] The attempt is provenance only: accepted material authority is the
      `WorkplaceProductionRevision` chain; nothing selects "latest attempt
      output" as material.
- [ ] Contribution → sealed revision → `CandidateSet` (role-correct, bound to
      one revision) → `CheckPlan` receipts → `GateDecision` over the exact
      CandidateSet: each step's distinct fact is present and typed.
- [ ] Only gate `accepted` progresses; `repair` / `upstream-repair` /
      `human-wait` / `terminal-reject` take their explicit typed branches.
- [ ] Required acceptance effects have successful `EffectReceipt`s **before**
      `CellFinalAcceptance`; an effectful cell was not terminalized
      `effect_pending`.
- [ ] `CellFinalAcceptance` embeds its acceptance digest with digest equality
      (D11).
- [ ] Reviewer work cannot shadow author budget/identity; repair stays a
      transition (repair epoch rollover / authority widening), not a role.

## F. Context admission and provider sends

- [ ] Every provider request was admitted by
      `activityAttempt.admitProviderRequest` at the correct linearization
      point (immediately before final serialization/network send, after all
      hooks/tool results/additional context).
- [ ] The `PromptAssemblyReceipt` sequence for the attempt is unbroken:
      ordinals are consecutive, each receipt is `admitted` or `refused`
      (never `sent`), and cumulative counters advanced by CAS only.
- [ ] Refusals persisted the rejected-envelope digest without consuming
      context or worker-retry budget, and the identical request was not
      reissued.
- [ ] Oversized hook `additionalContext` or tool results appear in the exact
      next pre-send receipt and were refused before the network when the
      envelope was exceeded.
- [ ] Two concurrent admissions at one `contextRevision` produce exactly one
      CAS success and one stale typed refusal.
- [ ] Provider/model selection came from the pinned `executorRoutePolicyRef`
      (evaluated once, pinned as `ProviderRoutePin`); no downstream component
      reselected the route; no fallback to task status/tags/tracker state.
- [ ] The transport enforces `maxOutputTokens <= reservedOutputTokens`; hook-
      originated provider calls outside the accounted transport do not exist.
- [ ] A crash before send redrives the same obligation and ordinal; a crash
      after a non-idempotent send became typed uncertainty (D12), never a
      duplicate.

## G. Settlement, proofs and effects

- [ ] Terminal proofs match their exact evidence closure per scope and kind
      (see Diagnostics §6); an empty queue was never used as a proof.
- [ ] Truthful failure is backed by repair-epoch exhaustion +
      `RepairTerminalityEvidence` (D6).
- [ ] Cancellation proofs name member dispositions (D3); unreachable proofs
      exist only at cell/workplace/node scope (D7).
- [ ] Effect results use the seven typed kinds (D2); `unknown` waits for
      operator disposition; `already-applied` proves idempotency held.
- [ ] Settlement references only accepted outputs; lifecycle routing is
      idempotent (`LifecycleRoutingReceipt`, `ProcessOutcomeCertificate`).
- [ ] `lifecycleRun.verifyTerminalClaims` (D4) closed the claim verification
      before the run proof was recorded.

## H. Projection hygiene

- [ ] No production scheduling, dependency, material, effect or terminal
      decision read `KanbanCard` or any projection row.
- [ ] Deleting all Kanban rows mid-run and rebuilding yields the identical
      normalized authoritative trace and terminal proof (mandatory mutation).
- [ ] Operator actions on the board translated into typed commands; no direct
      card-status API exists.
- [ ] The tracker displays pinned role-contract/prompt-receipt references and
      selects nothing.

## I. Crash-window sweep (fault points)

For every changed or suspect durable boundary, inject crashes **immediately
before and after** the write and prove exactly-once logical outcomes:

- [ ] before/after every event, evidence and obligation commit;
- [ ] before/after worker spawn and return;
- [ ] before/after gate and effect commits;
- [ ] before/after context admission and provider send;
- [ ] before/after obligation completion and settlement.

Each crash window settles to success, typed wait or truthful terminal —
never to a busy-spin loop, a duplicate effect, or a false terminalization.

## J. Incident card (required for every stall/failure)

Attach the card defined in `CONVEYOR-TRANSITION-DIAGNOSTICS.md` §8: scope
refs, landmarks, root unmet invariant with typed reason code, obligation
ledger excerpt, wait + wake source, attempt refs with role-contract digest
and receipt ordinal range, evidence refs, observed revision set, coverage,
competing invariants, retry class, resume action with expected revision,
reusable evidence, correlation id. Confirm the retry did not create a second
active run, Workplace or obligation owner.

## K. Conformance scenario for every new workshop

Run the same scenario without changing the kernel:

1. Bootstrap a fresh database; import the workshop's capsule through public
   ingress.
2. Drive one chain, one diamond, one fan-out and one failed-predecessor
   topology through the obligation driver.
3. Crash at every fault point from §I and prove convergence.
4. Reject a candidate in review; verify the typed repair branch and exact
   feedback on the same Workplace lineage.
5. Delete all Kanban rows mid-run; finish; rebuild; compare normalized traces.
6. Admit a scripted, a replay and a real actor through the same accountant;
   compare receipts.
7. Prove the workshop added no kernel transition kind, table, driver branch
   or reconciler (synthetic non-game workshop is the reference case).
8. Re-derive forward/reverse observed graphs and reconcile with the protocol
   graphs.
