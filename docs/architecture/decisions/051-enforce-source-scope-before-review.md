# ADR-051: Enforce source scope before review and isolate integration from checkout bytes

- **Status:** Accepted
- **Date:** 2026-08-11
- **Decision-maker:** autonomous-decision skill

## Context

Real GLM-4.7 run 006 reached Development but paused during integration. Task 18
declared `src/core/` and `src/types/`, while its immutable commit also changed
`package.json`, tests, and `tsconfig.json`. The reviewer asserted compliance,
because scope was prompt guidance rather than executable authority. Untracked
worker bytes in the canonical checkout then made checkout-based integration
report a conflict even though Git could construct the merge tree.

Cynefin classification: **complicated**. The failure is deterministic and its
authority boundaries are knowable.

## Decision drivers and options

| Option | Authority 30 | Recovery 20 | Architecture 20 | Delivery risk 20 | Reversible 10 | Total |
|---|---:|---:|---:|---:|---:|---:|
| Prompt/reviewer only | 1 | 2 | 3 | 5 | 5 | 280 |
| Deterministic author Gate + object merge | 4 | 4 | 4 | 4 | 5 | 405 |
| New generic grant/diff-receipt subsystem | 5 | 5 | 5 | 2 | 3 | 430 |

Choose the middle option as the production stabilization slice, while retaining
the generic grant/diff receipt as the strategic follow-up. The current package
now declares a deterministic author Gate. It derives the actual changed paths
from Git using the Factory-issued effective desk base, requires exact agreement
with the submitted manifest, and rejects any path outside frozen scopes before
review. Scope overlap uses path containment rather than literal equality.

Integration no longer checks out and merges through shared working-directory
bytes. It computes the merge tree in the object database, creates the merge
commit, advances the integration ref with compare-and-swap, and synchronizes a
previously clean tracked checkout. Untracked bytes neither enter nor block the
merge. Dirty tracked state fails closed.

## Consequences

- Reviewer prose cannot authorize undeclared changes.
- Directory/file overlaps require dependency ordering.
- A dirty untracked checkout cannot fabricate a content conflict.
- Narrow plans may cause author repair rather than silent scope expansion.
- A future generic immutable ChangeAuthorityGrant and DiffReceipt should
  replace the tactical Development/task-projection storage seam.

## Pre-mortem and Red Team

Failure modes: renamed paths escape a name-only diff; metadata is mutated;
another effect omits the author Gate; target ref advances during integration.
Mitigations now are exact base binding, Gate-plan pinning, CAS ref update, and
fail-closed path normalization. Follow-up is a schema-neutral immutable grant
and diff receipt required by every repository effect.

The Red Team's strongest objection was that scope validation alone would leave
checkout contamination. The decision incorporates object-database integration
and an explicit contaminated-checkout regression.

## Decision Journal

**Expectation:** the next real run rejects undeclared files before reviewer, and
no integration conflict is caused solely by untracked canonical-checkout bytes.

**Check trigger:** any author-scope Gate failure, integration dirty-desk result,
or real run reaching repository integration.
