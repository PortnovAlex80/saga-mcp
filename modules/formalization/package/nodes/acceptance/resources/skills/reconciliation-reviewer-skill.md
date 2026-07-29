# Reconciliation Reviewer Skill Fragment (W8-A4)

> Package-local reviewer skill for the `formalization-reconciler` review pass.
> Pinned by the `formalization.reconciliation.reviewer-skill` resource index
> entry.

## Review targets

1. **Closure** — every accepted WHAT artifact (PRD/FR/NFR/RULE/UC/AC) has its
   required `derived_from` / `covers` / `enforced_by` links after repair.
2. **No silent repair** — every repaired edge is recorded; no contradiction
   was hidden to make the graph close.
3. **Authority respected** — no WHAT artifact was created or mutated by the
   reconciler (only trace edges).
4. **Baseline readiness** — the accepted AC set is stable enough for the
   freezer to hash. Any drift source must be flagged.

## Verdict

- `approved` lets the kernel resolver materialize the report and hand off to
  the baseline freezer.
- `changes_requested` returns to the reconciler with a precise repair list.
