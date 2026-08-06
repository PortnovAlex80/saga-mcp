# ADR-028: WorkIntent conclusion and Workplace settlement are one transaction

Status: accepted

Date: 2026-08-06

## Context

The factory previously allowed three records describing one bounded LM cell to
move independently:

- `factory_work_intents.status` — execution authority binding;
- `factory_workplaces.{kanban_phase,loop_state}` — production-state authority;
- `tasks.status` — human-facing reverse projection.

A worker could commit `proposal_submit` and then die before its process close or
`worker_done` acknowledgement. The Discovery resolver correctly found the
durable product and concluded the WorkIntent, but no Workplace transition was
committed. The resulting state was:

```text
WorkIntent = concluded
Workplace = in_progress / verifying
Task = todo
WorkerExecution = lost
```

On resume the queue selected the stale task and
`readWorkIntentForTaskClaim` rejected the new claim with
`AUTHORITY_BINDING_INVALID`. Making `concluded` claimable or silently reopening
it would duplicate already committed work and violate the authority contract.

## Decision

A transition of a bound WorkIntent to `concluded` is a cross-channel invariant.
The following writes commit in the same SQLite transaction:

1. WorkIntent becomes `concluded`.
2. Its bound Workplace becomes terminal (`done/accepted` or `failed/failed`).
3. The active Workplace reservation is revoked.
4. `tasks.status` is rebuilt from the terminal Workplace and its stale worker
   assignment/fence is cleared.

The invariant is installed by
`ensureAuthorityBindingInvariant` in the Workplace projection boundary. SQLite
executes the trigger inside the caller's existing WorkIntent CAS transaction,
so a process crash cannot occur between authority conclusion and Workplace
settlement.

At database open, the same function reconciles historical split-brain rows
before lifecycle resume or dispatcher queue reads begin.

`concluded` remains non-claimable. It is never converted to `open` merely
because a stale task projection says `todo`. A new author/reviewer execution is
legal only after an explicit semantic repair transition has moved the same
Workplace to a repair state and reopened its bounded intent under policy.

## Discovery disposition bridge

The current migration has not yet routed every module resolver through a
first-class universal GateRun. Until that cutover is complete, the durable
module resolver is the acceptance authority for the WorkIntent cell.

For the Discovery proposal cell:

- a submitted canonical `factory_proposals` row means terminal `accepted`;
- `factory_raw_submissions.status=normalization_required` means the proposal
  cell completed successfully and handed a durable raw product to the
  normalization cell, so the proposal Workplace is terminal `accepted`;
- a syntactically rejected raw submission, a missing raw submission, or an
  `accepted_deterministically` raw submission without its canonical Proposal
  means terminal `failed`.

For normalization, readiness and other current LM intent kinds, the existing
resolver calls `concluded` only after it has accepted the durable output, so the
bridge settles them as `accepted`.

This bridge does not fabricate CandidateSets, CheckReceipts or GateDecisions.
Those records must be produced by the planned Production Cell gate cutover. The
bridge only guarantees that the current legitimate resolver decision cannot
leave the authority channels contradictory.

## Consequences

- Crash-after-submit/pre-close converges without a replacement worker.
- Resume skips the already settled task because its Workplace is terminal and
  its task projection is `done`.
- The exact terminal reason remains on Workplace; the current board projection
  renders every terminal phase as `done`.
- A stale WorkerExecution may remain in the execution audit until supervision
  observes and terminalizes it, but its reservation/fence no longer authorizes
  mutation.
- Opening an old database may log a one-time reconciliation count. No products,
  proposals, NodeRuns or audit evidence are deleted.

## Rejected alternatives

### Make `concluded` claimable

Rejected. It grants a fresh worker authority over an already closed intent and
can duplicate immutable products.

### Reopen `concluded -> open` when `tasks.status=todo`

Rejected. `tasks.status` is a projection and cannot override authority state.
The prior implementation did exactly this in resume preparation and thereby
hid the split brain instead of repairing it.

### Update only `tasks.status`

Rejected. That would make a projection appear healthy while the authoritative
Workplace remained stuck in `verifying`.

### Blindly repeat the worker

Rejected. The durable product already exists; recovery must adopt/settle it,
not regenerate it.
