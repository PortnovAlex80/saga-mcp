# Architecture Thought Leaders on LLM-Agent-Native Code Structure: A Literature Review

> **Source:** research agent run 2026-07-17, subagent `agent_64e22f12`.
> **Question:** Have any of the nine named thought leaders (Fowler, Evans, Uncle Bob, Newman, Feathers, Vernon, Cockburn, Henney, Booch) articulated either the diagnosis (classical rules are human-tuned, not agent-tuned) or the proposed cure (Face/Body split with typed-graph linkage)?

## Thesis under test

Classical code architecture (SRP, Clean Architecture layers, DDD, GoF) is widely treated as if agent-neutral. Thesis inverts: those rules were optimized for human cognitive profile (working memory 7±2, durable long-term memory, slow sequential reading, strong aesthetic judgment). LLM agent has opposite profile (100K-2M token context, no persistent memory between sessions, near-instant pattern-matching, weak global coherence). Rules tuned for human can be actively anti-patterns for agent.

Proposed resolution "Constellation Architecture": small queryable **Face** (registry of exports/consumes/invariants) + large cohesive **Body** (implementation), linked through typed graph not textual code imports.

---

## Per-author findings

### 1. Martin Fowler — most engaged, closest to Face/Body idea

Only one of nine with substantial first-party *written* corpus on coding-agent architecture. Site hosts directly relevant articles, several co-authored with Birgitta Boeckeler.

**"Harness engineering for coding agent users"** (martinfowler.com/articles/harness-engineering.html). Fowler's adoption/popularization of OpenAI's "harness engineering" term. Framing: trust built through *feedforward guides* (constraints agent reads before acting) + *feedback sensors* (signals agent reads after acting). Mental model explicitly separates *map agent reads* from *implementation it operates on* — structurally Face/Body distinction, though Fowler doesn't name it. Arguably chief popularizer of harness engineering outside OpenAI.

