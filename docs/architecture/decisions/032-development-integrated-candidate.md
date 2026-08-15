# ADR-032: Development verifies one integrated candidate

- Status: accepted
- Date: 2026-08-07
- Decision owner: factory architecture

## Context

The Development planner treated acceptance-criterion cardinality as work-item
cardinality. Fan-out desks then started from the same base, produced independent
task branches, and verification inspected those branches rather than one
assembled product. `dependsOnKeys` existed as data but the universal Production
Cell did not enforce it. A generic worker-completion receipt could also satisfy
the declared product schema without the typed product body needed by
settlement.

The factory model permits an LM to generate text and invoke granted tools. Git
integration, admission, freezing and acceptance remain kernel/provider effects.

## Options

1. Keep direct implementation-to-verification flow and strengthen planner
   wording only. Small change, but timing remains authoritative and no exact
   candidate exists.
2. Add an LM reconciliation desk that edits and merges a final product. Flexible,
   but makes an LM the authority for an infrastructure effect and introduces a
   Development-only runtime.
3. Use the universal fan-out DAG, typed desk products, the existing serialized
   integration protocol, and a deterministic kernel freeze station before the
   universal verification cell.

## Decision matrix

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | Wording only | LM integrator | Kernel freeze |
|---|---:|---:|---:|---:|
| Exact candidate provenance | 30 | 1 | 2 | 5 |
| Factory-model consistency | 25 | 2 | 2 | 5 |
| Reuse across architectures | 20 | 2 | 3 | 5 |
| Restart determinism | 15 | 1 | 2 | 4 |
| Implementation risk | 10 | 5 | 2 | 3 |
| Weighted result | 100 | 185 | 220 | 460 |

Choose option 3.

## Decision

- The planner groups coherent product increments. ACs are coverage obligations,
  never an implicit task partition.
- Work items declare repository-local change scopes and a closed acyclic
  dependency graph. Same-repository overlapping scopes require a dependency
  path.
- The universal Production Cell admits a dependent workplace only after every
  named predecessor is terminal and accepted.
- Development cell outputs require exact typed submissions. Completion prose
  cannot impersonate the declared product.
- Accepted `git_change` work must be integrated before freeze. The freeze kernel
  observes only the declared repository bindings and integration branches,
  checks expected-base ancestry and merged task state, and persists one
  content-addressed candidate.
- Verification starts after freeze and must echo the exact candidate hash in
  its typed evidence. Settlement rejects foreign-candidate evidence and reads
  the persisted candidate rather than reconstructing one late.

The planner skill contains architecture-neutral principles and a checklist;
it contains no frontend, backend, framework or file-layout examples.

## Pre-mortem and red-team constraints

Most likely failures are an accepted branch that was never merged, overlapping
parallel work, a worker that completes without a typed product, branch movement
during or after freeze, and verification that merely repeats a requested hash.
The implemented cutover fails closed on the first three and detects later live
branch drift at settlement.

The red team identified further hardening required for hostile concurrency:
provider-owned CAS merges with monotonic fence tokens and immutable integration
receipts; a closed integration epoch across multiple repositories; detached
candidate materialization receipts for verifiers; scope-to-diff enforcement;
and candidate-addressed verification work keys. These are recorded as follow-up
work, not reasons to retain the known-broken direct verification flow.

## Consequences

Verification no longer sees per-task branches. Independent work may remain
parallel, while shared foundations and overlapping scopes are serialized by
the same reusable cell mechanism. The additional kernel node is a generic
admission/freeze station in the flow, not a fifth bespoke workshop runtime.

## Decision journal

- 2026-08-07: selected option 3 after three independent option briefs, weighted
  comparison, pre-mortem and adversarial review.
- Revisit when the integration provider gains atomic CAS receipts and an
  integration-epoch barrier; the flow ordering and product contracts remain
  valid when that provider is strengthened.
