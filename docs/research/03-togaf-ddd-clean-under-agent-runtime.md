# Classical Architecture Frameworks Under an LLM Executor

> **Source:** research agent run 2026-07-17, subagent `agent_e1da01cf`.
> **Question:** How do TOGAF, DDD, Clean Architecture/Hexagonal, and bytebytego System Design deform when the executor is a parallel LLM agent?
> **Method:** grounded analysis against saga-mcp's verified data model (artifact types, link types, episode stages, conflict keys, verification, risk, observations, typed tasks).

## Scope note

All recommendations are grounded in saga's actual schema: artifact types (`PRD/SRS/UC/AC/FR/NFR/decision/brief/theme`), link types (`covers/implements/derived_from/depends_on/verified_by/superseded_by`), episode stages, conflict keys (`file_path/schema/public_protocol/integration_branch`), 4-valued verification outcome, RiskClass max(), runtime_observations. Per Sign 008: recommendations for future REQ episodes, not claims about current capabilities.

## Recurring structural finding

Every framework assumes a human executor who (a) navigates by reading prose, (b) coordinates by talking, (c) reviews by judgment. An LLM executor inverts all three. The recommendations collectively push saga from **prose sections → typed queryable artifacts**, from **implicit team coordination → explicit conflict keys**, and from **in-process events → persisted observations**.

---

## 1. TOGAF — ADM under agent executor

### 1.1 Phase mapping

| ADM phase | Saga analog | Survives? |
|---|---|---|
| Preliminary | saga-start, GUARDRAILS Signs (ConstitutionVersion-0), AGENTS.md | Yes, unchanged |
| Phase A — Vision | Discovery: brief + decision, saga-kickstart | Yes — discovery IS vision |
| Phase B — Business Architecture | PRD + UC | Survives, thinned |
| Phase C — Information Systems | SRS §2 + data model + schema conflict keys | Survives, thinned |
| Phase D — Technology Architecture | SRS §5 constraints + project_repository bindings | Survives, very thin |
| **Phase E — Opportunities & Solutions** | SRS §2b + artifact_coverage + multi-episode roadmap | **Collapses into formalization + planning** |
| **Phase F — Migration Planning** | saga-planner task decomposition + depends_on graph | **Collapses into planning** |
| Phase G — Implementation Governance | CGAD governance, episode_transition hard gates, cgad-spec-lint v1.0 | Survives strongly — most developed |
| Phase H — Change Management | drift_state, superseded_by traces, ADR supersession | Survives, automated |

### 1.2 The Phase E + F collapse — confirmed with refinement

Phase E and F are separate in TOGAF because **migration has a deployment window**. For LLM-runtime there is **no migration window**: unit of change = episode, unit of integration = merge into `dev`. What TOGAF spreads across Phase E+F, saga collapses into formalization (define building blocks as §2b contract) → planning (decompose into tasks with depends_on).

