# K2 — Legacy Burn-Down Baseline

- **Release:** K2 — Legacy Expansion Freeze (Saga Core Renewal)
- **Baseline tip:** this commit's parent
- **Live status:** `npm run legacy:report`

## Frozen baseline (comment-stripped CODE references)

| Category | Baseline | Owning release | K20 target |
|---|---|---|---|
| `escalate-vocabulary` | 7 files | K15 | 0 |
| `recency-selector-authority-persistence` | 9 files | K7 / K8 | 0 |
| `execution-scoped-lookup` | 0 files | pinned 0 (was comment-only at capture) | 0 |
| `latest-candidate-code-refs` | 0 | pinned 0 (ADR-053 Phase 7) | 0 |
| `schema-snapshot` | 96 tables, digest `1ccd5a45…` | K17 lowers it by the deletion set | reduced by K17 |

Monotonicity is mechanical: `tests/architecture/legacy-expansion-freeze.test.mjs`
fails the architecture suite on any addition outside the allowlist or any
schema drift. Lowering the allowlist happens in the SAME commit as the real
removal; broadening requires a new ADR.

## Disposition of the planned "dead aliases and stale scripts" commit

The K2 train's fourth commit (remove dead aliases and stale scripts) is
absorbed, not skipped:

- The one verified stale script (`test:e2e` → deleted
  `tests/e2e-pipeline.test.mjs`) was removed in K1 commit 1 when the
  restored ratchet caught it.
- Package-script target integrity is now continuously enforced by the
  factory-only ratchet (`no package script references a missing node
  target`).
- No further verified-dead exports existed at the freeze baseline:
  remaining legacy code (categories A/B) has live callers and is owned by
  K7/K8/K15 — deleting it early would be an unverified change, which the
  program's discipline forbids.

## K2 exit gate

Every future removal can prove a monotonic decrease: the allowlist names
each legacy file with its owning release, the ratchet blocks additions and
schema drift, and `legacy:report` prints the live counts against this
baseline.
