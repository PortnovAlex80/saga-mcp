# Wave 2 — Immutable Installation & Registries Frozen Contract Spec

> Frozen by the integrator (serial precondition, plan §0.5.2) on `15d931a` (Wave 1 checkpoint `6a349a2` + progress-log commit).
> This document is the contract every Wave 2 lane validates against. Workers
> MUST NOT change this spec; escalate ambiguities (§0.1.7).

## 0. Reconnaissance result (HEAD `15d931a`)

- **No installation/package persistence exists today.** `grep` for `saga3_process_module_installations` / `saga3_module_packages` over `src/` returns zero. Installations are an in-memory `Map` in `application/process-module-installation-registry.ts`.
- **`ProcessRunRecord`** (`persistence/process-run.ts:111-151`) carries `moduleRef: ProcessModuleReference` (`{name; version}`) but NO `installationId`, NO `packageDigest`. Same for `saga3_process_runs` table and `StartProcessModuleCommand`. Wave 2 ADDS both (additive schema).
- **`EXECUTOR_KINDS`** = `['legacy-adapter','generic-flow','external','human']`. Unchanged by Wave 2.
- **Composition root** (`composition/product-lifecycle-runtime.ts:361-374`) hard-binds 4 `{definition, executor}` pairs at startup via `createBuiltInProcessModuleInstallationRegistry`. All its edges into `modules/*` + `sqlite-*` are grandfathered under Rule 6 of the ratchet with reason `compositionCutover` (Wave 11).
- **Wave 1 SPI barrel** (`domain/spi/index.ts`) exports: `ProcessModuleManifest`, `ResourceIndexEntry`, `ResourceKind`, `HandlerRef`, `ContractRef`, `computeContractRefDigest`, `validateProcessModuleManifest`, `adaptLegacyProcessModule`, `LEGACY_MANIFEST_FORMAT_VERSION`, plus `assertCanonicalSerializable` etc. Wave 2 builds on these — does NOT redefine them.
- **Ratchet rules** (plan §3, dep-graph scanner): Rule 2 forbids `modules/*` from importing sqlite adapters / `db.ts` / `schema.ts` / anything outside `src/process-modules/`; Rule 5 forbids `domain/*` from importing `application/`/`persistence/`/`composition/`/`modules/`; Rule 6 allowlists composition-root smells for Wave 11.

## 1. New files (frozen layout)

Wave 2 introduces a **new `installation/` subdir** under `src/process-modules/` (sibling to `domain/`, `application/`, `persistence/`, `composition/`). This is the home for the immutable-package + registry layer. Ownership:

