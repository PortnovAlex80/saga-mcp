# Event-Projected Kernel Greenfield Refactoring Plan

## Status and authority

- **Status:** ready for execution, but blocked by the predecessor gate.
- **Predecessor:** `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`.
- **Parent decisions:** ADR-053 and ADR-097.
- **Start rule:** no production-code work from this plan may start until the
  predecessor has a signed completion receipt, `saga4` points at its reviewed
  canonical SHA, the worktree is clean, and every predecessor residual is
  explicitly classified.
- **Database policy:** greenfield schema only. There is no database migration,
  backfill, row adoption, dual read, dual write, compatibility fallback, or
  support for resuming a pre-cutover run.
- **Legacy policy:** replacement and deletion land together. No phase may exit
  with an old and a new production authority both reachable.
- **Documentation policy:** obsolete documents are deleted, not moved to an
  archive directory. Git history is the archive.

This plan is self-contained. An execution coordinator may hand an individual
work package to a subagent without relying on conversational context.

A truthful predecessor verdict of `IN-PROGRESS` does not disappear. It permits
this plan to start only when its exact ADR-053 residuals are copied into EK-1
and assigned to owning work packages; those residuals become blocking EK-13
criteria. A missing verdict or unclassified residual blocks EK-0.

## SMART objective

Within 60 calendar days after the predecessor completion receipt, replace the
current production orchestration path with the ADR-097 event-projected workflow
kernel on a fresh database protocol, delete all superseded production runtime,
schema, test-fixture and documentation legacy, and qualify one immutable build
with all of the following evidence:

- [ ] every cross-owner transition in the independently declared transition
      universe is demonstrated by a blocking production-composition test;
- [ ] crash injection before and after every durable boundary cannot lose,
      duplicate or falsely terminalize work;
- [ ] deleting, corrupting or rebuilding the complete Kanban projection does
      not change dispatch, dependency, material, effect or terminal outcomes;
- [ ] the Development capsule completes the simple served Node/browser product
      ten consecutive times from ten fresh databases and repositories;
- [ ] the 20-project scripted corpus completes 20/20 from fresh databases and
      repositories through the same production ingress used by real agents;
- [ ] three diverse, consecutive, full-conveyor OpenCode project runs complete
      from idea through local Delivery on the same immutable build, without
      operator repair, manual SQL, hot-swapped `dist` or oracle weakening;
- [ ] the legacy-zero, fresh-schema, test-hosting and current-document ratchets
      are green on Windows and in blocking CI;
- [ ] `saga4` ends at the reviewed qualification SHA with a clean worktree and
      no valuable code left only in a temporary branch or worktree.

Any failure resets the affected consecutive-success series. A run repaired by
editing its database, repository, capsule, source tree, build output, task
state, or evidence is diagnostic evidence, not a qualifying success.

## Definition of complete

The refactor is complete only when all of these statements are true together:

- [ ] One fact has one owner and one linearization point.
- [ ] Every cross-owner edge is an atomic event plus durable obligation.
- [ ] Every nonterminal scope has a runnable obligation, a typed wait with a
      durable wake source, or a transition committed in the same transaction.
- [ ] Terminalization has an exact proof; an empty queue is never a proof.
- [ ] WorkItem definitions and dependencies are immutable planning facts.
- [ ] Kanban cards are disposable read models and are never read by the kernel
      to decide what work, material, effect or terminal state is authoritative.
- [ ] WorkerExecution is an activity attempt and provenance only.
- [ ] Workplace production revision, CandidateSet, GateDecision, EffectReceipt
      and CellFinalAcceptance remain the accepted-material chain required by
      ADR-053.
- [ ] Workshops supply semantics, schemas, prompts, checks and effects only.
      They do not own queues, schedulers, retry engines or workflow tables.
- [ ] Scripted, replay and real LLM actors replace only cognition and use the
      same commands, product ingress and validation path.
- [ ] Only the new schema protocol exists in production source and fixtures.
- [ ] No reachable legacy production runtime, schema, compatibility adapter,
      migration helper or stale operating instruction remains.

## Non-negotiable architecture laws

### One authority

- [ ] A mutable fact is owned by exactly one aggregate repository.
- [ ] Only that repository may compare-and-set the aggregate revision.
- [ ] A projector, UI, worker, reconciler, watchdog or recovery tool may issue a
      typed command, but may not write aggregate state directly.
- [ ] No decision may select authority using `latest`, descending chronology,
      maximum IDs, task status, execution status, node status, or a lossy
      projection.

### Durable handoff

For each cross-owner edge, the source command commits this grammar in one
transaction:

```text
source fact or immutable evidence
  + exact WorkflowEvent
  + one durable obligation for each target-owner edge
```

The replaceable obligation consumer then:

```text
leases one exact obligation by CAS and fence
  -> loads the target aggregate at the expected revision
  -> invokes the target aggregate command with exact evidence references
  -> atomically commits:
       target fact/evidence
       obligation completion receipt
       next obligations, or typed wait, or terminal proof
```

- [ ] The consumer owns no run-wide truth.
- [ ] Retrying the same obligation is idempotent.
- [ ] A stale lease, stale expected revision or foreign evidence reference is
      refused with a typed reason.
- [ ] Fan-out creates explicit obligations; fan-in checks exact predecessor
      final-acceptance/effect evidence.
- [ ] A terminally failed predecessor makes dependants explicitly unreachable
      and creates runnable settlement work. Nothing waits on a dead wake source.

### Planning and idea conservation

Acceptance criteria are not the only planning input. Formalization and
Development must preserve product intent, lifecycle claims, unknowns,
cross-cutting constraints and integration surfaces.

- [ ] Every epic scope item is covered by a requirement/acceptance claim or is
      explicitly deferred with owner and reason.
- [ ] Every Discovery unknown becomes an open obligation with an owner and
      cannot disappear at a workshop boundary.
- [ ] Qualitative requirements are parameterized or explicitly deferred.
- [ ] Every terminal lifecycle claim has an owned construction surface and an
      executable verifier.
