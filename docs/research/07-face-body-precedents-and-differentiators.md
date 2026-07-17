# Constellation Architecture: Precedent & Differentiator Research

> **Source:** research agent run 2026-07-17, subagent `agent_622b7205`.
> **Question:** What historical and existing frameworks match our Face/Body module separation + typed-graph linkage, and what is genuinely novel?

## Executive Summary

Face/Body separation has **deep, well-established precedents** on Face side (IDLs, ML module systems, capability models, WASM components, traceability matrices) and on Body side (enclaves, processes, actors, per-worktree isolation).

**Genuinely novel** is the *specific combination*:

1. **Explicit goal of LLM-context-window economics** (context-size-vs-discoverability paradox) as primary design driver — every precedent solved different problem (interoperability, security, concurrency, hardware locality)
2. **Physical de-linking of Face from Body in source tree** — dependencies resolved through external typed artifact graph (DB) rather than in-language imports or compile-time module system
3. **"Load Body once, work entirely inside it" rule** — closest to OpenAI's "application legibility / bootable-per-worktree" and Modular Imperative paper, but not previously framed as context-management discipline

---

## Section A — Classical Interface/Implementation Separators

### 1. WSDL / CORBA IDL / Protocol Buffers — **Partial (Face only)**

IDL is declarative, language-neutral description of *what* service offers. Stubs/skeletons generated from IDL.

**Difference:** IDLs for cross-language RPC interoperability + wire-format/codegen, not LLM context management. IDL and implementation still linked by language's build/codegen step; nothing resolved through external graph.

**Adopt?** Yes — WIT/`.proto`/IDL style is obvious Face format. WIT (item 10) is modern, language-agnostic successor, strongest single candidate.

### 2. Haskell typeclasses / ML modules / OCaml — **Partial-to-Strong (Face + Body)** ★

**Strongest of all classical precedents.** OCaml explicitly separates **signature** (Face — `sig`/`module type`) from **structure** (Body — `struct`/`module`), functors as parameterized composition. "The three definitions (class, data type, and instance) are completely separate." Signatures *restrict* what's externally visible — exactly our "protects" axis.

**Difference:** Signature attached to module at compile time via language's module system — not through external DB. Body in ML usually small (single module).

**Adopt?** Yes — OCaml signatures are **clearest theoretical grounding for "Face as type"**. "Signatures are to modules as types are to values" is right mental model. Academic ML-module lineage (Macqueen, Harper) is rigorous foundation to cite.

### 3. Capability-based security / E language / Mark Miller — **Partial (Face as capability list)**

Object capabilities (ocap) are addressable references carrying their own authority — no ambient authority. Mapping "Face as capability list, Body as private address space" almost exactly right: in E, object reference IS capability, internal state private.

**Difference:** Capabilities are runtime security mechanism (who can call what), not discovery mechanism.

**Adopt?** Yes — adopt "protects" axis of Face explicitly as capability/permission schema. Cite Miller's "Capability Myths Demolished" for why Face-level capability declarations beat ACL-style reasoning for LLM agents.

---

## Section B — OS / Isolation Precedents

### 4. Microkernels (seL4, Mach, L4) — **Strong ("saga DB as kernel")** ★ STRONGEST INFRASTRUCTURE PRECEDENT

seL4 = capability-based microkernel where each **protection domain (PD)** runs in isolated **VSpace** (Body); all authority mediated through per-thread hierarchical **CSpace** (capability graph — Face); communication via **IPC through capability-referenced endpoints**.

**Mapping "saga DB as kernel, modules as isolated address spaces":**
- saga DB = seL4 kernel (tracks capabilities/edges, mediates IPC)
- Module Body = protection domain's VSpace
- Face = CSpace entry for module (capability to invoke)
- Trace edge `implements`/`depends_on` = capability reference / IPC endpoint

**Difference:** seL4 solves runtime isolation + formal verification, not "what should LLM load."

**Adopt?** Yes — adopt CSpace metaphor explicitly: typed artifact graph IS capability space, saga DB IS microkernel for agents. Powerful and accurate framing. seL4's formal-verifiability suggests north star: **provably-complete Face coverage** (every Body export declared in graph).

### 5. SGX / enclaves — **Weak-to-Partial (Body isolation only)**

Enclave = isolated memory region with hardware-enforced ELRANGE; entry only via EENTER, exit via EEXIT/AEX.

**Adopt?** Metaphor for Body integrity: "Body is enclave — once loaded, agent works entirely inside, no cross-enclave transitions mid-task."

### 6. Unix processes / Plan 9 — **Strong (address space = Body, FDs = Face)** ★

