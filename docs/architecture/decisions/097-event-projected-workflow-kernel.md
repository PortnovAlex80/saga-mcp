# ADR-097: Event-projected workflow kernel; Kanban is a read model

- **Status:** Accepted
- **Date:** 2026-08-24
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** primary architect after autonomous-decision analysis and hostile review

## Context

The factory repeatedly passes thousands of local and conformance tests while a
fresh production run finds a new stall, premature terminal, dead dependency or
authority mismatch. The simple Kanban algorithm is not the difficult part. The
difficulty is that several durable representations still participate in
deciding what happens next.

The intended architecture already says:

- `factory_workplaces` owns Workplace loop state;
- `tasks.status` is a reverse projection for people;
- WorkerExecution is attempt/provenance, not accepted-material authority;
- separate bounded state machines are lawful;
- every cross-machine handoff needs an explicit durable obligation.

The implementation does not yet satisfy those statements as a conjunction:

1. `src/application/conveyor-runtime.ts:10-27` declares `tasks.status` a
   projection, but `bindTaskToWorkplace` reads that projection back to seed
   authoritative Workplace state (`:381-415`).
2. `src/lifecycle/work-assignment-core.ts:483-503` admits work through
   `t.status IN ('todo','review')`.
3. `src/tools/tasks.ts:322-376` derives dependency readiness from task rows and
   directly blocks/unblocks them.
4. `src/infrastructure/projections/workplace-projector.ts:66-75` lossily maps
   Workplace `done`, `failed` and `cancelled` to the same task value `done`.
5. Production readers subsequently use `status='done'` for dependency,
   generation and progress decisions
   (`src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts:175-215`).
6. The Workplace repository calls itself the only state writer, while operator
   unpark, lifecycle burial and Development supersession directly update
   `factory_workplaces` outside it.
7. The static architecture test does not enforce one writer. It sanctions a
   growing list of task-state writers
   (`tests/lifecycle/architecture.test.mjs:131-181`).

Therefore Kanban is simultaneously a projection and a scheduling input. State
is projected from Workplace to task and then read back from task into runtime
authority. A stale or lossy projection can change production behavior.

The independently authored forward and reverse maps did not promise to solve
this. They were frozen at `586871ad`, state that production code is
authoritative, and deliberately leave concurrency, time, environment, model
cognition and several replay boundaries open. They prove static material and
claim topology, not temporal ownership of each edge.

The missing theorem is:

> When an authoritative fact commits, the obligation to perform the next
> cross-machine transition commits with it, has one exact owner capability and
> fence, and eventually completes, becomes a typed wait, or fails truthfully.

This ADR extends ADR-053 from material authority to transition authority. It
does not replace the exact Workplace production revision, CandidateSet,
GateDecision, EffectReceipt or CellFinalAcceptance model.

## Cynefin triage

The situation was initially **Confusion** and was decomposed:

- Kanban column movement is **Clear** and should remain a projection concern.
- Deterministic cross-machine coordination is **Complicated**: it is finite,
  analyzable and suitable for reducers, CAS, obligations and model checking.
- Product semantics and LLM cognition are **Complex**: they require probes and
  honest semantic gates and cannot be made deterministic by the workflow
  kernel.
- The migration is **Complex** because a second authority left beside the old
  one would worsen the failure space.

The architecture fork therefore used the full decision loop and requires a
bounded Development-capsule probe before broad cutover.

## Decision drivers

Scores use 1 (poor) through 5 (strong).

| Driver | Weight | Why it matters here |
|---|---:|---|
| Authority correctness | 30 | A projection or stale attempt must never decide production state. |
| Temporal/fault testability | 20 | Crash windows and missing synchronization edges are the recurring production class. |
| Fit with ADR-053 and retained assets | 15 | Exact material, gates, effects and bounded aggregates are valuable and should survive. |
| Migration safety and reversibility | 15 | A long dual-authority migration is the highest-risk failure mode. |
| Workshop universality/isolation | 10 | New workshops may add semantics, not schedulers or state machines. |
| Operational simplicity and cost | 10 | The result must reduce, not add, coordination machinery. |

## Considered options

### Option A — Minimal command kernel

Reduce mutable authority to `WorkflowRun` and `Workplace`; turn StageRun,
ProcessRun and NodeRun into projections or immutable metadata; drive every
activity from one universal command queue. This has the smallest target model
and strongest model-checking surface, but it is the broadest rewrite and risks
discarding useful bounded aggregate semantics.