- [ ] The planner may synthesize infrastructure and integration WorkItems from
      terminal claims and seams; it must not perform a blind one-AC-to-one-card
      conversion.
- [ ] Every WorkItem maps to one or more obligations, or has a distinct typed
      infrastructure/integration obligation identity.
- [ ] A forward graph is derived from idea, scope, unknowns and commands.
- [ ] A separate reverse graph is derived from terminal claims, required
      evidence and effect receipts.
- [ ] The two derivations are performed independently and reconciled by typed
      node/edge set equality. Neither derivation may read the other's output
      before both are frozen.
- [ ] A non-empty difference is a repair request, never an accepted warning.

### Projection-only Kanban

- [ ] Planning stores immutable WorkItems and dependency edges.
- [ ] Workflow state lives in aggregate heads, events, obligations, waits and
      terminal proofs.
- [ ] Kanban cards are regenerated from those facts.
- [ ] Operator actions translate into typed domain commands.
- [ ] There is no API that directly sets a production card status.
- [ ] Deleting all Kanban rows and rebuilding them is a normal supported
      operation with no production consequence.

### Fresh protocol only

- [ ] A new database is bootstrapped from one declarative schema.
- [ ] The schema contains an exact protocol identifier and schema fingerprint.
- [ ] An empty path creates the new protocol.
- [ ] A database with the exact new identifier and fingerprint opens.
- [ ] Any other non-empty database fails closed with
      `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` and an operator-facing instruction
      to choose a fresh database path.
- [ ] The runtime never alters an existing schema.
- [ ] Old databases may be preserved offline as incident evidence, but new
      production code contains no reader, importer or migration path for them.
- [ ] A Development capsule is a content-addressed external input bundle. It is
      imported through public new-protocol ingress into a fresh database; it is
      not an old SQLite snapshot and does not seed authority rows directly.

## Target logical model

Physical names are frozen by Phase EK-1 before implementation. The new schema
must contain exactly the logical relations below and only the additional
catalog/authentication relations justified in the authority census.

| Relation | Authority and rule |
|---|---|
| `ProtocolMetadata` | One exact schema/protocol identity; immutable after creation. |
| `FactoryRun` | Owns run identity, pinned build/package/capsule digests and final run proof. |
| `LifecycleRun` | Owns lifecycle state and current revision. |
| `StageRun` | Owns stage state and current revision. |
| `ProcessRun` | Owns process state and current revision. |
| `NodeRun` | Owns node state and current revision. |
| `WorkItem` | Immutable semantic/planning definition; no mutable board status. |
| `WorkItemDependency` | Immutable exact dependency edge. |
| `Workplace` | Owns the author/reviewer/repair loop and current revision. |
| `ActivityAttempt` | Worker attempt, lease, heartbeat and provenance; never accepted-material authority. |
| `WorkplaceProductionRevision` | Immutable accepted production revision. |
| `CandidateSet` | Immutable author or reviewer presentation bound to one production revision. |
| `GateDecision` | Immutable decision over one exact CandidateSet and CheckPlan. |
| `EffectReceipt` | Immutable idempotent post-acceptance effect outcome. |
| `CellFinalAcceptance` | Exact cell completion evidence. |
| `WorkflowEvent` | Append-only fact naming source owner, source revision, transition kind and evidence refs. |
| `TransitionObligation` | Durable target command, expected revision, capability, lease/fence and completion. |
| `TypedWait` | Nonterminal wait reason plus exact durable wake source and deadline/policy. |
| `TerminalProof` | Success, truthful failure, cancellation or unreachable proof for one exact scope. |
| `KanbanCard` | Rebuildable operator projection only. |

An aggregate head owns current mutable state. A `WorkflowEvent` is the immutable
receipt emitted by that same owner in the same transaction; it is not a second
writer and production code may not discover current state by selecting the
"latest" event. An offline replay may verify an aggregate head against its
ordered stream, but ordinary commands read the exact owner and expected
revision.

Do not add a generic mutable "current state" table that becomes a second owner.
Do not add a run-wide supervisor authority. A scheduler may lease obligations,
but it is stateless and replaceable.

## Execution model for subagents

### Roles

- **Integration coordinator:** owns the integration branch, shared-file edits,
  phase gates, cherry-picks and final evidence. This role does not delegate the
  decision to weaken an invariant.
- **Implementer:** changes only the assigned paths and delivers focused tests
  plus a logical commit.
- **Independent verifier:** receives the requirement and resulting commit, not
  the implementer's reasoning, and attempts to disprove the exit criteria.
- **Adversarial reviewer:** is a verifier explicitly asked to construct a
  counterexample, fault schedule, stale/foreign input or projection corruption.
  It does not mean a security attack and does not edit the implementation.
- **Run operator:** starts immutable qualification runs and records evidence.
  It never repairs a live qualifying run.

An implementer must not self-approve an authority boundary, fresh schema,
terminal proof, legacy deletion or qualification result.

### Branch and worktree rules

- [ ] The coordinator creates one integration branch from the exact EK-0 base.
- [ ] Each bounded work package uses its own clean worktree and branch.
- [ ] No subagent edits the live operator worktree or a qualifying project.
- [ ] Shared files are coordinator-owned:
      `package.json`, the schema entrypoint, acceptance-matrix manifests,
      ADR/closure registries and the current-document index.
- [ ] Parallel packages have disjoint owned paths.
- [ ] Before EK-8, the new kernel is instantiated only by its focused test
      composition. The production entrypoint continues to select the old
      runtime and has no feature flag, fallback or environment switch that can
      select the new one.
- [ ] EK-8 is one hard production cutover: route the production entrypoint to
      the fully integrated new composition and delete the old runtime/schema
      composition in the same reviewed landing.
- [ ] A pre-cutover test composition is not production authority and must not
      open an operator/live database.
- [ ] An agent rebases or recreates its patch on the current integration SHA
      before handoff; it never merges stale branch history wholesale.
- [ ] Every handoff states base SHA, commit SHA, files changed, files deleted,
      commands run, pass/fail/skip counts, deliberate RED mutation and residual
      risks.