Each Unix process = isolated address space (Body); file descriptors + sockets = Face; `ps`/`/proc` = crude registry. Unix FDs behave as capabilities, passable via sendmsg(). Plan 9 sharpens: each process has per-process private namespace (customized resource view via 9P). Plan 9 deliberately provides no mechanism to describe one process's namespace to another except by direct interaction — explicit isolation stance.

**Adopt?** Yes — "process = Body, FD table = Face" is most intuitive explanation for engineers. Plan 9's "no implicit namespace sharing" maps to "no implicit imports across Bodies."

### 7. Actor model (Hewitt, Erlang, Akka) — **Strong (purest Face + opaque Body)** ★ CLEANEST MATCH

Actors isolated (Body = private state, no shared memory), communicate only via messages; actor's typed mailbox protocol is Face. **Akka Typed** adds compile-time-typed actor interfaces.

**Adopt?** Akka Typed's message-protocol-as-interface is cleanest Face formalism for behavioral modules. Cite Hewitt/Erlang for "no shared state between Bodies" principle.

### 8. Data-Oriented Design (Mike Acton) — **Weak (metaphor only)**

DOD separates data layout (queryable) from transformations. Mapping strained — DOD famously anti-OO.

### 9. Rust crate visibility (`pub use`) — **Partial (Face enforcement in-language)**

Rust enforces explicit public surface via `pub use` re-exports; `pub(crate)`/`pub(super)` fine-grained scoping.

**Adopt?** Yes — adopt `pub use`-style re-export discipline as in-language convention helping auto-generate Faces.

### 10. WASM Component Model / WIT — **Strong (closest modern Face formalism)** ★ BEST FACE FORMAT

WASM component declares **typed imports and exports** in WIT; **World** bundles complete import/export boundary; **Canonical ABI** mediates calls; components may not export core Wasm memory (enforced sandboxing → strong Body isolation).

**Adopt?** **Yes — WIT is best candidate for Face IDL.** Modern, typed, has imports AND exports (consumes/exports axes), supports versioning, has real ABI. Cite Bytecode Alliance as upstream.

### 11. Graph-based languages (Luna, Unreal Blueprints) — **Strong conceptual match** ★ PHILOSOPHICAL ANCESTOR

Luna: "first language allowing switching between code and graphs on demand" — dependency graph IS program; files are views.

**Adopt?** Yes — Luna/Enso is clearest philosophical ancestor for "graph-first, files-as-views." Position Constellation as "Luna's graph-first principle, applied to source-code organization for LLM agents rather than visual programming."

---

## Section C — Industry Agent-Specific Approaches

**Critical finding: NONE of industry tools propose Face/Body separation as architectural principle.** All operate **retroactively** (indexing existing codebases) rather than **prescriptively** (requiring source organized Face+Body). This is largest white space.

### 12a. Aider's repository map — **Body-side only; no Face concept**

Tree-sitter → reference graph → **PageRank** → token-budgeted tree. Computed Face (extracted from Bodies), opposite of declared Face.

**Adopt?** PageRank-over-tree-sitter is industry baseline to beat. Pitch: Aider *infers* Face; Constellation *declares* it — no ranking loss.

### 12b. Cursor / Continue.dev — **RAG, not architecture**

Chunks → embeds → vector store → semantic retrieval. Pure embedding-RAG over chunks. No structural graph, no Face.

**Adopt?** Negative example: RAG-over-chunks is retrieval answer, not architectural answer. Constellation makes it work *because of* architecture, not despite it.

### 12c. Sourcegraph SCIP — **Strongest "Face as index" precedent** ★ MOST PRAGMATIC INTEGRATION

SCIP (Sourcegraph Code Intelligence Protocol) = language-agnostic index format for precise go-to-definition/find-references, cross-repository. Eric Fritz frames as **"LLM antihallucinogen"** — grounding LLM outputs in verified semantic relations.

**SCIP is essentially computed Face per file.** Closest existing artifact to "Face as queryable registry of exports/consumes/protects." But computed from Bodies, not declared; no "load Body entirely."

**Adopt?** **Yes — SCIP should be Face index format, or at least reference protocol.** Consider emitting SCIP-compatible indices from saga so existing Sourcegraph/GitLab tooling works.

### 12d-12f. Devin / Copilot Workspace / OpenAI Harness

Devin = workflow. Copilot Workspace = spec/plan. **OpenAI Harness Engineering** = closest industry ally; "bootable per git worktree" = strong Body-side overlap, but no Face separation, no typed artifact graph. Their "enforcing architecture" is convention (ARCHITECTURE.md), not registry.