### Option B — Event-projected workflow kernel

Retain bounded authoritative aggregates and exact immutable evidence, but make
every cross-aggregate handoff an append-only event plus durable obligation
committed atomically with its source fact. Kanban, task status, runnable work,
dependency blocking and diagnostics are rebuildable projections. Obligation
consumers are stateless and replaceable; only the aggregate owner may decide an
aggregate transition.

### Option C — Per-run deterministic supervisor

Add one logical command/event supervisor per FactoryRun. It owns all
inter-machine commands while workshops become semantic plugins and external
work becomes activities. This gives a clear process-manager model, but risks
becoming another mutable authority over aggregates that already own their
transitions. With that risk removed, it collapses into Option B's stateless
obligation consumer.

## MCDA matrix

| Option | Authority (30) | Fault proof (20) | Domain fit (15) | Migration (15) | Universal (10) | Simplicity (10) | Weighted total / 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| A — minimal command kernel | 5 | 5 | 3 | 2 | 4 | 3 | 395 |
| B — event-projected kernel | 4 | 4 | 5 | 4 | 4 | 3 | 405 |
| C — per-run supervisor | 5 | 5 | 4 | 3 | 5 | 3 | 435 |

**Sanity check:** C initially leads, but its margin over B is below 10%, so the
matrix does not decide the fork. Reversibility favors B. The hostile review
also found that C's distinguishing run-wide authority conflicts with the
existing rule that bounded machines remain authoritative.

## Pre-mortem

Assumption: the event-projected kernel was implemented and failed six months
later.

1. **The ledger became another shadow beside legacy SQL writers** — likelihood:
   high; detectable by a non-zero writer inventory; mitigation: hard protocol
   cutover per FactoryStart and a zero-writer ratchet before qualification.
2. **Dispatch still read `tasks.status` or another projection for convenience**
   — likelihood: high; detectable by source ratchets and a board-corruption
   mutation; mitigation: dispatch only durable obligations, with aggregate-head
   revalidation before claim.
3. **Events duplicated evidence loosely instead of naming exact authority** —
   likelihood: medium; detectable by foreign-ref and digest mutations;
   mitigation: evidence and event commit in one transaction with exact refs.
4. **A universal reducer gained workshop-specific branches** — likelihood:
   medium; detectable by module-name and private-state-machine ratchets;
   mitigation: workshops provide schemas, pure mappings, checks and effects,
   never workflow transition kinds.
5. **The executable model drifted from production** — likelihood: medium;
   detectable by normalized trace conformance; mitigation: replay generated and
   minimized traces against the production reducers and SQLite repositories.
6. **Orchestration became deterministic but criteria remained jointly
   impossible** — likelihood: high; detectable by the satisfiability gate;
   mitigation: keep semantic preservation and joint satisfiability as a
   separate installation/formalization obligation. Do not claim this kernel
   proves product meaning.

**Net effect:** Option B survives only as a hard cutover, not as a long-lived
dual-write migration.

## Red Team

**Strongest argument against the initial leader C:** a per-run supervisor is
one more mutable authority and failure domain. It either duplicates decisions
from potentially stale aggregate snapshots, or it merely consumes durable
obligations; in the latter case it is Option B with a different name.

**Source in the repository:** ADR-053 says separate machines are not the
defect; synchronization without durable obligations is. Conveyor Mental Model
section 23 requires a composition of authoritative machines rather than a
projection impersonating a global machine. The existing obligation schema
already contains source identity, owner capability, fences, lease and
idempotent completion, while the live violation is the bidirectional task
projection.

**Response:** accepted. Option C is demoted. A scheduler/reconciler may exist as
a stateless, replaceable consumer of the obligation ledger, but it owns no
run-wide truth and makes no workshop-semantic decision.

## Decision

Choose **Option B — Event-projected workflow kernel**.

Keep separate bounded authoritative aggregates. Give every mutable fact one
owner and one CAS/reducer boundary. For every committed fact that requires a
different aggregate to advance, atomically append one exact workflow event and
one durable successor obligation. A replaceable consumer leases the obligation
and invokes the owning aggregate's idempotent command. It never reconstructs
intent from current board rows and never becomes another state authority.

The governing rules are:

