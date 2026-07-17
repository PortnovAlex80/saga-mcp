# Agent-Native Codebase Architecture: Industry Essays 2024-2026

> **Source:** research agent run 2026-07-17, subagent `agent_cb8b24cf`.
> **Method:** ~30 web searches + 5 primary-source full reads (OpenAI harness, Anthropic context eng, Anthropic Skills, Cognition, Aider).

## Thesis under examination
Classical code architecture (SRP, Clean layers, GoF) optimized for human cognition. LLM agents invert constraints: huge context but no persistent cross-session memory, instant pattern-matching but weak global coherence. Creates paradox: agents want large cohesive blocks but need fine-grained discoverability.

---

## PART 1 — Top findings (ranked by thesis-relevance)

### F1. OpenAI "Harness Engineering" (Ryan Lopopolo)
- **Source:** [openai.com/index/harness-engineering](https://openai.com/index/harness-engineering) — Codex team, ~July 2025.
- **Claim:** One engineer produced ~965K LOC over 5 months not by coding but by building "harnesses" — scaffolded contracts, test fixtures, review gates constraining what autonomous Codex agents emit.
- **Thesis relation:** **STRONG SUPPORT.** Most direct practitioner instantiation. Shifts discipline from "write body" to "write contract + verifier; let agents fill body."
- **Concrete patterns:** (a) Contracts/scaffolding authored first; agents implement against. (b) Tests as primary specification. (c) Frequent merge cadence. (d) Code review as human's leverage point.
- **Critical response:** HN threads push back hard on 965K LOC as marketing; practice not refuted but scale contested.

### F2. Anthropic "Effective Context Engineering for AI Agents"
- **Source:** [anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — June 2025.
- **Claim:** Finite context window is agent's working memory; engineering it (what enters, leaves, in what order) is dominant skill for reliability — more important than prompt wording.
- **Thesis relation:** **STRONG SUPPORT.** Directly names discoverability-vs-cohesion tension: "context rot" sets in as window fills.
- **Concrete patterns:** (a) Four context layers: instructions, tool results, history, retrieved knowledge. (b) "Just-in-time" context loading. (c) Context window compression. (d) Warns against dumping whole files: retrieve relevant slice. (e) Auto-compaction near limit.

### F3. Anthropic "Agent Skills" (progressive disclosure) — ★ KEY FINDING
- **Source:** [anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — Oct 2025.
- **Claim:** A "Skill" is folder with SKILL.md front-matter + progressive body. Front-matter (name, description, when-to-use) always loaded; body loads only when invoked. **Deliberate two-tier design** optimizing context budget.
- **Thesis relation:** **THE CLOSEST EXISTING ANALOG TO "FACE/BODY" SEPARATION.** Only major source explicitly implementing surface/depth split *for LLM consumption*.
- **Concrete patterns:** (a) SKILL.md YAML front-matter as "interface." (b) Body as "implementation." (c) Bundled executable scripts. (d) References as separate files loaded on demand. (e) Now open standard being adopted across vendors.

### F4. Cognition "Don't Build Multi-Agents"
- **Source:** [cognition.com/blog/dont-build-multi-agents](https://www.droppgroup.com/blog/dont-build-multi-agents) — early 2025.
- **Claim:** Multi-agent fails because (a) each agent gets incomplete context (fractionated view), (b) orchestrator-agent handoff is LLM call that can err. Single agent with one coherent context thread outperforms.
- **Thesis relation:** **SUPPORT on context-cohesion; in tension with parallel-agent scaffolding.** If agents need large cohesive context blocks, splitting across N agents is inherently lossy.
- **Concrete patterns:** (a) Prefer one long-lived agent context. (b) When parallelize, do so behind shared, versioned contract. (c) Orchestrator as deterministic code, not LLM-as-router.

### F5. Anthropic "Building Effective Agents" (workflow taxonomy)
- **Source:** [anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents) — Dec 2024.
- **Claim:** Most production wins are workflows (predefined code paths orchestrating LLM calls), not autonomous loops. Six topologies: prompt-chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer, agent.
- **Thesis relation:** **ORTHOGONAL — provides vocabulary.** Runtime composition, not codebase structure. But "orchestrator-workers" maps directly to scaffolding-then-parallel-bodies.
- **Concrete patterns:** Central LLM decomposes, workers implement slices in parallel, orchestrator synthesizes.

### F6. Aider "Repository Map" (tree-sitter + PageRank)
- **Source:** [aider.chat/2023/10/22/repomap.html](https://aider.chat/2023/10/22/repomap.html) — Paul Gauthier.
- **Claim:** Builds compact "repo map" fitting in LLM context by: (1) parsing via tree-sitter (130+ languages), (2) reference graph construction, (3) **PageRank** to score symbol importance, (4) top-ranked rendered into token-budgeted tree.
- **Thesis relation:** **SUPPORT for discoverability half.** Most sophisticated existing "repo-as-graph" for navigation. BUT navigation-time only — does not propose writing code differently.
- **Concrete patterns:** Stateless, live-computed, scope-aware tree summary. Parse → rank → fit pipeline. Empirical proof LLMs need symbol-graph projection, not raw files.

### F7. Cursor codebase indexing (embeddings + Merkle-like hashing)
- **Source:** [read.engineerscodex.com/p/how-cursor-indexes-codebases-fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast); [cursor.com/blog/secure-codebase-indexing](https://cursor.com/blog/secure-codebase-indexing).
- **Claim:** Indexes code by chunking files into syntactic units, hashing chunks for content-addressed caching, embedding, storing in vector DB with line numbers.
- **Thesis relation:** **PARTIAL SUPPORT.** Hash-based chunk caching is Merkle-like. But vector/semantic graph, NOT true dependency graph. Finds *similar* code, not *structurally related* code.
- **Concrete patterns:** Syntactic chunking at function/class granularity. Content-addressed embedding cache.

### F8. Sourcegraph "precise code intelligence" (LSIF / SCIP / stack graphs)
- **Source:** [github.com/oxenprogrammer/sourcegraph/.../precise_code_intelligence.md](https://github.com/oxenprogrammer/sourcegraph/blob/main/doc/code_intelligence/explanations/precise_code_intelligence.md); Sourcegraph 7.0 "intelligence layer" announcement.
- **Claim:** Precomputes true code-intelligence graph offline (LSIF/SCIP emitters in CI), serves O(1) definition/reference/hover queries at browse time. Stack graphs generalize name resolution across files without type-checker.
- **Thesis relation:** **STRONG SUPPORT for artifact graph feasibility — read-time only.** Closest industry thing to "codebase as queryable graph." Sourcegraph 7.0 (2025) repositions as "intelligence layer for agents."
- **Concrete patterns:** LSIF/SCIP as language-agnostic code-graph exchange format. Precompute-in-CI, query-at-runtime split.

### F9. Scaffolding pattern (stubs first, parallel bodies later)
- **Sources:** zbrain.ai; levelup.gitconnected; Replit [ZenML case study](https://www.zenml.io/llmops-database/building-reliable-ai-agents-for-application-development-with-multi-agent-architecture); [LangChain Replit breakout](https://www.langchain.com/breakoutagents/replit).
- **Claim:** Generate interface stubs/type signatures/test scaffolds first; spawn parallel agents to implement bodies against shared contract. Merges behind contract.
- **Thesis relation:** **DIRECT SUPPORT.** File-level pattern thesis proposes. Multiple practitioner sources. NOT elevated to formal architectural principle anywhere — remains workflow trick.
- **Concrete patterns:** (a) One agent emits interfaces + tests. (b) N parallel agents implement bodies. (c) Interface contract is merge gate.

### F10. Empirical counter-evidence: context files can *hurt* — ★ CRITICAL
- **Sources:** rasbt (Sebastian Raschka) AGENTS.md experiments; Colin Eberhardt replications; ETH Zurich study.
- **Claim:** Adding AGENTS.md / context files can *reduce* agent task success by ~20%+. Mechanism: extra context dilutes signal, increases "lost in the middle," can misdirect if stale.
- **Thesis relation:** **CRITICAL CONTRADICTION of naive "add more discoverability metadata."** Wrong context worse than less context. Surface/depth separation must be *correct* and *fresh*.
- **Concrete patterns:** Context files must be (a) minimal, (b) generated/verified from code rather than hand-maintained, (c) progressively disclosed.

### F11. "Lost in the middle" / context rot
- **Sources:** Liu et al. "Lost in the Middle" (TACL 2024); Chroma context rot report; [arXiv 2506.20081](https://arxiv.org/pdf/2506.20081).
- **Claim:** LLMs U-shaped recall: best at start/end, worst in middle. Performance degrades monotonically as context fills.
- **Thesis relation:** **SUPPORT both halves.** Large files fine if relevant content at start/end; discoverability matters because position affects recall.

### F12. Specification-driven development (GitHub Spec Kit, Kiro, BMAD)
- **Sources:** [github.com/github/spec-kit](https://github.com/github/spec-kit); AWS Kiro; BMAD Method.
- **Claim:** Author spec before code; spec drives generation, validation, review. Spec-as-source-of-truth, code-as-derived.
- **Thesis relation:** **STRONG SUPPORT for interface/contract separation** — at requirements level, not code-module level.

### F13. AGENTS.md open standard
- **Source:** agents.md vendor-neutral spec; adopted by Sourcegraph, Cursor.
- **Claim:** Markdown at repo root declaring how agents work: build commands, conventions, what-not-to-touch.
- **Thesis relation:** **PARTIAL — proto-pattern.** Flat, prose-only, manually maintained (the F10 problem).

### F14. Practitioner consensus: small modular files win — ★ CRITICAL CONTRADICTION
- **Sources:** r/cursor threads; Medium "150-500 line sweet spot"; Simon Willison.
- **Claim:** For agent-authored code, consensus is OPPOSITE of "large cohesive blocks": small files (150-500 LOC), one responsibility per file, flat module graphs, explicit imports.
- **Thesis relation:** **CONTRADICTS "large cohesive block" half.** Practitioners report agents struggle more with large files than cross-file navigation.
- **Concrete patterns:** Files ≤500 LOC. Flat inheritance. Explicit over implicit. No dynamic metaprogramming.

### F15. Simon Willison agentic anti-patterns
- **Sources:** [simonwillison.net](https://simonwillison.net/); DEV Community "6 things to avoid."
- **Claim:** Anti-patterns: deep inheritance, dynamic metaprogramming, implicit control flow, "assuming understanding," prompt thrashing.
- **Thesis relation:** **SUPPORT "explicit > implicit."** Behavior must be readable from file, not runtime-resolved.

### F16. Replit Agent / multi-agent architecture
- **Sources:** [ZenML](https://www.zenml.io/llmops-database/building-reliable-ai-agents-for-application-development-with-multi-agent-architecture); [LangChain](https://www.langchain.com/breakoutagents/replit); Replit 2025-in-review.
- **Claim:** Multi-agent topology (planner, builder, reviewer) from blank page to deployment.
- **Thesis relation:** **ORTHOGONAL — tooling, not structure advice.**

### F17. Martin Fowler on generative AI
- **Sources:** [martinfowler.com/articles/exploring-gen-ai.html](https://martinfowler.com/articles/exploring-gen-ai.html); [pushing-ai-autonomy](https://martinfowler.com/articles/pushing-ai-autonomy.html); [Pragmatic Engineer interview](https://newsletter.pragmaticengineer.com/p/martin-fowler).
- **Claim:** AI is biggest shift since high-level languages; discipline is in *pre-coding* stages (architecture, feedback).
- **Thesis relation:** **SUPPORT — pre-coding architecture is contract authoring.** Fowler's "pre-coding reasoning" = Face; generated code = Body.

### F18. Shopify Sidekick / "session must survive"
- **Source:** Shopify engineering blog.
- **Claim:** Agent sessions must survive across context evictions — design runtime so long-running work persists state to disk.
- **Thesis relation:** **ORTHOGONAL** (runtime, not codebase).

### F19. AI-native languages: Mojo, Bosque
- **Sources:** Mojo (Modular); Bosque (Microsoft Research, 2019).
- **Claim:** Bosque designed to eliminate accidental complexity (no subtyping, no loops, regularized AST) — explicitly more legible to tooling/reasoning. Pre-LLM, no adoption.
- **Thesis relation:** **WEAK SUPPORT.** No major language redesigned for LLM consumption yet.

### F20. APPL prompt-programming language (interface/implementation for prompts)
- **Source:** APPL, [ResearchGate 394272866](https://www.researchgate.net/publication/394272866).
- **Claim:** Programming language embedding LLM prompts with explicit interface/implementation separation.
- **Thesis relation:** **SUPPORT at prompt level.** Closest academic analog to Face/Body, but for prompts.

### F21. Academic: repository-level benchmarks
- **Sources:** SWE-Atlas; USEbench; ARKREPOBENCH; SACL; SWE-PRBench.
- **Claim:** Whole benchmark subfield measures repository-level agent capability — presupposing cross-file comprehension is the hard problem.
- **Thesis relation:** **SUPPORT for discoverability being bottleneck.**

---

## PART 2 — Recurring themes

**T1. Contract-first is now dominant practitioner pattern.** F1 (OpenAI harness), F12 (Spec Kit), F9 (scaffolding), F17 (Fowler) all converge: humans author contracts/specs/tests/interfaces; agents author bodies. Strongest single trend.

**T2. Progressive disclosure is emerging context-management principle.** F3 (Anthropic Skills), F2 (context eng), F13 (AGENTS.md), Face/Body intuition all express: cheap surface always loaded, expensive depth opt-in. Resolution to large-vs-small file tension: not file *size*, but *what loaded by default vs on demand*.

**T3. Navigation tooling compensates for codebase structure rather than demanding better structure.** F6 (Aider), F7 (Cursor), F8 (Sourcegraph) all *project graph over* file-based codebase. None argues "write codebase *as* graph." Significant gap.

**T4. Empirical evidence cuts against naive "add more context."** F10 (AGENTS.md hurts), F11 (lost-in-middle), F14 (small-file consensus) imply more metadata not always better. Must be correct, minimal, progressively disclosed.

**T5. Single-vs-multi-agent debate is fundamentally about context partitioning.** Cognition (F4) vs Anthropic multi-agent. Scaffolding-then-parallel sits on multi-agent side, must defend against Cognition's evidence.

**T6. "Explicit over implicit" is universal practitioner advice.** F15, F19, r/cursor consensus. Behavior readable from file in front of agent, not from runtime-resolved indirection.

---

## PART 3 — What is novel/missing (research opportunities)

**G1. "Face/Body" or "surface/depth" module separation is NOT described as codebase-architecture pattern anywhere.** ★ MOST NOVEL CONTRIBUTION.
Closest existing realizations:
- Anthropic Skills (F3) — but at prompt/agent-skill level, not source code
- APPL (F20) — for prompts, not code modules
- Spec-driven development (F12) — at feature level, not module

No source proposes authoring each code module as Face (always-loadable interface contract) paired with Body (loaded only when invoked).

**G2. "Artifact graph replacing imports" has NO proponent.** Even Sourcegraph treats graph as tooling layer over file-based repo. No source proposes import graph being replaced by artifact-graph (content-addressed dependency graph referencing contract hashes, not file paths). Open territory.

**G3. No formal bridge between navigation-time repo maps (F6-F8) and write-time architecture.** If agents always read through repo map, modules should be *authored* to project well through that map.

**G4. Cognition single-agent critique (F4) unanswered by scaffolding-parallel school.** Thesis needs story for how shared Face contract closes gap (probably: Face small enough to fully load into every parallel worker, making partial-context problem moot).

**G5. Empirical validation thin.** F10 only hard empirical work, shows context files hurting. No peer-reviewed study of Face/Body, scaffolding-then-parallel, or artifact-graph imports.

**G6. AI-native language design dormant.** No production language redesigned for LLM consumption. Bosque (2019) only precedent, pre-agent era.

---

## PART 4 — Direct verbatim anchors (load-bearing claims)

**OpenAI harness:** "The lack of hands-on human coding introduced a different kind of engineering work, focused on systems, scaffolding, and leverage." Cleanest statement that human work moves up abstraction stack to contract authoring.

**Anthropic context eng:** Context window is working memory with four layers (instructions / tool results / history / retrieved knowledge), each competing for tokens. "Just-in-time" loading beats upfront. Operational basis for Face/Body: Face = instructions (always loaded); Body = retrieved knowledge (loaded just-in-time).

**Anthropic Skills:** Two-tier SKILL.md design (front-matter always loaded; body loaded on invocation) is *the only existing production pattern implementing surface/depth separation for LLM consumer*. Thesis generalizes this from skills to source modules.

**Cognition:** "Context engineering is fundamentally harder [in multi-agent] because each agent needs to have context about what's going on" — strongest argument *against* parallel-body scaffolding, which thesis must address.

**Aider:** "Parse → rank → fit" (tree-sitter → PageRank → token budget) is dominant pattern for projecting codebase into navigable graph. Open question: should codebases be *authored* to optimize this projection?

---

## Summary verdict

Thesis **well-supported on discoverability half** (F2, F6, F8, F10, F11, F21) and **on contract-first implication** (F1, F9, F12, F17). **Partially contradicted on "large cohesive blocks" half** (F14, F10) — practitioners overwhelmingly favor small modular files.

Resolution evidence points to: **NOT "large files" but "small cohesive files + authored Face/Body separation + progressive disclosure"** — which is precisely the pattern thesis appears poised to formalize and **no existing source has formalized for source code modules** (G1).

Most defensible novel claim: *generalize Anthropic Skills' surface/depth split from prompt artifacts to source-code modules, and couple it with content-addressed artifact graphs (G2) so discoverability is authored, not just compensated for by tooling (G3).*