- [ ] A landing is not a phase exit. The coordinator reruns the phase gate on
      the integrated tree.

### Dependency graph

```text
predecessor completion
  -> EK-0 freeze
  -> EK-1 authority/specification/deletion manifests
  -> EK-2 pure kernel model
  -> EK-3 fresh schema and repositories
  -> EK-4 obligation driver and fault semantics
  -> EK-5 Development Workplace vertical
  -> EK-6 planning, dependencies and aggregate settlement
  -> EK-7 Kanban/UI projection
  -> EK-8 all-workshop cutover and legacy purge
  -> EK-9 test engine and CI truth
  -> EK-10 documentation purge
  -> EK-11 scripted project qualification
  -> EK-12 real-agent project qualification
  -> EK-13 closure and canonical merge
```

The test-engine skeleton and documentation inventory may be developed in
parallel after EK-1, but their integration gates remain EK-9 and EK-10. No
later phase may be used to excuse an open earlier exit criterion.

### Bounded work-package allocation

The coordinator may split a phase further, but must not combine packages in a
way that gives one agent both an implementation and its independent approval.

| Package | Bounded assignment | Depends on | Primary owned paths/output |
|---|---|---|---|
| WP-01 | Complete the authority reader/writer census | EK-0 | `authority-census.json` and `AUTHORITY-CENSUS.md` |
| WP-02 | Derive the forward graph from inputs and commands only | EK-0 | private forward draft delivered to coordinator |
| WP-03 | Derive the reverse graph from terminal claims/evidence only | EK-0 | private reverse draft delivered to coordinator |
| WP-04 | Build legacy and document deletion manifests | EK-0 | the two deletion manifests |
| WP-05 | Implement pure kernel reducers and model explorer | EK-1 | `src/workflow-kernel/domain/**` and model tests |
| WP-06 | Implement greenfield schema and repositories | WP-05 | `src/workflow-kernel/persistence/**` |
| WP-07 | Implement obligation consumer, waits and fault points | WP-06 | `src/workflow-kernel/application/**` |
| WP-08 | Implement the Development/material vertical | WP-07 | Development adapter, capsule ingress and focused tests |
| WP-09 | Implement planning, dependency and aggregate settlement | WP-07 | WorkItem/aggregate composition and tests |
| WP-10 | Implement Kanban projection and command-only UI adapters | WP-08, WP-09 | projector, read API, UI and tests |
| WP-11D | Convert Discovery semantic package | WP-09 | Discovery package paths only |
| WP-11F | Convert Formalization semantic package | WP-09 | Formalization package paths only |
| WP-11V | Finalize Development semantic package | WP-08, WP-09 | Development package paths only |
| WP-11L | Convert Delivery semantic package | WP-09 | Delivery package paths only |
| WP-12 | Integrate adapters and perform hard cutover/legacy deletion | WP-10, all WP-11 | entrypoints and deletion manifest |
| WP-13A | Implement scenario contract/model comparison/minimizer | WP-05 | workflow test-engine core |
| WP-13B | Implement actors, fault scheduler and production-size fixtures | WP-07 | actor/fault test paths |
| WP-13C | Implement CI hosting, removal guards and mutation coverage | WP-13A, WP-13B | test manifests/tools; coordinator lands shared files |
| WP-13D | Implement 20-project corpus and qualification drivers | WP-08, WP-13A | project corpus and run drivers |
| WP-14 | Rewrite canonical docs and prepare deletion patch | EK-1 | documentation paths only |
| WP-15 | Execute immutable scripted and real qualification | EK-10 | evidence only; no production source edits |

WP-02 and WP-03 must not be committed or placed in a mutually visible shared
path until both derivations are frozen. The coordinator records their hashes,
then imports both for reconciliation. Workshop packages WP-11D/F/V/L may run
in parallel because they own disjoint paths; the common workshop interface is
frozen before they start.

## Phase EK-0 - Predecessor gate and immutable baseline

Owner: integration coordinator.

- [ ] Read `AGENTS.md` and the four mandatory conveyor/ADR-053 documents in
      full.
- [ ] Verify every final deliverable of
      `CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md` exists.
- [ ] Record the predecessor completion receipt, canonical SHA, ADR-053 verdict
      and exact residual list.
- [ ] Require `saga4` to point at that reviewed SHA and require a clean
      worktree.
- [ ] Confirm no factory worker, watchdog or qualification run uses the target
      worktree, database or `dist`.
- [ ] Preserve any old database needed for incident evidence outside the new
      runtime path. Do not copy it into a new test kit.
- [ ] Create the refactor integration branch and record its base SHA.
- [ ] Create `docs/refactoring/event-kernel/EXECUTION-TRACKER.md` with one row
      per work package: owner, base SHA, status, commit, verifier, evidence and
      residual. Only the coordinator edits the tracker or this plan.
- [ ] Run and record the baseline commands:
  - [ ] `npm ci`;
  - [ ] `npm run build`;
  - [ ] `npm run adr-closure:validate`;
  - [ ] `npm run test:architecture`;
  - [ ] `npm run test:factory-model`;
  - [ ] `npm run test:factory-temporal`;
  - [ ] `npm run test:factory-contract`;
  - [ ] `npm run test:process-modules`;
  - [ ] `npm run test:acceptance-matrix`;
  - [ ] `npm test`.
- [ ] Write `docs/refactoring/event-kernel/BASELINE.md` with exact counts,
      durations, failures and the frozen SHA.

Exit:

- [ ] The predecessor is complete, the base is reproducible, the branch is
      clean, and no new-plan code was started early.

## Phase EK-1 - Authority census, protocol and deletion manifests

Owner: architecture/specification package. No production behavior changes.

### Authority census

- [ ] Parse complete SQL statements and repository calls; do not rely only on
      line-oriented grep.
- [ ] Enumerate every reader and writer of project/order/run, lifecycle, stage,
      process, node, WorkItem/task, Workplace, execution/attempt, material,
      CandidateSet, gate, effect, obligation, recovery, checkpoint and terminal
      facts.
