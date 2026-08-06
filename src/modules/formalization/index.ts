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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { createSrsStructuralCheckProvider } from './application/srs-structural-check-provider.js';
import type { CheckProvider } from '../../process-modules/domain/workplace/gate.js';
import { SqliteFormalizationBriefProvisioning } from '../../infrastructure/process-modules/brief-provisioning-ports.js';
import {
  createFormalizationKernelHandlers,
  createFormalizationOutputResolver,
} from './application/formalization-installation.js';
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
  const { db, certificateRepo, exactCandidateAcceptance, candidateSetRepo, gateRepo } = sharedDeps;

  // Module-specific concrete adapters (composition owns construction).
  const baselineRepository = new SqliteFormalizationBaselineRepository(db);
  const solutionContractRepository = new SqliteFormalizationSolutionContractRepository(db);
  const graph = new SqliteFormalizationArtifactGraph(db);
  const ledger = new SqliteManagedProductionLedger(db);
  const briefProvisioning = new SqliteFormalizationBriefProvisioning(db);

  // Production Cell: SRS content reader + CheckProvider registry.
  // The content reader reads the SRS file from disk (same approach as the
  // SRS validator). The registry holds the SRS structural check provider.
  const srsContentReader = candidateSetRepo
    ? createDbSrsContentReader(db)
    : null;
  const checkProviderRegistry = srsContentReader
    ? createSrsCheckProviderRegistry(srsContentReader)
    : null;

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
      // Production Cell: CandidateSet + Gate repositories. Passed through
      // so the architecture handler can seal a CandidateSet and drive a
      // GateRun. Optional (feature-detect) — the handler checks availability
      // before using them, falling back to ExactCandidateAcceptance when not
      // wired (tests, unmigrated modules).
      candidateSetRepo: candidateSetRepo ?? null,
      gateRepo: gateRepo ?? null,
      checkProviderRegistry,
      srsContentReader,
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
    onWorkplaceVerified: sharedDeps.onWorkplaceVerified,
    adoptedNodeResults: sharedDeps.adoptedNodeResults,
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

// ---------------------------------------------------------------------------
// Production Cell: SRS content reader + CheckProvider registry helpers.
// ---------------------------------------------------------------------------

/**
 * Create a DB-backed SRS content reader. Reads the SRS artifact's file from
 * disk via project_repository.local_path + artifact.path, same approach as the
 * SRS submission validator. Returns null if the file cannot be read.
 */
function createDbSrsContentReader(db: import('better-sqlite3').Database): {
  readSrsContent(artifactRef: string): string | null;
} {
  return {
    readSrsContent(artifactRef: string): string | null {
      // Parse 'artifact:<id>' to get the artifact id.
      const match = artifactRef.match(/^artifact:(\d+)$/);
      if (!match) return null;
      const artifactId = Number(match[1]);
      const artifact = db.prepare(
        'SELECT path, project_repository_id FROM artifacts WHERE id=?',
      ).get(artifactId) as { path: string; project_repository_id: number } | undefined;
      if (!artifact) return null;
      const repo = db.prepare(
        'SELECT local_path FROM project_repositories WHERE id=?',
      ).get(artifact.project_repository_id) as { local_path: string } | undefined;
      if (!repo?.local_path) return null;
      try {
        const filePath = join(repo.local_path, artifact.path.split('#')[0]);
        if (!existsSync(filePath)) return null;
        return readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Create a CheckProvider registry with the SRS structural check provider
 * pre-registered. The registry is a simple Map keyed by providerId.
 */
function createSrsCheckProviderRegistry(contentReader: {
  readSrsContent(artifactRef: string): string | null;
}): { resolve(providerId: string): CheckProvider | null } {
  const provider = createSrsStructuralCheckProvider(contentReader);
  const registry = new Map<string, CheckProvider>([
    [provider.providerId, provider],
  ]);
  return {
    resolve(providerId: string) {
      return registry.get(providerId) ?? null;
    },
  };
}
