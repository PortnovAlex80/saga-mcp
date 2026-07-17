# Research Charter v1.0 — Agent-Oriented Software Engineering

> **Status:** Final. Passed 6-critic adversarial review (Henney defender, empirical skeptic, practitioner, seL4 purist, DDD traditionalist, type theorist).
> **Date:** 2026-07-17
> **Mode:** Private research for saga-mcp framework strengthening. For internal blog/discussion.
> **Sources:** 7 research reports + 6 critic reports at `docs/research/`.

---

## 1. What this research set out to answer

**Question:** Do classical SDLC and code architecture principles (SRP, Clean Architecture, DDD, GoF, test pyramid) need to change when the primary executor is an LLM coding agent rather than a human engineer?

**Initial hypothesis (v0.1):** "Classical rules were optimized for human cognition (7±2 working memory). LLM agents have inverted cognitive profile. Therefore classical rules are mis-tuned and a new architecture (Constellation Architecture with Face/Body split) is needed."

**After adversarial review:** The hypothesis was **partially refuted and substantially refined**. This charter records what survived.

---

## 2. What was refuted (honest record)

Six claims from v0.1 did NOT survive the critic review. Recording them prevents repetition.

### 2.1 "SRP is about Miller's 7±2 working memory" — REFUTED

**Killed by:** Critic #1 (classical defender).

SRP traces to Parnas 1972: decomposition by **change-propagation axes** (different stakeholders cause change at different rates). Not about working-memory slots. An LLM with 2M tokens still benefits from SRP because a module with N reasons-to-change is N times more likely to be touched by N parallel agents.

**Lesson:** Attack the real principle, not a caricature. SRP is about coupling-and-cohesion, not chunking.

### 2.2 "Large cohesive Body (1000-3000 lines)" — REFUTED

**Killed by:** Critics #1, #2, #3 (classical, empirical, practitioner).

Three independent lines of evidence:
- F11 (Liu et al. TACL 2024): U-shaped recall, worst in middle of large contexts
- F10 (Raschka/ETH): context files can reduce agent success by 20%+
- F14 (industry consensus): practitioners favor 150-500 LOC files

**Lesson:** Agents do WORSE on large files, not better. The "load one big Body" prescription maximizes exposure to context rot. Small cohesive files win.

### 2.3 "Face replacing imports" — REFUTED

**Killed by:** Critics #3, #4 (practitioner, seL4 purist).

Python/JS/TS have no runtime mediator. `importlib.import_module()` is ambient authority Face cannot gate. "Saga DB resolves dependencies" means two dependency systems that will drift. No language-level enforcement mechanism exists without committing to WASM components or capability-secure languages.

**Lesson:** Imports stay. The artifact graph is a **parallel provenance/tracability layer** (INCOSE RTM), not a replacement for the compiler's dependency resolution.

### 2.4 "Constellation Module as new architecture" — REFUTED

**Killed by:** Critic #1 (classical defender).

Structurally identical to Hexagonal Architecture (Cockburn 2005) + an indexed port registry. Report 03 admitted: "Problems isomorphic; solutions converge." Convergent rediscovery is not novelty.

**Lesson:** Don't rename known things. Use Cockburn's vocabulary, add the enforcement layer.

### 2.5 "Face as type (OCaml signature analog)" — REFUTED

**Killed by:** Critic #6 (type theorist).

ML signatures are checked by the compiler: a decision procedure admits or rejects. Face is markdown/YAML — no checking algorithm, no abstract types, no functors. Face is a **specification** (JML-style annotation), not a **type**.

**Lesson:** Claiming OCaml lineage without OCaml's teeth is borrowing unearned rigor. Face as spec is honest; Face as type is not — unless paired with a real checker (future direction, §6).

### 2.6 "TRIZ physical contradiction" — REFUTED as framing

**Killed by:** Critic #2 (empirical skeptic).

File size is not a physical parameter. "300-line file + 50-line Face" = two small files. TRIZ added gravitas, not rigour.

**Lesson:** The engineering answer (small files + generated index + invariant registry) does not need TRIZ to justify it.

---

## 3. What survived (the defensible core)

Six claims survived all 6 critics. These are the research's genuine contributions.

### 3.1 The statelessness diagnosis — SURVIVED (strongest survivor)