- [ ] For each fact record:
  - [ ] current owner claimed by documentation;
  - [ ] every production writer;
  - [ ] every production reader that makes a decision;
  - [ ] current linearization point;
  - [ ] target owner and command;
  - [ ] target event/obligation/wait/proof;
  - [ ] disposition: retain and move, rewrite, or delete;
  - [ ] positive proof and deliberate mutation.
- [ ] Classify every use of chronology, maximum ID, task status, execution
      status and projection data as authoritative, diagnostic or delete.
- [ ] Produce machine-readable
      `docs/refactoring/event-kernel/authority-census.json` and the reviewed
      `AUTHORITY-CENSUS.md`.
- [ ] Require zero unclassified reader or writer before EK-2.

### Transition and claim specification

- [ ] Define typed command, event, obligation, wait and terminal-proof
      vocabularies for every bounded aggregate.
- [ ] Define exact input/output evidence refs and expected revisions for every
      edge.
- [ ] Define the write-time progress invariant for every nonterminal result.
- [ ] Define dependency fan-out, fan-in, failure, unreachable and settlement
      semantics.
- [ ] Define idea/scope/unknown/claim/WorkItem trace types.
- [ ] Freeze a machine-readable `transition-universe.json` independently of
      scenario implementations.
- [ ] Have one agent derive the forward graph from inputs and commands.
- [ ] Have a different agent derive the reverse graph from terminal proofs and
      required evidence without reading the forward result.
- [ ] Freeze both outputs, then reconcile typed node and edge sets.
- [ ] Resolve every difference in the protocol, not with explanatory prose.

### Deletion manifests

- [ ] Create `LEGACY-DELETION-MANIFEST.md` listing every old production file,
      table, column, trigger, endpoint, compatibility branch, migration helper,
      fixture and test with the phase that deletes it.
- [ ] Create `DOCUMENT-DELETION-MANIFEST.md` classifying every Markdown/diagram
      document as KEEP, REWRITE or DELETE with one reason.
- [ ] Mark current scheduling through `tasks.status`, direct Workplace updates,
      inferred dependency blocking/unblocking, old transition reconcilers,
      old schema bootstrap/mutation and DB adoption as mandatory DELETE.
- [ ] Mark pure ADR-053 material contracts as RETAIN-AND-MOVE only if they have
      one owner and no import from a deleted runtime.
- [ ] Require zero unclassified legacy or document entry.

Exit:

- [ ] The target protocol and physical schema names are frozen.
- [ ] Forward and reverse graphs match exactly.
- [ ] Every current authority access and deletion target is classified.
- [ ] An independent verifier can name no missing owner or transition.

## Phase EK-2 - Pure workflow kernel and executable model

Owner paths: new `src/workflow-kernel/domain/**` and
`tests/workflow-kernel/model/**` only.

- [ ] Implement pure types and reducers for aggregate revisions, commands,
      events, obligations, waits and terminal proofs.
- [ ] Implement one deterministic canonical serialization and digest rule.
- [ ] Implement the write-time progress invariant.
- [ ] Implement transition legality, idempotency keys, fences and expected
      revision checks.
- [ ] Implement explicit failed/unreachable propagation and settlement.
- [ ] Keep the pure kernel independent of SQLite, UI, worker providers,
      package names and workshop module names.
- [ ] Implement a reference state explorer from the independently frozen
      transition universe.
- [ ] Generate legal and illegal traces, retain random seeds and minimize a
      failing trace.
- [ ] Compare normalized production-intended traces with the reference model.
- [ ] Add deliberate mutations for:
  - [ ] missing successor obligation;
  - [ ] two owners for one fact;
  - [ ] terminalization from empty work;
  - [ ] wait without wake source;
  - [ ] stale expected revision accepted;
  - [ ] duplicate effect accepted twice;
  - [ ] dead predecessor leaving a dependant pending;
  - [ ] workshop-specific branch in the kernel.
- [ ] Add `npm run test:workflow-model` and make every new test blocking.

Exit:

- [ ] Every declared transition has a generated positive trace and at least one
      illegal mutation.
- [ ] The model cannot reach an unexplained nonterminal state.
- [ ] The pure package has no import from persistence, UI or workshop modules.

## Phase EK-3 - Fresh database schema and sole-writer repositories

Owner paths: new `src/workflow-kernel/persistence/**`, the new schema module and
focused persistence tests. The coordinator owns the schema entrypoint.

- [ ] Implement the Phase EK-1 schema as one declarative fresh bootstrap.
- [ ] Record an exact protocol ID and schema fingerprint at creation.
- [ ] Add required primary keys, foreign keys, uniqueness, append-only guards
      and CAS revisions.
- [ ] Make event/evidence/obligation writes transactional.
- [ ] Give each mutable aggregate one repository and forbid all other direct
      writes.
- [ ] Implement exact-version open and fail-closed unsupported-database open.
- [ ] Add tests proving an old database is refused without any file mutation.
- [ ] Add tests proving a wrong or partially created fingerprint is refused.
- [ ] Add tests proving a failed transaction leaves neither fact nor orphan
      obligation.
- [ ] Add tests proving duplicate command/idempotency keys cannot create a
      second fact or effect.
- [ ] Regenerate all fixtures by public bootstrap/ingress; do not convert old
      rows or copy old SQLite fixtures.
- [ ] Keep the new bootstrap unreachable from the production entrypoint until
      the EK-8 hard cutover. Focused tests construct it explicitly at a fresh
      temporary path.
- [ ] Prepare an exact deletion patch for the old schema bootstrap, schema
      mutation code, DB adoption, backfill and compatibility logic; EK-8 lands
      that deletion in the same change that routes startup to the new schema.
- [ ] Add a source ratchet that fails on production occurrences of:
  - [ ] `ALTER TABLE`;
  - [ ] migration/backfill modules or functions;
  - [ ] old-schema import/adoption paths;
  - [ ] dual-read or dual-write feature flags;
  - [ ] runtime fallback to a missing protocol identifier.

