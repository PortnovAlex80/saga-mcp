# ADR-015: Process Module Package Identity is name@semver + content digest

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.11, §5.5 (5.5.4–5.5.10), §14.1.2, §14.3 (Phase 2)

## Context

The current codebase has no durable notion of an installed package. The four
built-in Process Modules (`product-discovery@3.0.0`, `solution-formalization@1.0.0`,
`solution-development@1.0.0`, `delivery-release@1.0.0`) live as in-memory objects
constructed by `modules/catalog.ts` → `createBuiltInProcessModuleRegistry()` and
`modules/installations.ts` → `createBuiltInProcessModuleInstallationRegistry()`
(baseline §"Modules — `modules/`"). There is no `saga3_process_module_installations`
table — installations are an in-memory registry exercised only by
`tests/process-modules/process-module-installation.test.mjs` (baseline §"saga3_process_module_installations — does NOT exist").

This produces three observed problems that the refactor must close:

1. **Identity is `name@version` only.** Two builds of `product-discovery@3.0.0`
   with different Flow nodes, schema digests, or handler code are
   indistinguishable. Nothing rejects re-installing the same name+version with
   different bytes (plan §3.11, §5.5.8).
2. **Definition hash drops non-serializable fields.** `lifecycle-orchestrator.ts`
   silently drops `routeResolver` and other function resolvers when computing a
   definition hash (baseline §"Application layer"; plan §3.5). A hash that
   ignores executable closures cannot be a content identity.
3. **Resolution happens at stage-execution time, not at run start.** Installing a
   newer module while a LifecycleRun is in progress can alter later stages of
   that run (plan §6.7, baseline §"lifecycle-orchestrator.ts").

Plan §3.11 makes released package identity immutable; §5.5.8 requires rejecting a
different digest under an already released name+version; §5.5.9 forbids
`ON DELETE SET NULL` for installations pinned by a run. This ADR records the
decision before Wave 2 builds the content-addressed store and Wave 3 replaces the
in-memory catalog with an injected `PackageRegistry` (plan §14.3, §14.4).

## Decision

A **Process Module Package** is identified by a composite key:

```
package identity = (name, semantic version)   -- human/stable handle
                ⊕ content digest              -- canonical manifest + resource index
```

1. **`name@semver` is the human-facing stable handle.** It is what a Lifecycle
   Scenario selector references (plan §6.3.2) and what operators install. It is
   NOT, by itself, sufficient to execute a run.

2. **The content digest is computed over canonical JSON of the manifest plus the
   ordered resource index with per-resource hashes** (plan §5.5.3–5.5.4). The
   canonicalization MUST reject functions, Maps, Sets, class instances, undefined
   values, non-finite numbers, and non-enumerable behavior (plan §3.5, §14.2.3)
   — these are already a known defect of `routeResolver` and must not survive
   into the digest.

3. **Released identity is immutable.** In production mode, installing a different
   digest under an already-released `name@version` is rejected (plan §3.11,
   §5.5.8). Development mode must use a prerelease version suffix or an explicit
   build identity (plan §5.5.8).

4. **An `InstalledProcessModule` row pins `(name, version, digest, store location,
   manifest snapshot, dependency lock, handler versions)`** (plan §5.5.6). The
   dependency lock binds handler and policy identities to actual packaged code or
   deployment bundle digests — caller-declared version strings alone do not prove
   executable identity (plan §5.5.10).

5. **Stored bytes are verified against the digest before activation and replay**
   (plan §5.5.7). The store is content-addressed and copy-on-write; the same
   bytes always resolve to the same installation.

6. **Runs reference an installation, not a name+version.** A `ProcessRun` and
   every `StageRun` pin the installation identity (plan §9.3, §9.5). A pinned
   installation is deletion-restricted — `ON DELETE SET NULL` is forbidden for
   any installation referenced by a run (plan §5.5.9).

## Consequences

**Positive:**

- Two builds of the same `name@version` with different bytes are detectable and
  rejectable in production, closing the silent-drift failure mode.
- A LifecycleRun that pinned installation X continues to resolve X even after a
  newer Y is installed mid-run (plan §6.7).
- Rollback becomes "select the previous installation" — immutable bytes are never
  edited (plan §16.10; ADR-021).
- The dependency lock makes handler/policy identity provable, not asserted.

**Negative:**

- Wave 2 must add a content-addressed `ModulePackageStore` port + filesystem
  adapter and persist `saga3_process_module_installations` properly (plan §14.3,
  §9.1). Until then the current in-memory registry remains a prototype
  (plan §5.6).
- Version-collision rejection forces a discipline: dev builds must bump a
  prerelease tag or pass an explicit build identity (plan §5.5.8).
- Canonicalization must be hardened against `routeResolver`-style escapes BEFORE
  the digest is trusted (plan §3.5; tracked by W0-A1 dependency enforcement and
  Wave 1 SPI).

## Current state (frozen-commit `fd26fd1`)

- No `saga3_process_module_installations` table; installation is in-memory only.
- Catalog coupling concentrated in `modules/catalog.ts`,
  `modules/installations.ts`, `composition/product-lifecycle-runtime.ts`,
  `application/execution-profile-resolver.ts` (baseline §"Cross-cutting refactor
  seams"). These are the four seams Wave 3 breaks.
- `sqlite-managed-production-ledger.ts` is the closest existing prototype of a
  "package/installation store with digests" (keyed by processRunId/moduleRef/
  nodeId/intentId/taskId/executionId, tracks `contentHash`) — it can seed but
  does not satisfy the contract.

## References

- Plan §3.5 (no persisted function/closure), §3.11 (released identity immutable)
- Plan §5.5.3–5.5.10 (canonicalize, digest, content-addressed store, immutability)
- Plan §6.7 (LifecycleRun pins exact module lock at start)
- Plan §9.1, §9.3, §9.5 (persistence of installation identity)
- Plan §14.3 (Phase 2: immutable package installation), §14.4 (Phase 3: registries)
- Baseline §"Modules — `modules/`", §"saga3_process_module_installations — does NOT exist"
- Related: ADR-016 (Scenario identity), ADR-017 (dependency direction), ADR-021 (compatibility policy)
