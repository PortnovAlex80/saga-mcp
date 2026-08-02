/**
 * W8-A6 — Formalization package ports barrel.
 *
 * Single import surface for the formalization package's port-injected path.
 * Plan §5.4.8 (`modules/<module-name>/ports`). Re-exports the port interfaces
 * and the handler adapter so a consumer imports substrate-free contracts and
 * the pure handler wiring from one place:
 *
 *   import {
 *     type FormalizationPackagePorts,
 *     createFormalizationPackageHandlerAdapter,
 *   } from '../ports/index.js';
 *
 * Purity: this barrel re-exports only port TYPES and the handler adapter (which
 * depends solely on ports + the legacy handler factory). It deliberately does
 * NOT re-export the concrete SQLite-backed adapters (`SqliteFormalizationBrief
 * Provisioning` / `SqliteFormalizationManagedProduction` /
 * `buildSqliteFormalizationPackagePorts`): those live in
 * `src/infrastructure/process-modules/formalization/package/sqlite-formalization-package-adapters.ts`
 * and must be imported directly from there. A module-tree barrel re-exporting
 * them would form a Rule 2 module→infrastructure edge (dependency-direction
 * ratchet, `tests/architecture/dependency-direction.test.mjs`). Importers who
 * only need the TYPES (`import type { … }`) incur no runtime coupling to the
 * substrate, and the barrel itself now incurs none either.
 */

export type {
  FormalizationBriefProvisioningContext,
  FormalizationBriefProvisioningOutcome,
  FormalizationBriefProvisioningPort,
  FormalizationManagedArtifactWrite,
  FormalizationManagedProductionPort,
  FormalizationManagedProductionQuery,
  FormalizationManagedTraceWrite,
  FormalizationPackagePorts,
  FormalizationPrdRootRead,
} from './formalization-package-ports.js';

export {
  createFormalizationPackageHandlerAdapter,
  createFakeBriefProvisioningPort,
  portInjectedEnsureBriefRoot,
  FORMALIZATION_PACKAGE_HANDLER_IDS,
  type FakeBriefProvisioningRecord,
  type FormalizationPackageHandlerAdapterOptions,
} from './handler-adapter.js';