**Defended by:** Critic #1: "The strongest part of the charter and what saga-mcp has genuinely pioneered."

LLM agents have zero persistent memory across sessions. This requires explicit durable state: `accepted_hash`, drift detection, typed task provenance, content-addressed artifacts. This is orthogonal to classical architecture — it is infrastructure that makes ANY architecture work under stateless-per-launch execution.

**saga-mcp evidence (12 features):** completeness-gate, frozen baseline, hard gates, conflict keys, 4-valued verdict, RiskClass max(), observation store, cgad-spec-lint, stop:true, projectname.txt convention, role isolation, decision matrix ≥3×≥2.

### 3.2 The invariant enforcement gap — SURVIVED (most novel contribution)

**Defended by:**
- Critic #1: "Classical architecture talks about invariants constantly and enforces them almost never. This is the one place where the charter identified a real gap."
- Critic #5: "Enforcement DDD practitioners have wanted for 15 years and never had."
- Critic #6: Demanded refinement types as future direction — constructive, not dismissive.
- Critic #3: "If collapsed to 'INVARIANTS.md per module + lint that tests cover them,' I'd try it."

**The claim:** Classical architecture (Hexagonal, DDD, Clean) declares invariants in prose (comments, wikis, review checklists) but has no machine-enforcement. saga-mcp can close this gap: declared invariants become Trusted Guard inputs (CGAD §6), checked by property tests (L3) and eventually refinement types (L0).

**This is the genuine novelty.** Nobody in the literature (Reports 02, 05, 06) has proposed invariants as first-class queryable artifacts enforced through a verification pipeline. OpenAI's "harness engineering" comes closest ("enforce invariants, not implementations") but implements it as convention, not infrastructure.

### 3.3 Artifact graph as queryable index — SURVIVED

**Defended by:** Critic #1: "If framed as 'build a tool that indexes Hexagonal ports, Clean Architecture dependency direction, and DDD Context Maps into a queryable graph' — I would defend it enthusiastically."

The artifact graph (saga DB traces: `implements`, `derived_from`, `covers`, `verified_by`, `depends_on`, `superseded_by`) IS the navigation substrate that replaces human memory for dependency discovery. Not a replacement for imports — a **parallel provenance layer** (INCOSE RTM applied to codebases).

**Saga evidence:** `artifact_traces` table, `conflict_check` tool, `artifact_coverage` tool, `conflict_keys_auto_derive`.

### 3.4 Property tests (L3) over example tests (L2) — SURVIVED

**Defended by:** Critics #2, #4 (empirical, test pyramid). "Genuinely good, orthogonal to Face/Body, adoptable on SRP codebase tomorrow."

For algorithmic ACs (formula/invariant-based), property tests express the contract more compactly and more honestly than example tests. A wrong LLM cannot simultaneously fool an L2 example test AND an L3 property test derived from the same contract.

**Gap:** No saga AC currently declares properties (Report 04 §1.5: zero saga ACs mention property tests despite textbook candidates).

### 3.5 Generated Faces (SCIP-compatible) — SURVIVED as modified

**Original claim:** Hand-authored Face per module.
**After critic #3:** "Make Faces generated, not authored. Face emitted from Body's AST by SCIP-compatible indexer. Humans never touch face.md."

**The modified claim:** The Face is **generated** from the Body's AST at CI time (using SCIP — Sourcegraph Code Intelligence Protocol). Humans author only:
- `INVARIANTS.md` (10-line file per critical module: the invariants this module protects)
- `AGENTS.md` sections (existing convention, kept minimal per F10)

The generated Face is the discovery surface. The authored INVARIANTS.md is the enforcement target. No dual-maintenance burden; no Face rot.

### 3.6 Contract-first scaffolding (Pattern B) — SURVIVED (already working)

Not contested by any critic. Already implemented in saga-mcp (topology.ts, saga-planner skill, conflict_keys, REQ-013/R4). The scaffold materializes the frozen contract; body tasks implement against it; conflict_keys detect semantic collisions at planning time.

---

## 4. The refined thesis

**v0.1 (refuted):** "Classical architecture is mis-tuned for agent cognition; a new Face/Body architecture is needed."

**v1.0 (defensible):**

