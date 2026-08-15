# ADR-044: Append-only local release continuation

- Status: accepted
- Date: 2026-08-10
- Decision owner: factory architecture

## Context

LifecycleRun 9 completed Development with an exact verified candidate, then
terminated truthfully at Delivery with `approval-required`. The operator has
authorized a local release of that exact candidate. A release record alone is
not an external effect, and terminal lifecycle/process rows must not be
reopened or relabelled.

## Guardrails

1. Discovery, Formalization, and Development production must not run again.
2. LifecycleRun 9 and all of its evidence remain byte-for-byte immutable.
3. `released` requires an observable, idempotent effect and authoritative
   observation; a database row cannot manufacture success.
4. The effect is local only: no remote push, deployment, or registry publish.
5. A conflicting existing release identity fails closed and is never moved.

## Options

| Option | Authority correctness (30) | Preserves work (25) | Crash safety (20) | Time (15) | Reuse (10) | Weighted / 500 |
|---|---:|---:|---:|---:|---:|---:|
| Append-only Delivery child + immutable Git tag | 5 | 5 | 5 | 4 | 5 | 485 |
| Append-only Delivery child + local release-marker store | 4 | 5 | 4 | 4 | 3 | 410 |
| Insert a ReleaseRecord / mutate Run 9 | 1 | 5 | 1 | 5 | 1 | 260 |

## Decision

Create a single-use continuation from the exact `approval-required` Delivery
boundary. Its verified prefix inherits the completed upstream stages and its
child lifecycle executes only Delivery.

The authorized policy contains one required `source-tag` action. A local Git
tag provider resolves the project repository from factory authority, validates
the exact candidate commit and tree, and creates a content-addressed tag without
force. It observes before mutation and again after mutation. An existing tag is
successful only when it resolves to the exact authorized commit/tree; any
collision blocks. Delivery settlement may emit `factory.release-record.v1`
only after the authoritative observation matches.

The operator grant is bound to the exact candidate and policy. It represents
the explicit approval already given for this local effect, so the child policy
does not require a second interactive approval after preflight. This does not
authorize remote publication.

## Pre-mortem and controls

- **Wrong candidate released:** bind authorization, action payload, commit,
  tree, Development certificate, and verified bundle; re-observe immediately.
- **Tag moved or collided:** use compare-and-set creation; never force/update.
- **Crash after Git mutation:** observe-before-act recognizes the exact tag and
  the effect ledger settles the same desired state idempotently.
- **Old workshops rerun:** continuation entry is Delivery and tests assert zero
  upstream StageRuns, tasks, and worker executions in the child.
- **Local release misreported as deployment:** policy channel and ReleaseRecord
  identify a local source tag only.

## Consequences

The parent remains visibly `approval-required`; the active order leaf can reach
`released` through new authority. Before tag creation the operation is fully
reversible. After creation, recovery is append-only: the tag is retained as an
audit fact and a correction requires a new release identity, never mutation.

## Decision journal

The incident was classified as complicated. Three independent option analyses
converged on an append-only Delivery suffix. Red-team review rejected both a
pure ReleaseRecord and synchronous/unreceipted Git mutation. The deciding
invariants were terminal-row immutability, zero repeated upstream cognition,
and execute/observe/receipt authority.
