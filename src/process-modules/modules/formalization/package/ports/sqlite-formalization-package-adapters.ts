/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite package adapters
 * (`SqliteFormalizationBriefProvisioning`,
 * `SqliteFormalizationManagedProduction`,
 * `buildSqliteFormalizationPackagePorts`) physically live in
 * `src/infrastructure/process-modules/formalization/package/sqlite-formalization-package-adapters.ts`
 * after the Wave 7 hex extraction. This file remains ONLY as a re-export so
 * existing importers (the formalization package index, tests) keep resolving.
 * The implementation imports `better-sqlite3` and declares the `Sqlite*`
 * classes — neither belongs inside the module tree. A re-export is a pure
 * pass-through: no better-sqlite3 import, no Sqlite class declaration, so it
 * does not trip the physical-placement ratchet
 * (`tests/architecture/no-sqlite-in-modules.test.mjs`).
 *
 * New code MUST import directly from the infrastructure path.
 */
export {
  SqliteFormalizationBriefProvisioning,
  SqliteFormalizationManagedProduction,
  buildSqliteFormalizationPackagePorts,
} from '../../../../../infrastructure/process-modules/formalization/package/sqlite-formalization-package-adapters.js';
