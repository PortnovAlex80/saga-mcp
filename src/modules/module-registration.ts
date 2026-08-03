/**
 * Shared types for module registration (the LEGO contract).
 *
 * Each Process Module exports a `register<Name>(registries, sharedDeps, ...)`
 * function. The composition root (`src/app/product-lifecycle-runtime.ts`)
 * constructs the shared deps ONCE, then calls the four register functions.
 * Adding a fifth module = one new register call, not 200 lines of wiring.
 *
 * # Why these types live here
 *
 * `src/modules/` is the module-scoped tree (each subdir = one module). The
 * shared registration contract crosses all four modules, so it lives at the
 * `src/modules/` root rather than inside any single module. This file imports
 * ONLY types (no runtime values) from `src/process-modules/` and `better-sqlite3`,
 * so it introduces no substrate coupling.
 *
 * # Shared prerequisites note
 *
 * Two values that look module-specific (`runtimePersistence` for Discovery,
 * `exactCandidateAcceptance` for Formalization) are constructed in the
 * composition root and passed via `ModuleSharedDeps` because the shared
 * `nodeExecutors` map (constructed once in the composition root) needs them:
 *   - the kernel executor takes `exactCandidateAcceptance`;
 *   - the LM executor takes `createDiscoveryLmNodePersistence(runtimePersistence)`.
 * Keeping `nodeExecutors` in the composition root (per the refactoring brief)
 * forces these two prerequisites up into the shared layer.
 */

import type Database from 'better-sqlite3';
import type { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import type { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import type { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import type { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { NodeExecutor, NodeProducts } from '../process-modules/application/node-executor.js';
import type { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import type { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import type { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import type { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';
import type { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import type { SqliteProcessProductRepository } from '../process-modules/persistence/sqlite-process-product-repository.js';
import type { SqliteExactCandidateAcceptance } from '../process-modules/persistence/sqlite-exact-candidate-acceptance.js';
import type { Saga3DiscoveryRuntimePersistence } from './discovery/infrastructure/saga3-discovery-runtime-port.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';
import type { WorkplaceProductPort } from '../process-modules/application/workplace-product-port.js';

/**
 * The four registries that register functions populate. Constructed once in
 * the composition root; the same instances are passed to every register call.
 */
export interface ModuleRegistries {
  kernelHandlers: KernelHandlerRegistry;
  humanInteractions: HumanInteractionRegistry;
  moduleRegistry: ProcessModuleRegistry;
  installationRegistry: ProcessModuleInstallationRegistry;
}

/**
 * The v2 executor product-resolver port. Bridged from
 * `SqliteProcessProductRepositoryV2` in the composition root and shared by all
 * four module executors. Declared as a structural type (not the concrete class)
 * because the composition root builds it inline with a NodeRun fallback.
 */
export interface AssemblerProductRepo {
  getByProductRef(ref: ProductRef): {
    productRef: { schemaId: string; ref: string; digest: string };
    payload: unknown;
  } | null;
}

/**
 * Shared deps constructed ONCE in the composition root and passed to every
 * register function. Each register function constructs only its OWN
 * module-specific adapters on top of these.
 */
export interface ModuleSharedDeps {
  readonly db: Database.Database;
  readonly processRunRepo: SqliteProcessRunRepository;
  readonly nodeRunRepo: SqliteNodeRunRepository;
  readonly certificateRepo: SqliteProcessOutcomeCertificateRepository;
  readonly recoveryCaseRepo: SqliteRecoveryCaseRepository;
  readonly managedNodeSubmissions: SqliteManagedNodeSubmissionRepository;
  /** Shared v1 process-product repo (Development reuses this instance). */
  readonly processProductRepo: SqliteProcessProductRepository;
  readonly nodeExecutors: ReadonlyMap<string, NodeExecutor>;
  readonly resolveNodeProducts: (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ) => NodeProducts | null;
  readonly executorV2Options: { productRepo: AssemblerProductRepo };

  // ---- Shared prerequisites (constructed in composition root because the
  // shared `nodeExecutors` map needs them; see file header). ----

  /** Discovery runtime persistence — needed by the shared LM executor. */
  readonly runtimePersistence: Saga3DiscoveryRuntimePersistence;
  /** Exact-candidate acceptance — needed by the shared kernel executor. */
  readonly exactCandidateAcceptance: SqliteExactCandidateAcceptance;

  /**
   * T8 — Universal cross-module product handoff port ("one desk for all
   * workshops"). Backed by the existing `saga3_process_products` table via
   * `SqliteWorkplaceProductAdapter`. Purely ADDITIVE: future module code MAY
   * use it for cross-module submit + read; existing submit tools and their
   * tables are unchanged. Optional so legacy/test paths that do not construct
   * the adapter keep working — modules should feature-detect before use.
   */
  readonly workplaceProductPort?: WorkplaceProductPort;
}