1. **One fact, one owner, one linearization point.**
2. **Every cross-owner edge is a durable obligation, never an inferred poll.**
3. **Every nonterminal scope has a live owner, runnable obligation, typed wait
   with a wake source, or committed transition due.** The invariant is checked
   before committing a transition, not only diagnosed afterward.
4. **Kanban and tasks are read models.** Core scheduling, dependency, terminal
   and material decisions may not read them.
5. **Projection loss is harmless.** Deleting and rebuilding Kanban cannot
   change a run's result.
6. **Terminalization requires a proof**, not absence of returned work.
7. **Workshops own semantics; the kernel owns coordination.** A workshop may
   declare products, mappings, CheckPlans and effects, but not a queue,
   scheduler, retry engine or mutable workflow table.
8. **LLM, replay and scripted actors replace only cognition.** They return
   typed contributions/results through the same production ingress.

The canonical handoff grammar is:

```text
source aggregate command
  -> source fact/evidence + WorkflowEvent + successor obligation
       (one transaction)
  -> stateless obligation consumer leases exact obligation
  -> target aggregate command with expected revision and exact evidence refs
  -> target fact + completion receipt + next obligation/wait/terminal proof
       (one transaction)
```

Dependency readiness is a predicate over exact predecessor final-acceptance and
effect evidence. It is not a command that flips `blocked -> todo`. A terminally
failed predecessor makes downstream work explicitly unreachable and makes graph
settlement runnable; dependants cannot remain pending behind a dead wake source.

## Consequences

**Positive:**

- Kanban becomes as simple and disposable as the operator expects.
- Projection lag or corruption cannot stall or advance production.
- A crash cannot erase knowledge of the next required transition.
- Existing Workplace, material, Candidate, Gate, Effect, replay and package
  assets remain reusable.
- The state-space becomes testable through generated obligation/event traces,
  fault schedules and projection rebuilds instead of incident-shaped examples
  alone.
- Failure attribution separates kernel coordination, workshop semantics,
  worker behavior, provider substrate and human/external waits.

**Negative:**

- This is a substantial orchestration cutover.
- Event, obligation and reducer versioning need strict governance.
- SQLite write volume increases.
- Existing nonterminal runs cannot safely change protocol mid-flight.
- The kernel cannot prove that an LLM understood an idea or that arbitrary
  natural-language requirements are satisfiable.

**Neutral / follow-ups:**

- Inventory every reader/writer of task, Workplace, execution, obligation,
  node, process, stage and lifecycle state.
- Pin a workflow protocol version at FactoryStart; no mid-run switch.
- Convert the existing progress classifier into a write-time successor check.
- Generate Kanban, runnable work and forward/reverse temporal maps from the
  event/obligation vocabulary.
- Use the frozen Development capsule and simple-server corpus as the first hard
  vertical cutover probe.
- Retain incident regressions until equivalent invariant and mutation coverage
  is proven; then remove implementation-mirroring duplicates deliberately.

## Decision Journal

**Date:** 2026-08-24

**Decision (one line):** preserve bounded machines but make every cross-machine
handoff an atomic durable event/obligation; Kanban is a rebuildable read model
and never transition authority.

**Ex-ante expectations — if this decision is right:**

- In 30 days: the authority inventory is complete; no new direct task/Workplace
  writer is added; a corrupted or deleted Kanban projection has zero effect on
  Development dispatch and outcome.
- In 90 days: the Development capsule settles under one pinned protocol with
  crash injection before/after every event/evidence boundary; every reachable
  nonterminal state has exactly one truthful progress explanation.
- In 6 months: adding a synthetic non-game workshop requires no new kernel
  transition kind, mutable state table, dispatcher or reconciler.

**Check trigger:** the first hard Development vertical, any proposal to let a
core query read `tasks.status`, any new direct aggregate-state writer, or any
production stall without a persisted unmet obligation/wait.

**What would change this decision:** evidence that exact per-aggregate
obligations cannot express a required coordination behavior without a
run-wide mutable supervisor, or that the obligation kernel cannot preserve
throughput under measured workloads even with independent activity execution.

## References

- `docs/architecture/CONVEYOR-MENTAL-MODEL.md`, especially sections 19, 22 and 23
- `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`
- `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md`
- ADR-048: temporal conformance over canonical composition
- ADR-053: sealed Workplace production revision as material authority
- ADR-090: idea authority conservation
- `docs/factory-map/FORWARD_GRAPH.md`
- `docs/factory-map/GRAPH_RECONCILIATION.md`
