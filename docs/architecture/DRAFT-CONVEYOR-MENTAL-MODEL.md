# Conveyor Mental Model — Event-Projected Kernel (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). This is the rewrite of the
> conveyor compass to the target protocol built by WP-05…WP-18. Until the EK-8
> hard cutover, the legacy runtime is still the production entrypoint; the laws
> below are the review standard for all new-kernel work and the shape of the
> world after cutover.
>
> Machine authority: the frozen
> `docs/refactoring/event-kernel/specs/frozen-inputs/transition-universe.json`
> and `PROTOCOL-DECISIONS-FROZEN.md` (D1–D12). Vocabulary reference:
> `WORKFLOW-KERNEL.md`. Decision history: ADR-053 (accepted-material chain),
> ADR-097 (event-projected kernel), ADR-098 (frozen successor contracts).

This document is the plain-language interpretation of the kernel laws. Use it
to review runtime, persistence, workshop, testing, replay, recovery and
delivery changes. The governing rule is now three laws:

> **one authority · durable handoff · projection-only Kanban**

---

## 1. One authority

Every mutable fact has exactly one owner. The owner is an aggregate repository
with a revision it alone may compare-and-set. The full ownership table is
`WORKFLOW-KERNEL.md` §2; the mental model is:

```text
FactoryRun owns the run           LifecycleRun owns the lifecycle
StageRun owns the stage           ProcessRun owns the flow cursor
NodeRun owns the node             Workplace owns work AND material
ActivityAttempt owns the attempt  Planning owns immutable WorkItems
```

What "one authority" forbids, concretely:

- No projector, UI, worker, reconciler, watchdog or recovery tool writes
  aggregate state directly. They issue typed commands.
- No decision selects authority by `latest`, descending time, maximum ID, task
  status, execution status, node status or a projection. If you are about to
  sort by recency to find "the real one", the design is wrong.
- An event is a receipt, not a second writer. Selecting the newest event to
  learn current state is the same defect wearing a different coat.
- WorkerExecution-era thinking is retired: **ActivityAttempt is an activity
  attempt and provenance only.** Accepted material authority is the Workplace
  production revision chain (ADR-053). A post-acceptance effect that reads
  "the latest attempt output" has already lost.

A workshop never owns queues, schedulers, retry engines or workflow tables. It
supplies semantics, schemas, prompts, checks and effects. Module identity
lives in installed manifests, never in kernel conditionals: the kernel has no
workshop-name branches.

## 2. Durable handoff

Work crosses owners exactly one way: the source owner commits, in one
transaction,

```text
source fact or immutable evidence
  + exact WorkflowEvent
  + one durable obligation per target-owner edge
```

and a stateless, replaceable consumer later leases that obligation, loads the
target at the expected revision, invokes the target command with exact
evidence references, and commits the target fact + completion receipt + next
progress — atomically.

The consequences that matter mentally:

- **A crash is a pause, not an ambiguity.** Every durable boundary has fault
  points immediately before and after it; every crash window settles to
  success, typed wait or truthful terminal. Nothing is inferred from silence.
- **Idempotency is structural.** Retrying the same obligation cannot create a
  second fact or effect; duplicate command/idempotency keys cannot double-pay.
- **Fan-out is explicit obligations; fan-in is exact predecessor evidence.**
  Nothing "discovers" that its inputs are ready by polling.
- **A dead predecessor is loud.** A terminally failed predecessor makes
  dependants explicitly unreachable and creates runnable settlement work.
  Nothing waits on a wake source that can never fire.

There is no run-wide supervisor. A scheduler may lease obligations; it holds
no truth and can be killed at any time.

## 3. Progress is owned, never inferred

Every nonterminal scope has, at the moment its current transition commits:

- a **runnable obligation**,
- a **typed wait with a durable wake source**, or
- a successor transition committed in the same transaction.

This is the write-time progress invariant. Its corollaries:

- **An empty queue is silence, not a proof.** Terminalization requires an
  exact `TerminalProof` (success, truthful failure, cancellation or
  unreachable) over an exact evidence closure. "Nothing seems left" proves
  nothing.
- Every wait names its wake source, and the wake source's discharge is an
  obligation-completion receipt (D5). Human waits wake on operator commands;
  quota waits on backoff deadlines or resume; readiness waits on predecessor
  evidence arrival; effect uncertainty wakes only on an operator disposition —
  never on an automatic duplicate send (D12).
