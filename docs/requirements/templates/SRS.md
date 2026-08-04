# SRS — <REQ-NNN slug>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/01-SRS.md.
  Produced by saga-architect. Parented to the PRD via `derived_from`.

  ⚠ PIPELINE REORDER (ADR-014). The SRS now runs AFTER the AC baseline is
  frozen (post-reconciliation), not in parallel with UC. The architect sees
  the frozen AC + the brief's complexity.tshirt / topology_hint and chooses
  architecture accordingly. FR/NFR/RULE have MOVED TO THE PRD (owned by
  saga-product). The SRS is now PURELY ARCHITECTURAL — it answers HOW the
  system is built to satisfy the frozen AC, not WHAT the system does.

  What belongs here:
    - §2.1   Architectural Style (chosen from the complexity→architecture table)
    - §2.2   Module Manifest (responsibilities, conflict-key surface)
    - §2b    Port Registry (if Hexagonal / >1 task touches a shared module)
    - §2.3   Invariant Registry (engineered predicates — HOW the system
             mechanically guarantees a RULE from the PRD; NOT the business
             rule itself)
    - §2.5   Test Strategy L0-L4
    - §D     Decomposition — AC → files / functions / types / conflict_keys /
             ac_kind. Planner is a dumb copier of §D2.
    - §7     Ubiquitous Language Glossary
    - §8     Open Questions
    - §9     Technology Stack (selected here, justified by NFR/Constraints)

  What does NOT belong here (moved to PRD, owned by saga-product):
    - FR  (functional requirements)      → PRD §FR
    - NFR (capacity targets)             → PRD §NFR
    - RULE (business rules)             → PRD §RULE
    - ALGORITHM-SPEC / API-SPEC / DATA-SPEC references — still relevant, but
      they trace derived_from an FR in the PRD, not from this SRS's §1.

  Fill ALL sections. Required sections are marked (REQUIRED). The architect
  skill (skills/saga-architect/SKILL.md) defines what each section must
  contain and the complexity→architecture table that drives §2.1.
-->

**Status:** Draft
**PRD:** <link/path to parent PRD>
**Epic:** REQ-NNN

---

## §2 Architecture

### §2.1 Architectural Style (REQUIRED)

<!--
  Declare ONE primary style (Hexagonal / Clean / DDD / Modular Monolith /
  KISS / Functional / Layered) or a documented combination. The style is NOT
  a free choice — it is dictated by the brief's complexity.tshirt +
  topology_hint + shared_mutation_risk via the complexity→architecture table
  in skills/saga-architect/SKILL.md.

  The table (summary):
    XS / sequence            → KISS (single file), Single task
    S  / sequence            → KISS / Modular, Pattern A
    M  / sequence            → Modular Monolith, Pattern A
    M  / scaffold-then-parallel → Modular Monolith + Ports, Pattern B
    L/XL / scaffold-then-parallel → Hexagonal / Ports, Pattern B
    L/XL / sequence          → Layered, Pattern A + spikes
    research / any           → Spike-first → re-plan

  Quote the row that applies and justify in one sentence. This kills
  over-engineering (e.g. Hexagonal for a single-page calculator).
-->

### §2.2 Module Manifest (REQUIRED)

<!--
  For each module: Responsibility (one sentence), Files (file_path conflict
  keys), Schema (schema conflict keys), Public protocol (public_protocol keys).
  Declare context relationships (Shared Kernel / Customer-Supplier /
  Anticorruption Layer) where modules depend on each other.

  This table is what saga-planner reads (via §D) to set conflict_keys on each
  dev-task. Two tasks that share a conflict-key collide at planning time
  (REQ-010, cgad-spec-lint R5) — preventing architectural merge conflicts
  before any worker starts.
-->

### §2.3 Invariant Registry (REQUIRED — the enforcement layer)

