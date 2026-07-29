/**
 * W8-A6 — Formalization package ports barrel.
 *
 * Single import surface for the formalization package's port-injected path.
 * Plan §5.4.8 (`modules/<module-name>/ports`). Re-exports the port interfaces,
 * the handler adapter, and the SQLite-backed adapters so a consumer imports
 * from one place:
 *
 *   import {
 *     type FormalizationPackagePorts,
 *     createFormalizationPackageHandlerAdapter,
 *     buildSqliteFormalizationPackagePorts,
 *   } from '../ports/index.js';
 *
 * Purity: this barrel re-exports types AND values, but the only VALUE imports
 * are the handler adapter (which depends only on ports + the legacy handler
 * factory) and the SQLite adapters (the single Rule 2-allowlisted touch point).
 * Importers who only need the TYPES (`import type { … }`) incur no runtime
 * coupling to the substrate.
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

export {
  SqliteFormalizationBriefProvisioning,
  SqliteFormalizationManagedProduction,
  buildSqliteFormalizationPackagePorts,
} from './sqlite-formalization-package-adapters.js';
