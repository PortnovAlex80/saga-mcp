# SRS — <REQ-NNN slug>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/01-SRS.md.
  Produced by saga-architect. Parented to the PRD. Each FR and NFR is also
  registered as its own artifact (parent_artifact_id = prd_id) so AC can later
  reference them by code.

  Fill ALL sections. Required sections are marked (REQUIRED). The architect
  skill (skills/saga-architect/SKILL.md) defines what each section must contain.
-->

**Status:** Draft
**PRD:** <link/path to parent PRD>
**Epic:** REQ-NNN

---

## §1 Functional Requirements (FR)

<!--
  FR describes OBSERVABLE BEHAVIOR, NOT implementation. A black-box observer
  must be able to verify each FR without knowing the implementation.

  - No endpoints. No JSON fields. No DB tables. No algorithms. No class names.
    No HTTP verbs. No protocol names. No framework references.
  - If an FR requires a specific algorithm or formula: create a linked
    ALGORITHM-SPEC artifact and write the FR as:
        "The system shall calculate X using the approved method
         (see ALGORITHM-SPEC-N), honoring business rule RULE-N."
    Capture the business/legal intent of the formula in a RULE artifact and the
    mechanism in the SPEC. Link both via trace_add(derived_from). Do NOT inline
    formulas into the FR.
  - Implementation signatures, port shapes, and adapter protocols belong in
    §2b (Port Registry / API contract) — which is itself a SPEC, not a
    requirement. FRs reference it; they do not contain its signatures.

  Number each FR (FR-1, FR-2, ...) and register each as its own artifact so AC
  can trace to it individually.
-->

### FR-1 — <title>

**Statement:** The system shall <observable behavior>, <condition>.

**Acceptance criteria format:** Given / When / Then, with observable outcomes.
No implementation assertions (no "calls endpoint X", no "writes to table Y",
no "returns JSON field Z").

<!-- Repeat per FR. -->

---

## §2 Architecture

### §2.1 Architectural Style (REQUIRED)

<!--
  Declare ONE primary style (Hexagonal / Clean / DDD / Modular Monolith /
  Functional) or a documented combination. Determines how the planner
  decomposes work and which conflict keys get set.
-->

### §2.2 Module Manifest (REQUIRED)

<!--
  For each module: Responsibility (one sentence), Files (file_path conflict
  keys), Schema (schema conflict keys), Public protocol (public_protocol keys).
  Declare context relationships (Shared Kernel / Customer-Supplier /
  Anticorruption Layer) where modules depend on each other.
-->

### §2.3 Invariant Registry (REQUIRED — the enforcement layer)

<!--
  Each invariant MUST have a Predicate (formal, testable) and a Check type
  (L3 property test / L4 benchmark / L0 type constraint). If an invariant
  cannot be tested, it is a wish, not an invariant — remove or reformulate.
  Flows downstream to INVARIANTS-<module>.md, L3 property test stubs, and CGAD
  Step 1.
-->

| Module | Invariant (predicate) | Check type | AC reference |
|--------|-----------------------|------------|--------------|
| _module_ | _predicate_ | L3 / L4 / L0 | AC-_n_ |

### §2b API Contract / Port Registry (SPEC — REQUIRED when >1 task touches a shared module)

<!--
  NOTE: §2b IS a SPEC, not a requirement. It describes implementation mechanism
  (port signatures, adapter protocols). FRs in §1 reference ports defined here
  but do not duplicate their signatures.

  For each port: Name, direction (driving/driven), signature, Consumes
  (upstream ports), Invariant (link to §2.3), Implementations (adapters, each
  = one dev-task), Conflict keys, Extension point (how a new case is added).
  The scaffold task (Pattern B) materializes this registry as stubs before any
  body-task runs.
-->

### §2.5 Test Strategy L0-L4 (REQUIRED)

<!--
  Declare which contract levels apply per AC type. Every algorithmic AC must
  have at least L2 (Builder examples) + L3 (Verifier property tests from the
  Invariant Registry).
-->

| Level | What | Example tools |
|---|---|---|
| L0 Compilation | types, visibility, cycles | `tsc --noEmit`, `cargo check`, `mypy` |
| L1 Structural | schemas, formats, versions | JSON Schema, OpenAPI, `ajv` |
| L2 Behavioral | examples, Given/When/Then | pytest, jest, cargo test |
| L3 Property | invariants, monotonicity, idempotence | Hypothesis, QuickCheck, proptest |
| L4 Operational | latency, throughput, security | pytest-benchmark, locust, Semgrep |

## §3 Non-Functional Requirements (NFR) — Capacity Targets (REQUIRED)

<!--
  Each NFR MUST carry a quantitative capacity target. "Fast"/"secure"/"quick"
  are not requirements. The target becomes the baseline_value for runtime
  observations (REQ-011) and the oracle for verification evidence.
-->

| NFR | Target | Verification |
|-----|--------|--------------|
| _e.g. p99 latency_ | _< 200ms at 1000 QPS sustained_ | _L4 benchmark_ |

## §4 Linked SPEC Artifacts (OPTIONAL — referenced from FRs)

<!--
  When FRs delegate mechanism to SPECs, list them here so the planner can
  generate scaffold/body tasks for them. Each SPEC is its own artifact, traced
  derived_from the FR(s) that reference it.
-->

| SPEC | Type | Referenced by FR |
|------|------|------------------|
| _name_ | ALGORITHM-SPEC / API-SPEC / DATA-SPEC | FR-_n_ |

## §5 Linked RULE Artifacts (OPTIONAL — business decision logic)

<!--
  When an FR delegates decision logic to a RULE, list the RULE here. RULEs
  capture business/legal intent (if X then Y, calculate Z, route to W). They
  evolve independently of the FRs that enforce them.
-->

| RULE | Intent | Enforced by FR |
|------|--------|----------------|
| _RULE-N_ | _one-sentence business rule_ | FR-_n_ |

## §7 Ubiquitous Language Glossary (REQUIRED when DDD)

<!--
  Map each domain term to its defining artifact and code symbol. Prevents two
  parallel workers from using the same word for different concepts.
-->

## §8 Out-of-scope (REQUIRED)

<!--
  Explicitly list what this episode does NOT cover. Scope discipline (TOGAF
  Phase A "Statement of Architecture Work"). Without it, the planner creates
  tasks for FRs that belong to a future episode.
-->