<!--
  Each invariant MUST have a Predicate (formal, testable) and a Check type
  (L3 property test / L4 benchmark / L0 type constraint). If an invariant
  cannot be tested, it is a wish, not an invariant — remove or reformulate.

  IMPORTANT — the RULE / INV split (ADR-014):
    - The BUSINESS rule lives in the PRD as a `RULE` artifact (owned by
      saga-product). Example: "refund.amount must not exceed charge.amount".
    - The ENGINEERED predicate lives HERE as an invariant row. Example:
      `INV-PAY-1: refund.amount <= charge.amount`, enforced by an L3 property
      test on the Refund aggregate. The invariant references the RULE it
      mechanically enforces; it does NOT restate the business intent.
    - One RULE may map to zero, one, or many engineered invariants. A RULE
      with no invariant is business debt surfaced by lint; an invariant with
      no RULE is orphan engineering — both are visible at lint time.

  These invariants flow downstream to INVARIANCES-<module>.md, L3 property
  test stubs, and the CGAD Step 1 intercept.
-->

| INV | Module | Predicate | Check type | Enforced RULE | AC reference |
|-----|--------|-----------|------------|---------------|--------------|
| INV-_n_ | _module_ | _predicate_ | L3 / L4 / L0 | RULE-_n_ | AC-_n_ |

### §2b API Contract / Port Registry (SPEC — REQUIRED when >1 task touches a shared module)

<!--
  NOTE: §2b IS a SPEC, not a requirement. It describes implementation
  mechanism (port signatures, adapter protocols). FRs in the PRD reference
  ports defined here but do not duplicate their signatures.

  For each port: Name, direction (driving/driven), signature, Consumes
  (upstream ports), Invariant (link to §2.3), Implementations (adapters,
  each = one dev-task), Conflict keys, Extension point (how a new case is
  added). The scaffold task (Pattern B) materializes this registry as stubs
  before any body-task runs.
-->

### §2.5 Test Strategy L0-L4 (REQUIRED)

<!--
  Declare which contract levels apply per AC type. Every algorithmic AC must
  have at least L2 (Builder examples) + L3 (Verifier property tests from the
  Invariant Registry). The ac_kind column in §D2 records which ACs are
  `verification` (pure L3/L4, no dev body) vs `implementation`.
-->

| Level | What | Example tools |
|---|---|---|
| L0 Compilation | types, visibility, cycles | `tsc --noEmit`, `cargo check`, `mypy` |
| L1 Structural | schemas, formats, versions | JSON Schema, OpenAPI, `ajv` |
| L2 Behavioral | examples, Given/When/Then | pytest, jest, cargo test |
| L3 Property | invariants, monotonicity, idempotence | Hypothesis, QuickCheck, proptest |
| L4 Operational | latency, throughput, security | pytest-benchmark, locust, Semgrep |

---

## §D. Decomposition (REQUIRED — filled by architect after AC are frozen)