Exit:

- [ ] A fresh database contains only the approved new schema.
- [ ] An old database is byte-for-byte unchanged after typed refusal.
- [ ] Zero production schema migration or compatibility path exists.
- [ ] Each mutable aggregate has exactly one writer.

## Phase EK-4 - Obligation driver, recovery and fault semantics

Owner paths: new `src/workflow-kernel/application/**` and driver/fault tests.

- [ ] Implement a stateless, replaceable obligation consumer.
- [ ] Claim by CAS lease and fence; revalidate the exact target aggregate
      revision before invoking its command.
- [ ] Complete an obligation only in the transaction that commits its target
      result and next progress witness.
- [ ] Implement bounded retry for retryable substrate failures.
- [ ] Persist typed waits for human input, external availability, policy and
      quota with exact wake sources.
- [ ] Distinguish worker loss, provider refusal, malformed result, semantic
      rejection, effect uncertainty and policy terminal.
- [ ] Implement idempotent wake/redrive without reading Kanban or inferred
      current task status.
- [ ] Implement durable operator stop/resume as commands and evidence, not
      direct state updates.
- [ ] Add fault points immediately before and after every durable write,
      worker spawn/return, gate, effect and obligation completion boundary.
- [ ] Execute every fault point with restart and prove exactly-once logical
      outcome.
- [ ] Prove two consumers cannot both own one obligation.
- [ ] Prove a stale consumer cannot complete after its fence is lost.
- [ ] Prove watchdogs observe and issue commands only; they cannot repair SQL.

Exit:

- [ ] Every crash window settles to success, typed wait or truthful terminal.
- [ ] There is no busy-spin recovery loop and no progress inferred from a
      board, heartbeat absence or empty queue.
- [ ] The driver contains no workshop-specific transition branch.

## Phase EK-5 - Development Workplace vertical and ADR-053 material chain

Owner paths: Development adapter, new Workplace application layer, capsule
ingress and simple-server corpus. This is the first hard vertical.

- [ ] Import one content-addressed Discovery+Formalization capsule through
      public ingress into a fresh database.
- [ ] Verify capsule, certificate, requirements, terminal claims, AC set,
      module package, build and base repository digests.
- [ ] Refuse missing/corrupt package bytes, foreign lineage, illegal parent
      state, active attempt and stale protocol with typed reasons.
- [ ] Implement WorkIntent -> ActivityAttempt -> contribution -> production
      revision -> CandidateSet -> gate -> effect -> CellFinalAcceptance through
      the new commands/events/obligations only.
- [ ] Preserve exact author/reviewer/repair identity and revision binding.
- [ ] Route out-of-scope and upstream-material defects to typed repair
      obligations; do not widen Development silently.
- [ ] Make scripted, replay and real actors implement the same cognition port.
- [ ] A scripted actor returns ordinary tool calls/text/products. It may not
      write factory tables, fabricate factory receipts or skip ingress.
- [ ] Define the canonical simple product:
  - [ ] dependency-light Node HTTP server;
  - [ ] `/healthz` endpoint;
  - [ ] `/api/message` returning a deterministic JSON message;
  - [ ] served HTML and JavaScript frontend;
  - [ ] frontend fetches the API and renders the returned value;
  - [ ] package/build/start commands;
  - [ ] unit, loopback HTTP and real browser smoke verification;
  - [ ] local packaging/delivery input without external deployment.
- [ ] Ensure the acceptance contract owns browser entry, static assets,
      bootstrap, build/start wiring and frontend/backend integration.
- [ ] Identify and test the exact deletion set for replaced Development
      dispatch/coordinator/material-selection paths. Keep the new vertical
      reachable only from focused tests until EK-8 deletes those old paths and
      performs the production cutover.
- [ ] Add foreign-ref, stale-revision, missing-integration-surface, duplicate
      completion and malformed-actor mutations.

Exit:

- [ ] One fresh scripted Development run builds, starts and browser-smokes the
      simple product through production composition.
- [ ] Corrupt capsule/material/actor variants fail at their owning boundary.
- [ ] No old Development authority path is reachable.

## Phase EK-6 - Planning, dependency graph and aggregate settlement

Owner paths: planning contract, WorkItem graph, lifecycle/stage/process/node
owners and their tests.

- [ ] Implement immutable WorkItem and dependency creation from the complete
      idea/claim/unknown/integration graph, not ACs alone.
- [ ] Require epic scope equality: covered plus explicit deferred equals
      declared scope.
- [ ] Require terminal-claim equality: owned and verifiable equals required.
- [ ] Require every open unknown, cross-module seam, test surface and
      integration surface to have an owner.
- [ ] Reject circular, jointly unsatisfiable, homeless and zero-obligation
      planning graphs.
- [ ] Implement exact chain, diamond, fan-in, fan-out and independent-branch
      readiness over authoritative predecessor evidence.
- [ ] Implement bounded aggregate commands for Node, Process, Stage and
      Lifecycle.
- [ ] Implement success, truthful failure, cancellation and unreachable
      settlement proofs.
- [ ] Generate forward and reverse observed graphs from committed events and
      evidence, then compare them with the independently declared protocol
      graphs.
- [ ] Prove reviewer work cannot shadow author budget/identity.
- [ ] Prove a failed predecessor cannot leave descendants permanently blocked.
- [ ] Prove parallel independent obligations do not share mutable authority.

Exit:

- [ ] All dependency topologies and terminal outcomes settle under the model.
- [ ] Idea-to-product and terminal-to-source graphs have exact typed equality.
- [ ] No planning or settlement decision reads Kanban/task projection state.

## Phase EK-7 - Kanban, tools, hooks and operator UI as projections

Owner paths: projector, read API, UI and command adapters.

- [ ] Project WorkItems, current aggregate evidence, obligations, waits and
      terminal proofs into Kanban cards.
- [ ] Show TODO, in-progress, review, repair, waiting and terminal columns as
      human views, not workflow inputs.
- [ ] Translate claim, review, stop, resume, retry and human-response actions
      into typed commands.