**"Maintainability sensors for coding agents"** (Boeckeler on Fowler's site). Defines maintainability as "making it easy and low risk to change the codebase over time — also known as 'internal quality'" and argues for layering static-analysis tools as *sensors* agents self-regulate against. Operational layer beneath harness concept. Notably, arXiv:2606.21804 ("Is Agent Code Less Maintainable Than Human Code?") provides empirical support: building on agent-generated code drops downstream task-resolve rates more often than building on human code.

**"Agentic Programming" bliki.** "Increasingly software developers are not typing code into their IDEs... developers prompt LLM, then review." Developer's role shifts from writer to reviewer/harness-builder.

**Verdict:** Fowler works *around* classical assumption — building sensors and harnesses — rather than challenging it. Does NOT explicitly state SRP/layering rules were tuned to human cognition and may be wrong for agents.

### 2. Eric Evans — engaged via keynotes, on DDD's survival

Explore DDD 2024 keynote "DDD and LLMs" + DDD Europe 2024 + own essay "LLMs & Software Design: Beginning My Learning Journey." InfoQ summary: "Evans argued that software designers need to look for innovative ways to incorporate LLMs into their systems." Evans's framing about DDD's *knowledge-crunching* role and how LLMs can participate — context-mapping with AI components, AI as deterministic-system component.

**Not** on record arguing aggregate/bounded-context sizing should change to suit agent reader. Concern is *domain-modeling conversation*, not *code-structure* one thesis targets.

### 3. Robert C. "Uncle Bob" Martin — notably SILENT on SRP+AI specifically

Most diagnostic silence. Canonical SRP definition (2014 blog) rooted in Parnas's 1972 decomposition — explicitly cognitive/organizational argument.

2026: co-authored "Clean AI: Agentic Discipline" video series (cleancoders.com/episode/agentic-discipline-1, /agentic-discipline-2; O'Reilly). Thesis: *preservation* of clean-code discipline in agentic era — rules still hold, agent must be disciplined to follow them.

Widely-circulated Reddit thread attributes "The AIs will outcode you many times to one... It's over" — but **could not find** Uncle Bob interrogating whether SRP's "one reason to change" — sized for human's narrow attention — should be relaxed for agent with 200K-token window.

**Has NOT written on SRP-vs-agent-context-window question.** Most prominent living defender of classical rules has not yet defended them against inverted-cognition argument. This silence is itself data point for thesis.

### 4. Sam Newman — essentially SILENT

Clearest silence. No 3rd ed of *Building Microservices* (2nd ed 2021); no samnewman.io essay on AI agents; InfoQ minibook predates agent era framing.

**Has NOT** addressed whether microservice granularity — originally justified by human team boundaries (Conway's Law) — should change when "team" is single agent with large context window. Striking gap given service granularity is precisely the variable thesis predicts should shift.

### 5. Michael Feathers — minimal engagement

Tech Lead Journal episode 195 + YouTube talk. Searched for Feathers + "brutalism"/"mechanical sympathy" + AI — no essay matches. *Working Effectively with Legacy Code* framing (seams, characterization tests) conceptually adjacent to Face idea (seam = thin discoverable surface around large body), but Feathers has not extended to agent case.

### 6. Vaughn Vernon — engaged via talks, no first-party essay

Mastodon presence, SAG 2025 talk, InfoQ citations. Like Evans, angle is DDD's survival/adaptation, not structural argument about module sizing for agent readers.

### 7. Alistair Cockburn — partially engaged; Hexagonal angle structurally relevant

Original Hexagonal Architecture essay is *the* canonical precedent for Face/Body distinction: ports are small queryable surface, adapters and application core are body. Cockburn has LinkedIn post on ChatGPT as "translation layer" and where to place it in hexagonal system — active engagement with agent question *within* existing framework. Franz Bender's "The Hexagonal Agent" explicitly maps Cockburn's ports-and-adapters onto LLM agents.

Cockburn's *framework* is strong precedent for Face half; Cockburn *himself* has not proposed that *size* of hexagon (body) should grow because consumer is now agent not human.

### 8. Kevlin Henney — engaged and explicitly SKEPTICAL; closest to diagnosis in spirit

Most clearly articulated *variant* of diagnosis, from opposite direction. LinkedIn post + talk "The Hidden Risk in AI-Generated Code" + "Think For Yourself" + Deep Engineering podcast.

Argument: GenAI does NOT change fundamental rules of good architecture — bottleneck shifts to *knowing the patterns and structures* rather than to typing. "GenAI shifts bottleneck from writing to architecture and pattern knowledge itself."

Half-agrees with thesis (bottleneck moves) but disagrees with prescription (Henney says rules still apply; thesis says rules themselves were tuned for wrong consumer). **Henney is author a thesis like ours most needs to engage with directly.**

### 9. Grady Booch — engaged at accountability level, not module-structure

Pragmatic Engineer interview "The Third Golden Age of Software" + InfoQ podcast. Framing: AI-generated code makes *architect's* judgment *more* necessary — someone must hold global coherence agent lacks.

Consistent with "weak global coherence" half of cognitive-profile diagnosis, but prescription is *human architectural accountability*, not restructuring of code itself. Has not addressed module sizing, Face/Body splits, or typed-graph linkage.

---

## Concept-level findings (beyond the nine)

**OpenAI "harness engineering" origin.** "0 lines of manually-written code." Thesis-relevant passage: prescription to *"give Codex a map, not a 1,000-page instruction manual,"* combined with emphasis on *progressive disclosure* and *"enforce invariants, not micromanaging implementations."* Near-direct Face/Body statement from authoritative source: small map (Face) over large body, invariants as queryable contract. LangChain's "Agent = Model + Harness" independently arrives at same formulation.

**Zengineer "From Human-Centric Code to AI-Native Architecture"** (ljzengineer.medium.com) — **strongest single essay-length precedent for Body half.** Explicitly argues for *"larger, self-contained modules organized by domain, fewer layers, and function-oriented design."* Matches Body half almost exactly. **Does not propose small queryable Face half.**

Supplementary: every.to/guides/agent-native, builder.io/blog/agent-native-architecture, levelup.gitconnected.com modular monoliths argument — all converge on "bigger cohesive modules for agents" — none propose small queryable Face half.

**Graph navigation vs file reading.** Codebase-Memory knowledge-graph approach (arxiv 2603.27277) proposes tree-sitter-based code knowledge graphs so agents *navigate typed graph* rather than read files sequentially. Matches linkage half. Manifest/registry-driven discovery widespread in agent-framework ecosystem (Praetorian MANIFEST.yaml, MCP server.json) — but always at agent layer, never as intra-codebase module-structuring primitive.

**CLAUDE.md / AGENTS.md guidance.** Anthropic recommends keeping CLAUDE.md under ~200 lines — implicit acknowledgment that *Face* (file agent always reads) must be small and dense, while body of codebase is large. Face/Body split arrived at empirically from other direction.

---

## Synthesis: is Face/Body with typed-graph linkage precedent or novel?

Decompose into four claims:

**Claim 1 — Classical rules optimized for human cognition, not agent.** Diagnosis largely **UNSTATED** by nine. One partial exception: Henney's "bottleneck shifts to architecture/patterns" comes closest to noticing consumer changed, but draws opposite conclusion. Fowler, Evans, Vernon, Cockburn, Booch all *work within* classical rules, add agent-specific scaffolding on top. Uncle Bob's 2026 course actively defends classical rules. **None explicitly says "SRP's 'one reason to change' is sized for human's 7±2 working memory and is wrong for 200K-token agent." Diagnosis itself appears under-articulated by named leaders.**

**Claim 2 — Modules should be larger and more cohesive (Body half).** Strong **precedent.** Zengineer states directly. Modular-monolith-over-microservices argument via context economics. OpenAI "map not manual" implies it. CLAUDE.md <200-line is inverse corollary. **Not novel.**

**Claim 3 — Each module should expose small queryable Face (registry of exports/consumes/invariants).** **Partial precedent.** Cockburn's Hexagonal ports are architectural ancestor. OpenAI's "enforce invariants, not implementations" and Fowler's feedforward guides are agent-era restatement. CLAUDE.md/AGENTS.md degenerate form (one Face per repo, not per module). But specific proposal — *per-module, machine-queryable, structured registry of exports AND consumes AND invariants as primary discovery surface* — does not appear in any of nine authors' work. Manifests exist at agent/tool layer; Faces-as-module-primitive do not.

**Claim 4 — Modules linked via typed graph rather than textual code imports.** **Partial precedent, novel synthesis.** Codebase-Memory knowledge-graph paper proposes graph navigation at tooling layer. MCP/Internet-of-Agents propose typed capability discovery at inter-agent layer. But proposing codebase itself be structured so primary dependency topology is typed graph (with imports demoted to implementation detail of Body) — **no thought leader or practitioner source articulates this as first-class architectural rule.** Most novel component.

---

## Overall verdict

**Constellation Architecture is novel synthesis of mostly-precedented parts.**

Strongest intellectual debts:
- Cockburn's Hexagonal Architecture (Face/Body distinction)
- OpenAI's harness engineering (invariants over implementations)
- Zengineer's AI-native sizing argument (bigger cohesive bodies)

Genuinely novel contributions:
- (a) explicit framing that classical rules are *mis-tuned* for inverted cognitive profile — framing none of nine have stated head-on
- (b) typed-graph linkage as first-class module primitive — analogues in agent-tooling and inter-agent protocols but no precedent as intra-codebase structuring rule

Closest named thought leader: **Fowler's harness/sensors corpus**, which arrives at Face/Body distinction *operationally* (feedforward guides + feedback sensors) without naming it as *structural* property of modules.

## Practical implication

**Gap identified is real and uncontested.** The nine leaders are either:
- Defending old rules (Uncle Bob, Henney)
- Working around them with scaffolding (Fowler, Cockburn)
- Silent (Newman most striking, given service granularity is exact variable thesis predicts should shift)

Nobody has yet published explicit argument that rules were tuned to different consumer and should be re-derived for new one. **That is the opening.**

---

## Full source list

- https://openai.com/index/harness-engineering/ — OpenAI harness engineering origin
- https://www.langchain.com/blog/the-anatomy-of-an-agent-harness — Agent = Model + Harness
- https://martinfowler.com/articles/harness-engineering.html — Fowler harness
- https://martinfowler.com/articles/sensors-for-coding-agents.html — Boeckeler/Fowler sensors
- https://martinfowler.com/bliki/AgenticProgramming.html — Fowler bliki
- https://martinfowler.com/articles/structured-prompt-driven/ — SPDD
- https://martinfowler.com/articles/exploring-gen-ai.html — Fowler GenAI hub
- https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html — Uncle Bob canonical SRP
- https://cleancoders.com/episode/agentic-discipline-1 — Uncle Bob + J. Martin "Agentic Discipline" Ep.1
- https://cleancoders.com/episode/agentic-discipline-2 — Ep.2
- https://www.youtube.com/watch?v=Tll_suxZluk — Evans, "DDD and LLMs," Explore DDD 2024
- https://www.infoq.com/news/2024/03/Evans-ddd-experiment-llm/ — InfoQ on Evans
- https://www.domainlanguage.com/articles/llm-software-design-learning-journey/ — Evans's essay
- https://alistair.cockburn.us/hexagonal-architecture — Cockburn Hexagonal original
- https://medium.com/@franz.bender/the-hexagonal-agent-6e9a5d31a4a7 — Bender "The Hexagonal Agent"
- https://www.linkedin.com/posts/kevlin_apparently-because-of-genai-developers-activity-7439626645180665858-gsrE — Henney key post
- https://www.youtube.com/watch?v=Qgw9fjw4lcU — Henney "Hidden Risk in AI-Generated Code"
- https://kevlinhenney.medium.com/think-for-yourself-7d129aa959e3 — Henney "Think For Yourself"
- https://newsletter.pragmaticengineer.com/p/the-third-golden-age-of-software — Booch interview
- https://ljzengineer.medium.com/from-human-centric-code-to-ai-native-architecture-422bc89e66a0 — Zengineer (strongest Body-half precedent)
- https://every.to/guides/agent-native — Agent-native architectures
- https://www.builder.io/blog/agent-native-architecture
- https://levelup.gitconnected.com/modular-monolith-instead-of-of-microservices-... — Modular monolith for agents
- https://arxiv.org/html/2603.27277v1 — Codebase-Memory knowledge graphs
- https://arxiv.org/html/2606.21804v1 — "Is Agent Code Less Maintainable Than Human Code?"
- https://code.claude.com/docs/en/memory — CLAUDE.md <200 lines guidance
- https://maintainable.software/agentic-engineering-part-2-agentic-codebase-principles/ — Locality, blast radius, navigability