<!--
  This section is the bridge from architecture to planning. It is filled
  AFTER the AC baseline is frozen (ADR-014: SRS runs post-reconciliation).
  The architect knows the AC count, their coupling, and the chosen pattern;
  §D records the per-AC implementation map.

  CONTRACT:
    - The architect OWNS §D1, §D2, §D3, §D4. Decisions live here, not in the
      planner. The planner is a DUMB COPIER (see saga-planner SKILL): it
      reads §D2 and copies fields verbatim into task.metadata.
    - §D1 File Tree is CANONICAL. The scaffold task (Pattern B) MUST follow
      it verbatim. If the scaffold deviates, that is a defect, not a
      design choice — fix the scaffold, do not "update the SRS to match".
    - §D2 AC → Implementation Map is a YAML block, one stanza per AC. The
      planner parses it and creates one task per stanza (implementation →
      development.code, verification → verification.ac, spike →
      development.spike, merge_with → folded into another task's metadata).
    - §D3 Priority Rationale records the critical path. The planner does NOT
      invent priority — it copies it.
    - §D4 Pattern Selection records why a cluster of ACs uses Pattern A vs
      Pattern B. This is the audit trail for the complexity→architecture
      decision in §2.1.
-->

### §D1. File Tree (canonical — scaffold обязан следовать дословно)

<!--
  The frozen directory layout for this episode. Every file that will be
  created by any task in this episode appears here, with an inline comment
  naming the AC(s) that own it. Files NOT in this tree are out of scope for
  the episode. If a worker needs a file that is not listed, that is a
  planning gap — escalate, do not improvise.

  Format: plain-text tree, one file per line, trailing comment after `#`
  naming AC(s). Use forward slashes regardless of OS.
-->

```
src/
  physics/
    orbital.ts          # AC-1: calculateOrbit
    transfers.ts        # AC-4, AC-5: moon/mars transfer
    constants.ts        # shared kernel (no AC — scaffold only)
  ui/
    calculator-form.tsx # AC-6
```

### §D2. AC → Implementation Map (machine-readable YAML — planner copies verbatim)

<!--
  One YAML stanza per AC. The planner reads this block and creates one task
  per stanza. Every field below is load-bearing:

    ac               — the AC code (AC-1, AC-NFR-1, ...). Stable key.
    title            — human title, copied into task.title.
    module           — module from §2.2 this work lives in.
    files            — list of file paths from §D1 this AC touches. Becomes
                       task.metadata.target_file / conflict_keys(file_path).
    functions        — public functions/methods this AC owns. Becomes part
                       of task.metadata.
    types            — exported types this AC owns. Becomes conflict_keys
                       (schema) when the type is a persisted/shared schema.
    public_protocol  — port (from §2b) this AC implements or consumes.
                       Becomes conflict_keys(public_protocol). Omit if the
                       AC does not touch a port.
    conflict_keys    — full list of {key_type, key_value} pairs. The
                       planner calls conflict_keys_set directly with this
                       list; conflict_keys_auto_derive fills any blanks.
    invariants       — INV codes from §2.3 this AC must honour. Drives the
                       verifier's L3 property test generation.
    test_layers      — subset of {L0,L1,L2,L3,L4} that apply to this AC.
    pattern          — A | B | spike. Which decomposition pattern this AC
                       participates in. For Pattern B, list the scaffold
                       dependency in depends_on.
    depends_on       — list of AC codes or scaffold:<module> tokens this
                       AC must wait for. Becomes task.depends_on.
    ac_kind          — implementation | verification | spike | merge_with.
                       Drives task_kind: implementation→development.code,
                       verification→verification.ac, spike→development.spike,
                       merge_with→folded into the named AC's task (no own task).
-->

```yaml
- ac: AC-1
  title: "Trajectory Calculation Engine"
  module: physics
  files: [src/physics/orbital.ts]
  functions: [calculateOrbit]
  types: [LaunchParameters, OrbitResult]
  public_protocol: PhysicsEnginePort
  conflict_keys:
    - {key_type: file_path,       key_value: 'src/physics/orbital.ts'}
    - {key_type: schema,          key_value: 'OrbitResult'}
    - {key_type: public_protocol, key_value: 'PhysicsEnginePort'}
  invariants: [INV-PHYS-1, INV-PHYS-3]
  test_layers: [L0, L2, L3]
  pattern: B
  depends_on: [scaffold:physics]
  ac_kind: implementation

- ac: AC-4
  title: "Moon Transfer Trajectory"
  module: physics
  files: [src/physics/transfers.ts]
  functions: [calculateMoonTransfer]
  types: []
  public_protocol: PhysicsEnginePort
  conflict_keys:
    - {key_type: file_path,       key_value: 'src/physics/transfers.ts'}
    - {key_type: public_protocol, key_value: 'PhysicsEnginePort'}
  invariants: [INV-PHYS-1]
  test_layers: [L0, L2, L3]
  pattern: B
  depends_on: [scaffold:physics, 'AC-1']
  ac_kind: implementation

- ac: AC-NFR-1
  title: "Page Load Time"
  module: ui
  files: []
  functions: []
  types: []
  public_protocol: null
  conflict_keys:
    - {key_type: integration_branch, key_value: 'dev'}
  invariants: []
  test_layers: [L4]
  pattern: A
  depends_on: ['AC-6']           # after UI is built
  ac_kind: verification          # NOT a dev task — Lighthouse measurement
```

### §D3. Priority Rationale (critical path)

<!--
  One bullet per AC, priority + one-line reason. The planner copies priority
  verbatim into task.priority — it does NOT re-rank. Mark the shared-kernel
  ACs (consumed by many others) as high; mark leaf ACs as medium/low.
-->

- AC-1: high (consumed by AC-2, AC-4, AC-5 — shared kernel, blocks parallel work)
- AC-2: medium
- AC-4: medium (parallel-safe after scaffold:physics)
- AC-5: medium (parallel-safe after scaffold:physics)
- AC-6: high (UI demo-blocker)
- AC-NFR-1: low (verification, runs after AC-6)

### §D4. Pattern Selection per Module Cluster

<!--
  One bullet per module cluster (a group of ACs sharing a module/port).
  Records the pattern (A=sequence, B=scaffold-then-parallel) and a one-line
  reason. This is the audit trail for §2.1's architecture choice: it shows
  WHY the cluster decomposes the way it does, so a reviewer can challenge
  the decomposition without re-deriving it.
-->

- cluster: physics (AC-1, AC-4, AC-5)
  pattern: B (scaffold:physics → 3 parallel bodies)
  reason: "AC-1/4/5 share the PhysicsEnginePort; scaffold freezes the port,
           bodies implement against it in parallel without colliding."
- cluster: ui (AC-6)
  pattern: A (single task)
  reason: "Single AC, single file, no shared port — scaffold overhead not justified."

---

## §7 Ubiquitous Language Glossary (REQUIRED when DDD)

<!--
  Map each domain term to its defining artifact and code symbol. Prevents two
  parallel workers from using the same word for different concepts. Terms
  introduced in the PRD §RULE / §FR propagate here; the architect binds them
  to code symbols chosen in §2.2 / §D1.
-->

## §8 Out-of-scope (REQUIRED)

<!--
  Explicitly list what this episode does NOT cover architecturally. Scope
  discipline (TOGAF Phase A "Statement of Architecture Work"). The PRD §2
  already lists product non-goals; this section lists architectural non-goals
  (e.g. "no message queue — sync HTTP only for this episode", "no DB
  migrations — schema is greenfield"). Without it, the planner creates tasks
  for architectural work that belongs to a future episode.
-->

## §9 Technology Stack (REQUIRED — selected by architect, justified by NFR/Constraints)

<!--
  The stack is chosen HERE, not earlier (not in brief, not in PRD).
  Why: NFRs (in the PRD §NFR) determine what performance/safety/capabilities
  are needed. Constraints (PRD §3) determine what's available. The architect
  reads both and decides. The SRS now runs AFTER the AC baseline — so the
  architect also knows which ACs are verification-only (L3/L4) and picks
  tooling that supports them.

  Every choice MUST be justified by a specific NFR or Constraint.
  The justification links to an ADR (Architecture Decision Record) artifact.

  After SRS accepted, downstream skills read this section:
  - saga-planner: knows test_framework → creates correct verification.ac tasks
  - saga-verifier: knows property_test_framework → generates correct L3 tests
  - trusted_providers: auto-register language-specific tools
-->

```yaml
language: <python | typescript | rust | go | java | c# | other>
runtime: '<version requirement>'
frameworks: [<primary framework(s)>]
test_framework: <pytest | jest | cargo-test | go-test | other>
property_test_framework: <hypothesis | fast-check | proptest | quickcheck | none>
linter: <eslint | pylint | clippy | golangci-lint | mypy | other>
formatter: <prettier | black | rustfmt | gofmt | other>
type_checker: <tsc | mypy | rustc | none>
build_tool: <npm | cargo | go | pip | maven | other>
justification: |
  NFR-<n> (...): <why this language satisfies the NFR>
  Constraint (...): <why this framework is required/available>
  INV-<n> (...): <why this test framework supports the invariant verification>
  Alternative considered: <X> — rejected because <reason>
adr: <ADR-NNN artifact reference>
```
