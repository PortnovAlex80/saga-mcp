# Research Charter (DRAFT): Agent-Oriented Software Engineering

> **Status:** Draft v0.1 — pending synthesis of 7 research reports (4 complete, 3 running).
> **Mode:** Private research for saga-mcp framework strengthening + working blog post discussion.
> **Not a publication** — research-to-product, not research-to-paper.

## 1. The Research Thesis

Classical SDLC and code architecture principles — SRP, Clean Architecture layers, DDD, GoF patterns, test pyramid, TOGAF phases — were optimized across 30+ years for a specific executor: the **human engineer**. Every "best practice" embeds an assumption about human cognition:

- Small files, because human working memory is 7±2 (Miller's Law)
- Single Responsibility, because humans lose track of multi-purpose units
- Layered architecture, because humans navigate by reading top-to-bottom
- DRY, because humans forget where code lives and duplicate it
- Code review as social process, because humans reason by conversation
- Test pyramid ratios, because human execution/maintenance time dominates cost

The LLM coding agent inverts the executor's cognitive profile:

| Constraint | Human | LLM Agent |
|---|---|---|
| Working memory | 7±2 concepts | 100K-2M tokens in single context |
| Persistent memory across sessions | ✅ days/weeks | ❌ zero (stateless per launch) |
| Reading speed | ~300 lines/hour | instant pattern-match |
| Aesthetic judgment | strong (smells spaghetti) | weak (no aesthetic preference) |
| Global coherence reasoning | strong (causal) | weak (pattern-match over reasoning) |
| Parallelism | 1 thread per engineer | N workers concurrent |
| Self-evaluation | honest (social signaling) | confidently wrong (optimizes for plausibility) |

**The thesis is not "agents are better" or "agents are worse" — it is that they are different, and architecture optimized for one profile is sub-optimal for the other.**

## 2. The Central Paradox (TRIZ-formulated)

Applying TRIZ to the LLM-runtime constraint surfaces a **physical contradiction**:

> **Parameter:** Size of the code unit an agent works with.
> **Requirement A (for context efficiency):** LARGE — load one cohesive block into context, avoid expensive transitions (context reloads between files cost tokens, time, and lose coherent state).
> **Requirement B (for discoverability and isolation):** SMALL — find dependencies instantly without reading large files, isolate blast radius, avoid "spaghetti inside a monolith".

Classical SRP goes all-in on B. The naive "big cohesive block" reaction goes all-in on A. Both fail:
- All-A → monolithic spaghetti (unmanageable inside the block)
- All-B → many small files, each transition costs context, total system coherence lost

## 3. Resolution: Dimensional Asymmetry (TRIZ synthesis)

TRIZ resolves the physical contradiction by **separation along a new dimension** and **transition to a supersystem**. We propose:

### Principle: "Constellation Architecture"

A module is **two-faced**, not one-file:

```
module/
├── face.md         ← Discovery surface (small, structured, queryable)
└── body/           ← Implementation (large, cohesive, bounded by face)
```

**Face** — the discovery surface:
- Exports: public API (signatures)
- Consumes: list of consumed ports (typed dependencies)
- Protects: invariants the module enforces
- Conflict keys: file_path, schema, public_protocol, integration_branch
- *Small (~50-200 lines). Queryable via saga DB. Does NOT require opening body.*

**Body** — the implementation:
- Free internal organization (functions, classes, dataclasses — whatever is cohesive)
- Bounded by Face: cannot export/import anything not declared in Face
- Large acceptable (1000-3000 lines OK if cohesive and self-contained)
- One worktree task = one Body modification

**Link** — dependencies are NOT runtime code imports. They are **typed edges in the artifact graph** (saga DB). When module A "uses" module B, saga DB carries a trace edge; agents query the trace, get B's Face, never touch B's Body unless explicitly loading it.

### TRIZ precedents in this resolution

| TRIZ principle applied | How |
|---|---|
| **#1 Segmentation** | Split module into Face (discovery) + Body (implementation) |
| **#5 Combination** | Body combines everything needed for one capability into one cohesive unit |
| **#7 Nesting (Matryoshka)** | Body is nested inside Face; external world sees only Face |
| **#17 Transition to another dimension** | Dependencies live in artifact graph (DB), not in code text |
| **#19 Periodic action** | Discovery (Face query) and Execution (Body load) are separate phases in time |
| **#25 Self-service** | Face is self-describing; agents don't need human memory to navigate |
| **#35 Parameter change** | Module "size" stops being a physical attribute; it's an emergent property of Face/Body asymmetry |

### Why this is NOT just IDL / WSDL / TypeScript interfaces

Classical interface-implementation separation (CORBA IDL, WSDL, TS interfaces, Rust traits) exists, but:
- It serves **interoperability** (cross-language, cross-process, cross-team) — not LLM context management
- Interfaces are **compiled together with implementations** in the same artifact; they don't exist as standalone queryable registries
- No typed graph holds the cross-module dependencies; the compiler resolves them, throws away the graph

Our proposal:
- Face is a **first-class queryable artifact** (lives in saga DB with content_hash, drift detection)
- Body is **isolated** from other Bodies — saga enforces no undeclared cross-body references
- The artifact graph is the **source of truth** for dependencies, not the compiler

## 4. What this implies for saga-mcp

### 4.1 New artifact types (proposed)

- `Module` — represents a Constellation module (Face + Body)
- `Port` — abstract contract declared in a Module's Face
- `Invariant` — protected property of a Module's Body
- (These may initially be structured SRS sections rather than new artifact types — Sign 008 scope honesty)

### 4.2 New trace link types (proposed)

Current: `covers, implements, derived_from, depends_on, verified_by, superseded_by` (6 types)

Proposed additions:
- `exports` — Module exports Port/Symbol
- `consumes` — Module consumes Port
- `protects` — Module protects Invariant
- `leases` — Module leases a Resource (file_path, schema, etc.)

### 4.3 saga-architect skill upgrade

Currently the architect writes SRS §2b as prose with function signatures. Proposed:
- SRS §2 becomes a **Module Manifest**: list of Constellation modules, each with Face summary
- §2b becomes per-module **Port Registry** (structured, addressable)
- Scaffold task materializes Faces as `face.md` files + Body stubs as `body/*.py`
- Body tasks fill implementations; lint enforces Body-Export-Matches-Face

### 4.4 cgad-spec-lint rules (proposed, future REQs)

- **R18 — Face declared for every module** (warning if §2 lists a module without a `face.md` path)
- **R19 — Body export/import matches Face** (error if Body has symbols/imports not in Face — requires AST analysis, future)
- **R20 — Dependency is a trace** (warning if two modules import each other in code but no `consumes/exports` trace exists in DB)
- **R21 — Cohesion bound** (warning if Face.exports > 15 — module may be doing too much; consider split)

## 5. Hypotheses (testable through saga experiments)

- **H1**: Codebases authored under Constellation Architecture produce fewer merge conflicts than under classical SRP, when built by N parallel agents.
- **H2**: Agent time-to-completion is lower for Body tasks in Constellation modules than for equivalent SRP-decomposed tasks (fewer transitions).
- **H3**: Property tests (L3) are more effective than example tests (L2) for catching agent-introduced bugs in algorithmic modules.
- **H4**: SAST as Trusted Provider raises the floor of agent-written code security without changing the ceiling.
- **H5**: Typed contract registry (Face) reduces agent "lost in codebase" incidents vs prose SRS.
- **H6**: Bounded Context ≈ Constellation Module (DDD alignment — hypothesis from TOGAF/DDD/Clean analysis).

## 6. Experimental methodology

saga-mcp is the experimental platform. Each smoke-test run is an experiment:

1. Frame hypothesis (H1..H6)
2. Construct treatment SRS (e.g., water-cannon with Constellation Architecture)
3. Construct baseline SRS (water-cannon with classical SRP)
4. Run both through saga flow (discovery → planning → development → verification)
5. Capture observations: merge conflicts, time-to-completion, test outcomes, agent confusion markers (changes_requested counts)
6. Record via `observation_record` with observation_type='benchmark'
7. Refine hypothesis

## 7. Existing saga-mcp findings (12 datapoints supporting the thesis)

These are already-shipped features that respond to specific LLM constraints:

| saga feature | LLM constraint addressed | Evidence |
|---|---|---|
| `completeness-gate` | LLM loses inputs between sessions | Sign 001 |
| `accepted_hash + drift_state` | LLM may resume against stale spec | CGAD §22 §32 |
| `stop:true` + `projectname.txt` | LLM has no persistent memory | saga-worker SKILL |
| `role:<name>` task isolation | LLM gets overwhelmed by other-role context | saga dispatcher |
| Pattern B scaffold | LLM workers can't coordinate via conversation | Sign 002 |
| Hard gates on episode_transition | LLM self-evaluates as done prematurely | lifecycle.ts |
| 4-valued verdict (passed/failed/unknown/error) | LLM conflates "I couldn't check" with "it passed" | REQ-008 |
| RiskClass max() with policy_minimum | LLM self-lowers risk to skip checks | REQ-009, P15 |
| Semantic conflict keys | Git merge conflicts are not the only conflicts | REQ-010 |
| Runtime observation store | Runtime behavior is third truth axis, not acceptance oracle | REQ-011 |
| cgad-spec-lint 12 rules | LLM-reasoning as guard input is unreliable | REQ-012 |
| Decision matrix ≥3×≥2 in kickstart | LLM invents fake consensus | saga-kickstart SKILL |

## 8. Open questions (not yet answered)

- **OQ1**: Does the Face/Body split work for stateful systems, or only for pure-function modules?
- **OQ2**: How to enforce "Body cannot import undeclared dependency" without a custom linter per language?
- **OQ3**: Should Faces be machine-readable (YAML/JSON) or human-readable (markdown with anchors)? Both? Different audiences?
- **OQ4**: Where does polymorphism live? (Resolved: in Port registry + Adapter composition root, not in runtime vtable — see GoF analysis)
- **OQ5**: How to bootstrap? Existing codebases don't have Faces. Migration path?
- **OQ6**: Is "Constellation Module" === "Bounded Context" === "Aggregate"? Are these three names for the same boundary, or different?

## 9. Roadmap

1. **Synthesize 7 research reports** (4 done, 3 in flight) → this charter updated
2. **Write working blog post** for internal discussion ("Agent-Oriented SE: the locality-discoverability paradox and Constellation Architecture")
3. **Design Exp-1** (water-cannon under Constellation vs classical SRP)
4. **Implement minimum viable Face/Body support in saga-architect skill** (no schema change, structured SRS sections)
5. **Run Exp-1**, capture observations, refine

## 10. Sources

(pending — to be populated from 7 research reports at `docs/research/01-04-*.md` plus the 3 in-flight reports on Fowler/Evans/Uncle Bob, Face/Body precedents, and 2024-2026 essays)
