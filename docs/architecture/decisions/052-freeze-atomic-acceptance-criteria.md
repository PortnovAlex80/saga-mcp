# ADR-052: Freeze Atomic Acceptance Criteria, Not Artifact Containers

Status: accepted

## Context

Run 007 froze one accepted AC Markdown artifact as one criterion (`code=AC`),
although that artifact contained fifteen level-three criteria (`AC-1.1` through
`AC-3.4`). The deterministic SRS validator consequently required one D2 row,
while five independent semantic reviewers correctly required the fifteen
observable criteria. Every local state transition was lawful, but the repair
loop was unsatisfiable because its two authorities disagreed.

Existing tests used one artifact per criterion and therefore encoded the lossy
boundary as a valid fixture.

## Decision

The Formalization baseline remains bound to immutable accepted artifact
containers, and additionally freezes their atomic criterion members. Atomic
members are derived deterministically from canonical level-three AC headings and
bind container artifact id, exact code, title, and section hash. Codes must be
unique across the accepted set. A legacy single-criterion artifact without such
headings falls back to its artifact code.

SRS D2 validation and the Development handoff consume the frozen atomic member
set. They never infer criterion cardinality independently from the current file.

## Alternatives

- Prompt-only reviewer clarification: rejected; it leaves conflicting machine
  authority and permits recurrence with another model.
- One artifact row per criterion: valid future normalization, but unnecessarily
  rewrites the managed-document authoring model for this incident.
- Treat the whole Markdown file as one criterion: rejected; it destroys
  traceability, verification planning, and change-impact precision.

## Consequences

One artifact can now provide multiple Development acceptance bindings without
duplicating its provenance. Criterion section hashes make changes observable.
The heading grammar is intentionally narrow; malformed or duplicate atomic
codes fail before architecture authoring. Legacy baseline snapshots remain
readable through the one-artifact fallback.

## Verification

- Parser tests cover multiple members and duplicate rejection.
- SRS validator tests prove that omitting one member from a multi-member
  container fails closed.
- A clean real E2E is required; Run 007 remains immutable evidence and is not
  resumed.
