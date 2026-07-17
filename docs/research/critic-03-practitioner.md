# Critic 3: Practitioner Pushback (Cursor/trenches stance)

> **Source:** research agent run 2026-07-17, subagent `agent_ac3180a2`.
> **Stance:** Senior practitioner shipping production code daily with Cursor + Claude Code + Aider. Skeptical of grand theories, trusts what works.
> **Verdict on proposal:** "Identifies real tension but over-prescribes. The existing stack captures most claimed wins at fraction of cost."

---

## Six critiques (grounded in concrete keyboard scenarios)

### 1. "Small modular files" already works. The proposal solves a problem the tooling already ate.

When editing Python in Cursor: open 300-line file, indexing already chunked at function level. Cmd+Click jumps in 50ms. Cmd+K finds callers across 4 files in <1s. Aider's repo map: tree-sitter + PageRank, ~2K tokens. **"Transition cost" never felt.**

Charter assumes 2022-era agent that reloads whole file each hop. Modern agents load 30-line slice + call graph summary. Essays doc T3 admits "navigation tooling compensates for structure rather than demanding better structure" — then dismisses as "gap." From trenches: **not a gap, it's the solution.** Small SRP files with explicit imports project cleanly through tree-sitter. r/cursor consensus "150-500 LOC" because that size chunks well, not because Miller's Law.

### 2. The "transition cost" thesis is overstated for any model shipped after mid-2024.

Claude Sonnet 4.5: 200K usable. Gemini 2.5 Pro: 1M tokens. Loading 10 small files (~30K tokens) = 15% of window. Model retains all fine.

**Real failure mode (F10, F11):** not about file count, about relevance and freshness. rasbt/ETH: wrong/stale context worse than less context. **Doesn't support "consolidate into fewer large files"** — supports "don't add metadata you can't keep correct." Exact opposite of adding `face.md` per module.

Observed in Cursor: agent gets sloppy around line 1200 of 2000-line file — U-shaped recall from F11. **Practitioners see opposite of what charter predicts: agents do worse on big files, not better.** F14 contradiction is single most important datapoint; charter waves past it.

### 3. Face/Body doubles maintenance surface; Face will rot. This is AGENTS.md failure mode repackaged.

**Concrete failure scenario:** PM wants `void_refund` added. Under SRP: edit processor.py, tests, ship. Under Constellation: edit body/processor.py AND face.md (Exports + Protects if invariant touched) AND saga DB trace.

**Tuesday 4pm with PM breathing down neck:** edit body/processor.py and ship. Face goes stale. Three weeks later, agent reads face.md, doesn't see void_refund, reimplements it. **Two copies now exist.** This is documented AGENTS.md rot pattern (F10, F13).

Proposal's own research: "Context files must be (a) minimal, (b) generated/verified from code not hand-maintained, (c) progressively disclosed." **Hand-maintained face.md per module violates (b) on every commit.**

OQ3 ("machine-readable or human-readable?") is giveaway this hasn't been thought through for human in loop. Every dual-source-of-truth system eventually collapses: one becomes authoritative, other becomes stale and misleading.

### 4. "Typed artifact graph replacing imports" is not actionable. Show me the Python.

Normal Python:
```python
from payments.gateways.stripe import StripeClient
from payments.models import Order
def charge_order(order: Order, gateway: StripeClient) -> str: ...
```

Under Constellation — three options, all bad:

**(a) Keep imports + maintain saga traces.** Two dependency systems. Will drift. R20 lint fires on every refactor. Never met team maintaining parallel dep graph alongside imports.

**(b) Replace imports with saga-resolution at runtime.** Python loads modules by querying SQLite? Through what import hook? IDE symbol resolution? pytest collection? mypy call graph? Every tool assumes imports.

**(c) Generate imports from Faces at build time.** Face becomes IDL, imports real — WSDL/protobuf with extra steps. Precedents doc admits this.

Gradle DependencySubstitutions is closest precedent. Gradle notorious for configuration overhead. Practitioners will run.

