# PRD — <REQ-NNN slug>

<!--
  Copy this template to docs/requirements/REQ-NNN-<slug>/00-PRD.md.
  Produced by saga-product. Parented to the accepted brief from Discovery. The
  PRD fixes business intent — everything downstream (SRS, UC, AC) derives from
  it. The PRD MUST NOT specify implementation: no stack, no APIs, no data
  models, no algorithm names. That is the SRS's job (saga-architect).

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
  becomes the seed for one or more FRs in the SRS.
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
  owner and a decision date. Anything still open at SRS time is a risk the
  architect must flag. Use an OQ artifact (type='OQ') per open question so
  saga-planner can track resolution.
-->
