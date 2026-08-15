/**
 * Concrete Delivery-module port adapters (Wave 7 hex extraction).
 *
 * These are the infrastructure-side adapters for the Delivery module's
 * driver-neutral ports (delivery-kernel-ports: DeliveryProcessProductRepositoryPort,
 * DeliveryExternalEffectLedgerPort, ProcessRunSchemaEnsurePort). They keep the
 * concrete SQLite adapter imports (`SqliteProcessProductRepository`,
 * `SqliteExternalEffectLedger`, `ensureFactoryProcessRunSchema`) and the global
 * `getDb()` out of the Delivery module — the module speaks the port, this file
 * owns the concrete construction.
 *
 * Mirrors `git-machine-ports.ts` (the Development module's sibling adapters).
 * The composition root calls these factories and injects the resulting ports
 * into the Delivery runtime/approval-inbox constructors.
 */

import type Database from 'better-sqlite3';
import { ensureFactoryProcessRunSchema } from '../../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteExternalEffectLedger } from '../../process-modules/persistence/sqlite-external-effect-ledger.js';
import { SqliteProcessProductRepository } from '../../process-modules/persistence/sqlite-process-product-repository.js';
import type {
  DeliveryExternalEffectLedgerPort,
  DeliveryProcessProductRepositoryPort,
  ProcessRunSchemaEnsurePort,
} from '../../modules/delivery/domain/delivery-kernel-ports.js';

/**
 * Build a Delivery process-product repository port backed by the shared
 * `SqliteProcessProductRepository`. The module reads/writes its durable
 * preflight/approval/publication/observation products through this surface.
 */
export function createDeliveryProcessProductPort(
  db: Database.Database,
): DeliveryProcessProductRepositoryPort {
  return new SqliteProcessProductRepository(db);
}

/**
 * Build a Delivery external-effect ledger port backed by the shared
 * `SqliteExternalEffectLedger`. The module records publish/deploy action
 * execution results through this surface.
 */
export function createDeliveryExternalEffectLedgerPort(
  db: Database.Database,
): DeliveryExternalEffectLedgerPort {
  return new SqliteExternalEffectLedger(db);
}

/**
 * Build a ProcessRun schema-ensure port backed by
 * `ensureFactoryProcessRunSchema`. Guarantees the parent `factory_process_runs`
 * table exists before a module's own tables are created, without the module
 * importing the concrete SQLite repository.
 */
export function createProcessRunSchemaEnsurePort(): ProcessRunSchemaEnsurePort {
  return {
    ensure: (db: unknown) => {
      ensureFactoryProcessRunSchema(db as Database.Database);
    },
  };
}