- [ ] Implement command-only replacements for direct card-status endpoints and
      tools; keep them test-only until EK-8 removes the old endpoints.
- [ ] Remove core reads of `tasks`, `tasks.status`, assigned worker and
      projection-derived dependency state.
- [ ] Delete the old `tasks` scheduling table and its status triggers from the
      new schema; do not leave a compatibility view.
- [ ] Implement full projection rebuild from canonical facts.
- [ ] Add three mandatory mutations:
  - [ ] delete all Kanban rows while work is running;
  - [ ] write false/stale Kanban rows;
  - [ ] stop the projector, finish work, then rebuild.
- [ ] Assert identical normalized authoritative trace and terminal proof in all
      three cases.
- [ ] Verify tools and hooks receive exact context from authoritative commands,
      never by reverse-reading the board.

Exit:

- [ ] Kanban is operationally useful and provably disposable.
- [ ] A repository-wide ratchet finds no production scheduling, dependency,
      material, effect or terminal decision based on projection rows.

## Phase EK-8 - Workshop conversion, hard cutover and legacy purge

Owner: bounded workshop-adapter packages plus a dedicated deletion package.

- [ ] Convert Discovery, Formalization, Development and Delivery to the same
      workshop semantic interface:
  - [ ] input/output product schemas;
  - [ ] pure contribution mappings;
  - [ ] installed skills, tools and hooks;
  - [ ] CheckPlans and semantic gates;
  - [ ] idempotent effects;
  - [ ] typed human/external waits.
- [ ] Keep module/package identity in installed manifests, never in kernel
      conditionals.
- [ ] Add a synthetic non-game workshop and prove it requires no new kernel
      transition kind, table, driver or reconciler.
- [ ] Route every workshop through the new obligation driver.
- [ ] Remove every old production coordinator, dispatcher, lifecycle adapter,
      transition reconciler, direct aggregate writer, task-status scheduler,
      recovery SQL writer and old-schema helper classified DELETE in EK-1.
- [ ] Retained pure contracts are moved to their canonical new package; the old
      file and import path are deleted. Do not leave forwarding facades.
- [ ] Delete compatibility fixtures, implementation-mirroring tests and
      retired package resources only after their invariant/mutation replacement
      is blocking.
- [ ] Delete all old database DDL and unsupported database fixtures.
- [ ] Delete feature flags and environment switches that choose old versus new
      runtime.
- [ ] Add `npm run test:legacy-zero` to prove:
  - [ ] every deletion-manifest entry is absent;
  - [ ] every production import resolves only to the new runtime;
  - [ ] forbidden old table/column names do not occur in production SQL;
  - [ ] no migration, adoption or compatibility fallback exists;
  - [ ] no workshop owns a private scheduler/state table.

Exit:

- [ ] The deletion manifest is 100% complete.
- [ ] There is exactly one production orchestration composition.
- [ ] A fresh build and all focused suites pass with no legacy allowlist.

## Phase EK-9 - Universal test engine and blocking CI truth

Owner paths: `tests/workflow-kernel/**`, `tests/project-corpus/**` and new test
drivers. The coordinator owns matrix registration.

### Scenario contract

Define one versioned scenario format containing:

- [ ] protocol/build/package/capsule identities;
- [ ] fresh seed input through public commands;
- [ ] actor program and allowed tool/result sequence;
- [ ] dependency topology and concurrency cap;
- [ ] fault schedule;
- [ ] expected normalized events, obligations, waits and terminal proofs;
- [ ] expected material/gate/effect evidence;
- [ ] product verification commands and time budgets.

Expected outcomes are authored from the independent transition/claim universe,
not copied from production output. Generated IDs, timestamps, leases and paths
are normalized only when they are not semantic.

### Required dimensions

- [ ] actor role: planner, author, reviewer, repairer, certifier;
- [ ] actor behavior: compliant, omission, extra paths, malformed product,
      stale hash, foreign ref, duplicate completion, prose-only review, timeout,
      crash and tool misuse;
- [ ] gate result: accept, repair, upstream repair, human wait and terminal
      reject;
- [ ] effect result: success, already applied, retryable, unknown, human wait
      and policy terminal;
- [ ] dependency: none, chain, diamond, fan-in, fan-out, cycle refusal and
      failed predecessor;
- [ ] restart boundary: before/after every event, evidence, obligation, worker,
      gate, effect and settlement commit;
- [ ] projection state: absent, stale, false, delayed and rebuilt;
- [ ] payload scale: minimum, normal production and current observed maximum;
- [ ] platform: Windows production lane and Linux CI lane;
- [ ] concurrency: 1, exact cap 2, cap saturation with deterministic barrier,
      stale lease and two consumers.

### Engine requirements

- [ ] Drive the pure reference model and production composition from the same
      scenario input.
- [ ] Compare normalized traces and final evidence.
- [ ] Minimize failures while preserving the random seed and fault schedule.
- [ ] Never write authority tables from the harness.
- [ ] Never fabricate factory receipts; use canonical factory signing/digest
      code through public ingress.
- [ ] Support deterministic scripted actors and the real OpenCode cognition
      adapter.
- [ ] Make production-sized fixtures mandatory for budget, review, scale and
      rollover tests.
- [ ] Maintain an independently declared
      `WORKFLOW_OBLIGATION_UNIVERSE` and require declared equals demonstrated.
- [ ] Classify every test file as blocking. The new suite has no quarantine,
      shadow or unhosted category.
- [ ] Fail CI if a test, driver, universe, corpus or removal guard is deleted or
      de-hosted.
- [ ] Add mutation tokens for every architecture law and establish a
      non-decreasing kill-rate floor from the first honest run.

### Blocking commands

Create and host these stable commands:

- [ ] `npm run test:workflow-model`;
- [ ] `npm run test:workflow-persistence`;
- [ ] `npm run test:workflow-faults`;
- [ ] `npm run test:development-capsule`;
- [ ] `npm run test:project-corpus`;
- [ ] `npm run test:legacy-zero`;
- [ ] `npm run test:docs-current`.
- [ ] `npm run qualify:development`;
- [ ] `npm run qualify:projects:scripted`;
- [ ] `npm run qualify:projects:real`.