Refinement: **Transition Architecture survives at different scale.** Each REQ episode is itself a Transition Architecture; multi-episode roadmap (ADR-005's REQ-008→013) is a Transition Architecture chain. ADR-007 confirms: six REQs as six independently-reversible transition states.

### 1.3 Recommendations from TOGAF

1. **Promote §2b from prose to queryable Building-Block registry** — structured, addressable sections (anchors queryable via path), each with public surface, module layout, extension point.
2. **Make `artifact_coverage` mandatory planning-gate input** — Gap Analysis as hard gate.
3. **Model multi-episode roadmaps as Transition Architecture sequences** — queryable, not buried in ADR prose.
4. **Add explicit "out-of-scope" section to SRS** — Statement of Architecture Work discipline.
5. **Treat accepted AC + verified_by evidence as Architecture Contract (Phase G)** — already structurally true, should be named.

---

## 2. DDD — strategic and tactical patterns for agents that cannot see each other

### 2.1 Core tension: DDD assumes conversational modeling

DDD is built on the premise that domain expert + technical team sit in a room, build Ubiquitous Language through conversation, draw Bounded Contexts around team boundaries. The entire framework is social-technical: assumes modeling unit is conversation, coordination unit is team that talks.

LLM-runtime breaks both: agents do not converse to build shared language (they load context window); agents do not coordinate by talking (they read shared state + obey conflict keys).

### 2.2 Bounded Context — boundary relocates, doesn't shrink or grow

For humans: boundary is where you split teams. For agents: boundary is where you split **context windows and merge-conflict surfaces**. A Bounded Context maps to one `project_repository` (or coherent subset), cross-BC communication is cross-repository API contract enforced via `schema`/`public_protocol` conflict keys.

DDD's strategic principle (model each context coherently, translate at boundaries) survives intact; its social mechanism (team conversations to define boundary) is replaced by architect's explicit declaration.

### 2.3 Aggregate — largest unit one worker can implement without seeing another's uncommitted changes

Maps almost exactly to saga's Pattern B (scaffold-then-parallel):
- Scaffold fixes Aggregate Root's public surface (API contract §2b)
- Body tasks fill in internal behavior within boundary
- Root's invariants = CGAD Step 1 "invariants" (ordering, uniqueness, monotonicity)
- conflict_keys ensure two body tasks don't both claim same Aggregate's internals

**Gap:** saga has Aggregate pattern implicitly but doesn't name Aggregate Root's invariants as first-class machine-checkable thing. Invariants buried in prose.

### 2.4 Domain Event — from in-process dispatch to persisted observation

Two workers in separate worktrees don't share process, event bus, or real-time visibility. Domain Event becomes:
1. **Recorded observation** — `runtime_observations` table (REQ-011)
2. **Merge point** — event's effect realized through integration, not dispatch

**Recommendation:** architect should model cross-component events as declared emit/consume contracts + observation types, never as real-time dispatch assumptions.

### 2.5 Ubiquitous Language — matters differently, not less

LLMs sharing embedding space doesn't prevent divergence — two workers can both embed "deposit" and implement two different `deposit()` functions. UL must be **explicit, written, machine-queryable** because there's no reviewer-conversation backstop. The SRS should require a **glossary** mapping each domain term to defining artifact and code symbol.

### 2.6 Context Mapping patterns → saga conflict-key types

| DDD pattern | Saga analog |
|---|---|
| **Shared Kernel** | Scaffold task (Pattern B) — signatures all body tasks conform to |
| **Customer-Supplier** | Generation chain: PRD → SRS → AC → dev task (hard gate enforces supplier accepted before customer starts) |
| **Conformist** | DEFAULT for parallel body tasks — conform to scaffold's API contract |
| **Anticorruption Layer (ACL)** | Adapter in Ports & Adapters terms; `public_protocol` conflict key |
| **Open Host Service** | `public_protocol` conflict key + API contract §2b |
| **Published Language** | `schema` conflict key — persisted data shape multiple components read/write |

**Finding:** saga has already rediscovered most Context Mapping patterns as conflict-key types. Missing is the naming.

### 2.7 Recommendations from DDD

1. **saga-architect MUST emit one Bounded Context declaration per distinct domain** — BCs in scope, mapped to project_repository, set of Aggregates owned.
2. **Context Map section declaring BC-to-BC relationships** (Shared Kernel/Customer-Supplier/ACL) — naming itself forces architect to think about coordination.
3. **Each Aggregate's invariants declared explicitly** — feeds CGAD Step 1/2 freeze-snapshot.
4. **Domain Events as declared emit/consume contracts + recorded observations** — not real-time dispatch.
5. **Ubiquitous Language glossary mapping terms to artifacts and code symbols** — agent-runtime substitute for modeling conversation.

---

## 3. Clean Architecture / Hexagonal / Ports & Adapters

### 3.1 Dependency Rule is executor-invariant

Source dependencies point inward toward domain — claim about complexity management, not about who writes code. Holds whether author is human or LLM.

### 3.2 Ports — from human-readable interfaces to typed queryable registry

Humans navigate ports by reading. Agents navigate by querying. Agent-aware Port:
- **Structured and addressable** — stable anchor (#PORT-EventStore) referenced by path in artifact_create
- **Queryable independently** — "what ports does BC:X define?" without loading SRS
- **Linked to adapters by trace** — each adapter task `implements` its port artifact

Current §2b is seed of this registry but neither structured nor queryable.

### 3.3 Adapters — natural unit of parallel work

Each adapter is one worktree task, with its own `integration_branch` conflict key, `depends_on` the port scaffold, `implements`-tracing the port artifact. Already latent in Pattern B — make it explicit.

### 3.4 Layering — relocates from code folders to artifact types

| Clean Architecture layer | Saga artifact home |
|---|---|
| **Entity** | NFR artifacts + Aggregate invariants (CGAD "invariant" touch class) |
| **Use Case** | UC artifacts (saga-analyst) |
| **Interface** | SRS §2b ports + adapter dev tasks |
| **Infrastructure** | project_repository bindings + integration_branch |

### 3.5 Dependency Rule as trace-direction invariant

Enforceable as future cgad-spec-lint rule: no `depends_on` trace points outward across layers. Reduces to graph-direction check.

### 3.6 Recommendations from Clean Architecture

1. **saga-architect MUST declare each Port as structured addressable SRS section (Port Registry)**.
2. **Each Adapter becomes one dev task with public_protocol/integration_branch conflict key, depends_on port scaffold, implements port artifact**.
3. **Encode Dependency Rule as trace-direction invariant** (future lint rule).
4. **Map four Clean Architecture layers onto artifact types explicitly in skill**.
5. **Scaffold task materializes Port Registry as stubs** — already practice, name it as Shared Kernel materialization.

---

## 4. System Design (bytebytego / Alex Xu) — for agent-built software

### 4.1 Step-by-step: agent-friendly vs agent-hostile

| Step | Agent-friendly? | Notes |
|---|---|---|
| Requirements Clarification | ✅ | Maps to discovery (brief, decision), PRD |
| Capacity Estimation | 🟡 agent-hostile, mostly irrelevant for dev tools | Right-sized down; full estimation for high-traffic targets only |
| High-Level Design | ✅ | Component breakdown = parallelization input |
| Database Design | ✅ | Maps to schema conflict key |
| Interface Design | ✅ | Maps to §2b → Port Registry |
| Design Deep Dive | ✅ THE parallel execution | Interview's sequential deep-dive → saga's parallel development stage |
| Wrap-Up: monitoring | ✅ | NFR-observability + runtime_observations types |
| Wrap-Up: scaling | 🟡 deferred | Future episode informed by real observations |

### 4.2 Recommendations from System Design

1. **Every performance/reliability NFR MUST carry quantitative capacity target** — "p99 < 200ms at 1000 QPS sustained" not just "p99 < 200ms". Target becomes baseline_value for benchmark observations.
2. **Component breakdown must declare parallelizable structure** — each component with owning BC, ports, conflict-key surface.
3. **Data-model design MUST register each persisted schema as `schema` conflict key at planning time**.
4. **Capacity estimation right-sized by product class** — dev-tool/internal-service/user-facing-high-traffic.
5. **Wrap-up monitoring → NFR-observability + declared observation types; scaling-path analysis deferred**.

---

## 5. Synthesis — three recurring deformations + meta-finding

### 5.1 Three recurring deformations

**Deformation 1 — Prose sections become typed queryable artifacts.** Every framework produces documents humans navigate by reading. LLM navigates by querying. Promote structured addressable sub-sections (Building Blocks, BCs, Aggregates, Ports, NFR-capacity-targets) from prose to queryable anchors.

**Deformation 2 — Implicit team coordination becomes explicit conflict keys.** DDD assumes Context Mapping conversations; Clean Architecture assumes reviewers enforce Dependency Rule; TOGAF assumes Phase G humans. For agents all must be declared. Saga has partially rediscovered this: conflict-key types are ACL/Open Host Service/Published Language made explicit.

**Deformation 3 — In-process events become persisted observations read at boundaries.** DDD Domain Events, Clean Architecture's use-case-to-adapter calls, system-design's component interactions all assume single-process flow. For agents none flows in real time — integrates at merge boundaries, observed at runtime. `runtime_observations` table is correct substrate.

### 5.2 Meta-finding: saga has already rediscovered most of this

Saga arrived at structurally similar answers by solving pain of parallel agents breaking each other. Classical frameworks arrived at similar answers by solving pain of human teams breaking each other. **Problems isomorphic; solutions converge.**

What classical frameworks add: **naming and typing discipline.** Make what saga does implicitly → declared, structured, queryable.

### 5.3 Consolidated recommendations (9 skill-upgrade requirements)

**Group A — Structure SRS §2b into queryable registry (convergent across all four):**
1. Building Blocks / Ports / Aggregate Roots declared as structured addressable sections
2. Each with conflict-key surface for parallelization
3. Scaffold task materializes registry as stubs

**Group B — Declare coordination structure explicitly (DDD-informed):**
4. Bounded Context declarations per distinct domain
5. Aggregate invariants declared per BC
6. Context Map section declaring BC-to-BC relationships
7. Ubiquitous Language glossary

**Group C — Right-size system-design discipline:**
8. NFRs carry quantitative capacity targets
9. Cross-component interactions as emit/consume contracts + observation types

**Group D — Enforcement (mechanism, not discipline):**
10. (Future REQ) Extend cgad-spec-lint: trace direction obeys Dependency Rule; every Port has adapter task; every Aggregate invariant has CGAD Step-1 intercept.

### 5.4 What does NOT transfer

1. **TOGAF Phase F calendar-window migration planning** — depends_on graph replaces entirely
2. **DDD modeling conversations as boundary-definition mechanism** — boundaries declared by architect, not negotiated
3. **System-design capacity estimation as universal early step** — right-sized by product class

### 5.5 Scope honesty (Sign 008)

Proposed structured sections, implicit artifact roles (Port, BoundedContext, Aggregate), and potential lint rules do NOT exist today. Per Sign 008: recommendations for future REQ episodes. Cheapest first step requires no schema change — saga-architect skill upgrade requiring structured addressable SRS sections using markdown anchors. Schema-level promotions follow only if structured-section discipline proves load-bearing.
