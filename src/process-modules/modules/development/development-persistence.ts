/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite adapter (`SqliteDevelopmentOutputRepository`,
 * `ensureDevelopmentPersistenceSchema`) physically lives in
 * `src/infrastructure/process-modules/development/development-persistence.ts`
 * after the Wave 7 hex extraction. This file remains ONLY as a re-export so
 * existing importers (sibling modules, tests, the composition root) keep
 * resolving without an edit on every file that touched the old path. The
 * implementation imports `better-sqlite3` and declares the `Sqlite*` class —
 * neither belongs inside the module tree (Wave 7 physical-placement gate,
 * `tests/architecture/no-sqlite-in-modules.test.mjs`). A re-export is a pure
 * pass-through: no better-sqlite3 import, no Sqlite class declaration, so it
 * does not trip the physical-placement ratchet.
 *
 * New code MUST import directly from the infrastructure path; this shim exists
 * for backwards compatibility during the parallel-agent refactor window.
 */
export {
  SqliteDevelopmentOutputRepository,
  ensureDevelopmentPersistenceSchema,
} from '../../../infrastructure/process-modules/development/development-persistence.js';
