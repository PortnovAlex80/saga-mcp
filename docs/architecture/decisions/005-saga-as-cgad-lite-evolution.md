# ADR-005: saga as CGAD-lite — evolution strategy

## Status
Accepted (2026-07-17)

## Context

A target-state design for governance of parallel AI agents — **CGAD v2 (Contract-Governed Agentic Development)** — was specified at [cgad-v2-spec.md](cgad-v2-spec.md). The spec describes a 14-phase bootstrap toward a full control plane: Constitution, Semantic Kernel, Control State Store, typed Architecture Graph, Authority Model, Contract/Work/Lease Governance, Trusted Guard Input Providers, 4-valued Guard verdicts, Workflow Ledger, Wave Scheduler, Runtime Observation Store, and `cgad-spec-lint`.

An independent coverage analysis of saga (the MCP-based governance system already running REQ-003/004/006/007 episodes on this board) against CGAD produced a six-item gap list. Three independent reviewers also audited the CGAD spec itself and concluded its 14-phase interactive bootstrap is un-executable as-written (Phase 11 needs a runtime no phase produces; 30–60 human round-trips guarantee rubber-stamping; the spec is a "strong philosophy, weak mechanism").

A decision is needed NOW, before any gap-closing REQ episode, so that future REQs cite a single authority for "why we are doing this and how," rather than each re-deriving the strategy. Per `AGENTS.md`: *"When making an architectural decision: create a new ADR."*

Constraints:
- saga is in production use (REQ-006, REQ-007 episodes in flight; 83/83 tests green).
- ADRs 002 (multi-repo), 003 (episode hard gates), 004 (enforced provenance + machine checkouts) already encode working primitives that align with CGAD philosophy under different names.
- GUARDRAILS Signs 001–007 already function as an informal, append-only constitution.

## Decision

1. **CGAD v2 is adopted as saga's target-state reference.** saga evolves toward it; saga is not rewritten from scratch as a CGAD bootstrap.

2. **Evolution proceeds by hardening existing primitives**, not by replacing the working kanban/task/artifact core. The 14-phase CGAD bootstrap is explicitly **out of scope** — the reviewers' verdict on its executability is accepted.

