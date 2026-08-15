# ADR-055: Execution-scoped author repository desks

Status: Accepted

## Context

Run 015 exposed a liveness defect after a valid author repair. Task 14 first
produced a rejected candidate from base `bc966e0`. An independent sibling then
advanced `dev` to `582a970`. The replacement execution received the correct
immutable effective-base receipt, but desk provisioning tried to reuse the
stable `task/14` branch at `fd5a804` and failed because it did not descend from
the new base.

A task is a logical work item, while an author execution is one immutable
production attempt. A mutable task-scoped Git ref incorrectly combined those
identities.

## Decision

Every author WorkerExecution receives a deterministic branch and worktree keyed
by task id, WorkerExecution ref, and effective-base-receipt digest. Repeating the
same execution reuses the exact desk. A later repair execution receives a new
desk and never resets, deletes, or moves the earlier attempt's ref.

All role desks live in a Factory-owned sibling administration directory, never
below the canonical checkout. This prevents product commands such as
`git add .` from observing worktrees as embedded repositories.

Reviewer desks remain detached at the exact sealed source commit. Integration
continues to validate the current accepted CandidateSet, source ref, commit, and
tree. Branches are transport identities; CandidateSets and content hashes remain
the acceptance authority.

## Options and scoring

Weighted criteria were audit safety 30%, implementation readiness 25%, crash
idempotency 20%, architectural fit 15%, and reversibility 10%.

| Option | Score / 500 | Decision |
| --- | ---: | --- |
| Execution-scoped desk | 455 | Selected |
| Authorized archive and reset of `task/<id>` | 365 | Reject: moves a ref named by historical products |
| Full repair-production-revision aggregate | 405 | Strategic follow-up; too broad for this liveness repair |

## Pre-mortem and controls

- A retry could create a different desk: the key includes immutable execution
  and receipt identities, and existing mismatched state fails closed.
- An old candidate could be reviewed or integrated: reviewers remain pinned to
  the exact CandidateSet commit and the final effect validates that binding.
- Old work could be lost: no old ref or worktree is reset or removed.
- Scripted tests could diverge from production: both use the same provisioner
  and pass the WorkerExecution ref.
- Branch-name injection or Windows path length could break provisioning: only a
  fixed-length SHA-256 prefix enters names and paths.

## Consequences

Repair after integration-head movement is append-only and can proceed without
manual Git or database mutation. More worktrees and refs accumulate; retention
and archival remain a separate policy. A future production-revision aggregate
may replace execution identity, but it must preserve this no-ref-rewrite rule.
