/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite adapter (`SqliteDevelopmentModuleStore`,
 * `ensureDevelopmentStoreSchema`) physically lives in
 * `src/infrastructure/process-modules/development/sqlite-development-settlement-state.ts`
 * after the Wave 7 hex extraction. This file remains ONLY as a re-export so
 * existing importers keep resolving. The implementation imports
 * `better-sqlite3` and declares the `Sqlite*` class — neither belongs inside
 * the module tree. A re-export is a pure pass-through: no better-sqlite3
 * import, no Sqlite class declaration, so it does not trip the
 * physical-placement ratchet (`tests/architecture/no-sqlite-in-modules.test.mjs`).
 *
 * New code MUST import directly from the infrastructure path.
 */
export {
  SqliteDevelopmentModuleStore,
  ensureDevelopmentStoreSchema,
} from '../../../infrastructure/process-modules/development/sqlite-development-settlement-state.js';
