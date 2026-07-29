# Acceptance Reviewer Skill Fragment (W8-A4)

> Package-local reviewer skill for the `formalization-acceptance` review pass.
> Pinned by the `formalization.acceptance.reviewer-skill` resource index entry.

## Review targets

For each AC artifact offered by the `define-acceptance-contract` LM node:

1. **Lineage** — AC `derived_from` a UC that exists and is accepted; the UC
   `covers` at least one accepted FR/NFR. No orphan AC.
2. **Contract form** — AC is structured as testable contract data (given /
   when / then or equivalent), not free prose. Verifier can derive an L3
   property test from it without re-interpretation.
3. **WHAT-only** — no architecture or implementation choices leaked in. SRS is
   not yet written; the AC must remain architecture-agnostic.
4. **Naming** — stable codes unique within the episode and follow convention.
5. **No placeholders** — TODO/FILL/??? reject.

## Verdict

- `approved` advances to the kernel resolver.
- `changes_requested` returns the AC set to the author node with a precise
  repair list.
