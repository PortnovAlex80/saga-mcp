# PRD — <REQ-NNN slug>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/00-PRD.md.
  Produced by saga-product. Parented to the accepted brief from Discovery. The
  PRD fixes business intent and the WHAT layer (FR/NFR/RULE) — everything
  downstream (UC, AC, SRS) derives from it. The PRD MUST NOT specify
  implementation: no stack, no APIs, no data models, no algorithm names, no
  class names. That is the SRS's job (saga-architect, which now runs AFTER AC
  are frozen — see ADR-014).

  FR/NFR/RULE live HERE, in the PRD — not in the SRS. saga-product registers
  each FR/NFR/RULE row as its own artifact (parent_artifact_id = this PRD,
  derived_from → this PRD) so UC, AC and the SRS Invariant Registry can each
  trace to a single stable handle. A row that lives only in PRD prose is
  invisible to the traceability lint.

  Fill ALL sections. Required sections are marked (REQUIRED). The product skill
  (skills/saga-product/SKILL.md) defines what each section must contain.
-->

**Status:** Draft
**Brief:** <link/path to parent Brief artifact>
**Epic:** REQ-NNN

---

## §1 Problem & Value (REQUIRED)

<!--
  Describe the user problem in the user's words, and the value the user gets
  when the problem is solved. This is NOT a feature description — it is the
  pain the user pays (time, money, attention) to remove. Quote real users
  where possible. Tie back to the brief's business-objectives anchor.
-->

## §2 Boundaries (REQUIRED)

### In scope

<!--
  What this episode WILL deliver. Concrete, observable, testable. Each item
  becomes the seed for one or more FRs in §FR below.
-->

### Out of scope / Non-goals

<!--
  What this episode will NOT deliver, even though it would be nice. Non-goals
  are as load-bearing as scope — they stop scope creep and they stop the
  planner from creating tasks for FRs that belong to a future episode. If a
  stakeholder requests something that is listed here, the answer is "next
  episode", not "we'll squeeze it in".
-->

## §3 Context (REQUIRED)

<!--
  Prior art, related systems, constraints the solution MUST honour (legal,
  regulatory, contractual, integration). Anything an architect needs to know
  before designing, that does NOT belong in the FR list because it is not
  observable behaviour — it is the world the behaviour lives in.
-->

## §FR Functional Requirements (REQUIRED)

<!--
  FR describes OBSERVABLE BEHAVIOUR, NOT implementation. A black-box observer
  must be able to verify each FR without knowing the stack. These used to live
  in the SRS — they moved here (ADR-014) because UC and AC are now written
  against the PRD (before SRS), so the FR handles they trace to MUST exist in
  the PRD.

  Each FR row MUST be registered by saga-product as its own `FR` artifact
  (type='FR', parent_artifact_id = this PRD, derived_from → this PRD). The
  `code` (FR-1, FR-2, ...) is the stable query key — UC and AC later trace to
  it by code.

  Hard rules (cgad-spec-lint R14 enforces):
    - No endpoints, no JSON fields, no DB tables, no DB identifiers.
    - No HTTP verbs, no protocol names, no framework references.
    - No class names, no algorithm names, no library names.
  If an FR requires a specific algorithm or formula: capture the business/
  legal intent in a RULE artifact (§RULE below), capture the mechanism in a
  SPEC artifact (created later by saga-architect in the SRS), and write the
  FR as:
      "The system shall calculate X per RULE-N using the approved method
       (see SPEC-N)."
  Do NOT inline formulas into the FR body. R14 will flag the leak.

  Acceptance criteria format: each FR is later refined by one or more ACs
  (Given / When / Then, observable outcomes) — those live in the AC artifact
  family, not here. Here, state only the behavioural requirement.
-->

### FR-1 — <title>

**Statement:** The system shall <observable behaviour>, <condition>.

**Acceptance criteria format:** Given / When / Then, with observable outcomes.
No implementation assertions (no "calls endpoint X", no "writes to table Y",
no "returns JSON field Z").

<!-- Repeat per FR. saga-product registers FR-1, FR-2, ... as individual
     artifacts with code = FR-N, path anchored at #FR-N. -->

---

## §NFR Non-Functional Requirements — Capacity Targets (REQUIRED)

<!--
  NFRs are capacity / quality targets: performance, security, reliability,
  browser support, accessibility, etc. Each NFR MUST carry a quantitative
  target — "fast"/"secure"/"quick" are not requirements. The target becomes
  the baseline_value for runtime observations (REQ-011) and the oracle for
  verification evidence.

  Each NFR row MUST be registered by saga-product as its own `NFR` artifact
  (type='NFR', parent_artifact_id = this PRD, derived_from → this PRD). The
  SRS §9 Technology Stack is later chosen to satisfy these NFRs.

  Like FRs, NFR bodies must NOT name implementation (no "Vite", no "PostgreSQL
  EXPLAIN ANALYZE"). State the target as an observable property of the shipped
  system: "p99 page load < 2s on Slow 3G". The architect chooses how to hit it.
-->

| NFR | Target | Verification |
|-----|--------|--------------|
| NFR-1 | _e.g. p99 latency < 200ms at 1000 QPS sustained_ | _L4 benchmark_ |
| NFR-2 | _e.g. cold start < 3s wall-clock_ | _L4 benchmark_ |
| NFR-3 | _e.g. SAST clean (zero high-severity findings)_ | _L4 SAST scan_ |

<!-- saga-product registers NFR-1, NFR-2, ... as individual artifacts with
     code = NFR-N, path anchored at #NFR-N (or at this section if the table
     is the only mention). -->

