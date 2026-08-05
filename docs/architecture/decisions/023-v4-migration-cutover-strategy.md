# ADR-023: Conveyor v4 migration — cutover-strategy and step-6 sequencing

**Status:** Accepted
**Date:** 2026-08-04
**Relates to:** [`CONVEYOR-V4-MIGRATION-PLAN.md`](../CONVEYOR-V4-MIGRATION-PLAN.md),
[`FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md`](../FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md),
ADR-021 (compatibility policy)

## Context

The Conveyor v4 migration plan (`CONVEYOR-V4-MIGRATION-PLAN.md`) is a 6-step
rewrite of saga-mcp's production-state model: legacy `tasks` (a single
status-machine table) is being superseded by the authoritative `Workplace`
aggregate (`v4_workplaces`) with two-channel state (Kanban + loop). The plan's
"stay-on-the-front" contract requires the runtime to keep working between
phases (DB additive; `SCHEMA_VERSION` bump once at step 6; MCP names stable
until step 5).

By the end of the v4 implementation work (steps 1–5 infrastructure +
coordinator + dual-write shadow + conformance harness + E2E-01..13), two
items remained that the completion verifier flagged:

1. **Step 5.2 cutover authority** — make `v4_workplaces` the read source
   (`SAGA_WORKPLACE_READ=new`), forbidding core reads of `tasks` owner-columns
   as orchestration truth (REG-06-AC-01/02, step 5.4).
2. **Step 6 drop legacy** — bump `SCHEMA_VERSION` 1→2, drop legacy tables and
   `tasks` owner-columns, final ratchets (`no-task-table-in-core`,
   `no-module-name-switch`, `fifth-workshop-installs-without-core-change`).

A full cutover requires rewriting ~16 orchestration core files that still read
`tasks` (the lifecycle single-writer set, the dispatch eligibility view, every
workshop's settlement/runtime). The plan itself scopes each workshop's
read-switch as a 4–7 week sub-phase (3.A.4 / 3.B.3 / 3.C.4).

## Decision Drivers

- **Stay-on-the-front contract** — the runtime MUST keep working. A single-PR
  "rip out tasks" would break every active run.
- **Disposable pre-release DB policy** (ADR-021) — no shipped databases; the
  schema can change incompatibly, but the *runtime code paths* cannot.
- **Honest ratchets beat silent drift** — a whitelist ratchet that captures
  the current state and forbids regression is more valuable than a hard gate
  that fails today and gets disabled.
- **REG-06 / REG-03 / REG-18 acceptance criteria** — the registry demands
  *behavioral* conformance (rebuildable projection, no module switches in
  core, closed verdict), not a specific day-1 table drop.

## Considered Options

### Option A — full destructive drop now (one-shot)
Drop legacy tables, bump `SCHEMA_VERSION`, rewrite all 16 core readers to
`v4_workplaces` in one PR.

- **Pro:** the plan's step 6 is "done" in one move.
- **Con:** breaks the stay-on-the-front contract (runtime stops working until
  every reader is rewritten); high risk of subtle bugs in 16 simultaneously
  rewritten paths; contradicts the plan's own per-workshop sequencing.
- **Rejected.**

### Option B — shrinkage ratchets + safe step-6 increments (CHOSEN)
Ship what is safe and honest now, and gate the destructive parts behind
measurable ratchets:

1. Bump `SCHEMA_VERSION` 1→2 (signals the v4 additive layer is now a required
   schema part — additive-only, legacy tables retained as projection).
2. Bump `tracker_export` format_version 1.4→1.5.
3. Add the **absence-of-readers ratchet** (`tasks-reader-invariant.test.mjs`):
   a shrinkage whitelist of the 16 current core readers, target = 0. Each
   workshop's read-switch (3.A.4/3.B.3/3.C.4) removes an entry.
4. Strengthen the **no-module-name-switch ratchet**: a shrinkage whitelist of
   the 4 current `task_kind`/`module_ref_key` switches, target = 0.
5. Leave the destructive table/column drop for after cutover — the plan
   explicitly requires "после join'ов через workplace" (after the workplace
   join path replaces direct reads).

- **Pro:** every change is safe (runtime keeps working); the ratchets make the
  remaining work measurable and forbid regression; pre-release policy honored.
- **Con:** step 6 "drop legacy" is not literally complete — but the plan's own
  sequencing makes this impossible without the per-workshop read-switches.

### Option C — feature-flag cutover now (SAGA_WORKPLACE_READ=new default)
Flip the read flag so `v4_workplaces` is the source.

- **Pro:** "authority on Workplace" achieved.
- **Con:** requires sustained zero-drift in `both` mode first; the workshop
  kernels still read legacy tables directly (not through the comparator), so
  flipping the flag would make them read a half-populated shadow. Would break
  settlement/resolution in production.
- **Rejected** (premature).

## Decision

**Option B.** The migration ships its safe, additive, ratchet-gated
increments now. The destructive drop (legacy tables, `tasks` owner-columns,
`episode_workflows`) is sequenced AFTER the per-workshop read-switches land
and the absence-of-readers whitelist reaches zero — exactly as the plan's
"после join'ов через workplace" clause requires.

The two new ratchets (`tasks-reader-invariant`, strengthened
`v4-target-conformance-ratchet`) make the cutover progress measurable: a
future PR that lands a workshop read-switch MUST shrink the whitelist, or the
build fails.

## Consequences

- **Positive:** runtime stays green; cutover progress is auditable; the
  registry's behavioral criteria (REG-06 rebuildable projection, REG-03 no
  module switches, REG-18 closed verdict) are guarded by executable tests.
- **Negative:** two sources of truth (`tasks` legacy + `v4_workplaces` shadow)
  coexist until cutover; the dual-write + read-comparator (`both` mode) is the
  safety net during this window.
- **Neutral:** `SCHEMA_VERSION=2` and `format_version=1.5` are now the
  baseline; a fresh DB stamps `user_version=2`.

## Decision Journal (ex-ante expectations)

- **30 days:** the absence-of-readers whitelist drops by ≥1 entry (the first
  workshop read-switch lands). If it grows, the cutover has stalled.
- **90 days:** at least one workshop's kernel reads exclusively from
  `v4_workplaces` (its entry removed from the whitelist), proving the
  read-switch path is viable end-to-end.
- **Check trigger:** the `tasks-reader-invariant` test run on each PR; the
  "reports reader set" line shows the count.