OQ2 ("How to enforce Body cannot import undeclared without custom linter per language?") is admission this requires per-language work nobody built.

### 5. WIT-for-Python is hand-waved. The binding problem is hard.

WIT describes WASM Component Model via Canonical ABI. **What WIT doesn't have: mapping to Python's actual semantics.** Python has duck typing, monkey-patching, AST-rewriting decorators, `__init_subclass__`, metaclasses, `importlib.import_module`, `getattr`. WIT has none.

**Concrete:** Python module exports `PaymentGateway` Protocol, 3 methods. Two implementations registered via `@register_gateway("stripe")` decorator at import time. Where does registration live — Face or Body?
- If Face: Face must know plugin discovery → not small
- If Body: Face doesn't describe actual runtime surface → lie

WIT can't express this. OCaml signatures can't either (ML modules statically resolved; Python dynamically dispatched). Proposal leans on OCaml as theoretical grounding but Python doesn't share its semantics.

**Would believe for Rust codebase** (traits + `pub use` already give most of it). **Don't believe for Python, TS, Ruby** — dynamically typed where runtime surface ≠ declared surface.

### 6. What does this solve that "AGENTS.md + small files + property tests" doesn't?

Competition is not "classical SRP with no agent support." It's "classical SRP + tight AGENTS.md + property tests + existing tooling."

- **H1 (fewer merge conflicts):** conflicts come from two workers editing same function, not same file. Face/Body doesn't fix. Saga's existing conflict_keys already work on SRP code.
- **H2 (lower time-to-completion):** slowdowns from agents not knowing *which* file to edit, not file being too small. AGENTS.md with module map fixes at 1/50th implementation cost.
- **H5 (reduces "lost in codebase"):** Cursor symbol index already gives typed registry. SCIP does better, computed from code, zero per-module cost. "SCIP is essentially computed Face per file" — why hand-write face.md?
- **H3 (property tests) + H4 (SAST):** genuinely good, orthogonal to Face/Body, adoptable on SRP codebase tomorrow.

**Single concrete thing proposal offers that existing stack doesn't:** declared Faces with `protects` (capability/invariant) axis. Interesting. ~5% of proposal's scope. If collapsed to "write short INVARIANTS.md per critical module + lint rule that tests cover them," worth trying. But that's not what's proposed.

---

## Three things that would make practitioner try it

### 1. Make Faces generated, not authored.

Face emitted from Body's AST by SCIP-compatible indexer. Humans never touch face.md. `protects:` invariants are only human-authored part, in 10-line `INVARIANTS.md` co-located with module. **Kills rot problem and dual-maintenance in one move.** Charter half-admits this in T4 — make it design, not footnote.

### 2. Show one real Python codebase migrated, end to end, with measurements.

Take 5000-LOC Python service (FastAPI, Django, something real). Run same multi-agent task under SRP vs Constellation. Show merge-conflict count, time-to-completion, changes_requested rate. **If Face/Body wins by 2x on any axis, interested. 20%, sticking with what have.**

Proposal asking to restructure codebase on strength of TRIZ argument. Show numbers.

### 3. Drop "artifact graph replacing imports" or scope to build-time.

Runtime-imports-via-DB is most aggressive, least-defensible part. Either:
- (a) **Retract** — Faces are documentation/index, runtime still uses imports, saga graph is parallel provenance/tracability layer (just INCOSE RTM, which precedents doc admits)
- (b) **Commit to single language target** (Rust, where `pub use` makes natural) and prove there before generalizing

Trying "works in any language" + "we replace imports" in same proposal is overreach. Pick one.

---

## Bottom line

Proposal identifies real tension but over-prescribes. Practitioner stack already run — small files, tight AGENTS.md, property tests, generated symbol indices — captures most claimed wins at fraction of architectural/maintenance cost.

**One genuinely novel piece:** declared `protects` invariants as first-class Face axis. Worth pursuing, doesn't require restructuring.

Fix three things → pilot. As written → "interesting blog post, not production codebase."