| File | Owner | Contents |
|---|---|---|
| `installation/domain/package-store.ts` | W2-A1 | `ModulePackageStore` PORT (interface) + pure value types: `StoredModulePackage { manifest: ProcessModuleManifest; resources: readonly ResourceBlob[]; packageDigest: string; storedAt: string }`, `ResourceBlob { logicalId; kind; bytes: Uint8Array; digest }`, `PackageStoreError`. |
| `installation/adapters/filesystem-package-store.ts` | W2-A1 | `FilesystemModulePackageStore implements ModulePackageStore` — content-addressed: writes each package to `<root>/<packageDigest-prefix>/<packageDigest>/` with `manifest.json` (canonical) + `resources/<logicalId>` blobs. Reads verify stored digest. Rejects path traversal. |
| `installation/domain/installation.ts` | W2-A2 | Pure value types: `ModuleInstallationRecord { id; packageDigest; manifestSnapshot: ProcessModuleManifest; storeLocation; resourceIndex; handlerRefs; dependencyLock; status: 'staged'|'validated'|'active'|'retired'|'corrupt'; installedAt; activatedAt }`, `ModuleInstallationId` (branded string/number). **Single source of truth for "what is installed".** |
| `installation/persistence/installation-repository.ts` | W2-A2 (SQL OWNER) | `ModuleInstallationRepository` PORT + `SqliteModuleInstallationRepository` adapter. Creates `saga3_module_installations` table (ADDITIVE — see §3). Methods: `insert`, `getById`, `getByPackageDigest`, `activate`, `retire`, `markCorrupt`, `listActive`. Enforces version immutability (UNIQUE on `name`+`version`+`status='active'` semantics) + deletion restriction (NO `ON DELETE SET NULL` — plan §5.5.9). |
| `installation/domain/installer.ts` | W2-A3 | `PackageInstaller` service (port + default impl). `install(manifest, resources, opts): ModuleInstallationRecord` — orchestrates: validate manifest → resolve resources → compute dependency lock → compute package digest → store bytes atomically → persist installation record → verify stored bytes → activate. Detects corruption, version collision, replay drift. |
| `installation/domain/dependency-lock.ts` | W2-A3 | `DependencyLock` pure type + `computeDependencyLock(manifest, contractRegistry)` — resolves every `ContractRef` / `HandlerRef` / `ResourceIndexEntry` reference to a digest; produces an immutable lock document. |
| `installation/domain/process-run-pinning.ts` | W2-A4 | `PinnedInstallation` pure type + `pinInstallationOnProcessRun(...)` value builder. The ProcessRun-pinning concern lives here; the actual schema ALTER is in W2-A2's SQL (single writer). |
| `installation/persistence/process-run-installation-adapter.ts` | W2-A4 | `ProcessRunInstallationAdapter` — reads/writes the new `installation_id`/`package_digest` columns on `saga3_process_runs` via the existing `SqliteProcessRunRepository` (DOES NOT create a new table — uses the ALTER W2-A2 applied). Includes the **legacy nullable adapter** (plan §14.3.7) so pre-Wave-2 runs still resolve. |
| `installation/domain/package-registry.ts` | W2-A5 | `PackageRegistry` PORT + `InstallationBasedPackageRegistry` adapter (replaces built-in catalog lookups, plan §14.4.1). `select(selector): ModuleInstallationRecord`, `registerInstallation(record)`, `listSelectors`. Looks up by `ModuleSelector {name; versionRange}` → exact active installation. NO module-name switching. |
| `installation/domain/registries.ts` | W2-A6 | Ports for the generic registries (plan §14.4.2): `HandlerRegistry`, `CapabilityRegistry`, `ModuleToolRegistry`, `SchemaRegistry` (= the Wave 1 `ContractSchemaRegistry` — re-export, don't redefine), `GuardRegistry`, `AgentDriverRegistry`. Each is a PORT (interface) + in-memory adapter. Bind handler FACTORIES through `ProcessModulePlugin` at composition time (plan §14.4.3). |
| `installation/domain/plugin.ts` | W2-A6 | `ProcessModulePlugin` pure interface — `{ installationId; handlerFactories: Readonly<Record<string, HandlerFactory>>; adapterFactories; capabilityProviders }`. The composition-root-facing binding contract. |
| `installation/domain/installation-binding.ts` | W2-A6 | `InstalledProcessModule` — binds an immutable `ModuleInstallationRecord` to resolved handler/tool/schema/protocol/resource registrations (plan §5.1.3). Pure value object (no live executor — that's composition root's job). |
| `installation/tests-fixtures/` (under `tests/`) | W2-A7 | Isolated test fixtures: a 3rd synthetic module package (proves "install without central catalog edit", plan §0.5.12 / §14.4.7), plus a resource-traversal test fixture, a hash-mismatch fixture, a version-collision fixture. |
| `installation/domain/describe.ts` | W2-A7 | `describeInstallation(record): InstallationDescription` — read-only generated description (plan §12.1): contracts, flow, resources, capabilities, tools, outcomes, recovery paths. Pure projection from the persisted record. |
| `installation/index.ts` (barrel) | W2-A8 | Re-exports the Wave 2 surface. |
| `tests/installation/**/*.test.mjs` | lanes own their tests | Each lane's tests live under `tests/installation/`. |

**Critically**: Wave 2 does NOT yet wire installations into the live execution path. The composition root (`product-lifecycle-runtime.ts`) is touched ONLY to add a NEW code path that builds installations alongside the legacy in-memory registry — the legacy path stays the default until Wave 11 cutover (plan §16.9). No production behavior changes for existing runs.

## 2. Ports vs adapters (plan §4.3, §4.4)

Every persistence/filesystem touch is behind a PORT defined in `installation/domain/`. The sqlite/filesystem implementations live in `installation/adapters/` or `installation/persistence/`. This keeps `domain/` pure (Rule 5) and lets Wave 13 swap adapters without touching domain.

- `ModulePackageStore` (port) ← `FilesystemModulePackageStore` (adapter)
- `ModuleInstallationRepository` (port) ← `SqliteModuleInstallationRepository` (adapter)
- `PackageRegistry` (port) ← `InstallationBasedPackageRegistry` (adapter)
- `HandlerRegistry`, `CapabilityRegistry`, `ModuleToolRegistry`, `GuardRegistry`, `AgentDriverRegistry` (ports) ← in-memory adapters
- `ContractSchemaRegistry` (port, Wave 1) ← `InMemoryContractSchemaRegistry` (Wave 1)

## 3. Schema changes (single SQL owner = W2-A2, plan §0.5.2, C083)

**ADDITIVE only** (plan §16.1). W2-A2 reserves migration numbering and owns:

1. **NEW table `saga3_module_installations`** (created via `ensureSaga3ModuleInstallationSchema(db)` in `installation/persistence/installation-repository.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS saga3_module_installations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     package_digest TEXT NOT NULL,           -- sha256Hex of canonical manifest+resources
     manifest_snapshot TEXT NOT NULL,        -- canonical JSON of ProcessModuleManifest
     store_location TEXT NOT NULL,           -- content-addressed path
     resource_index TEXT NOT NULL,           -- canonical JSON of ResourceIndexEntry[]
     handler_refs TEXT NOT NULL,             -- canonical JSON of HandlerRef[]
     dependency_lock TEXT NOT NULL,          -- canonical JSON of DependencyLock
     status TEXT NOT NULL DEFAULT 'staged',  -- staged|validated|active|retired|corrupt
     installed_at TEXT NOT NULL,
     activated_at TEXT,
     retired_at TEXT
   );
   CREATE UNIQUE INDEX idx_saga3_module_installations_active
     ON saga3_module_installations(name, version) WHERE status = 'active';  -- version immutability
   CREATE INDEX idx_saga3_module_installations_digest ON saga3_module_installations(package_digest);
   ```
   **NO `ON DELETE SET NULL`** (plan §5.5.9). Installations referenced by runs are deletion-restricted.

2. **ALTER `saga3_process_runs`** (additive, nullable for legacy — plan §14.3.7):
   ```sql
   ALTER TABLE saga3_process_runs ADD COLUMN installation_id INTEGER;      -- references saga3_module_installations.id
   ALTER TABLE saga3_process_runs ADD COLUMN package_digest TEXT;          -- denormalized for replay verification
   ```
   Both nullable. The legacy nullable adapter (W2-A4) resolves `null` → fall back to in-memory registry. New Wave-2+ runs MUST set both (enforced in application code, not schema, until Wave 11 hardens the NOT NULL).

3. **ALTER `saga3_lifecycle_runs`** + **`saga3_stage_runs`** — Wave 2 does NOT touch these. Scenario installation is Wave 7 (plan §6.6). Wave 2 only pins MODULE installation.

**Migration wiring**: W2-A2 adds an idempotent `ensureSaga3ModuleInstallationSchema(db)` call into `db.ts` `getDb()` chain (one line, AFTER existing migrations). W2-A2 ALSO adds the two ALTERs as idempotent `try { ALTER } catch {}` blocks in `db.ts` (matching the existing pattern, baseline §db.ts). **W2-A2 is the ONLY lane that edits `src/db.ts` this wave** (C083).

## 4. Identity rules (frozen, plan §3.11, §3.12, §5.5.8)

- **Released package identity is immutable.** `(name, version)` with `status='active'` is UNIQUE. Installing a different `package_digest` under the same `(name, version)` while an active installation exists → REJECTED with `MODULE_INSTALLATION_VERSION_COLLISION`. Development mode MUST use a prerelease version (e.g. `0.0.0-dev.<build>`) or explicit build identity (plan §5.5.8).
- **`package_digest` = `sha256Hex` of canonical JSON of `{ manifest, resourceIndex, resourceDigests }`.** Computed by W2-A3's `computePackageDigest`. Stable across runs (uses Wave 1 `canonicalJson`).
- **Every ProcessRun (new) MUST pin `installation_id` + `package_digest`.** Legacy runs (pre-Wave-2) have both NULL and route through the legacy adapter (W2-A4). Application code that starts a new ProcessRun MUST set both (Wave 3 enforces; Wave 2 only provides the mechanism).
- **Replay verification**: reading an installation MUST re-hash stored bytes and compare to `package_digest`. Mismatch → `MODULE_INSTALLATION_CORRUPT` + status flips to `corrupt` (plan §5.5.7, §9.2).

## 5. What Wave 2 does NOT do (anti-scope)

- **No scenario installation / scenario lock** (Wave 7).
- **No live execution-path cutover** — composition root keeps the legacy in-memory registry as default; Wave 2 only ADDS the installation layer alongside (plan §16.9). No existing run's behavior changes.
- **No `NOT NULL` enforcement on `installation_id`** in schema (Wave 11 hardens after cutover).
- **No removal of the built-in catalog** (`modules/catalog.ts`, `modules/installations.ts`) — they stay until Wave 13 (plan §16.7).
- **No module migration** — production modules (discovery/formalization/development/delivery) stay on the legacy in-memory path. Wave 2 proves the installation layer works using SYNTHETIC fixtures (W0-A7) + a new 3rd synthetic package (W2-A7).
- **No edits to `domain/spi/*`** (Wave 1 frozen). Wave 2 imports from the barrel.
- **No edits to existing `persistence/sqlite-process-run-repository.ts`** — W2-A4's adapter reads the new columns via raw SQL through the existing connection, NOT by editing the existing repository file (avoids Rule 6 / hot-file conflicts). Single SQL owner (W2-A2) owns the ALTERs.

## 6. Exit gate (plan §0.5.12 serial gate)

Wave 2 closes when ALL hold:
1. `npm run build` green.
2. A synthetic package installs into `FilesystemModulePackageStore` + `SqliteModuleInstallationRepository`; its bytes are immutable; mutating the source files after install does NOT change the stored package (plan §14.3.8 exit gate).
3. Installing a different digest under an already-active `(name, version)` → REJECTED (version immutability).
4. A ProcessRun pinned to an installation cannot be nullified (the legacy adapter resolves NULL but new runs set both fields).
5. A 3rd synthetic module installs WITHOUT editing Runtime source, the central catalog, or another module (plan §14.4.7).
6. Replay-after-source-mutation test PASSES (plan §0.5.12): installed bytes replay identically.
7. Dependency lock resolves every ContractRef/HandlerRef/ResourceIndexEntry to a digest.
8. Ratchet W0-A1 stays GREEN (73 allowlisted unchanged OR fewer — Wave 2 may SHRINK the allowlist if it replaces a catalog import, but must not ADD composition-root violations beyond documented Wave 11 entries).
9. Wave 0 + Wave 1 regression suites stay GREEN.

## 7. Test command (the wave gate)

```bash
npm run build
node --test tests/installation/**/*.test.mjs
node --test tests/spi/**/*.test.mjs                    # Wave 1 regression
node --test tests/architecture/dependency-direction.test.mjs   # ratchet
node --test tests/characterization/saga2-runtime-contracts.test.mjs  # Wave 0 regression
```

## 8. Integration order (integrator, serial)

1. W2-A2 (SQL owner — tables/ALTERs must exist before any other lane reads them).
2. W2-A1 (store — installer writes to it).
3. W2-A3 (installer + dependency lock — depends on store + installation repository).
4. W2-A5 (package registry — depends on installation records).
5. W2-A6 (generic registries + plugin + installation binding — depends on installation records).
6. W2-A4 (ProcessRun pinning + legacy adapter — depends on installation repository + the ALTERs).
7. W2-A7 (3rd synthetic fixture + describe — depends on installer).
8. W2-A8 (barrel + cross-cutting conformance).
Run gate after each pick. Create checkpoint `refactor(wave-2): immutable installation checkpoint`.

## 9. Notes for workers

- Read this spec IN FULL. Read `01-CODEBASE-BASELINE.md` §"Persistence & migrations" and the Wave 1 barrel (`domain/spi/index.ts`).
- Every persistence/filesystem touch goes through a PORT in `installation/domain/`. The sqlite/filesystem impl lives in `installation/persistence/` or `installation/adapters/`. NEVER import `sqlite-*` or `db.ts` from `installation/domain/*` (Rule 5).
- The composition root (`product-lifecycle-runtime.ts`) is a HOT FILE (plan §0.2.4). Wave 2 touches it ONLY to add a parallel installation-building path; the integrator does this single edit at checkpoint (C084), NOT individual lanes. Lanes expose their services via the barrel; the integrator wires.
- W2-A2 is the single SQL writer (C083). Other lanes that need a schema change STOP and request it through W2-A2 (escalate, §0.1.7).
- Use `process.env.DB_PATH = mkdtempSync(...)` in tests (existing pattern) — never share a DB across tests.
