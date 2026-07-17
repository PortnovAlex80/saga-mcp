# Literature Scan: Architecture for AI Coding Agents

> **Source:** research agent run 2026-07-17, subagent `agent_f77aa90d`.
> **Method:** ~18 WebSearch queries + 2 primary-source reads.
> **Purpose:** map existing work on agent-oriented software engineering for private research blog and saga-mcp roadmap.

## Executive Summary

The thesis sits in a **narrowly occupied niche**. The literature is abundant on two adjacent topics but thin on ours specifically:

- **Abundant:** "architecture OF agents" (how to build agent systems — ReAct, Plan-Execute, orchestrator-worker) and "protecting human architecture FROM agents" (guardrails, AGENTS.md, spec-driven dev).
- **Thin (our gap):** "architecture REDESIGNED FOR agent cognition" — the claim that classical principles were human-cognition-optimized and should be re-evaluated against an agent cognitive profile. Only two sources engage this directly (Maintainable Software's agentic codebase principles; OpenAI's "harness engineering"). No one frames it as a cognitive-profile mismatch.

The space is fragmented across arXiv preprints, vendor engineering blogs (OpenAI, Anthropic, Cognition, Cursor), practitioner Substacks, and 1990s AOSE work. There is no canonical paper. **Good news for a thesis — the territory is open — but means we synthesize more than cite.**

---

## RQ1: Architecture FOR AI Agents (the core thesis)

**State: embryonic but real. Two anchor sources, plus an emerging academic strand.**

### Most influential sources (ranked)

