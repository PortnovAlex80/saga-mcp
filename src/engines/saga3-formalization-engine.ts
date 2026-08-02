/**
 * Saga3FormalizationEngine — ONE-SHOT wrapper that mounts Formalization as a
 * runnable Process Module through the OrchestrationEngine port.
 *
 * CRITICAL (v2 correction #8): this is NOT a poll-loop. It does NOT cycle
 * looking for claimable tasks. It runs the settlement+certificate step EXACTLY
 * ONCE per invocation and returns. The formalization workers (saga-product,
 * saga-analyst, saga-architect, saga-reconciler) are driven by a SEPARATE
 * mechanism — saga2 orchestrate(), saga-dispatch, or a future saga3 formalization
 * pump. This engine only governs the ProcessRun + certificate lifecycle.
 *
 * Flow:
 *   run(command) =
 *     1. Find or create the ProcessRun for (project, epic, formalization module).
 *     2. Call LegacyFormalizationProcessAdapter.execute() once.
 *     3. Project the RunResult into OrchestrationRunResult.
 *
 * The terminal condition is whatever the adapter's settlement policy decides —
 * 'formalized' on success, 'clarification-required'/'inconsistent'/'failed' on
 * incomplete input. The engine never invents its own "no claimable tasks"
 * exit — that would re-implement the pump and defeat the SPI universality proof.
 */

import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { ProcessRunRepository } from '../process-modules/persistence/process-run-repository.js';
import type { ProcessOutcomeCertificateRepository } from '../process-modules/persistence/process-outcome-certificate-repository.js';
import type { ProcessModuleRunResult } from '../process-modules/application/process-module-executor.js';
import { LegacyFormalizationProcessAdapter } from '../process-modules/modules/formalization/legacy-formalization-process-adapter.js';
import {
  ReferenceFormalizationSettlementPolicy,
  SqliteFormalizationArtifactGraph,
} from '../infrastructure/process-modules/formalization/sqlite-formalization-kernel.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../process-modules/modules/formalization/formalization-schemas.js';
import { FORMALIZATION_CASE_SCHEMA } from '../process-modules/modules/formalization/formalization-schemas.js';
import { processModuleKey } from '../process-modules/domain/process-module.js';
import type Database from 'better-sqlite3';

export interface Saga3FormalizationEngineOptions {
  db: Database.Database;
  processRunRepo: ProcessRunRepository;
  certificateRepo: ProcessOutcomeCertificateRepository;
  /**
   * The FormalizationCase payload to use when starting a ProcessRun. In
   * production this comes from the discovery certificate of the upstream
   * episode; the engine receives it via the command's metadata or derives it.
   * For now we accept it as an option so the composition root can wire it.
   */
  resolveFormalizationCase: (command: RunEpisodeCommand) => {
    discoveryEpicId: number;
    formalizationEpicId: number;
    discoveryCertificateRef: string;
    discoveryCertificateHash: string;
    discoveryOutcome: string;
    initiatedBy: string;
  };
}

export class Saga3FormalizationEngine implements OrchestrationEngine {
  private readonly db: Database.Database;
  private readonly processRunRepo: ProcessRunRepository;
  private readonly certificateRepo: ProcessOutcomeCertificateRepository;
  private readonly resolveFormalizationCase: Saga3FormalizationEngineOptions['resolveFormalizationCase'];