Also keep the canonical aggregate commands green:

- [ ] `npm run build`;
- [ ] `npm run test:architecture`;
- [ ] `npm run test:factory-model`;
- [ ] `npm run test:factory-temporal`;
- [ ] `npm run test:factory-contract`;
- [ ] `npm run test:process-modules`;
- [ ] `npm run test:acceptance-matrix`;
- [ ] `npm run coverage:factory`;
- [ ] `npm test`.

Exit:

- [ ] Every test file is blocking-hosted and removal guarded.
- [ ] Declared obligations equal demonstrated obligations.
- [ ] Every required mutation is killed.
- [ ] Production-sized and Windows-only behavior has executable evidence.

## Phase EK-10 - Canonical documentation rewrite and purge

Owner: documentation package plus independent link verifier.

### Canonical documents to produce

- [ ] `docs/architecture/WORKFLOW-KERNEL.md`: current owners, commands, events,
      obligations, waits, terminal proofs and projection boundary.
- [ ] `docs/architecture/CONVEYOR-MENTAL-MODEL.md`: rewrite to the new protocol.
- [ ] `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`: diagnose from
      persisted obligation/wait/proof evidence only.
- [ ] `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md`: new transition and
      fault checklist.
- [ ] `docs/operations/FACTORY-RUNBOOK.md`: fresh DB start, OpenCode setup,
      stop/resume, evidence and unsupported-old-DB behavior.
- [ ] `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md`: scenario contract,
      universe, fault matrix and project qualification.
- [ ] `docs/CURRENT-DOCUMENTS.md`: the sole active documentation index.
- [ ] Update `AGENTS.md` so a first-time agent reads the new kernel, runbook and
      test strategy before changing production code.

### Delete, do not archive

- [ ] Delete completed/superseded execution plans, handoff briefs, stage/night
      trackers, old live-status pages, duplicate quickstarts and stale reports.
- [ ] Delete old static forward/reverse maps after the new generated maps and
      reconciliation command are blocking.
- [ ] Delete the old workshop test plan/status/journal if their current
      information is fully replaced by the new strategy and machine evidence.
- [ ] Delete architecture prose that describes tasks/Kanban, WorkerExecution,
      old coordinators or old tables as production authority.
- [ ] Delete stale package/resource instructions that reference removed tools,
      commands, schemas or runtimes.
- [ ] Keep ADRs as decision history only when registered and truthfully marked
      accepted/superseded/rejected. Delete abandoned unregistered drafts.
- [ ] Keep this plan through qualification. The completed predecessor plan may
      be deleted after its completion SHA and receipt are pinned in the final
      record.
- [ ] Do not create `docs/archive` or another in-tree graveyard.
- [ ] Update every retained link and test fixture after deletion.
- [ ] Add a current-document linter that fails on:
  - [ ] a retained document absent from the active index or explicit ADR list;
  - [ ] a broken link;
  - [ ] a deleted symbol/table/command presented as current;
  - [ ] multiple documents claiming to be the primary runbook/status;
  - [ ] a stale generated graph fingerprint.

Exit:

- [ ] Every documentation-manifest row is resolved.
- [ ] Current docs describe only the new protocol.
- [ ] No broken/stale current instruction remains and no archive directory was
      created.

## Phase EK-11 - Scripted fresh-project qualification

Owner: run operator. No source edits while a series is active.

### Immutable kit

- [ ] Freeze one source SHA, clean `dist`, schema fingerprint, installed package
      digests, scenario universe and actor version.
- [ ] Generate every run from a new empty database path and new repository.
- [ ] Import capsules through public ingress; never copy a database.
- [ ] Record OS, Node/npm versions, environment, build digest and scenario seed.
- [ ] Store evidence under a build-addressed qualification directory.

### Development reliability series

- [ ] Execute `npm run qualify:development -- --kit <kit-manifest>`; the driver
      owns fresh-path provisioning, evidence capture and refusal of a dirty or
      mismatched build.
- [ ] Run the canonical simple served Node/browser product ten times.
- [ ] Use ten fresh databases and repositories.
- [ ] Use the same immutable build and capsule.
- [ ] Require 10/10 terminal successes with identical normalized authority
      traces.
- [ ] Build, start, call `/healthz` and `/api/message`, and execute the real
      browser smoke in every run.
- [ ] Require no manual stop/resume, SQL, repository patch or actor repair.

### Twenty-project scripted corpus

All projects use production composition and a scripted cognition actor. They
exercise product diversity, not game-specific kernel branches.

| ID | Product |
|---|---|
| P01 | Served Node/browser hello product with frontend/API integration |
| P02 | Static browser counter |
| P03 | Command-line text statistics tool |
| P04 | Reusable JavaScript validation library |
| P05 | Todo CRUD web application |
| P06 | CSV-to-JSON command-line transformer |
| P07 | Webhook receiver with validation |
| P08 | Markdown documentation site generator |
| P09 | File-backed notes HTTP service |
| P10 | In-memory job-queue simulator |
| P11 | Read-only metrics dashboard |
| P12 | JSON-Schema validator package |
| P13 | SQLite inventory application |
| P14 | Multi-module event processor |
| P15 | REST service with an operator frontend |
| P16 | Local release packager with idempotent effect receipt |
| P17 | Configuration linter with machine-readable output |
| P18 | Import/export application with recovery path |
| P19 | Small canvas game with keyboard input and browser smoke |
| P20 | Full-stack expense tracker with persistence and tests |

- [ ] Give every project a versioned input capsule, claim graph, actor program,
      verifier and maximum duration.
- [ ] Execute
      `npm run qualify:projects:scripted -- --kit <kit-manifest> --all`.
- [ ] Run 20/20 from fresh database/repository paths.
- [ ] Verify actual product outputs, not factory statuses alone.
- [ ] Require build/test/start evidence appropriate to each product.
- [ ] Require browser smoke for browser products and command/API smoke for
      non-browser products.