---

## §RULE Business Rules (REQUIRED when domain logic is present)

<!--
  RULE captures BUSINESS / LEGAL intent: decision logic, formulas, routing
  policies, regulatory constraints. RULEs evolve independently of the FRs that
  enforce them. A RULE is the WHAT of the decision; the FR states that the
  system honours it; the SRS SPEC (later) states the mechanism.

  Examples of RULEs:
    - "If refund amount exceeds original charge amount, reject with error E."
    - "Tax is calculated per jurisdiction at the rate effective on invoice date."
    - "A user with role 'auditor' may read but not write financial records."
    - "Discount code applies once per customer per campaign."

  Each RULE row MUST be registered by saga-product as its own `RULE` artifact
  (type='RULE', parent_artifact_id = this PRD, derived_from → this PRD).
  cgad-spec-lint R15 checks that every accepted RULE has at least one
  outgoing trace to a UC or AC — so a RULE with no consumer is visible at
  lint time. The SRS §2.3 Invariant Registry later references the RULE it
  mechanically enforces (RULE = business intent, INV-... = engineered
  predicate + L3/L4 check; they do not duplicate each other).

  RULEs MAY name domain entities (refund, charge, jurisdiction) — those are
  ubiquitous language, not implementation. They must NOT name DB tables,
  HTTP verbs, framework classes (R14 still applies).
-->

| RULE | Intent | Enforced by FR |
|------|--------|----------------|
| RULE-1 | _one-sentence business rule_ | FR-_n_ |
| RULE-2 | _one-sentence business rule_ | FR-_n_ |

<!-- saga-product registers RULE-1, RULE-2, ... as individual artifacts with
     code = RULE-N, path anchored at #RULE-N. -->

---

## Hypotheses (REQUIRED for product episodes)

<!--
  The product discovery cycle closes ONLY when each hypothesis is measured.
  saga builds an excellent engineering cycle (FR→AC→code→evidence) but the
  product cycle (BR→hypothesis→metric→hit/kill) requires that every product
  bet is paired with a metric, a baseline, a target, a kill criterion, and a
  valid-by date — otherwise the work is an engineering exercise, not product
  discovery.

  Each hypothesis MUST have: metric, baseline, target, kill_criteria,
  valid_by date. Saga-product registers each row below as TWO artifacts:
    - a `hypothesis` artifact (code = HYP-N, parent_artifact_id = this PRD)
    - a `business_metric` artifact whose `path` points to a YAML block
      containing the metric definition (name, source, aggregation, unit)
  Observation of the metric is recorded via observation_record (REQ-011) and
  surfaced by cgad-spec-lint rule R16 (hypothesis without observation).

  This section is REQUIRED when the brief's classification is 'product'. It is
  NOT required for 'tech-task' classification (those episodes have no business
  bet to measure).
-->

| HYP-N | Hypothesis | Metric | Baseline | Target | Kill criteria | Valid by |
|---|---|---|---|---|---|---|
| HYP-1 | Users will use feature X | daily_active_users | 0 | 100 | <50 DAU after 30 days | 2026-09-01 |

<!--
  Example interpretation of each column:
    HYP-N           — stable code (HYP-1, HYP-2, ...). Becomes the hypothesis
                      artifact's `code`. Referenced by R16.
    Hypothesis      — the bet, in plain language. "If we ship X, users will do
                      Y more often / faster / at all."
    Metric          — the name of the business_metric artifact that measures
                      this bet (e.g. daily_active_users). MUST exist as its own
                      artifact.
    Baseline        — the metric value BEFORE the change. Numbers, not vibes.
                      If the metric is new (no prior measurement), the baseline
                      is 0 / null / "not-yet-collected" — but it is explicit.
    Target          — the metric value that means HIT. Numbers + a date or
                      window. "100 DAU" is a target; "more users" is not.
    Kill criteria   — the metric value that means KILL. If the metric lands
                      here, the feature is rolled back or redesigned — NOT
                      kept on life support. "Less than 50 DAU after 30 days"
                      is a kill; "doesn't work" is not.
    Valid by        — ISO date. After this date the hypothesis is either
                      confirmed (hit target) or killed (hit kill criteria) or
                      superseded by a new hypothesis. An open hypothesis past
                      its valid-by date is a product-cycle debt R16 will
                      surface.
-->

## §4 Priority (REQUIRED)

<!--
  How important is this work, relative to other open episodes? Use the same
  four levels as saga epics (low / medium / high / critical). Critical must
  carry a one-line justification — "critical" without a reason devalues the
  label for genuinely critical work.
-->

## §5 Open questions (OPTIONAL)

<!--
  Unresolved product decisions that the PRD carries forward. Each must have an
  owner and a decision date. Anything still open at UC/AC time blocks the
  baseline; anything still open at SRS time (SRS now runs AFTER AC — see
  ADR-014) is a risk the architect must flag. Use an OQ artifact (type='OQ')
  per open question so saga-planner can track resolution.
-->
