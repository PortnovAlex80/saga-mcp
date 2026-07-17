# GoF Patterns Under Parallel-Agent Implementation: A saga-mcp Analysis

> **Source:** research agent run 2026-07-17, subagent `agent_6bde8e4a`.
> **Context:** Private research on agent-oriented software engineering.
> saga-mcp = MCP server governing N parallel LLM coding agents in isolated git worktrees merging through a lock.

## Thesis

The Gang of Four catalogue (1994) was written for a single team editing one codebase through shared working memory. Under parallel-agent development — N LLM workers each in isolated git worktree, merging through a lock, with no shared session memory — patterns split along a single axis:

**Where does the pattern pay its coordination cost?**

- At **edit/compile time** (interface conformance, per-class signatures) → survives unchanged
- At **runtime, in a shared process** (mutable registries, subscriber lists, dispatch tables) → breaks or must be hoisted to artifact time
- **Across an open set on two axes** (Expression Problem: Visitor's elements×operations, Mediator's ever-growing colleague set) → breaks fundamentally

## Classification axis

| Question | A | B | C |
|---|---|---|---|
| Can N workers implement N parts in parallel against a frozen contract? | Yes, trivially | Yes, with one extra coordination artifact | No — parts are mutually recursive |
| Where is the coordination cost paid? | Edit time (per-file) | One declared artifact + one composition task | Runtime shared state or open-set enumeration |
| Does it need a global, mutable, runtime structure? | No | Replaceable with declared artifact | Yes, irreducibly |

**Result: A = 12, B = 7, C = 4.**

## Classification at a glance

| # | Pattern | Class | One-line reason |
|---|---|---|---|
| 1 | Abstract Factory | **B** | Product families need type-consistency contract (FR freeze) |
| 2 | Builder | **A** | Director is one task; builders independent |
| 3 | Factory Method | **A** | Subclass override; no registry |
| 4 | Prototype | **A** | Self-cloning; no factory required by the pattern |
| 5 | Singleton | **C** | Global mutable lazy-init; per-worktree instances diverge |
| 6 | Adapter | **A** | Frozen Target; per-Adapter file |
| 7 | Bridge | **A** | Designed for parallel evolution of two axes |
| 8 | Composite | **A** | Leaves add independently; composition is one task |
| 9 | Decorator | **B** | Stacking order is wiring; needs decision artifact |
| 10 | Facade | **A** | Single-owner thin wrapper over independent modules |
| 11 | Flyweight | **B** | Factory is a registry; make it declared + generated |
| 12 | Proxy | **A** | Adapter with same interface; watch for Singleton real-subject |
| 13 | Chain of Resp. | **B** | Chain order is wiring; needs decision artifact |
| 14 | Command | **A** | Each command encapsulates receiver; invoker decoupled |
| 15 | Interpreter | **A** | Frozen grammar + independent expressions |
| 16 | Iterator | **A** | Leaf computation; no cross-iterator state |
| 17 | Mediator | **C** | Closed-enumeration bus; adding colleague edits Mediator |
| 18 | Memento | **C** | Snapshots span worker boundaries; wide interface crosses impl |
| 19 | Observer | **B** | Replace subscriber list with append-only event log |
| 20 | State | **B** | Transition table must be frozen as decision |
| 21 | Strategy | **B** | Roster + selector become declared decision + generated dispatch |
| 22 | Template Method | **A** | Hooks are independent overrides |
| 23 | Visitor | **C** | Double dispatch over open set; Expression Problem made acute |

## The saga-mcp coordination model

Grounded primitives:
- **Git worktrees** — each worker commits to `task/<id>` against isolated checkout, no visibility of others' uncommitted code
- **Merge-lock** — typed tasks lock only their `project_repository`; different repositories merge concurrently
- **Typed artifacts** — PRD/SRS/UC/AC/FR/NFR/decision with status (draft→in_review→accepted→superseded), content_hash, drift detection
- **Traces** — directed edges with types covers/implements/derived_from/depends_on/verified_by/superseded_by
- **Conflict keys (REQ-010)** — per-task (key_type, key_value) over file_path/schema/public_protocol/integration_branch
- **Observations (REQ-011)** — append-only runtime records (benchmark/canary/shadow/incident/runtime_metric)
- **Episodes and stages** — discovery→formalization→planning→development→verification→integration→completed, with hard gates

Crucial property: **the only durable shared state across workers is the saga DB.** Anything not expressed as artifact/trace/conflict_key/observation is invisible to other workers until merge.

## CLASS A — Survives unchanged (12 patterns)

Frozen interface + N independent implementers. Conflict only on file paths (caught by `conflict_keys(file_path=…)` at planning time).