- [ ] Require local Delivery/package effect receipts without external
      publication.
- [ ] Run four independent scripted projects concurrently with isolated
      databases/repositories and prove no cross-run identity or material leak.
- [ ] Run a within-project diamond at concurrency cap 2 with a deterministic
      barrier and prove peak equals 2 without timing-based assertions.

Exit:

- [ ] Development reliability is 10/10.
- [ ] Scripted product diversity is 20/20.
- [ ] Serial, parallel, restart and projection-corruption traces satisfy the
      same architecture invariants.

## Phase EK-12 - Real OpenCode full-conveyor qualification

Owner: run operator. This is a clean reality check, not a debugging loop.

Before each engine start:

```powershell
$env:SAGA_REAL_CLAUDE_PATH = "node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"
$env:SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS = "1"
```

- [ ] Never invoke the Claude CLI directly.
- [ ] Pin the OpenCode provider/model and record it in the run receipt.
- [ ] Verify the `~/.claude/settings.json` tripwire only; never edit that file.
- [ ] Use the exact immutable kit that passed EK-11.
- [ ] Execute
      `npm run qualify:projects:real -- --kit <kit-manifest> --series R1,R2,R3`;
      the driver must refuse a dirty source tree, mismatched `dist` or reused
      database/repository path.
- [ ] Start each project from a new empty database and new repository.
- [ ] Do not modify source, `dist`, package bytes, capsule, database or product
      repository while the three-run series is active.
- [ ] Run these three projects consecutively:
  - [ ] R1: simple served Node/browser API product;
  - [ ] R2: command-line/library product with tests;
  - [ ] R3: full-stack CRUD product with persistence and browser smoke.
- [ ] Require the complete idea -> Discovery -> Formalization -> Development ->
      Delivery path for each run.
- [ ] Require idea/scope/unknown/terminal-claim forward/reverse reconciliation.
- [ ] Verify the produced repository independently: install, build, test,
      start, API/CLI/browser smoke and local delivery receipt.
- [ ] Require no operator repair, manual SQL, hot reload, stale process,
      inherited database or projection dependency.
- [ ] If any run fails, preserve its evidence, add a minimal blocking
      regression, build a new immutable kit, and restart the three-run series
      from R1.

Exit:

- [ ] R1, R2 and R3 are three consecutive successes on one immutable SHA.
- [ ] Every success has a truthful terminal proof and independent product
      verification.
- [ ] Every observed trace is inside the declared transition/claim universe.

## Phase EK-13 - Final qualification, closure and canonical merge

Owner: integration coordinator with independent verifier.

- [ ] Run all EK-9 blocking commands on a clean checkout.
- [ ] Run `npm test` and record exact pass/fail/skip counts and duration.
- [ ] Run the fresh-schema fingerprint and unsupported-old-DB tests.
- [ ] Run legacy-zero and require an empty allowlist.
- [ ] Run current-document/link checks.
- [ ] Re-run authority census and require one owner/writer for every mutable
      fact and no unclassified decision read.
- [ ] Re-run the independently derived forward/reverse graph reconciliation.
- [ ] Rebuild Kanban from zero and compare the terminal evidence.
- [ ] Review EK-11 and EK-12 receipts against the frozen build digest.
- [ ] Update ADR-097 and its closure registry only to the state supported by
      executable evidence.
- [ ] Write `docs/refactoring/event-kernel/FINAL-RECEIPT.md` containing:
  - [ ] predecessor completion SHA and receipt;
  - [ ] final source/build/schema/package/corpus digests;
  - [ ] authority and deletion summaries;
  - [ ] test command counts;
  - [ ] mutation and fault-schedule results;
  - [ ] 10-run, 20-project and 3-run qualification tables;
  - [ ] exact known residuals, if any.
- [ ] A residual in an architecture law, legacy deletion, schema policy or
      qualifying run blocks completion; it may not be relabeled as follow-up.
- [ ] Fast-forward `saga4` to the reviewed final SHA.
- [ ] Remove temporary branches/worktrees only after their commits are
      ancestors of `saga4` and their worktrees are clean.
- [ ] Verify no valuable unique commit exists only on a disposable branch.

Final exit:

- [ ] All phases are complete.
- [ ] `saga4` is clean and points at the qualified SHA.
- [ ] Only the new production protocol is reachable.
- [ ] Legacy source/schema/fixtures/docs are absent.
- [ ] The immutable project qualification evidence is reproducible.

## Standard subagent work order

The coordinator must fill this template for every subagent:

```text
Work package:
Role: implementer | independent verifier | adversarial reviewer | run operator
Integration base SHA:
Owned paths:
Forbidden paths:
Required reading:
Objective:
Architecture laws exercised:
Exact changes or counterexamples requested:
Legacy entries that must be deleted:
Required positive tests:
Required deliberate RED mutation:
Required blocking commands:
Exit criteria:
Handoff format:
```

Every implementation handoff must include:

- [ ] one focused logical commit;
- [ ] exact diff and deletion list;
- [ ] commands and pass/fail/skip counts;
- [ ] deliberate RED result before the production fix or equivalent mutation;
- [ ] GREEN result after the fix;
- [ ] remaining risks and any assumption made;
- [ ] confirmation that no oracle, scope fence, semantic gate or source ratchet
      was weakened.

## Stop and refusal rules

- Stop if the predecessor gate is incomplete.
- Stop if a work package would require migration or compatibility with an old
  database.
- Stop if the old and new authority would both be reachable after landing.
- Stop if an agent cannot name the owner, command, event, obligation and proof
  for a changed transition.
- Stop if expected results were copied from production output.
- Stop if a project run needs a manual database/repository/build repair.
- Stop if an implementation-specific regression is deleted before its
  replacement invariant and mutation test are blocking.
- Stop if a stale document is moved to an archive instead of deleted.
- Stop if a failure is hidden by quarantine, skip, timeout inflation or oracle
  weakening.
- Preserve the counterexample, return the package to its owning phase, and
  restart qualification only from a new immutable build.