  constructor(opts: Saga3FormalizationEngineOptions) {
    this.db = opts.db;
    this.processRunRepo = opts.processRunRepo;
    this.certificateRepo = opts.certificateRepo;
    this.resolveFormalizationCase = opts.resolveFormalizationCase;
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const { projectId, epicId } = command;
    const graph = new SqliteFormalizationArtifactGraph(this.db);
    const policy = new ReferenceFormalizationSettlementPolicy();
    const adapter = new LegacyFormalizationProcessAdapter({
      graph, policy,
      processRunRepo: this.processRunRepo,
      certificateRepo: this.certificateRepo,
    });

    // Resolve the formalization case from the command.
    const caseFields = this.resolveFormalizationCase(command);
    const casePayload = {
      schemaVersion: FORMALIZATION_CASE_SCHEMA,
      ...caseFields,
    };

    // Find or create the ProcessRun. Idempotent on (project, module, idempotency_key).
    const idempotencyKey = `formalization-epic-${epicId}`;
    const inputHash = await this.hashCase(casePayload);
    const startResult = this.processRunRepo.start({
      moduleRef: FORMALIZATION_PROCESS_MODULE_REF,
      executorKind: 'legacy-adapter',
      input: {
        schema: FORMALIZATION_CASE_SCHEMA,
        payload: casePayload,
        contentHash: inputHash,
      },
      projectedStage: 'formalization',
      // Legacy pre-Wave-2 path: not pinned to an installation (W3-A3, spec §6).
      installationId: null,
      packageDigest: null,
      invocationContext: {
        projectId,
        epicId,
        initiatedBy: caseFields.initiatedBy,
        idempotencyKey,
      },
    });
    const runId = startResult.record.id;

    // If the run is already terminal (re-execution), short-circuit with the
    // persisted outcome — the certificate is already issued.
    if (startResult.record.status === 'completed'
      || startResult.record.status === 'failed'
      || startResult.record.status === 'cancelled') {
      return this.projectPersistedResult(startResult.record, projectId, epicId);
    }

    // Run the settlement adapter exactly once.
    const runResult: ProcessModuleRunResult = await adapter.execute(
      // The adapter only uses _module for nothing in execute(); we pass undefined.
      undefined as never,
      {
        projectId,
        epicId,
        processRunId: runId,
        inputPayload: casePayload,
        inputHash,
        initiatedBy: caseFields.initiatedBy,
      },
    );

    return this.projectResult(runResult, projectId, epicId, 1);
  }

  private async hashCase(casePayload: unknown): Promise<string> {
    const { createHash } = await import('node:crypto');
    const { canonicalJson } = await import('../saga3/shared/discovery-canonical.js');
    return createHash('sha256').update(canonicalJson(casePayload)).digest('hex');
  }

  private projectResult(
    result: ProcessModuleRunResult,
    projectId: number,
    epicId: number,
    cycles: number,
  ): OrchestrationRunResult {
    const moduleRefKey = processModuleKey(FORMALIZATION_PROCESS_MODULE_REF);
    return {
      projectId,
      epicId,
      finalStage: 'formalization',
      endedAt: new Date().toISOString(),
      reason: result.outcome === 'failed' ? 'failed' : 'completed',
      cycles,
      lastError: result.outcome === 'failed' ? (result.raw?.error as string ?? null) : null,
      outcome: result.outcome,
      outcomeAuthority: 'none',
      processModule: {
        name: FORMALIZATION_PROCESS_MODULE_REF.name,
        version: FORMALIZATION_PROCESS_MODULE_REF.version,
        kind: 'formalization',
        ref: moduleRefKey,
      },
      processOutcome: {
        code: result.outcome,
        authority: result.authority,
        outputRef: result.output?.artifactRef ?? result.certificate?.certificateRef ?? null,
      },
    };
  }

  private projectPersistedResult(
    record: { status: string; localOutcome: string | null; outputRef: string | null; error: string | null },
    projectId: number,
    epicId: number,
  ): OrchestrationRunResult {
    return {
      projectId,
      epicId,
      finalStage: 'formalization',
      endedAt: new Date().toISOString(),
      reason: record.status === 'completed' ? 'completed' : 'stopped',
      cycles: 0,
      lastError: record.error,
      outcome: record.localOutcome ?? record.status,
      outcomeAuthority: 'none',
      processModule: {
        name: FORMALIZATION_PROCESS_MODULE_REF.name,
        version: FORMALIZATION_PROCESS_MODULE_REF.version,
        kind: 'formalization',
        ref: processModuleKey(FORMALIZATION_PROCESS_MODULE_REF),
      },
      processOutcome: {
        code: record.localOutcome ?? record.status,
        authority: null,
        outputRef: record.outputRef,
      },
    };
  }
}
