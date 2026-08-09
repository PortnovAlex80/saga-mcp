# ADR-034: Rehydrate Every Non-Terminal ProcessRun Package Pin at Host Start

- Status: accepted
- Date: 2026-08-09
- Incident: `PINNED_PACKAGE_SNAPSHOT_MISSING` during LifecycleRun 1 recovery

## Context

A compatible same-version toolset update creates a new active installation and
retires the prior installation. Existing ProcessRuns intentionally retain the
old `installation_id` and `package_digest` for exact replay. The content store
and installation repository preserve that historical package, but production
startup populated its in-memory snapshot map only from the manifests installed
in the current host process. A paused ProcessRun therefore resolved its retired
installation correctly and then failed before worker spawn because the exact
snapshot was absent from the map.

This violated the conveyor distinction between package selection and package
replay: `retired` forbids selection by a new run; it does not invalidate an
existing durable pin.

## Options

1. Eagerly load and verify every distinct package digest pinned by a
   non-terminal ProcessRun during host startup.
2. Lazily read a missing pinned snapshot from the content store during worker
   launch.
3. Repin existing ProcessRuns to the newly active compatible package.

## Decision matrix

Scores are 1 (worst) to 5 (best).

| Criterion | Weight | Eager preflight | Lazy worker read | Repin run |
|---|---:|---:|---:|---:|
| Exact-pin integrity | 30 | 5 | 5 | 1 |
| Failure locality before task reservation | 25 | 5 | 2 | 4 |
| Resume compatibility | 20 | 5 | 5 | 1 |
| Implementation simplicity | 15 | 4 | 3 | 4 |
| Startup/memory cost | 10 | 4 | 5 | 5 |
| Weighted total | 100 | **475** | 395 | 260 |

## Decision

Choose eager preflight. After installing current manifests, startup enumerates
the distinct non-null package digests of ProcessRuns in `created`, `preparing`,
`running`, `paused`, or `settling` state. Any digest not already in the current
snapshot map is resolved through the immutable installation repository and read
through the verifying content-addressed store.

Missing installation identity or unverifiable bytes abort host startup before
a task is reserved. Completed, failed, and cancelled runs are not eagerly held
in memory; their immutable rows and bytes remain available for explicit replay.

## Red-team / pre-mortem

- Loading every historical package forever could create unbounded startup cost.
  Restrict eager hydration to distinct pins owned by non-terminal ProcessRuns.
- Silently falling back to current active bytes would make a run non-reproducible.
  The lookup is exact by digest and has no active-package fallback.
- Discovering corruption only after reservation would misclassify a host
  dependency failure as a worker failure. Hydration completes before dispatch.
- Installation-only consumers may not have lifecycle tables. Absence of the
  ProcessRun table/column is treated as an installation-only host, not an empty
  or fabricated lifecycle.

## Consequences

- Compatible package replacement and exact historical resume coexist.
- Startup may perform additional verified reads proportional to distinct live
  package pins.
- The production-install regression crosses the previously missing seam:
  compatible replacement, retired installation, live ProcessRun pin, restart
  hydration, and simultaneous availability of old and new snapshots.

## Decision journal

The invariant priority is exact durable identity over convenience. Lazy loading
would preserve bytes but retain the observed wrong failure boundary; repinning
would destroy the very evidence required for reproducible recovery. Eager,
bounded hydration is the only option that makes readiness truthful before work
is issued.
