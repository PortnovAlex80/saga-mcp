# Research Charter v1.0 (SKELETON — pending critic synthesis)

> **Status:** Skeleton. Stable facts from 7 reports are filled in. Contested claims marked `[CRITIC-PENDING]` awaiting 6 parallel critic reports.
> **Plan:** (A) Charter → (B) Blog Post → (C) Skill Upgrade.

---

## 1. Research Framing

**Mode:** Private research to strengthen saga-mcp framework. For internal blog/discussion, not academic publication.

**Working hypothesis:** Classical SDLC and code architecture principles (SRP, Clean Architecture layers, DDD, GoF, test pyramid, TOGAF phases) encode implicit assumptions about the executor's cognitive profile. The LLM coding agent inverts this profile, making some principles counterproductive, some in need of adaptation, and opening space for new principles.

**Status of the hypothesis after 7 reports:** The diagnosis (Claim 1 below) is under-articulated by named thought leaders (Report 06). The cure (Constellation Architecture) is a novel synthesis of precedented parts (Report 07).

---

## 2. Three claims and their current standing

### Claim 1: The cognitive-profile mismatch (diagnosis)
> "Classical rules were optimized for human cognition (7±2 working memory, persistent long-term memory, slow sequential reading, aesthetic judgment). LLM agents have an inverted profile (huge context, no cross-session memory, instant pattern-matching, weak global coherence). Rules tuned for one are suboptimal for the other."

**Standing:** Conceptually supported by OpenAI "harness engineering" (map not manual) and Maintainable Software (agentic codebase principles). Not yet explicitly stated by Fowler, Evans, Uncle Bob, Newman, Cockburn, or Booch (Report 06). Kevlin Henney comes closest but inverts the prescription.

`[CRITIC-PENDING: Critic #1 (Henney successor) and #5 (DDD traditionalist) will challenge whether SRP is actually about cognition or about Parnas-style change-frequency clustering.]`

### Claim 2: The paradox (problem statement)
> "Agents need LARGE cohesive blocks (to avoid context-reloading transitions) but also need FINE discoverability (to find dependencies without reading large files)."

**Standing:** Both halves supported by industry essays (Report 05: Anthropic context engineering F2, Aider repo map F6, Sourcegraph SCIP F8). BUT the "large cohesive block" half is contradicted by practitioner consensus favoring small modular files (Report 05: F10, F14).

`[CRITIC-PENDING: Critic #2 (empirical skeptic) and #3 (practitioner) will stress-test whether the paradox is real or a false dichotomy that larger context windows already solve.]`

### Claim 3: Constellation Architecture (proposed resolution)
> "Modules should be authored as two-faced: a small queryable Face (registry of exports, consumes, invariants, conflict keys) + a large cohesive Body (implementation), linked via a typed artifact graph rather than textual code imports."

**Standing:** Novel synthesis (Report 07). Face concept has precedents in OCaml signatures (strongest theoretical grounding), WASM WIT (best modern Face format), seL4 CSpace (capability-graph metaphor). Body concept has precedents in Unix processes, Actor model, seL4 protection domains. Linkage concept has precedent in Luna graph-based languages and INCOSE traceability matrices. None of these precedents optimized for LLM context economics.

`[CRITIC-PENDING: Critic #4 (seL4 purist) will challenge whether the analogies hold formally. Critic #6 (type theorist) will challenge whether Face is a type or a comment.]`

---

## 3. The Central Paradox (TRIZ formulation)

