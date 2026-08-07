/**
 * Shared registration contract for installable Process Modules.
 *
 * A module contributes declarations, kernel handlers, human interactions and
 * quality CheckProviders. The composition root owns the registries; modules
 * register by opaque ids and never change the runtime dispatcher/state machine.
 */

import type Database from 'better-sqlite3';
import type { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import type { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import type { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import type { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { NodeExecutor, NodeProducts } from '../process-modules/application/node-executor.js';
import type { FactoryCheckProviderRegistry } from '../process-modules/application/standard-check-providers.js';
import type { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import type { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import type { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import type { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';
import type { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import type { SqliteProcessProductRepository } from '../process-modules/persistence/sqlite-process-product-repository.js';
import type { SqliteExactCandidateAcceptance } from '../process-modules/persistence/sqlite-exact-candidate-acceptance.js';
import type { SqliteCandidateSetRepository } from '../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type { SqliteGateRepository } from '../infrastructure/workplace/sqlite-gate-repository.js';
import type { FactoryDiscoveryRuntimePersistence } from './discovery/infrastructure/discovery-runtime-port.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';
import type { WorkplaceProductPort } from '../process-modules/application/workplace-product-port.js';
import type { AdoptedNodeResultPort } from '../checkpoints/sqlite-resume-directive-repository.js';

export interface ModuleRegistries {
  kernelHandlers: KernelHandlerRegistry;
  humanInteractions: HumanInteractionRegistry;
  checkProviders: FactoryCheckProviderRegistry;
  moduleRegistry: ProcessModuleRegistry;
  installationRegistry: ProcessModuleInstallationRegistry;
}

export interface AssemblerProductRepo {
  getByProductRef(ref: ProductRef): {
    productRef: { schemaId: string; ref: string; digest: string };
    payload: unknown;
  } | null;
}

export interface ModuleSharedDeps {
  readonly db: Database.Database;
  readonly processRunRepo: SqliteProcessRunRepository;
  readonly nodeRunRepo: SqliteNodeRunRepository;
  readonly certificateRepo: SqliteProcessOutcomeCertificateRepository;
  /** Legacy FlowRecovery store. Removed once the last old module is cut over. */
  readonly recoveryCaseRepo: SqliteRecoveryCaseRepository;
  readonly managedNodeSubmissions: SqliteManagedNodeSubmissionRepository;
  readonly processProductRepo: SqliteProcessProductRepository;
  readonly nodeExecutors: ReadonlyMap<string, NodeExecutor>;
  readonly resolveNodeProducts: (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ) => NodeProducts | null;
  readonly executorV2Options: { productRepo: AssemblerProductRepo };
  readonly onWorkplaceVerified?: (
    processRunId: number,
    repairNodeId: string,
  ) => void;

  readonly runtimePersistence: FactoryDiscoveryRuntimePersistence;
  readonly exactCandidateAcceptance: SqliteExactCandidateAcceptance;
  /** Production Cell infrastructure is mandatory in the target factory. */
  readonly candidateSetRepo: SqliteCandidateSetRepository;
  readonly gateRepo: SqliteGateRepository;
  readonly workplaceProductPort: WorkplaceProductPort;
  readonly adoptedNodeResults?: AdoptedNodeResultPort;
}