1. **OpenAI — "Harness engineering: leveraging Codex in an agent-first world"** ([openai.com/index/harness-engineering](https://openai.com/index/harness-engineering/))
   - *Claim:* When a repository is entirely agent-generated, it gets optimized **first for Codex's legibility** (UI, logs, app metrics made directly observable to the agent) rather than for human readability. The AGENTS.md itself was agent-authored.
   - *Relation to thesis:* **Strongly supports.** Closest an industry player has come to saying "redesign the app for the agent's cognitive profile." Introduces "application legibility" as first-class architectural concern.
   - *Concrete pattern:* Make runtime state (logs, metrics, UI) agent-inspectable rather than requiring humans to interpret output for the agent.

2. **Maintainable Software — "How to Design a Maintainable Codebase for AI Coding Agents"** ([maintainable.software/agentic-engineering-part-2](https://maintainable.software/agentic-engineering-part-2-agentic-codebase-principles/))
   - *Claim:* A maintainable codebase for agents lets "an unfamiliar agent find the right context, make a narrow change, and verify it" — proposes **locality, small blast radius, boundary integrity, navigability, cohesive modules, ownership-aligned boundaries**.
   - *Relation to thesis:* **Directly supports — closest existing articulation of our thesis.** Explicitly reframes maintainability around agent capabilities rather than human reading.
   - *Concrete patterns:* Blast-radius analysis converts tacit structural knowledge into queryable data; design so change touches few files; co-locate things that change together for agent locality.

3. **Anthropic — "Harness design for long-running application development"** + companion "Effective harnesses for long-running agents" ([anthropic.com/engineering/harness-design-long-running-apps](https://www.anthropic.com/engineering/harness-design-long-running-apps), [anthropic.com/engineering/effective-harnesses-for-long-running-agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents))
   - *Claim:* Harness design (scaffolding around model) is key performance lever at agentic frontier; long-running multi-context builds need generator/evaluator loops (`/goal` command), subagent isolation, checkpointing.
   - *Relation to thesis:* **Supports (harness-level).** Doesn't address codebase architecture directly but implies it: long-running agents need resumable, partitionable work — codebase must support stateless re-entry.
   - *Reference repo:* [github.com/anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents).

4. **arXiv 2604.04990 — "Architecture Without Architects: How AI Coding Agents Shape Software Architecture"** ([arxiv.org/abs/2604.04990](https://arxiv.org/abs/2604.04990))
   - *Claim:* Agents make **implicit architectural decisions** (framework/database/deployment selection) via prompt-driven mechanisms, producing "five mechanisms, six coupling patterns, and a governance gap." These are architectural acts going ungoverned.
   - *Relation to thesis:* **Orthogonal/contradictory.** Frames agents as a *risk to be governed*, not as a cognition to be designed-for. Good evidence base for the "things break" half of thesis.
   - *Popular write-up:* [pub.towardsai.net/architecture-without-architects](https://pub.towardsai.net/architecture-without-architects-the-hidden-cost-of-ai-coding-agents-a7298110b7be).

5. **arXiv 2603.00601 — "Theory of Code Space (ToCS): Do Code Agents Understand Software Architecture?"** ([arxiv.org/abs/2603.00601](https://arxiv.org/abs/2603.00601))
   - *Claim:* Benchmarks whether agents can construct/maintain a coherent architectural mental model. Implicit finding: **agents lack global architectural coherence** — they manipulate surfaces.
   - *Relation to thesis:* **Strongly supports the "principles break" half.** Empirical evidence that whatever architecture humans optimized for, agents don't internalize it the same way.

6. **arXiv 2603.28592 — "A Large-Scale Empirical Study of AI-Generated Code in the Wild"** ([arxiv.org/html/2603.28592v2](https://arxiv.org/html/2603.28592v2))
   - *Claim:* Across 302K+ AI-generated items, 484K+ issues: **89.3% code smells (architecture-level), 6% correctness, 4.7% security.** AI optimizes for local correctness, lacks global architectural judgment.
   - *Relation to thesis:* **Strongest empirical support.** Quantifies the "principles break" claim — the dominant failure mode is architectural, not bugs.

7. **arXiv 2511.09268 — "Decoding the Configuration of AI Coding Agents"** ([arxiv.org/html/2511.09268v1](https://arxiv.org/html/2511.09268v1))
   - *Claim:* Empirical study of how developers configure code-agent files (AGENTS.md etc.); finds recurring "Software Architecture" sections in configs.
   - *Relation to thesis:* **Supports — shows the field is inventing ad-hoc architecture-for-agent conventions without theory.**

8. **NimblePros — "Keeping AI Agents In Line With Clean Architecture"** ([blog.nimblepros.com/blogs/ai-agents-clean-architecture](https://blog.nimblepros.com/blogs/ai-agents-clean-architecture/))
   - *Claim:* Clean Architecture's explicit boundaries are the ideal guardrail for keeping agents consistent.
   - *Relation to thesis:* **Contradicts the "principles break" claim** — argues Clean Architecture transfers wholesale. Useful counterpoint.

---

## RQ2: What Frameworks Say/Imply About Code Architecture

**State: frameworks almost never prescribe target-code architecture. They prescribe agent-internal architecture and leave the codebase to the user. The prescriptions that exist are implicit and conflicting.**

### Framework-by-framework findings

| Framework | Architectural stance on *target code* | Source |
|---|---|---|
| **Devin / Cognition** | **Single-threaded continuous-context agent** over multi-agent (Cognition's "Don't Build Multi-Agents"). Implication for codebase: optimize for one agent holding full context, not for parallelizable partitions. "Provide the architecture upfront." | [cognition.com/blog/dont-build-multi-agents](https://cognition.com/blog/dont-build-multi-agents), [devin.ai/agents101](https://devin.ai/agents101) |
| **Cursor** | Plan-first, rule-based. `.mdc` rules and AGENTS.md encode conventions; no opinion on what those conventions should be. Best practice: "plan architecture before prompting," rules under 500 lines. | [cursor.com/blog/agent-best-practices](https://cursor.com/blog/agent-best-practices), [prompthub.us/blog/top-cursor-rules-for-coding-agents](https://www.prompthub.us/blog/top-cursor-rules-for-coding-agents) |
| **Aider** | **Repository map** (tree-sitter-based symbol graph) is the explicit architectural bridge — Aider builds a compressed map of the codebase rather than reading it whole. Architect mode = two-stage (architect proposes, editor implements). | [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html), [aider.chat/2023/10/22/repomap.html](https://aider.chat/2023/10/22/repomap.html) |
| **SWE-agent** | **Agent-Computer Interface (ACI)** is the design contribution — the action/observation space matters more than the model. Minimal toolset (file edit + shell). Implicit: codebases navigable by grep/open/edit win. | [github.com/swe-agent/swe-agent](https://github.com/swe-agent/swe-agent), [arXiv 2512.10398 scalable scaffolding](https://arxiv.org/html/2512.10398v6) |
| **OpenHands** | V1 SDK principles: composability, optional isolation, type-safe interfaces. "Code is the universal action — don't design 20 tools, give bash+editor+browser." | [docs.openhands.dev/sdk/arch/design](https://docs.openhands.dev/sdk/arch/design), [arXiv 2511.03690](https://arxiv.org/html/2511.03690v1) |
| **AutoGPT / BabyAGI** | Goal-driven monolithic loop vs. 3-agent task queue. Neither addresses target-code architecture — they predate the codebase-quality conversation. | AutoGPT vs BabyAGI comparisons |
| **CrewAI / AutoGen / LangGraph** | **Agent-internal** architecture only (roles/tasks, conversational mesh, state graph). LangChain's "Choosing the Right Multi-Agent Architecture" gives 4 patterns (subagents, skills, handoffs, routers) — all about agent topology, not code topology. | [langchain.com/blog/choosing-the-right-multi-agent-architecture](https://www.langchain.com/blog/choosing-the-right-multi-agent-architecture) |

### Key implication for our thesis
**Frameworks are architecture-agnostic about the codebase by design.** The one structural signal worth extracting: Aider's repo-map and SWE-agent's ACI both imply that **agent-legible structure = explicit, greppable, symbol-graph-friendly code** — which mildly contradicts human-aesthetic preferences (heavy DI magic, implicit conventions, "clever" metaprogramming).

### Conflicting prescription worth highlighting
Cognition argues **single-agent + full context** → favors monolithic, high-locality codebases. The multi-agent camp (MetaGPT, LangGraph, OpenHands multi-agent) implies **partitionable, contract-bound codebases** that map to agent boundaries. **This contradiction is itself a research finding** — no one has reconciled it.

---

## RQ3: Academic Multi-Agent Software Engineering

**State: the academic literature is dominated by "agents that DO software development" (ChatDev, MetaGPT, SWE-agent), not "software development that accommodates agents."**

### Foundational academic sources

- **MetaGPT (arXiv 2308.00352)** — [arxiv.org/html/2308.00352v6](https://arxiv.org/html/2308.00352v6). SOP-driven multi-agent framework; encodes human SDLC workflows (PM/architect/dev/QA roles) as agent roles. ICLR 2024. *Implication:* treats classical SDLC as the target to mimic, not to redesign.
- **ChatDev** — virtual software company with role-specialized agents. Same framing.
- **OpenHands (ICLR 2025)** — [openreview.net/forum?id=OJd3ayDDoF](https://openreview.net/forum?id=OJd3ayDDoF). Platform paper, ~890 citations.
- **Survey: "A Survey on Code Generation with LLM-based Agents" (arXiv 2508.00083)** — [arxiv.org/html/2508.00083v1](https://arxiv.org/html/2508.00083v1). Explicitly notes current code agents **lack software architecture understanding**, limiting autonomous planning. Direct evidence for our "principles break" claim.
- **"LLM-Based Multi-Agent Systems for Software Engineering" (arXiv 2404.04834)** — [arxiv.org/html/2404.04834v4](https://arxiv.org/html/2404.04834v4). Positions Shoham's AOP as foundation.

### "Agent-oriented programming" — RED HERRING CONFIRMED
Shoham's 1993 **Agent-Oriented Programming** ([en.wikipedia.org/wiki/Agent-oriented_programming](https://en.wikipedia.org/wiki/Agent-oriented_programming), Wooldridge/Jennings AOSE papers) is a **design-time paradigm for software composed OF agents** (agents as runtime abstractions with beliefs/desires/intentions). Our topic is software **BUILT BY agents**. These are **orthogonal** — you could build agent-oriented software by hand, or build traditional OOP software entirely via agents. The term collision is a real trap; several recent sources (Smythos, Cisco Outshift) conflate them. **Cite Shoham/Wooldridge only to disambiguate, not as prior art on the actual question.**

---

## Explicit "GoF under agents" and "DDD under agents" Discussions

### GoF under agents — YES, active but shallow
- **SAP Community — "Tame Your Agents: 10 Design Patterns for Reliable Agentic AI"** ([community.sap.com/.../tame-your-agents](https://community.sap.com/t5/technology-blog-posts-by-sap/tame-your-agents-10-design-patterns-for-reliable-agentic-ai/ba-p/14424874)) — explicitly claims "classic GoF and enterprise-integration patterns already solved" multi-step agentic structure. Strategy→routing, Observer→event-driven agents, Mediator→coordination, Command→action encapsulation/undo.
- **Cisco Outshift — "Agent-Oriented Design Patterns"** ([outshift.cisco.com/blog/ai-ml/agent-design-patterns-system-development](https://outshift.cisco.com/blog/ai-ml/agent-design-patterns-system-development)).
- **arXiv 2601.19752 — "Agentic Design Patterns: A System-Theoretic Framework"** ([arxiv.org/html/2601.19752v1](https://arxiv.org/html/2601.19752v1)) — categorizes agent patterns (Foundational, Cognitive, Execution, Adaptive).
- **Gap:** All these apply GoF to **the agent's own architecture**, not to **codebases agents maintain**. Nobody has written "Strategy pattern under agent authorship" at the code level. This is wide open.

### DDD under agents — YES, the most developed classical-principle adaptation
- **Russ Miles — "Domain Driven Agent Design"** ([engineeringagents.substack.com/p/domain-driven-agent-design](https://engineeringagents.substack.com/p/domain-driven-agent-design)) — "Bounded contexts protect you; DDD gives the scaffolding."
- **Philipp Kostyra — "Agent as Bounded Context"** ([medium.com/@philippkostyra/agent-as-bounded-context-part-2](https://medium.com/@philippkostyra/agent-as-bounded-context-part-2-e18c0405be60)) — treat each agent as a bounded context.
- **James Croft — "Applying DDD to Multi-Agent AI Systems"** ([jamescroft.co.uk/.../applying-domain-driven-design-principles-to-multi-agent-ai-systems](https://www.jamescroft.co.uk/applying-domain-driven-design-principles-to-multi-agent-ai-systems/)).
- **Slava Dubrov — "Domain-Driven Design for AI Agents"** ([slavadubrov.github.io/blog/2025/10/20/domain-driven-design-ai-agents](https://slavadubrov.github.io/blog/2025/10/20/domain-driven-design-ai-agents/)).
- **arXiv 2603.26244 — "Automating DDD: Experience with a Prompting..."** ([arxiv.org/html/2603.26244v1](https://arxiv.org/html/2603.26244v1)) — LLM auto-identifies bounded contexts.
- **GitNation talk — "From Prompt Spaghetti to Bounded Contexts: DDD for Agentic Codebases"** ([gitnation.com/contents/from-prompt-spaghetti-to-bounded-contexts-ddd-for-agentic-codebases](https://gitnation.com/contents/from-prompt-spaghetti-to-bounded-contexts-ddd-for-agentic-codebases)).
- **Consensus:** Bounded context ≈ agent boundary. This is the **single clearest adaptation** of a classical principle to the agent era. But framed as "DDD helps organize agents," not "DDD must change because agents, not humans, traverse it."

### Hexagonal / Clean Architecture under agents — modest coverage
- **"Ports & Adapters for AI — Why Hexagonal Still Wins"** ([linkedin.com/pulse/ports-adapters-ai](https://www.linkedin.com/pulse/ports-adapters-ai-why-hexagonal-architecture-still-wins-varun-singh-l9owe)) — argues hexagonal wins for swapping LLM providers/tools.
- **NimblePros Clean Architecture piece** (above).
- All argue these patterns **transfer unchanged**. None argue they need reinvention.

### TOGAF / enterprise architecture under agents — **NOTHING FOUND.** Clean gap.

### Test pyramid under agents — adaptation in progress, but for testing agents, not for how agents structure tests
- **Block Engineering — "Testing Pyramid for AI Agents"** ([engineering.block.xyz/blog/testing-pyramid-for-ai-agents](https://engineering.block.xyz/blog/testing-pyramid-for-ai-agents)).
- **LangWatch — "The Agent Testing Pyramid"** ([langwatch.ai/scenario/best-practices/the-agent-testing-pyramid](https://langwatch.ai/scenario/best-practices/the-agent-testing-pyramid)).
- **EPAM — "Testing Pyramid 2.0 for GenAI"** ([epam.com/.../reimagining-testing-pyramid-for-genai-applications](https://www.epam.com/insights/ai/blogs/reimagining-testing-pyramid-for-genai-applications)) — argues classic pyramid fails for GenAI, proposes integration-first.
- **arXiv 2601.18827 — "Automated structural testing of LLM-based agents"** ([arxiv.org/html/2601.18827v1](https://arxiv.org/html/2601.18827v1)).
- **Gap:** All frame it as "how to test agents." Nobody asks "how should an agent, writing tests in code it authors, structure the test pyramid differently than a human would?"

---

## Recurring Themes (cross-source)

1. **Guardrails over redesign.** The dominant frame is "agents threaten architecture → add guardrails (AGENTS.md, hooks, spec-driven dev, model-driven tools like Scryer)." Almost no one asks "redesign the architecture itself." [GitHub Spec Kit](https://github.com/spec-kit), [Cursor best practices](https://cursor.com/blog/agent-best-practices), [Bitloops architectural constraints](https://bitloops.com/resources/governance/architectural-constraints-for-ai-agents).
2. **Locality / small blast radius as the emergent axiom.** Appears independently in Maintainable Software, dev.to's "Agentic Engineering Framework," and practitioner posts — without being tied to a cognitive-profile argument. Our thesis could provide the *why*.
3. **Agent-legibility as a new first-class concern.** OpenAI's "harness engineering" introduces making UI/logs/metrics directly observable to the agent. Closest anyone comes to our "different cognitive profile" framing.
4. **Single-agent vs. multi-agent as the defining architectural fork** (Cognition vs. everyone else) — with codebase-structure implications nobody has worked out.
5. **Classical patterns "still work" is the reflexive consensus** — asserted more than argued. DDD transfers cleanly (bounded context = agent boundary); Clean/Hexagonal "still win"; GoF "rediscovered." The counter-evidence (ToCS, the 89%-code-smells study) is not reconciled with this optimism.
6. **Empirical evidence that agents lack architectural coherence** is mounting (ToCS, the 302K-item code-smells study, PAGENT failed-patch study) — but framed as "agents are bad at architecture" rather than "architecture is bad for agents."

---

## What's MISSING — Gaps Our Research Could Fill

1. **The cognitive-profile frame itself.** Nobody explicitly says "classical principles were optimized for human working memory / attention / aesthetic judgment; agents have a different profile (huge context but no persistent mental model, no aesthetic preference, strength in pattern-matching, weakness in global coherence)." Maintainable Software gestures at it; OpenAI's "legibility" implies it. **This framing is ours to claim.**

2. **A systematic break/adapt/reinvent taxonomy.** No paper maps {Clean, DDD, Hexagonal, GoF, TOGAF, test pyramid} × {breaks under agents / adapts / must be reinvented}. Each principle has its own scattered discussion; none are unified. The DDD-as-bounded-context work is the most mature; TOGAF is a void.

3. **Empirical comparison of architectural styles for agent legibility.** ToCS benchmarks whether agents *understand* architecture — but no study compares "how well do agents perform in a Clean Architecture codebase vs. a Hexagonal one vs. a Big Ball of Mud?" That experiment is the natural testbed for our thesis and is wide open.

4. **Test pyramid as authored BY agents.** All "test pyramid + agents" work is about testing agents. The question "should an agent authoring tests structure the pyramid differently (e.g., heavier on golden/integration, lighter on unit, because agents write cheap integration tests)?" is unasked.

5. **Reconciliation of the single-agent vs. multi-agent codebase-implications contradiction.** Cognition says single-context; MetaGPT/LangGraph say partitioned. Nobody has asked "what codebase structure does each imply, and which is right?"

6. **TOGAF / enterprise architecture under agents.** Zero results. Enterprise architecture frameworks predate the conversation entirely.

7. **Saga-mcp / governance-gated development as a research artifact.** CGAD-style "transition gates, evidence-based acceptance, conflict-key detection" approach to governing agent-authored architecture is novel relative to the literature. The closest adjacent work (Bitloops constraints, AGENTS.md rules) is far less rigorous. This is publishable as a design science contribution.

---

## Bottom Line for the Thesis

The territory is real and largely unclaimed. The two strongest existing sources (OpenAI harness engineering; Maintainable Software's agentic principles) validate the thesis direction but stop short of the cognitive-profile framing. The academic literature actively supports the "principles break" half via the code-smells and ToCS studies. The DDD-as-bounded-context strand is the one place a classical principle has been seriously re-grounded for agents. The biggest open lanes are:
- (a) the unifying cognitive-profile argument
- (b) the break/adapt/reinvent taxonomy across all six principle families
- (c) empirical A/B of architectural styles for agent legibility
- (d) TOGAF/enterprise-architecture under agents, which is a complete blank

## Full source list

OpenAI harness engineering; Anthropic harness design (x2); Maintainable Software agentic principles; Cognition "Don't Build Multi-Agents"; arXiv 2604.04990 (Architecture Without Architects), 2603.00601 (ToCS), 2603.28592 (code smells), 2511.09268 (config decoding), 2508.00083 (code-agent survey), 2308.00352 (MetaGPT), 2404.04834 (LLM MAS for SE), 2511.03690 (OpenHands SDK), 2512.10398 (scalable scaffolding), 2601.19752 (agentic design patterns), 2603.26244 (automating DDD), 2601.18827 (structural testing); SWE-agent, Aider repo-map, Cursor best practices, LangChain multi-agent architectures; Russ Miles / Kostyra / Croft / Dubrov on DDD+agents; SAP/Cisco/Confluent/Google on agent design patterns; Block/LangWatch/EPAM on test pyramid; GitHub Spec Kit; NimblePros Clean Architecture; Shoham 1993 AOP (red-herring disambiguation).
