# ADR-036: Read durable live concurrency before every worker assignment

- Status: accepted, bounded single-host enforcement
- Date: 2026-08-09
- Decision owner: factory architecture

## Context

The live recovery launch froze `concurrency=5`. The tracker later accepted an
operator change to `2`, but the canonical CLI retained its launch-local value
and started three GLM-4.7 workers. Repository policy was contradictory:
GLM-4.7 was capped at 2 in Factory administration, 10 in model management, and
5 in the CLI sandbox seed. The existing SQLite reader computed the intended
minimum but had no runtime caller.

The factory must downshift without killing active workers, preserve immutable
launch audit data, and stop treating UI state, launch input, and runtime
admission as independent authorities.

Cynefin classification: complicated. The current single-host topology is
knowable, but crash/adoption and alternate launch paths make a local counter
insufficient as a universal claim.

## Options

1. Durable live admission view: keep launch concurrency as audit input, publish
   the composition-owned policy reader, read operator/model minimum plus all
   durable active executions immediately before every dispatch assignment, and
   naturally drain on a downshift.
2. Launch-sealed budget: reject live changes while a launch is active and apply
   them only on a worker-free resume.
3. Atomic capacity authority: move provider/model quota validation, durable
   active counting, and capacity reservation into the same SQLite transaction
   as WorkAssignment fencing.

## Decision matrix

Scores are 1 (poor) to 5 (strong).

| Criterion | Weight | Live view | Launch-sealed | Atomic authority |
|---|---:|---:|---:|---:|
| Current single-host correctness | 25 | 4 | 4 | 5 |
| No-stop downshift behavior | 20 | 5 | 2 | 5 |
| Alignment with current composition | 15 | 5 | 3 | 4 |
| Implementation/recovery risk | 15 | 4 | 4 | 2 |
| Testability and observability | 15 | 5 | 4 | 5 |
| Multi-host safety | 10 | 2 | 3 | 5 |
| Weighted result | 100 | 430 | 335 | 430 |

Options 1 and 3 tie numerically. Option 1 is selected for this incident because
it is materially smaller and reversible while the observed topology has one
claimed canonical host. Option 3 remains the required target before concurrent
hosts or account-global quota enforcement are allowed.

## Decision

- Cloud Factory model profiles live in one compiled catalog. GLM-4.7 has the
  operator-confirmed safe ceiling of 2. The 5/10 duplicates are removed.
- `lifecycle_execution_controls` supplies current operator concurrency and
  model limit. Missing or malformed policy fails closed.
- The composition publishes the same `EpisodeRuntimeRepository` used by the
  application. The CLI does not construct a second policy adapter.
- Immediately before every dispatch assignment, the loop rereads a durable
  admission snapshot and counts executions in `reserved`, `running`, or
  `cancel_requested` for the epic.
- Effective concurrency is exactly `min(operator concurrency, model limit)`.
  A downshift never cancels existing workers; it suppresses replacements until
  durable active count falls below the ceiling.
- The launch row remains immutable audit evidence and is no longer the live
  dispatch authority. New start/resume commands persist model-capped values and
  never manufacture the old default 5.
- The current already-loaded host cannot hot-reload this decision. Its terminal
  evidence is preserved; enforcement begins with the next host.

## Pre-mortem and red-team constraints

Assume this failed later. Likely causes are two allocators racing between read
and claim, adopted executions missing from a local counter, a task-level route
using a different model quota, missing policy failing open, or capacity being
misreported as an empty queue. The bounded implementation therefore counts
durable active rows, rereads before each assignment, validates the exact
minimum, and throws on missing policy.

The Red Team correctly found that this is not full REG-10-AC-05 enforcement:
read-then-claim is not atomic across two hosts. Before multi-host operation,
capacity validation/reservation must move into the WorkAssignment
`BEGIN IMMEDIATE` transaction, produce typed `assigned | at_capacity |
queue_empty | policy_invalid` outcomes, and validate quota against the exact
frozen route. Tests must race two SQLite connections.

## Consequences

Tracker concurrency changes become effective through natural worker rotation
for future hosts. UI, CLI, and runtime share the GLM cap. Existing workers and
their fences are not disturbed.

This decision deliberately does not claim provider-account-global enforcement
across separate database files. Such a quota requires a shared lease database
or provider control service.

## Decision journal

- 2026-08-09: live evidence showed three workers after an acknowledged 5→2
  change; no provider 429 occurred and the cohort naturally drained.
- Expected in 30 days: no checked-in GLM-4.7 limit other than the canonical 2;
  no dispatch assignment while durable active count is at or above the current
  effective limit.
- Check trigger: the next real resume after this commit, plus any proposal to
  run two canonical hosts or multiple Factory databases concurrently.
