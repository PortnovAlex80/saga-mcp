# Critic 1: Classical Architecture Defender (Henney successor)

> **Source:** research agent run 2026-07-17, subagent `agent_91f2b083`.
> **Stance:** Defender of classical principles. SRP/layering/DDD encode deep truths about complexity, not human cognition accidents.
> **Verdict:** "Charter's diagnosis is strawman; empirical case contradicted by its own citations; central primitive is Hexagonal renamed; enforcement story punted. What survives is real and worth shipping — but doesn't require accepting Constellation thesis."

---

## Seven critiques

### 1. The "tuned for human cognition" claim is a strawman, and the charter knows it ★ MOST DAMAGING

**Claim under attack:** Charter §1's table — "Small files, because human working memory is 7±2 (Miller's Law)"; "Single Responsibility, because humans lose track of multi-purpose units."

**The attack:** SRP is not about working memory. Never was. Uncle Bob's canonical SRP is "a class should have one reason to change," traced explicitly to Parnas 1972. Parnas's argument was about **change-propagation**: different stakeholders cause change at different rates for different reasons; decompose so change in one concern doesn't force re-examination of others. *Coupling-and-cohesion argument about change axes*, not *chunking argument about memory slots*.

LLM with 2M-token window still cannot escape fact that module with N reasons-to-change is N times more likely to be touched by N parallel agents breaking each other.

Charter conflates three unrelated principles into single caricature: file-size (style guideline), SRP (change-axis principle), layering (dependency-direction invariant). None reduces to Miller's 7±2.

Charter §1 of report 06 attributes SRP to "Parnas's 1972 decomposition — explicitly cognitive/organizational argument." **Organizational. As in Conway/stakeholder/change-rate clustering. Not cognitive in working-memory sense.**

**What would change my mind:** Single primary source (Parnas, Uncle Bob, Martin) where SRP explicitly justified by working-memory capacity rather than change-rate/stakeholder concern. Source doesn't exist.

### 2. The proposal ignores its own counter-evidence on file size

**Claim under attack:** §3 "Body — Large acceptable (1000-3000 lines OK)."

**The attack:** arXiv:2606.21804 ("Is Agent Code Less Maintainable Than Human Code?"): building on agent-generated code drops downstream task-resolve rates more often than building on human code. **Direct empirical evidence agent-built large bodies are LESS maintainable.** Charter buries this, never reconciles.

Charter's own cognitive-profile table contradicts prescription. §1 concedes LLM has "weak global coherence reasoning" and is "confidently wrong." **Proposed cure for executor with weak global coherence: hand it 3000-line bodies and ask to preserve invariants across them. If diagnosis right, prescription wrong.**

Industry consensus moving other way: Cursor guidance, Willison anti-patterns, Anthropic CLAUDE.md <200-line rule. Charter cites, proceeds as if doesn't apply inside Body.

**What would change my mind:** Controlled experiment where agent maintains 3000-line Body more reliably than three cohesive 1000-line modules. H2 asserts; H2 not run.

### 3. "Face as typed registry" is WSDL/CORBA/SOAP, and charter's defense fails

**Claim under attack:** §3 "Why this is NOT just IDL/WSDL/TypeScript interfaces."

**The attack:** Three defenses don't address why IDL-registry architectures actually failed. Failed because of **drift between declaration and implementation, double source of truth, ceremony cost exceeding value.** None specific to interoperability — intrinsic to two artifacts kept synchronized by process compiler cannot enforce.

OQ2 admits enforcement problem open. R19 punted "AST analysis, future." R20 issues warning (non-binding). **Enforcement mechanism doesn't exist; design tolerates violation by default.**

We've been here before: CORBA IDL, WSDL, Thrift, Protobuf, gRPC schema, OpenAPI. Each survives *only at actual process/network boundary* — only place ceremony pays for itself. Inside codebase nobody maintains IDL per internal module. **Charter presents no evidence calculus flips for LLMs.**

**What would change my mind:** Working AST-level linter for real language, run across non-trivial codebase, where measured Face/Body drift over 6 months below stated threshold.

### 4. "Constellation Module" is Hexagonal Architecture with a registry

**Claim under attack:** §3 "Constellation Architecture" as named new thing.

**The attack:** Report 06 admits: "Strongest intellectual debts: Cockburn's Hexagonal Architecture (Face/Body distinction)." Claims two novel contributions: (a) framing that rules mis-tuned, (b) typed-graph linkage as first-class primitive.

Framing (critique 1) is strawman, so (a) rhetorical. (b) is *tooling*, not *architecture*. Hexagonal module observed by tool indexing ports into graph is still Hexagonal module. Cockburn 2005 didn't say "you may not also build database of your ports." **Graph is observation of architecture, not new architecture.**

Report 03 line 186-189 states openly: "Saga arrived at structurally similar answers... Problems isomorphic; solutions converge." Convergent rediscovery not novelty — recommendation to *use Cockburn correctly and add CI step*.

**Renaming not harmless.** Obscures prior art, prevents practitioners reaching for Hexagonal/Ports&Adapters literature, positions 20-year-old idea as 2026 discovery. Henney would call pattern-seeking.