[unchanged from v0.1 — this is structural, critics won't touch the formulation]

**Physical contradiction:** Module size must be LARGE (for context efficiency, avoid transitions) AND SMALL (for discoverability, isolate blast radius, avoid spaghetti).

**TRIZ resolution principles applied:**
- #1 Segmentation: Face (discovery) + Body (implementation)
- #7 Nesting: Body nested inside Face
- #17 Transition to another dimension: Dependencies in artifact graph, not code text
- #25 Self-service: Face is self-describing

---

## 4. What is settled (from 7 reports, critics won't overturn)

These are empirical findings from literature/industry, not our claims:

1. **Contract-first is dominant practitioner pattern** (OpenAI harness, Spec Kit, scaffolding, Fowler) — Report 05 T1
2. **Progressive disclosure is emerging context-management principle** (Anthropic Skills two-tier design) — Report 05 T2, F3
3. **Navigation tooling compensates for codebase structure** (Aider repomap, Cursor indexing, Sourcegraph SCIP) — Report 05 T3
4. **Wrong context is worse than less context** (AGENTS.md can reduce success by 20%+) — Report 05 F10
5. **Lost-in-the-middle effect is real** (Liu et al. TACL 2024) — Report 05 F11
6. **Agent code is architecturally smellier than human code** (89.3% of issues are code smells, not bugs) — Report 02 arXiv 2603.28592
7. **Saga-mcp has already rediscovered DDD Context Mapping patterns as conflict_key types** — Report 03 §2.6
8. **Current AC-verification is NOT independent** (re-runs Builder's tests) — Report 04 §7
9. **Property tests (L3) are more agent-resistant than example tests (L2)** for algorithmic ACs — Report 04 §1.4
10. **No thought leader has published the cognitive-profile-mismatch framing** — Report 06

---

## 5. What is contested (awaiting critic reports)

`[CRITIC-PENDING — 6 items]`

1. **Is "large cohesive Body" actually right?** Industry consensus (Report 05 F14) says small files. Our proposal says Body can be 1000-3000 lines. Resolution may be: "small cohesive files within a Body directory" — but this needs Critic #2 and #3 to surface the real constraint.

2. **Is Face a type or a comment?** If no compiler checks Body against Face, Face is documentation. Critic #6 will demand formal enforcement. Resolution may be: Face + lint rule (AST check) + drift detection (content_hash). This is weaker than OCaml's compiler-checked signatures but stronger than a comment.

3. **Does DDD survive without the social process?** Critic #5 will argue BC without Event Storming is arbitrary. Resolution may be: the architect agent performs a structured discovery (saga-kickstart already does decision-matrix-based triage) that substitutes for Event Storming.

4. **Are the seL4/Actor analogies formally correct?** Critic #4 will distinguish runtime isolation from authoring-time separation. Resolution may be: the analogies are *inspirational*, not *formal* — saga DB is not a microkernel, but the capability-graph *pattern* informs Face design.

5. **Is the paradox real or already solved?** Critic #3 will argue 1M-token context windows make the "transitions are expensive" claim obsolete. Resolution may be: transitions are expensive not because of tokens, but because of *coherence loss* (agent forgets the big picture when reloading).

6. **What is the falsification test?** Critic #2 will demand an experiment that could prove us wrong. Candidate: run water-cannon under Constellation vs classical SRP, measure (a) merge conflicts, (b) agent changes_requested rate, (c) time-to-completion.

---

## 6. Proposed Constellation Architecture (refined after critics)

### 6.1 Core principle: Dimensional Asymmetry
- **Face** = discovery surface (small, structured, queryable, content-hashed)
- **Body** = implementation (cohesive, bounded by Face, language-portable for domain core)
- **Linkage** = typed artifact graph (saga DB traces, not code imports)

### 6.2 Module anatomy (refined)

```
module/
├── face.wit              ← WIT-format typed Face (or markdown with structured anchors as fallback)
├── domain/               ← Hexagonal CORE: pure logic + invariants (language-portable)
├── ports/                ← Abstract ports (part of domain)
└── adapters/             ← Peripheral: one file per adapter (parallel-implementable)
```

### 6.3 Hexagonal + DDD alignment (our contribution)

Constellation Architecture does NOT replace Hexagonal/DDD. It extends them:
- **Domain + Ports** remain as Cockburn/Evans prescribe — pure, isolated, language-portable
- **Adapters** remain per-port, parallel-implementable
- **Face** is added as the agent-discovery surface (the novel contribution)
- **Linkage** via typed graph is the navigation substrate (the second novel contribution)

### 6.4 Language portability guarantee

If tomorrow a new language emerges that is more efficient for LLM-runtime (e.g., Mojo, or an AI-native language):
- **Domain + Ports + Face** are language-neutral (WIT format, pure logic)
- **Adapters** are rewritten (10-20% of codebase)
- System is ported in O(adapters), not O(whole_system)

This is the strategic value of Hexagonal + Face: **the investment in domain modeling and contracts survives language changes.**

### 6.5 Polymorphism preserved

Face declares Ports; Adapters implement Ports; polymorphism is via port-adapter binding (Composition Root), not via runtime vtable. This preserves:
- Testability (mock/stub/fake adapters)
- Replaceability (swap Stripe for PayPal)
- Parallelism (N agents implement N adapters)

---

## 7. GoF pattern classification (from Report 01)

[unchanged from Report 01 — this is settled analytical work]

- **Class A (12 patterns survive):** Adapter, Bridge, Composite, Facade, Proxy, Iterator, Command, Factory Method, Prototype, Builder, Interpreter, Template Method
- **Class B (7 adapt):** Abstract Factory, Strategy, Decorator, State, Chain of Responsibility, Observer, Flyweight
- **Class C (4 break):** Singleton, Mediator, Visitor, Memento

Five agent-aware meta-patterns emerge as replacements (Report 01 §7):
1. Port + Composition Root (replaces Singleton)
2. Append-only Event Log (replaces Observer/Mediator/Memento)
3. Closed-Set Decision Artifact (replaces Visitor)
4. Generated Registry (replaces Strategy/Chain/Flyweight)
5. Event Sourcing (replaces Memento)

---

## 8. Test pyramid and verification (from Report 04)

[settled — awaiting Critic #2's empirical demands]

- **L0-L4 contract levels** map onto test pyramid
- **Property tests (L3)** are more agent-resistant than example tests (L2) for algorithmic ACs
- **Independent Verifier** requires: contract-as-data in AC, different test layer, verifier-owned test directory
- **Trusted Provider Registry** needed (trusted_providers table) — provider as free-form string is a hole
- **test_layer field** on verification_evidence — cheap additive migration

---

## 9. Hypotheses (testable through saga experiments)

- **H1**: Codebases authored under Constellation Architecture produce fewer merge conflicts than under classical SRP, when built by N parallel agents.
- **H2**: Agent time-to-completion is lower for Body tasks in Constellation modules than for equivalent SRP-decomposed tasks.
- **H3**: Property tests (L3) catch more agent-introduced bugs than example tests (L2) for algorithmic modules.
- **H4**: SAST as Trusted Provider raises the floor of agent-written code security without changing the ceiling.
- **H5**: Typed contract registry (Face) reduces agent "lost in codebase" incidents vs prose SRS.
- **H6**: Bounded Context ≈ Constellation Module (DDD alignment hypothesis).
- **H7**: Language portability via Hexagonal Face — porting domain to new language is O(adapters).

`[CRITIC-PENDING: Critic #2 will demand falsification criteria for each H]`

---

## 10. Roadmap

1. **Synthesize 6 critic reports** → refine this charter into v1.0 final
2. **(A) Charter v1.0 final** — includes "Responses to Critiques" section
3. **(B) Blog post** — "Agent-Oriented SE: the locality-discoverability paradox"
4. **(C) Skill upgrade** — saga-architect requires structured SRS sections:
   - Module Manifest (list of Constellation modules)
   - Port Registry (per module)
   - Aggregate Invariants (per module)
   - Ubiquitous Language Glossary
   - NFR Capacity Targets
5. **Exp-1**: water-cannon under Constellation vs classical SRP — measure H1, H2, H5

---

## 11. Sources (7 research reports)

1. `docs/research/01-gof-patterns-under-agent-runtime.md` — GoF 23 patterns, A/B/C classification, 5 meta-patterns
2. `docs/research/02-literature-scan.md` — what's published, the niche is open
3. `docs/research/03-togaf-ddd-clean-under-agent-runtime.md` — classical frameworks deformations, saga rediscoveries
4. `docs/research/04-test-pyramid-and-tooling-integration.md` — L0-L4, provider registry, independent verifier hole
5. `docs/research/05-industry-essays-2024-2026.md` — OpenAI/Anthropic/Cognition, 21 findings, 6 gaps
6. `docs/research/06-thought-leaders-on-agent-architecture.md` — Fowler/Evans/Uncle Bob/Newman/Cockburn/Henney/Booch — the silence
7. `docs/research/07-face-body-precedents-and-differentiators.md` — WIT/seL4/OCaml/Actor/SCIP precedents, novelty map

## 12. Critic reports (pending — 6 parallel)

`[CRITIC-PENDING: 6 reports]`
1. Henney successor — classical architecture defense
2. Empirical skeptic — AGENTS.md rot, context rot, falsifiability
3. Practitioner — Cursor/trenches practicality
4. seL4 purist — distributed systems / capability formalism
5. DDD traditionalist — social process loss
6. Type theorist — ML modules, Face as type vs comment