3. **The six CGAD gaps are dispositioned** as recorded in the Roadmap table below:
   - three deferred to **named future REQ episodes** (high-leverage, closable by schema/extension)
   - two **permanently out of scope** for saga as a product (disproportionate to saga's purpose)
   - one **partially closed by this ADR's companion artifact** (`cgad-spec-lint` v0.1)

4. **GUARDRAILS.md Signs 001–007 + the Rules section are designated ConstitutionVersion-0 (informal).** Signs are append-only constitutional amendments (already the rule). ADRs are reversible architectural decisions (status-tracked, supersede-able). No machine-checked `ConstitutionVersion` entity is introduced.

5. **The concept mapping in this ADR is DESCRIPTIVE, not implementive.** It states which CGAD concept each saga entity maps to; it does **not** assert that the CGAD formal machinery is in place. GUARDRAILS Sign 008 (added with this ADR) enforces this distinction.

6. **ADR-005 supersedes nothing.** ADR-002/003/004 are re-read as existing implementations of CGAD-aligned primitives inside this frame.

## Concept mapping (saga entity → CGAD concept)

Each row is **descriptive** — it records intent, not implementation. Per Sign 008, identity claims ("saga HAS a Workflow Ledger") require the corresponding REQ in the Roadmap to be `completed` with passing evidence.

| saga entity (exists today) | CGAD concept (target reference) | Status |
|---|---|---|
| `project` + `epic` (REQ episode) | governed system / Initiative | aligned |
| `task` (typed, with `task_kind`, `workflow_stage`) | Work Package | aligned |
| `task.dependencies`, `generated_from_task_id`, `generation_key` | provenance-bound decomposition | aligned (saga exceeds CGAD here) |
| `artifact` (PRD/SRS/UC/AC/FR/NFR/decision/brief) | Declared Truth | aligned |
| `artifact.status` `accepted` + `accepted_hash` + `drift_state` | Frozen Contract Snapshot | partial (no version number, no snapshot history) |
| `artifact_traces` (`implements/covers/derived_from/verified_by`/...) | Architecture Graph edges | partial (2 node types, 6 edge types vs CGAD's 24 / 21) |
| episode hard gates (ADR-003) | Guards | informal (no providers, no 4-valued verdict) |
| `verification_evidence` (binary `passed/failed`, `recorded_by`, hash) | Evidence Bundle | partial (no UNKNOWN/ERROR, no provider field) |
| `worker_next` atomic claim / `worker_merge_acquire` | Agent Lease grant | aligned (lease is merge-lock-only, narrower than CGAD's AgentLease) |
| `activity_log` (append-only, CRUD history) | Workflow Ledger | partial (field-change log, not decision ledger with provenance) |
| `repositories` / `project_repositories` / `repository_checkouts` | Resource State | aligned (cleanly separate from lease — exceeds CGAD §18) |
| GUARDRAILS Signs 001–007 + Rules | Constitution (P0–P17 + amendments) | informal (no versioning machine) |
| `tasks.priority` / `epics.priority` (manual `low/medium/high/critical`) | RiskClass | partial (label, not derived; no `max(declared, derived, policy_minimum)`) |
| (absent) | Runtime Observation Store | **gap** |
| (absent) | semantic Conflict Model beyond git | **gap** (Sign 002 acknowledges) |
| (absent) | Trusted Guard Input Provider registry | **gap** |
| (absent) | cgad-spec-lint as deterministic validator | **gap** — partially closed by this ADR's companion artifact |

## Alternatives Considered

Four options were generated by parallel subagents and scored in a Weighted-Sum MCDA matrix (criteria: reversibility, gap closure, blast-radius safety, cost, pattern fit, bootstrap honesty, forward motion, testability). Scores: A=133, C=132, B=128, D=98. The two leaders (A and C) were within 1 point (~0.7%) — too close for the matrix to decide on its own.

### Option A: Conservative Minimal Hardening (CMH)
Close top-3 gaps by extending `verification_evidence.outcome` enum, adding three risk-source columns to `tasks`, and shipping `cgad-spec-lint` v0.1.
- **Pros:** lands on existing chokepoints (`assertVerificationPassed`, `task_update`); ~95% reversible in ~2h; REQ-006/007 untouched.
- **Cons:** 33–44h effort (too large for one session); enum rebuild is the one non-additive step; defers gaps 3/4/5 with no owner; vulnerable to legitimacy-washing without an ADR.
- **Why partially rejected:** the **full** CMH is premature — the gap analysis is one-pass work. ADR-first legitimization is cheaper than mid-flight rollback. But CMH's Gap 6 (`cgad-spec-lint` v0.1) is retained as the companion artifact (see Decision §3).

### Option B: Meta-Backlog — saga evolves itself through its own governance
Register each gap as a REQ-NNN episode on the Harmess board; decompose through saga's own discovery→formalization→planning→development flow.
- **Pros:** zero new infrastructure; self-hosting proof; full traceability; reversible per epic.
- **Cons:** slow (~13 calendar weeks, ~27–32 human round-trips); bootstrap residue real (REQ-008–012 governed without the features they introduce); heavy ceremony for one-function changes; constitution epic may stall on human availability.
- **Why deferred, not rejected:** this is the **follow-on execution vehicle** for gaps 1–5 once ADR-005 legitimizes the strategy. Future REQ episodes will use saga's own flow. Option B's bootstrap-honesty annotations (`cgad-gap:<feature>` tag + `note_save(decision)`) are adopted as convention for those future REQs.

### Option C: ADR-first / legitimization (ACCEPTED for the frame)
Write this ADR + GUARDRAILS Sign 008 as the legitimizing artifact. Code work deferred to subsequent REQs that cite ADR-005.
- **Pros:** lowest-cost decision that unblocks all subsequent work; fully reversible (mark Superseded); forces honest gap accounting in writing; matches existing additive ADR cadence (002/003/004).
- **Cons:** delays observable gap closure; "ADR theater" risk without a forcing function; no executable proof.
- **Why accepted:** the Red Team argument is correct — a one-pass gap analysis should not drive a 40h code change without human review of the roadmap. The ADR is the forcing function: it makes the gap list reviewable and the follow-on REQs citable.

### Option D: Ambitious architectural extension (big-bang)
Eight new tables, four extended, six new MCP tools, four new skill sections. Closes all six gaps atomically.
- **Pros:** only option that closes all six gaps; makes Phase 11 executable.
- **Cons:** ~12 engineer-weeks; largest blast radius; `episode_transition` return-shape change ripples to every caller; high risk of one of eight tables being wrong-shaped.
- **Why rejected:** disproportionate to saga's working state; violates CGAD's own P0 (linear change cost under human control); most of the substrate would sit unused until providers and rule sets are wired, which is itself multi-week work.

## Roadmap

| # | CGAD gap (saga lacks) | Disposition | Target REQ | Priority | Depends on | Rough effort |
|---|---|---|---|---|---|---|
| 1 | 4-valued guard verdict (PASS/FAIL/UNKNOWN/ERROR) + deny-by-default | **Close via REQ** | REQ-008 | high | — | ~10h |
| 2 | RiskClass computation `max(declared, derived, policy_minimum)` + P15 | **Close via REQ** | REQ-009 | high | REQ-008 | ~12h |
| 3 | Semantic Conflict Model (beyond git, typed conflict keys) | **Close via REQ** | REQ-010 | medium | REQ-009 | ~28h |
| 4 | Runtime Observation Store (3rd truth axis, immutable, cannot mutate oracle per P17) | **Close via REQ** | REQ-011 | medium | — | ~20h |
| 5 | Constitution as governed, versioned entity + constitutional gate (P16) | **Permanently out of scope** for saga as a product | — | — | — | 0 |
| 6 | `cgad-spec-lint` — deterministic artifact/transition validator | **Partially closed by this ADR** (v0.1 read-only, 3 rules); full version via REQ | REQ-012 | high | REQ-008 | ~15h (full) |

**Why gap 5 is permanently out of scope:** a machine-checked `ConstitutionVersion` entity with constitutional gate, version history, and ratification flow is a new top-level governance subsystem. saga's informal constitution (GUARDRAILS Signs + ADRs + AGENTS.md) is sufficient for a single-team product; the formal machinery is multi-team ceremony without commensurate benefit. If saga ever adopts multi-team constitutional governance, a future ADR may reopen this — that ADR would supersede ADR-005.

**Gap 6 v0.1 closes today** as the companion artifact: `tools/cgad-spec-lint.mjs` — a read-only Node script auditing a saga DB for three rules (R1: deny-by-default — UNKNOWN/ERROR evidence blocks integration gate; R2: P15 risk floor — `priority` must not be below `max(derived, policy_minimum)`; R3: Sign 006 — accepted AC with `implements` but no `verified_by` is a fail). This converts the `cgad` SKILL v0.1 limitation ("discipline, not mechanism") into one external enforcement point for the three highest-leverage rules.

## Anti-scope (explicitly NOT done by ADR-005)

- No code, schema, or tooling change in saga itself (only the standalone read-only lint script is added).
- No 14-phase CGAD bootstrap.
- No `ConstitutionVersion` entity / constitutional gate / P16 versioning machine.
- No typed Architecture Graph metamodel (24 node / 21 edge types) — `artifact_traces` keeps its 6-value CHECK.
- No Wave Scheduler component — saga's episode stage machine remains the wave model.
- No separation of AgentLease lifecycle from Resource State — `worker_merge_acquire` remains merge-lock-scoped.
- No new top-level entities in the artifact graph.

## Consequences

- **Code:** zero saga code changes. One standalone read-only script (`tools/cgad-spec-lint.mjs`) is added; it imports nothing from saga, mutates nothing.
- **Testing:** no test impact. The lint script is self-contained and has its own smoke test against a copy of the schema.
- **Performance:** none.
- **Team:** future CGAD-aligned work must cite ADR-005 as authority and obey Sign 008's descriptive-vs-implementive discipline. Any claim that a formal CGAD guarantee holds requires the corresponding Roadmap REQ to be `completed` with passing evidence.
- **Future:** opens REQ-008 (4-valued verdict), REQ-009 (RiskClass), REQ-010 (semantic conflict), REQ-011 (observation store), REQ-012 (full `cgad-spec-lint`). Each will be registered on the saga board and run through saga's own discovery→formalization→planning→development flow per Option B's convention, with `cgad-gap:<feature>` tags and bootstrap-honesty `note_save(decision)` entries.

## Reversibility

ADR-005 modifies zero saga code/schema/tools. To reverse:
1. Mark this ADR `Superseded by ADR-NNN`.
2. Sign 008 either survives (it remains good guidance regardless) or is amended by a later Sign.
3. `tools/cgad-spec-lint.mjs` can be `rm`'d — it has no callers in saga.
4. No data migration, no rollback, no tooling to uninstall.

Cost ≈ 0. This is the lowest-reversibility-cost option available, which is the structural reason it was chosen over the code-bearing alternatives.

## Related

- Spec: [cgad-v2-spec.md](cgad-v2-spec.md) — full CGAD v2 spec (1619 lines, дословный оригинал v0.95)
- Skill: [.zcode/skills/cgad/SKILL.md](../../../.zcode/skills/cgad/SKILL.md) — per-change CGAD procedure (v0.1)
- Companion artifact: `tools/cgad-spec-lint.mjs` (this ADR's partial Gap-6 close)
- [ADR-002](002-product-board-multi-repo-workflow.md) — multi-repo product board (CGAD's "single consistency boundary")
- [ADR-003](003-episode-hard-gates.md) — episode hard gates (CGAD's informal Guards; to be formalized by REQ-008)
- [ADR-004](004-enforced-provenance-and-machine-checkouts.md) — enforced provenance (CGAD provenance invariants + AgentLease routing)
- GUARDRAILS Signs 001–007 (designated ConstitutionVersion-0 by this ADR)
- Adds: GUARDRAILS Sign 008 (CGAD legitimacy-wash)