**Adopt?** Cite OpenAI harness as strongest industry validation of Body discipline. Position saga's typed artifact graph as *missing structural half*: they solved Body legibility; saga adds Face legibility.

---

## Section D — Academic Literature

**Academic search returned limited directly-targeted work — gap indicating research-novelty.**

### 13a. "The Modular Imperative" (Harvard/Midspiral, LMPL/ICFP-SPLASH 2025) — **Closest academic ally**

Position paper arguing modularity should be guiding principle for LLM-based development. Argues *for* modularity but **does not prescribe Face/Body separation or external graph.** "The field has identified the problem; we propose the architecture."

### 13b. "Revisiting the Impact of Pursuing Modularity for Code Generation" (EMNLP 2024)

Empirical: modularity helps some but can hurt when taken too far. Relevant to "cohesive large Body" sizing claim.

### 13c. "AI-Generated Smells: Code and Architecture in LLM/Agent-Driven Development" (arXiv 2605.02741)

Key finding: agents produce **"structurally modular but architecturally smelly"** code — naive modularity not enough. Directly motivates declared Face + graph rather than ad-hoc modular code.

### 13d. AOCI / Locagent / "Inside the scaffold"

Repository-map research tackling discovery half with computed graphs. None prescribe declared Faces or Body sizing.

---

## Section E — Cross-Cutting Precedents

### Requirements Traceability Matrix / artifact graphs (Systems Engineering)

RTM = tabular (now graph) mapping requirements → architecture → code → tests, maintained across lifecycle (INCOSE/EIA-632). Structurally identical to saga's typed artifact graph.

**Cite this heritage: saga graph IS systems-engineering traceability graph applied as LLM's navigation substrate.** Strong and underused framing.

### Build-time dependency substitution (Gradle)

Gradle's DependencySubstitutions: replace project/module dependencies with alternatives at build time, decoupling source from wiring. Mechanism-level precedent for "dependencies resolved outside source file."

---

## What Is Genuinely Novel vs Reinvention

### Novel (claim these):

1. **LLM-context-window as primary design constraint** for Face/Body split. Every precedent solved different problem (RPC, security, concurrency, hardware locality, formal verification). No prior work makes context-economics first-class driver.
2. **Physical de-linking of Face from Body in source**, dependencies resolved by external typed artifact graph (DB). Closest: Luna (graph-based languages), Gradle (build-time DI), INCOSE RTM. None apply as LLM navigation substrate.
3. **"Load Body once, work entirely inside it, no cross-file transitions"** as executable discipline. Closest: OpenAI "bootable per worktree" (Body isolation), Modular Imperative (motivation). Neither formalizes "one Body per context" rule.
4. **Declared (not computed) Faces** with "protects" axis (capabilities). Industry tools (Aider, Cursor, SCIP, Cody) all compute Faces retroactively; capability reasoning absent from agent tooling entirely.
5. **saga DB as microkernel-style capability space** for discovery, not just invocation. seL4's CSpace is conceptual parent, but seL4 has no notion of "what should LLM load."

### Reinvention (cite, don't claim):

- **Face as IDL** → WSDL/CORBA IDL/Protobuf/WIT (use WIT)
- **Face as ML signature** → OCaml/SML modules (rigorous theoretical grounding)
- **Body as isolated address space** → seL4 PD, Unix process, Actor, SGX enclave
- **Face/registry as capability space** → seL4 CSpace, E language, Unix FDs
- **Face as computed symbol index** → Aider repomap, Sourcegraph SCIP
- **Traceability artifact graph** → INCOSE RTM, ArchiMate, saga itself
- **Graph-first / files-as-views** → Luna, Unreal Blueprints

---

## Recommended Framing for Position Paper

> "Constellation Architecture is what you get when you take the **ML module system's signature/structure separation** (Milner, Macqueen), enforce it through **capability-space microkernel pattern** (seL4), describe Faces in **modern typed IDL** (WIT), expose them as **precise code-intelligence index** (SCIP), maintain provenance through **systems-engineering traceability graph** (INCOSE RTM), and adopt **'bootable per worktree' Body isolation** of OpenAI's harness engineering — *all in service of new primary constraint no prior architecture optimized for: the LLM context window*."

**Strategic call:** WIT for Face schema + SCIP as index emission format + seL4's CSpace as capability-graph metaphor = fully grounded, non-reinvented foundation. Novel contributions: (a) LLM-context sizing of Body and (b) external-graph resolution of dependencies. Literature search confirms neither has direct precedent.