| Pattern | Frozen contract | Parallelizable units |
|---|---|---|
| Adapter | Target interface | Each Adapter |
| Bridge | Implementor interface | Each ConcreteImplementor |
| Composite | Component interface | Each Leaf; tree assembly one task |
| Facade | Subsystem boundaries | Each subsystem; Facade one task |
| Proxy | Subject interface | Each Proxy variant |
| Iterator | Iterator interface | Each ConcreteIterator |
| Command | Command interface | Each ConcreteCommand |
| Factory Method | Creator's factory method | Each ConcreteCreator |
| Prototype | clone contract | Each ConcretePrototype |
| Builder | Builder interface + assembly protocol | Each ConcreteBuilder; Director one task |
| Interpreter | AbstractExpression + frozen grammar | Each TerminalExpression/NonterminalExpression |
| Template Method | Template's algorithm skeleton | Each ConcreteClass's hook overrides |

### Notable nuances

- **Proxy** is structurally Adapter where Target==Subject; **watch**: virtual/protection proxies often wrap a Singleton-ish "real subject" — if so, proxy inherits Class-C problem. saga-architect should reject proxy tasks whose `source_ref` resolves to a Singleton.
- **Interpreter** survives *if the grammar is closed* and frozen as SRS artifact. Open grammar degenerates toward Visitor failure mode.
- **Builder** product assembly protocol must be frozen in Builder interface FR — if workers invent their own order, products diverge.

## CLASS B — Adapts with modification (7 patterns)

Parallelizable in parts but require one extra declared artifact + single composition task.

| Pattern | What breaks | Declared artifact that fixes it |
|---|---|---|
| Abstract Factory | Product families must be type-consistent | Frozen abstract ProductA, ProductB as FRs |
| Strategy | Selection logic + roster is runtime | Strategy interface FR; roster as `decision` artifact |
| Decorator | Stacking order is wiring | Stacking rules as `decision` |
| State | Transitions are closed enumeration | Transition table as `decision` artifact |
| Chain of Resp. | Chain order is wiring | Chain order as `decision` |
| Observer | Mutable subscriber registry | Event taxonomy FR; append-only log as substrate |
| Flyweight | Shared factory/cache is registry | Intrinsic-state schemas FRs; factory code-gen |

### Observer — the key B→agent-aware substitution

Replace in-process subscriber list with **append-only event log** — saga's `observation_record` (REQ-011) is the native form. Producers emit; consumers are projections; log order is total and unambiguous. No mutable registry, no race on subscriber lists.

### Strategy — registry as generated code

Replace in-process Strategy registry with **explicit port registry**: a `decision` artifact enumerates `(key → strategy_task_id)` mappings; a code-gen task materializes the dispatch table. Hand-editing the registry file is forbidden; `conflict_keys(file_path=<registry-file>)` would otherwise serialize it.

## CLASS C — Breaks fundamentally (4 patterns)

Cannot be implemented by parallel workers against frozen contract — correctness depends on runtime structure two workers would both mutate, or on open set enumerated across two mutually-recursive axes.

### Singleton (C)

**How it breaks.** Each worker's worktree has its own process image; no shared "the process." Three workers each `getInstance()` get three instances. Global access point is a hidden dependency: any task calling `getInstance()` depends on the Singleton's task, but dependency is invisible to saga's `depends_on` graph until declared. Lazy initialization across merge boundaries is non-deterministic.

**Agent-aware replacement — Port + Composition Root.** Replace `Singleton` with a typed port (frozen interface as AC). Any task needing instance depends on port. Single composition root task binds concrete instance at integration stage. The saga-native Singleton is a *port bound at integration time*, not a runtime instance.

### Mediator (C)

**How it breaks.** Mediator is a closed enumeration of colleagues that grows monotonically. Adding Colleague edits the Mediator (it must know new colleague, route its events, handle lifecycle). Three agents adding three colleagues → all three edit same Mediator file → merge conflicts every time. Also carries hidden coupling: every Colleague's task depends on Mediator's task, Mediator depends on every Colleague — cycle in dependency graph.

**Agent-aware replacement — Event log + declared routing.** Each Colleague exposes typed port. "Mediation" is append-only event log; Colleagues emit events, consume events. Routing logic in single wiring task reading `decision` artifact declaring routing table. Where synchronous mediation essential: make Mediator a *generated* class from `decision` artifact.

### Visitor (C)

**How it breaks — the Expression Problem made acute.** Double dispatch. Adding ConcreteElement requires adding `visit(NewElement)` to *every* Visitor. Three agents adding three elements → each edits every Visitor file → merge conflicts on every Visitor, every time. Conflict surface grows quadratically with element set, in *interface* code (most shared, most fragile).