- Truthful failure is earned: repair epochs roll over, and when the repair
  ledger is exhausted a scope-refusal receipt (`RepairTerminalityEvidence`,
  D6) closes the scope honestly. A hang is not a failure; a fabricated success
  is worse.

## 4. Ideas are conserved into the plan

Acceptance criteria are not the whole plan. Formalization and Development must
preserve product intent, lifecycle claims, unknowns, cross-cutting constraints
and integration surfaces:

- `WorkItem` and `WorkItemDependency` are **immutable planning facts** — no
  mutable board status, no in-place rewrites.
- Every epic scope item is covered by a requirement/acceptance claim or is
  explicitly deferred with owner and reason.
- Every Discovery unknown becomes an open obligation
  (`obligation:openUnknownObligation`, D10) with an owner; unknowns cannot
  disappear at a workshop boundary.
- Every terminal lifecycle claim has an owned construction surface and an
  executable verifier (`lifecycleRun.verifyTerminalClaims`, D4).
- The planner synthesizes infrastructure and integration WorkItems from
  terminal claims and seams; a blind one-AC-to-one-card conversion is a
  defect.
- The forward graph (from idea/scope/unknowns/commands) and the reverse graph
  (from terminal claims/required evidence/effect receipts) are derived
  **independently** and reconciled by typed set equality. A non-empty
  difference is a repair request, never an accepted warning.

## 5. The material chain stays ADR-053

The author/reviewer/repair loop and the accepted-material chain live in the
Workplace aggregate:

```text
WorkIntent -> ActivityAttempt -> contribution
  -> WorkplaceProductionRevision (immutable, accepted-material authority)
  -> CandidateSet (author | reviewer, bound to one revision)
  -> GateDecision (over one exact CandidateSet + CheckPlan)
  -> EffectReceipt (idempotent post-acceptance effect outcome)
  -> CellFinalAcceptance (exact cell completion evidence, digest-embedded D11)
```

Distinctions that were paid for in incident currency and must never blur
again:

- A contribution means "this attempt stopped and left material on the desk" —
  not acceptance.
- Gate computation accepted ≠ GateDecision persisted ≠ decision applied at the
  expected revision ≠ required effects receipted ≠ cell-final acceptance.
  Only the last is terminal success.
- An effectful cell is `effect_pending` until its required `EffectReceipt`s
  land; effects never run "after terminal so the adapter can catch up".
- Effect results are seven typed kinds (D2), including `repair`; unknown
  outcomes reconcile, they never blindly retry.

## 6. Cognition is admitted, not assumed

Only two protocol roles exist in the Workplace: **author** and **reviewer**.
Planner, implementer, reviewer, certifier are semantic profiles; repair is a
transition, not a role.

- Every WorkIntent pins the exact `CanonicalRoleContract` reference and
  digest; ActivityAttempt copies it and never re-resolves the manifest.
  Dispatcher, runner, prompt builder and tracker transport the contract; none
  of them selects or repairs it. There is no fallback to task status, tags,
  execution status, assignment skill, tracker state or global skill roots.
- `executorRoutePolicyRef` is the sole provider/model selection authority —
  a finite declarative table evaluated once at attempt creation and pinned as
  evidence (`ProviderRoutePin`). A route change is a new typed attempt.
- Every provider request passes one cumulative context accountant
  (`activityAttempt.admitProviderRequest`) at the linearization point
  immediately before final serialization/network send. It covers the whole
  request — initial prompt, instructions, tool schemas, hooks, recovery
  history, tool results — and both the per-request window and the cumulative
  session budget. Zero/missing/unsupported limits fail closed; there is no
  environment variable that turns the invariant off.
- Each request leaves an immutable `PromptAssemblyReceipt` (`admitted` or
  `refused` — never `sent`). An admitted receipt is not send evidence: a crash
  before send redrives the same obligation and ordinal instead of admitting a
  new request; a crash after a non-idempotent external send becomes typed
  uncertainty.
- Scripted, replay and real actors implement the same cognition port and use
  the same commands, ingress and admission path. They replace cognition only.
  Replay substitutes worker production, never CandidateSets, decisions,
  state, cursors, settlements or effect completion.