**What would change my mind:** Single structural property of "Constellation Module" that Hexagonal module + indexed port registry cannot express. Haven't found one.

### 5. Hidden costs the proposal does not acknowledge

**Claim under attack:** Charter's silence on maintenance burden.

**The attack:**
- **Double source of truth.** Every cross-module dependency in (a) import graph inside Bodies, (b) trace graph in saga DB. R20 warns when disagree. Steady state: they will disagree often, warnings ignored. Universal fate of double-source-of-truth systems.
- **Refactor cost doubles.** Adding dependency, renaming export, splitting module — each requires Body change AND Face change AND trace update. §4.4 lists four new lint rules. Four new sources of red.
- **Invariant drift between Face and Body.** Face declares invariants, Body implements. Nothing enforces declared invariant is one actually enforced. R19 covers signatures, not semantics. Hard problem (does Body actually protect invariant?) unaddressed.
- **Migration cost.** "Existing codebases don't have Faces. Migration path?" Silent. Greenfield architecture sold against brownfield reality.

Classical SRP has charming property: enforced by code itself — import graph IS dependency graph; public API IS source of truth. Constellation deliberately breaks that, proposes lint rules to paper over breakage.

### 6. "100K-2M token context" is category error about how models actually work

**Claim under attack:** §1 "Working memory: 100K-2M tokens in single context."

**The attack:** Token window ≠ usable retrieval. Empirical literature (Anthropic evaluations, needle-in-haystack body, attention degradation): **reliable extraction degrades sharply past ~32-64K range**, even on models nominally accepting 1M+ tokens. Charter treats advertised window as effective working memory. It is not.

3000-line Body = ~25-40K tokens. If agent must reliably locate and respect three invariants while making change, operating at edge of reliable retrieval — same regime where humans start missing things. **TRIZ "physical contradiction" built on false premise: LLM's effective working memory is NOT dramatically larger than human's for targeted invariant-preserving edit.** Pattern-matching over large corpus easy; targeted invariant-preserving edit over same corpus not.

### 7. Experimental methodology cannot falsify thesis

**Claim under attack:** §5 (H1-H6), §6 (methodology).

**The attack:** Hypotheses unfalsifiable as specified. H1 ("fewer conflicts under Constellation than SRP") requires definition of "classical SRP" that isn't strawman, sample size detecting difference, stochasticity model. N=1 smoke-tests cannot produce. "changes_requested counts" as confusion markers — proxy so noisy can mean anything.

"12 datapoints supporting thesis" support no such thing. Each saga-mcp feature responding to LLM constraint. **Not one is evidence for Constellation over SRP.** Listing as supporting evidence is rhetorical misdirection — supports diagnosis of statelessness, not prescription of Face/Body.

---

## What survives — 3 things critic grudgingly defends

### 1. The statelessness diagnosis and its design consequences

Charter correct that LLM executor has zero persistent memory across sessions, requires explicit durable state — accepted_hash, drift detection, typed task provenance, content-addressed artifacts. §7's "12 datapoints" real and useful, even though don't support Constellation specifically. **Diagnosis of stateless-per-launch is strongest part of charter, what saga-mcp has genuinely pioneered. Nothing to do with classical architecture being wrong; orthogonal infrastructure.**

### 2. Artifact graph as queryable index of the architecture ★ KEY SURVIVOR

Report 03's most defensible claim: classical frameworks arrived at same answers by different route, what they add is *naming and typing discipline*. If proposal modestly framed as "build tool that indexes Hexagonal ports, Clean Architecture dependency direction, DDD Context Maps into queryable graph" — **would defend enthusiastically.**

Dependency-rule-as-graph-direction-invariant (report 03 §3.5) genuinely useful, strict *enforcement* of Cockburn/Martin, not replacement.

### 3. Invariants as queryable contract ★★ DEFENSIBLE CORE

Narrow slice of Face that declares **invariants** — not exports, not consumes — is defensible core. Henney himself repeatedly argues for thinking in invariants, contracts, properties.

**Registry of machine-checkable invariants per module, used as Trusted Guard input (REQ-012), is valuable.** This is one place where charter identified real gap: **classical architecture talks about invariants constantly and enforces them almost never.**

If Constellation Architecture narrowed to "invariant registry, enforced, per module" — would be real contribution. Rest of Face (exports/consumes as parallel of import graph) is ceremony layered on ceremony.

---

## Bottom line

Charter's diagnosis is strawman; empirical case contradicted by own citations; central primitive is Hexagonal renamed; enforcement punted to "future REQs"; experimental methodology cannot falsify itself; headline cognitive-premise (token window = working memory) is category error.

**What survives — saga's durable-state infrastructure, artifact-graph-as-index-of-Cockburn, invariant registry — is real and worth shipping. None requires accepting Constellation Architecture thesis. Most already done by saga-mcp under names it already has.**

Proposal credible when it stops renaming Hexagonal modules, drops cognitive-strawman framing, and shows — not asserts — that 3000-line Body survives 50 agent edits better than three 1000-line modules.
