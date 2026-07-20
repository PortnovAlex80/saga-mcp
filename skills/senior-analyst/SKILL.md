---
name: senior-analyst
description: "Reference methodology for requirements engineering. Loaded by saga-orchestrator at Complexity Gate (Stage 1.5) to assess which artifact types a project needs. NOT a worker skill — not claimed via worker_next. Distilled from BABOK v3, Wiegers & Beatty, ISO/IEC/IEEE 29148."
---

# senior-analyst — Requirements Engineering Reference

## When this skill is used

Loaded by saga-orchestrator at Stage 1.5 (Complexity Gate), after Discovery
(brief accepted) and before Formalization (PRD → UC → AC → Reconcile → SRS).
The orchestrator reads this reference to decide: which artifact types does
THIS project need? The brief's `complexity.tshirt` and `topology_hint` also
seed the SRS §2.1 style choice the architect makes LATER (after AC are
baselined) — see the complexity→architecture table in saga-architect SKILL.

## Complexity classes

> **Pipeline order (ADR-013).** Artifact SETS are unchanged; only the ORDER
> in which they are produced shifted. SRS now follows AC (the architect reads
> the frozen AC + brief complexity to choose a style). FR/NFR/RULE live under
> the PRD (saga-product registers them), not under the SRS.

| Class | T-shirt | Artifact set | Example |
|---|---|---|---|
| **thin** | XS-S | brief → PRD(+FR/NFR/RULE) → UC → AC → SRS(+DECOMP) | Prototype, utility |
| **modular** | M-L | thin + RULE + hypothesis + business_metric + SPEC | Product feature, service |
| **regulated** | XL | modular + DR + IR + CONSTRAINT + RISK + TR | Finance, health, legal |
| **research** | any | brief → decision → OQ | Spike, exploration |

## How to classify

Read the brief:
- `complexity.tshirt` — size hint
- `complexity.risk_triggers` — what's at stake
- `affected_projects` — how many systems
- `classification` — product vs tech-task vs research

Rules:
- If risk_triggers contains 'security', 'data_ownership', 'migration', 'monetary' → regulated
- If classification is 'research' → research (minimal artifacts)
- If affected_projects > 1 → at least modular (interfaces needed)
- Otherwise → thin or modular based on tshirt size

## Artifact value matrix

Each artifact type has a ROLE. Only create types that add value:

| Type | Role in saga | When to create | When to SKIP |
|---|---|---|---|
| brief | Discovery decision | Always | Never skip |
| hypothesis | Measurable business bet | Product classification | Tech-task, research |
| business_metric | Metric definition for hypothesis | With hypothesis | No hypothesis |
| PRD | Product intent + scope | Product, modular | Tech-task (use brief) |
| SRS | System design + contracts + §D Decomposition | Always (when code needed) — written AFTER AC baseline | Pure research |
| FR | Observable system behavior — **child of PRD** (saga-product registers) | Always | — |
| NFR | Quality thresholds with numbers — **child of PRD** (saga-product registers) | Always | — |
| RULE | Business logic, calculations, policies — **child of PRD** (saga-product registers) | When decision logic exists | Pure CRUD |
| SPEC | Implementation mechanism (API, algo, data) | When FR needs impl detail | Trivial impl |
| UC | Actor-system interaction — derived from PRD | When actors exist | Batch/automated |
| AC | Verifiable acceptance criteria — derived from UC + FR/NFR (in PRD) | Always (bridge to kanban) | Never skip |
| OQ | Unresolved question | When something is unknown | Everything resolved |
| decision | Explicit choice with rationale | At each fork | — |

Types NOT in saga's native set (use only if project complexity demands):
- BR → use hypothesis + PRD
- SR → use UC (actor need is in UC)
- CAP → use FR (capability = broader FR)
- DR → use NFR retention + schema conflict_key
- IR → use SPEC (Port Registry covers boundary)
- CONSTRAINT → use decision with tag
- ASSUMPTION → use evidence_status='assumed'
- TR → use episode with migration tasks
- RISK → use RiskClass on tasks + SRS risk table

## Classification Engine (4 tests — run on each requirement BEFORE writing)

TEST 1 — SYSTEM BOUNDARY: Who acts? System, business, external party?
TEST 2 — REMOVE-TECHNOLOGY: Remove all tech. Still meaningful? → business-level. Collapses? → system-level.
TEST 3 — OBSERVABLE-BEHAVIOR: Black-box verifiable? → FR. Needs impl knowledge? → SPEC.
TEST 4 — RULE-VS-FR: Contains decision logic (if X then Y)? → extract RULE. FR says "system enforces rules".

## Quality non-negotiables (enforced by lint R14-R16)

1. FR MUST NOT contain implementation detail (endpoints, JSON, DB tables, algorithms). R14 catches.
2. RULE MUST have enforcement path (implements or implements_spec trace). R15 catches.
3. Hypothesis MUST have observation. R16 catches.
4. NFR MUST have capacity target (number + unit). PRD template enforces (NFR lives under PRD per ADR-013).
5. AC MUST have properties block for algorithmic logic. AC template enforces.
6. Every artifact MUST trace to parent or child. episode gate enforces.

## FR Forbidden Content (reference — R14 enforces)

Never in FR: endpoints, URLs, HTTP verbs, status codes, JSON fields, DB tables,
class names, method names, frameworks, algorithms, formulas, hash constructions.
Move to linked SPEC. FR retains observable behavior only.

## Output

The orchestrator uses this reference to produce:
1. A `decision` artifact: "Artifact set for REQ-NNN: [list of types]"
2. Complexity class: thin / modular / regulated / research
3. Specific guidance for downstream skills (which SRS sections, which AC format)