## 7. Projection-only Kanban

The board is a view. Workflow state lives in aggregate heads, events,
obligations, waits and proofs; Kanban cards are regenerated from those facts.

- Columns (TODO, in-progress, review, repair, waiting, terminal) are human
  views, not workflow inputs.
- Operator actions translate into typed commands. There is no API that sets a
  production card status.
- Deleting all Kanban rows and rebuilding them is a **normal supported
  operation with no production consequence** — and a mandatory tested
  mutation, not an aspiration.
- Anything you can learn only from the board is something the kernel is not
  allowed to know. Scheduling, dependency readiness, material selection,
  effects and terminalization read authoritative facts, never projections.

## 8. Fresh protocol only

The database is a protocol, not a bucket. A new database bootstraps from one
declarative schema with an exact protocol identifier and fingerprint. Any
non-empty database that is not exactly the current protocol fails closed with
`FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` and an instruction to choose a fresh
path — byte-for-byte unchanged. There is no migration, backfill, adoption,
dual read, dual write or resume-from-pre-cutover. Git history is the archive;
old databases are offline incident evidence.

Identity rules that survive from the previous model, unchanged in spirit:

- New factory start = new run identity for the same project.
- Resume = same run identity; the persisted obligation/wait ledger is the
  resume state. `factoryRun.requestStop` / `factoryRun.resume` are durable
  commands and evidence (`OperatorStopCommand`, policy-quota waits), not
  direct state edits.
- Continuation = new linked run identity in the same lineage, starting from an
  exact accepted prefix; the failed parent is never rewritten as healthy.
- Idempotency deduplicates the same start command; it must not prohibit a
  later intentional new start.

## 9. Review duties (what to check on any kernel change)

1. Name the owner, command, event, obligation and proof for every changed
   transition. If you cannot, stop.
2. Name the wake source of every new wait, and what happens when that source
   terminally fails.
3. Name the evidence closure of every new proof.
4. Show that no reader of the changed fact selects by recency/status/projection.
5. Show the crash windows before/after each new durable boundary and how each
   settles.
6. Show that the change adds no workshop-name branch, no second consumer
   protocol, no role re-resolution, no unaccounted context source.
7. Check the complexity delta: a new state/relation/owner/path/policy layer
   requires an approved measured delta **before** code is written. A legacy
   baseline is diagnostic evidence, not an entitlement.
8. Adding any vocabulary kind or contract field reopens EK-1 and invalidates
   downstream qualification evidence. This is not an informal plan edit.

## 10. Canonical glossary

- **Aggregate** — a sole-writer owner of one mutable fact family with a CAS
  revision.
- **WorkflowEvent** — immutable receipt emitted by the owner in the same
  transaction; never authority.
- **TransitionObligation** — durable, leasable, idempotent instruction to
  invoke one exact target command with exact evidence.
- **TypedWait** — nonterminal wait reason plus exact durable wake source.
- **TerminalProof** — exact evidence closure that a scope ended (success /
  truthful failure / cancellation / unreachable). Empty queues prove nothing.
- **WorkIntent** — immutable launch intent binding WorkItem, expected
  revision, input evidence, command and role-contract digest.
- **ActivityAttempt** — worker-attempt lease/provenance plus CAS-fenced
  context admission; never accepted-material authority.
- **WorkplaceProductionRevision** — immutable accepted production revision;
  the accepted-material authority (ADR-053).
- **CandidateSet / GateDecision / EffectReceipt / CellFinalAcceptance** — the
  QC handoff chain inside Workplace transactions.
- **CanonicalRoleContract / PromptBudgetProfile** — immutable content-addressed
  protocol values in the installed workshop manifest.
- **PromptAssemblyReceipt** — immutable admitted/refused context-admission
  evidence per provider request; never proof of send.
- **KanbanCard** — rebuildable operator projection.
- **ProtocolMetadata** — exact database protocol identity; immutable after
  creation.

## 11. Architectural rule of thumb

> If a change makes you ask "which of these two rows is current?", the change
> is wrong. If a change lets the system advance because "nothing is left", the
> change is wrong. If a change teaches the kernel a workshop's name, the
> change is wrong. If a change lets a prompt reach a provider without a
> receipt, the change is wrong.