> Classical code architecture principles (SRP, Clean Architecture, DDD, GoF) remain valid for LLM-agent-executed codebases. Code should still be organized in small cohesive files with explicit imports, clear module boundaries, and Hexagonal/DDD-style separation of domain from infrastructure.
>
> What changes is not the code structure but the **enforcement layer above it**. Human teams enforce architectural invariants through social processes (code review, conversation, pair programming). LLM agent teams have no social process — workers are stateless, isolated, and cannot converse. The enforcement must become **machine-mediated**:
>
> 1. **Declared invariants** per module (INVARIANTS.md), enforced through Trusted Guard providers (property tests, refinement types, SAST)
> 2. **Artifact graph** (saga DB) as queryable provenance/tracability layer over the import graph — not replacing imports, but making dependency topology visible to stateless workers
> 3. **Generated discovery surfaces** (SCIP-compatible indices emitted from ASTs) replacing the human-memory function of "I know where things are"
> 4. **Independent verification** through contract-as-data (AC declares properties, Verifier generates L3 tests against frozen contract, not against Builder's L2 examples)
> 5. **Durable state management** for stateless-per-launch execution (frozen baselines, drift detection, typed provenance, 4-valued verdicts)
>
> saga-mcp is the infrastructure for this enforcement layer. It does not replace Clean Architecture or DDD — it makes them enforceable when the executor is a stateless parallel LLM agent rather than a human team.

---

## 5. What this means for saga-mcp

### 5.1 What we DON'T need to build (refuted claims)

- ❌ Face/Body file reorganization (small files stay)
- ❌ Custom Face IDL per module (SCIP computes it)
- ❌ Saga DB replacing imports (parallel layer, not replacement)
- ❌ "Constellation Module" as new artifact type (= Hexagonal module)
- ❌ Large cohesive Body files (small files confirmed)

### 5.2 What we DO need to build (survivors)

#### Priority 1: Invariant registry (the novel contribution)
- `INVARIANTS.md` convention per critical module (human-authored, ~10 lines)
- Lint rule: invariant declared → property test exists covering it (R-new)
- Lint rule: property test passes against frozen AC hash (extends R3)
- Future: refinement types for L0 checking (Critic #6's constructive recommendation)

#### Priority 2: Generated Faces via SCIP
- SCIP-compatible indexer in saga-mcp CI (emits symbol graph from ASTs)
- `conflict_keys_auto_derive` enhanced to consume SCIP index
- `artifact_coverage` enhanced to check Face-level coverage

#### Priority 3: Independent Verifier
- `saga-verifier` skill (or mode in saga-worker): reads AC + contract-as-data, generates L3 property tests
- Verifier-owned test directory (`tests/verifier/`)
- `test_layer` field on verification_evidence (L0-L4)
- Lint rule R17: accepted AC with verified_by evidence only at one layer → warning

#### Priority 4: Trusted Provider Registry
- `trusted_providers` table (category, name, trust_basis, determinism, scope, layer)
- Wire-in: ESLint/tsc (L0), Semgrep/Bandit (L1 security), pytest/hypothesis (L2/L3), pytest-benchmark (L4)
- SAST as derived_risk escalator (security finding → derived_risk='high' → final_risk recalculated)

#### Priority 5: saga-architect skill upgrade (practical, no schema change)
- SRS §2 requires: module list with conflict-key surface
- SRS §2b requires: Port Registry (structured, addressable anchors)
- SRS requires: Aggregate Invariants section (per module)
- SRS requires: Ubiquitous Language glossary (terms → artifacts → code symbols)
- NFRs require: quantitative capacity targets (not just metrics)
- ACs require: `properties` block for algorithmic ACs (L3 invariants)

---

## 6. Future directions (acknowledged but not committed)

These were raised by critics as valuable but requiring significant work:

### 6.1 Refinement types for L0 invariant checking (Critic #6)
Liquid Haskell / F* style: `{ r:Money | r <= amount }` discharged by SMT at compile time. Would promote "protects" from L3 (property-tested) to L0 (compile-time certain). High effort, high value.

### 6.2 Agent-runtime Event Storming (Critic #5)
Structured way for LLM architect to interrogate domain expert about events and invariants. Recorded negotiation trace for UL that survives drift. Event Storming artifact type that exists before SRS. This would restore DDD's discovery process under agent-runtime.

### 6.3 WASM Component Model as compilation target (Critic #4)
Commit to compiling each Body to a separate WASM component. This would make WIT Faces structural (Canonical ABI mediates), capability semantics real (unforgeable references), and isolation enforced. High effort; transforms the problem space.

### 6.4 Empirical validation experiments (Critic #2)
Three pre-registered experiments:
- E1: Declared invariant + property test vs example test only — measure bug catch rate
- E2: Generated Face (SCIP) vs Aider repo map — measure agent task success
- E3: Drift survival curve — inject invariant drift, measure agent success degradation

---

## 7. Sources

### Research reports (7)
1. `01-gof-patterns-under-agent-runtime.md` — GoF 23 patterns, A/B/C, 5 meta-patterns
2. `02-literature-scan.md` — published work, niche is open
3. `03-togaf-ddd-clean-under-agent-runtime.md` — classical frameworks deformation
4. `04-test-pyramid-and-tooling-integration.md` — L0-L4, provider registry, verifier hole
5. `05-industry-essays-2024-2026.md` — OpenAI/Anthropic/Cognition, 21 findings
6. `06-thought-leaders-on-agent-architecture.md` — Fowler/Evans/Uncle Bob silence
7. `07-face-body-precedents-and-differentiators.md` — WIT/seL4/OCaml precedents

### Critic reports (6)
1. `critic-01-henney-classical-defender.md` — SRP=Parnas, not Miller; Hexagonal rebranded
2. `critic-02-empirical-skeptic.md` — F10/F11/F14 evidence; falsification demands
3. `critic-03-practitioner.md` — small files work; Face rot; show me Python
4. `critic-04-sel4-distributed-purist.md` — invocation≠discovery; no Canonical ABI
5. `critic-05-ddd-traditionalist.md` — social process IS DDD; wax fruit
6. `critic-06-type-theorist.md` — Face=spec not type; need refinement types

---

## 8. Roadmap

1. **(A) This Charter** ← we are here
2. **(B) Blog post** — "Agent-Oriented SE: what changes and what doesn't" (populaized charter for discussion)
3. **(C) saga-architect skill upgrade** — structured SRS sections (Priority 5 above, no schema change)
4. **(D) Invariant registry MVP** — INVARIANTS.md convention + lint rule (Priority 1)
5. **(E) Exp-1** — property test vs example test on water-cannon AC-1 (H3)
6. **(F) Generated Faces via SCIP** — proof of concept indexer (Priority 2)

---

## Appendix: The debate scorecard

| Claim | Henney | Empirical | Practitioner | seL4 | DDD | Type | Verdict |
|---|---|---|---|---|---|---|---|
| SRP = Miller 7±2 | ❌ KILLED | — | — | — | — | — | REFUTED |
| Big Body 1000-3000 LOC | ❌ | ❌ KILLED | ❌ KILLED | — | — | — | REFUTED |
| Face replacing imports | — | — | ❌ KILLED | ❌ KILLED | — | — | REFUTED |
| Constellation = new architecture | ❌ KILLED | — | — | — | — | — | REFUTED |
| Face as type (OCaml analog) | — | — | — | — | — | ❌ KILLED | REFUTED |
| seL4 CSpace analogy | — | — | — | ❌ KILLED | — | — | REFUTED |
| TRIZ physical contradiction | — | ❌ KILLED | — | — | — | — | REFUTED |
| 12 datapoints as evidence | ❌ KILLED | ❌ KILLED | — | — | — | — | REFUTED |
| Statelessness diagnosis | ✅ DEFENDED | — | — | — | — | — | SURVIVED |
| Invariant enforcement gap | ✅ DEFENDED | — | ✅ DEFENDED | — | ✅ DEFENDED | ✅ (constructive) | SURVIVED ★ |
| Artifact graph as index | ✅ DEFENDED | — | ✅ DEFENDED | — | ✅ DEFENDED | — | SURVIVED |
| Property tests L3 > L2 | — | ✅ DEFENDED | ✅ DEFENDED | ✅ DEFENDED | — | ✅ DEFENDED | SURVIVED |
| Generated Faces (SCIP) | — | — | ✅ DEFENDED | ✅ DEFENDED | — | — | SURVIVED (modified) |
| Contract-first scaffolding | — | — | ✅ DEFENDED | — | ✅ DEFENDED | — | SURVIVED |