**Agent-aware replacement — three options:**
1. **Close the element set** — declare full ConcreteElement type list as `decision` at formalization. Frozen for episode duration. Extension becomes new episode.
2. **Typeclass/trait dispatch** — Rust traits, Haskell typeclasses, TypeScript structural interfaces with generic visitors. Each `(Type, Operation)` cell is independent file.
3. **Pattern match in single composition task** — matrix lives in one task; workers implement cells (one function per pair, each in own file); composition task imports and dispatches. Matrix generated from `decision` artifact.

### Memento (C)

**How it breaks on two axes.**
- *Wide interface crosses impl boundaries* — shared between Originator and Caretaker. If different tasks, they must agree on serialization format. Drift → silent corruption: undo restores garbage state.
- *Snapshots span worker boundaries* — Memento usually deployed for whole-system state. Under saga, no worker sees whole system. Snapshot scope is larger than any single worker's view.

**Agent-aware replacement — Event sourcing via observation_record.** Replace snapshot objects with append-only event log. Each state change is event; current state is reconstructed by replay. Events are the contract (captured by REQ-011). Time-travel is replay-to-offset-N. Snapshot schema (fallback for crash recovery) declared as FR artifact.

## Five agent-aware meta-patterns (the candidate new catalogue)

Looking across Class B and C replacements, five recurring primitives emerge:

### 1. Port + Composition Root (replaces Singleton, partially Mediator)

Port = frozen interface declared as AC artifact. Composition root = single task binding concrete instances to ports at integration stage. Hidden dependencies become explicit `depends_on` edges. Dependency injection elevated to artifact status.

### 2. Append-only Event Log (replaces Observer, partially Mediator, replaces Memento)

saga's `observation_record` (REQ-011) is the native form. Producers emit; consumers are projections; log order is total. Resolves Observer, simplifies Mediator, replaces Memento. Highest-leverage replacement in the catalogue.

### 3. Closed-Set Decision Artifact (replaces Visitor, constrains Interpreter/Mediator/State)

Force open sets closed at formalization time. Declared as `decision` artifact; extension becomes new episode. Converts runtime-open problem into planning-time-closed one.

### 4. Explicit Port Registry / Code-Generated Dispatch (replaces Strategy registry, Chain wiring, Flyweight factory)

Registry declared as `decision` artifact; materialized by code generation in one task. Hand-editing forbidden; `conflict_keys(file_path=<registry-file>)` removes bottleneck. Same principle as saga's `conflict_keys_auto_derive`.

### 5. Event Sourcing (replaces Memento, supports undo for Command)

State = left-fold of event stream. Snapshots = checkpoints. Undo = truncation. Matched to saga's append-only observation model. Not optimization — the honest model.

## Recommendations for saga-architect

1. **Make classification a gate.** Every pattern instance labeled A/B/C at SRS time. Class C requires explicit agent-aware replacement before dev task claimable. `episode_transition` to development refuses if Class C lacks declared replacement.

2. **Default-deny Singleton** — treat like `eval()`: not forbidden, but requires justification and port-bound alternative. Smell: `getInstance()` / `static get Instance` / module-level mutable singletons.

3. **Default-deny Visitor** — element set must be closed (`decision` artifact) or pattern re-expressed as trait dispatch / pattern-match composition.

4. **Prefer event log over Observer** — any SRS specifying Observer should be challenged: can this be event stream + projection?

5. **Declare registries as decisions, generate dispatch** — Strategy, Chain, Flyweight, Mediator routing.

6. **Use `conflict_keys` proactively** — for Class A: `file_path=<implementer-path>`. For Class B/C shared contracts: `schema=<contract-id>`, `public_protocol=<interface-id>`.

7. **Composition roots are first-class** — each repository's SRS names one composition root task. Without it, ports have no binder and Class C leaks back.

8. **Map five meta-patterns into skill guidance** — `saga-architect` ships with five replacements as named decision templates.

## Implications for research charter

- **Empirical validation** — instrument saga project using all 23 patterns; measure merge-lock contention, conflict-key collisions, rework rate per class. Hypothesis: Class C dominate integration-stage latency.

- **Language dependence** — Rust traits, Haskell typeclasses, Julia multiple dispatch change A/B/C assignment. Language-conditioned catalogue is follow-up.

- **From GoF to agent-native patterns** — five meta-patterns (Port, Event Log, Closed-Set Decision, Generated Registry, Event-Sourced State) as candidates for new catalogue.

- **Composition-root bottleneck** — all Class B/C replacements funnel work into single composition task per repo. Is this fundamental lower bound on parallelism for "coherent" systems?

- **Conflict keys as design tool** — `conflict_keys` introduced (REQ-010) as detection mechanism; this analysis suggests it is also design mechanism. Right conflict keys *are* the design.

- **The third truth axis** — `observation_record` as Memento/Observer replacement suggests runtime events are not just verification evidence but first-class design substrate.
