/**
 * Formalization module registration (the LEGO contract).
 *
 * `registerFormalization(registries, sharedDeps)` constructs Formalization's
 * module-specific concrete adapters (artifact graph, baseline / solution-
 * contract repositories, ledger), registers its kernel handlers, builds its
 * `GenericFlowExecutor`, and registers the module definition + installation.
 * Called once from the composition root.
 *
 * The exact-candidate-acceptance adapter is a SHARED prerequisite (the kernel
 * executor needs it), so the composition root constructs it and passes it
 * through `sharedDeps.exactCandidateAcceptance` — this register consumes it.
 *
 * Returns the executor plus the module-specific repositories the composition
 * root's public return surface exposes.
 *
 * This file lives under `src/modules/` (the module-scoped tree); the SQLite-
 * substrate gates that cover `src/process-modules/modules/` do not apply here.
 */

import { GenericFlowExecutor } from '../../process-modules/application/generic-flow-executor.js';
import {
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} from './infrastructure/formalization-persistence.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from './infrastructure/sqlite-formalization-kernel.js';
import { SqliteManagedProductionLedger } from '../../process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteFormalizationBriefProvisioning } from '../../infrastructure/process-modules/brief-provisioning-ports.js';
import {
  createFormalizationKernelHandlers,
  createFormalizationOutputResolver,
} from '../../process-modules/modules/formalization/formalization-installation.js';
import { formalizationProcessModule } from '../../process-modules/modules/formalization/formalization-process-module.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../module-registration.js';

/**
 * Formalization-specific overrides. Currently none are exposed (the composition
 * root always wires the reference SQLite adapters); kept for signature
 * stability.
 */
export interface RegisterFormalizationOptions {
  // intentionally empty
}

/** Module-specific artifacts the composition root exposes on its return surface. */
export interface FormalizationRegistration {
  executor: GenericFlowExecutor;
  baselineRepository: SqliteFormalizationBaselineRepository;
  solutionContractRepository: SqliteFormalizationSolutionContractRepository;
}

/**
 * Register the Formalization Process Module. Mutates `registries` in place.
 */
export function registerFormalization(
  registries: ModuleRegistries,
  sharedDeps: ModuleSharedDeps,
  _options?: RegisterFormalizationOptions,
): FormalizationRegistration {
  const { db, certificateRepo, exactCandidateAcceptance } = sharedDeps;

  // Module-specific concrete adapters (composition owns construction).
  const baselineRepository = new SqliteFormalizationBaselineRepository(db);
  const solutionContractRepository = new SqliteFormalizationSolutionContractRepository(db);
  const graph = new SqliteFormalizationArtifactGraph(db);
  const ledger = new SqliteManagedProductionLedger(db);
  const briefProvisioning = new SqliteFormalizationBriefProvisioning(db);

  // Register kernel handlers.
  registries.kernelHandlers.registerAll(
    createFormalizationKernelHandlers({
      ledger,
      graph,
      baselineRepository,
      solutionContractRepository,
      settlementPolicy: new ReferenceFormalizationSettlementPolicy(),
      candidateAcceptance: exactCandidateAcceptance,
      briefProvisioning,
      // The formalization settlement kernel issues its own
      // ProcessOutcomeCertificate and emits an explicit ModuleCompletion.
      certificateRepo,
    }),
  );

  // Build the executor.
  const executor = new GenericFlowExecutor({
    moduleRef: formalizationProcessModule.identity,
    processRunRepo: sharedDeps.processRunRepo,
    nodeRunRepo: sharedDeps.nodeRunRepo,
    certificateRepo: sharedDeps.certificateRepo,
    nodeExecutors: sharedDeps.nodeExecutors,
    recoveryCaseRepo: sharedDeps.recoveryCaseRepo,
    resolveNodeProducts: sharedDeps.resolveNodeProducts,
    resolveOutput: createFormalizationOutputResolver(solutionContractRepository),
    v2: sharedDeps.executorV2Options,
  });

  // Register module definition + installation.
  registries.moduleRegistry.register(formalizationProcessModule);
  registries.installationRegistry.register({
    definition: formalizationProcessModule,
    executor,
  } as Parameters<typeof registries.installationRegistry.register>[0]);

  return { executor, baselineRepository, solutionContractRepository };
}
