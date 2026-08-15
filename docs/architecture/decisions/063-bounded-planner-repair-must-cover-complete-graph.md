# ADR-063: Bounded planner repair must cover the complete graph

Status: Accepted

## Context

The clean Run026 Development planner produced a graph with many unordered
same-repository scope overlaps. Its second semantic candidate repaired all but
one pair, then the Production Cell exhausted its two-attempt budget and paused.
A physical worker crash between those candidates was correctly excluded from
the semantic attempt count.

The graph gate was correct: overlapping write authority without a dependency
path makes parallel authoring unsafe. The liveness failure was the combination
of a large relational repair surface, an instruction that allowed the model to
focus only on previously reported pairs, and a two-candidate recovery ceiling.

## Decision

The Development task-graph planner receives at most three semantic author
candidates. Physical execution failures remain governed by the separate engine
retry model and do not consume this budget.

On every repair the planner must recompute the complete pairwise overlap matrix
after applying feedback. It must prove that every same-repository overlapping
pair has a dependency path in one direction, including overlaps newly exposed
by changed scopes. The deterministic graph gate remains the authority and the
third attempt does not weaken or bypass it.

## Consequences

- A large but converging graph repair gets one additional bounded iteration.
- Persistent invalid graphs still pause after three semantic candidates.
- Kanban recovery and physical worker retry remain distinct axes.
- Regression tests pin the recovery ceiling and deterministic overlap checks.

