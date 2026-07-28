# ADR-021: Compatibility policy — additive migrations, one seam per subsystem, rollback selects never edits

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.13, §16 (16.1–16.10), §14.1.5

## Context

The refactor replaces the Runtime core, the SPI, the package model, the protocol
model, and the MCP gateway while keeping the existing Product Delivery pipeline
runnable the whole time (plan §16.9: "each phase must leave the repository
buildable and the previous production path runnable unless that phase explicitly
performs cutover"). That is only possible with an explicit compatibility policy —
otherwise the repo accumulates half-removed shims that re-break later waves.

The current codebase already carries compatibility debt that the policy must
govern:

- **Persistence migrations** in `src/db.ts`: a hand-rolled chain of idempotent
  `try { ALTER TABLE } catch {}` blocks plus nine named migration functions
  (baseline §"Persistence & migrations"; `COMPATIBILITY-INVENTORY.md` lists them).
  There is no `migrations/` dir, no `user_version` pragma, no framework — each
  repo calls its own `ensure…Schema(db)` lazily (baseline §"Where SQL lives").
- **Composition root seam**: `composition/product-lifecycle-runtime.ts` (483
  lines) hard-wires 4 `GenericFlowExecutor`s, the node-executor map, both
  built-in registries, and ~30 concrete symbols (baseline §"Composition —
  `composition/`").
- **Hard-coded Discovery workflow strings**, the flat `ALL_TOOLS` registry, the
  `routeResolver` closure dodge, the built-in catalog + prefix resolver
  (ADR-020, ADR-016, ADR-015; baseline §"Cross-cutting refactor seams").
- **Legacy rows** in existing tables that must not be reinterpreted as new
  contracts (plan §16.2).

Plan §3.13 requires compatibility code to live in explicit adapters outside the
new core and be removed after migration. Plan §14.1.5 freezes current public
tool names and persistence migrations as a compatibility boundary. Plan §16 sets
the migration and rollback policy.

## Decision

Three rules govern every compatibility surface in this refactor.

### 1. Additive database migrations until cutover (plan §16.1, §16.2)

- **Additive only.** New columns, new tables, new indexes. No destructive ALTER
  on existing columns until the phase that explicitly performs cutover (plan
  §16.1, §16.9).
- **Never reinterpret old rows as new contracts.** Legacy rows are marked and
  routed through explicit adapters (plan §16.2). A row written by the old
  Runtime is not silently treated as a new-contract row.
- **One persistence owner per wave** controls all SQL migration numbering and
  shared schema bootstrap changes (plan §0.1.8). No lane adds a migration
  unilaterally.

### 2. One compatibility seam per old subsystem, deleted immediately after migration (plan §3.13, §16.3)

- **Seams are explicit adapters outside the new core.** Examples:
  `LegacyProcessModuleAdapter` (plan §14.2.4) wraps the existing
  `ProcessModuleDefinition` behind the new SPI; the flat `ALL_TOOLS` registry
  stands in for the capability + module-contribution registries until Wave 3/12;
  the Markdown tracker stands in for `ProtocolRun` until Wave 5.
- **One seam per subsystem.** Do not fork two parallel compatibility paths for
  the same old subsystem.
- **Delete immediately after the owning module migrates** (plan §16.3). The seam
  does not linger "in case someone needs it". Specific deletion gates:
  - §16.4: do not move module resources before immutable package resolution works.
  - §16.5: do not make tracker read-only before `ProtocolRun` is authoritative.
  - §16.6: do not enable per-step tool restrictions before protocol step identity
    is live and tested.
  - §16.7: do not remove current tools before module tool aliases and replay
    behavior are verified.
  - §16.8: do not cut Product Delivery to the new scenario engine until all four
    current modules pass conformance tests.

### 3. Rollback selects the previous installation; it never edits immutable bytes (plan §16.10, §3.11)

- A failed phase is rolled back by **selecting the previous package installation
  or scenario package** — never by editing an immutable installed package (plan
  §16.10).
- This depends on ADR-015/ADR-016: installations are content-addressed and
  deletion-restricted when pinned by a run (plan §5.5.9). Rollback is therefore
  "point at the old installation", not "rewrite the new one".
- Additive migrations mean rollback does not require destructive DB changes:
  new columns/tables simply go unused.

## Consequences

**Positive:**

- The repository stays buildable and the previous production path stays runnable
  at every phase boundary (plan §16.9).
- Each compatibility surface has a named deletion gate (§16.4–16.8), so Wave 13
  removal is a checklist, not an archaeology project.
- Rollback is cheap and safe: select previous bytes, leave additive schema in
  place.

**Negative:**

- Compatibility seams are debt that MUST be deleted on schedule. A seam that
  lingers past its deletion gate becomes a permanent fork (plan §3.13).
- The frozen tool names and migrations (plan §14.1.5;
  `COMPATIBILITY-INVENTORY.md`) constrain later waves: a public tool cannot be
  renamed until §16.7's alias + replay verification is done.
- Two sources of truth exist during each cutover window (old path + new path).
  Tests must cover both until the seam is deleted.

## Current state (frozen-commit `fd26fd1`)

- `COMPATIBILITY-INVENTORY.md` (this lane) tabulates the seven Wave 13 removal
  surfaces: public MCP tool names (90, pinned sorted list); persistence
  migrations (9 named functions in `src/db.ts` + the `backfillWorkItemShadow`
  import from `src/lifecycle/backfill-migration.ts`); the 37 tables in
  `src/schema.ts`; the composition-root seam; the hard-coded Discovery workflow
  strings; the `routeResolver` + cumulative-frame machinery; the built-in
  catalog + prefix resolver.
- `src/db.ts` runs `SCHEMA_SQL` (single large `CREATE TABLE IF NOT EXISTS` in
  `src/schema.ts`, 968 lines) then the migration chain. No `user_version`, no
  framework (baseline §"Where SQL lives").

## References

- Plan §3.13 (compatibility code in adapters, removed after migration)
- Plan §14.1.5 (freeze tool names + migrations as compatibility boundary)
- Plan §16.1 (additive migrations), §16.2 (mark legacy rows), §16.3 (one seam per subsystem)
- Plan §16.4–16.8 (deletion gates), §16.9 (always buildable), §16.10 (rollback selects)
- Plan §0.1.8 (one persistence owner per wave)
- Baseline §"Persistence & migrations", §"Where SQL lives", §"Cross-cutting refactor seams"
- `docs/architecture/COMPATIBILITY-INVENTORY.md`
- Related: ADR-015 (package identity), ADR-016 (scenario identity), ADR-017 (dependency direction), ADR-018 (envelopes), ADR-019 (protocol state), ADR-020 (tool ownership)
