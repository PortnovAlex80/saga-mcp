/**
 * LegacyFormalizationProcessAdapter — the THIN SHIM that makes Formalization
 * runnable through the ProcessModuleExecutor SPI.
 *
 * IMPORTANT (v2 correction #8): this is NOT a new poll-loop engine. The
 * formalization workers (saga-product, saga-analyst, saga-architect,
 * saga-reconciler) are driven by the existing saga2 formalization pump (or a
 * dispatch loop). This adapter is ONLY the settlement+certificate step:
 *
 *   execute() =
 *     1. Decode FormalizationCase from the context's input payload.
 *     2. Build a FormalizationSettlementInput from the accepted artifact graph.
 *     3. Run the deterministic settlement policy (pure function).
 *     4. Build the FormalizationCertificatePayload.
 *     5. Issue the generic ProcessOutcomeCertificate (write-once).
 *     6. Transition the ProcessRun to completed with outcome+certificate.
 *     7. Return ProcessModuleRunResult.
 *
 * Terminal condition = settlement policy decided + certificate issued. NOT
 * "no claimable tasks" — that would defeat the SPI universality (it would
 * re-implement the pump's exit condition). The adapter trusts that by the
 * time it is invoked, the formalization workers have produced their artifacts;
 * if they haven't, the settlement policy returns 'clarification-required' or
 * 'inconsistent' and the adapter emits that outcome faithfully.
 *
 * Composition: the Runtime calls this adapter via the ProcessModuleExecutor
 * interface. The pump that drives the workers is OUTSIDE the adapter — it can
 * be saga2 orchestrate(), saga-dispatch, or a future saga3 formalization
 * engine. The adapter doesn't know and doesn't care.
 */

import { createHash } from 'node:crypto';
// CONVEYOR Wave 7 — saga3 cross-tree leak elimination: canonicalJson is
// re-exported by the process-modules shared layer, so this module no longer
// reaches into src/saga3/shared/**. Both resolve to the same byte-identical
// implementation.
import { canonicalJson } from '../../shared/canonical-json.js';
import { processModuleKey } from '../../domain/process-module.js';
import type { ProcessRunRepository } from '../../persistence/process-run-repository.js';
import type { ProcessRunStatus } from '../../persistence/process-run.js';
import type {
  ProcessModuleExecutionContext,
  ProcessModuleExecutor,
  ProcessModuleRunResult,
} from '../../application/process-module-executor.js';
import {
  type ProcessModuleCertificateRef,
  type ProcessModuleOutput,
} from '../../persistence/process-run.js';
import type {
  ProcessOutcomeCertificateRepository,
} from '../../persistence/process-outcome-certificate-repository.js';
import {
  type FormalizationArtifactGraphPort,
  type FormalizationSettlementPolicyPort,
  buildFormalizationCertificatePayload,
} from './formalization-kernel-ports.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
  type FormalizationCase,
  type FormalizationSettlementInput,
  type SolutionContractBundle,
} from './formalization-schemas.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from './formalization-schemas.js';
import { assertTransitionAllowed } from '../../persistence/process-run-repository.js';

export interface LegacyFormalizationProcessAdapterOptions {
  /** Graph port — reads accepted artifacts + baseline + traces. */
  graph: FormalizationArtifactGraphPort;
  /** Settlement policy — deterministic decision over (graph, input). */
  policy: FormalizationSettlementPolicyPort;
  /** ProcessRun repository — the adapter transitions the run to terminal. */
  processRunRepo: ProcessRunRepository;
  /** Generic certificate repository — the adapter issues the certificate. */
  certificateRepo: ProcessOutcomeCertificateRepository;
}

export class LegacyFormalizationProcessAdapter implements ProcessModuleExecutor {
  readonly moduleRef = FORMALIZATION_PROCESS_MODULE_REF;
  readonly kind = 'legacy-adapter' as const;
  private readonly graph: FormalizationArtifactGraphPort;
  private readonly policy: FormalizationSettlementPolicyPort;
  private readonly processRunRepo: ProcessRunRepository;
  private readonly certificateRepo: ProcessOutcomeCertificateRepository;

  constructor(opts: LegacyFormalizationProcessAdapterOptions) {
    this.graph = opts.graph;
    this.policy = opts.policy;
    this.processRunRepo = opts.processRunRepo;
    this.certificateRepo = opts.certificateRepo;
  }

  async execute(
    _module: unknown,
    context: ProcessModuleExecutionContext,
  ): Promise<ProcessModuleRunResult> {
    // 1. Decode the FormalizationCase from the input payload.
    const casePayload = context.inputPayload as FormalizationCase;
    if (!casePayload || casePayload.schemaVersion !== FORMALIZATION_CASE_SCHEMA) {
      return this.failRun(context, `invalid FormalizationCase schemaVersion (expected ${FORMALIZATION_CASE_SCHEMA})`);
    }

    // 2. Build the settlement input from the artifact graph.
    const bundle = this.buildBundle(casePayload);
    const settlementInput: FormalizationSettlementInput = {
      schemaVersion: 'saga3.formalization-settlement-input.v1',
      formalizationEpicId: casePayload.formalizationEpicId,
      discoveryCertificateRef: casePayload.discoveryCertificateRef,
      discoveryCertificateHash: casePayload.discoveryCertificateHash,
      bundle,
    };

    // 3. Run the deterministic policy.
    const decision = this.policy.settle(this.graph, settlementInput);

    // 4. Build the certificate payload + hash.
    const certPayload = buildFormalizationCertificatePayload(decision, bundle, settlementInput);
    const certHash = createHash('sha256')
      .update(canonicalJson(certPayload))
      .digest('hex');

    // 5. Issue the generic ProcessOutcomeCertificate (write-once, idempotent on hash).
    const { record: certificate } = this.certificateRepo.issue({
      processRunId: context.processRunId,
      moduleRef: this.moduleRef,
      projectId: context.projectId,
      epicId: context.epicId,
      payload: {
        schemaVersion: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
        decision: certPayload.decision,
        reasonCodes: certPayload.reasonCodes,
        rationale: certPayload.rationale,
        inputHash: certPayload.inputHash,
        payload: certPayload,
      },
      certificateHash: certHash,
      authority: 'formalization_settlement_policy',
    });

    // 6. Transition the ProcessRun to completed with the outcome + certificate ref.
    const certificateRef: ProcessModuleCertificateRef = {
      schema: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
      certificateRef: `certificate:${certificate.id}`,
      certificateHash: certificate.certificateHash,
    };
    const output: ProcessModuleOutput | null = decision.decision === 'formalized'
      ? {
          schema: 'saga3.solution-contract-certificate.v1',
          artifactRef: `bundle:${bundle.bundleHash.slice(0, 16)}`,
          contentHash: bundle.bundleHash,
        }
      : null;

    this.driveToCompleted(context.processRunId, decision.decision, output, certificateRef);

    // 7. Return the RunResult.
    return {
      outcome: decision.decision,
      output,
      certificate: certificateRef,
      authority: 'formalization_settlement_policy',
      raw: { reasonCodes: decision.reasonCodes, rationale: decision.rationale },
    };
  }

  /**
   * Build the SolutionContractBundle from the accepted artifact graph.
   * The bundle hash is computed over the canonical JSON of the bundle (minus
   * the bundleHash field itself, which is filled in after).
   */
  private buildBundle(casePayload: FormalizationCase): SolutionContractBundle {
    const artifacts = this.graph.readAcceptedArtifacts(casePayload.formalizationEpicId);
    const baseline = this.graph.readAcceptanceBaselineHash(casePayload.formalizationEpicId);
    const partial = {
      schemaVersion: 'saga3.solution-contract-certificate.v1' as const,
      formalizationEpicId: casePayload.formalizationEpicId,
      prdArtifactId: artifacts.prd,
      frArtifactIds: artifacts.frs,
      nfrArtifactIds: artifacts.nfrs,
      ruleArtifactIds: artifacts.rules,
      ucArtifactIds: artifacts.ucs,
      acArtifactIds: artifacts.acs,
      acceptanceBaselineHash: baseline.hash,
      srsArtifactId: artifacts.srs,
    };
    const bundleHash = createHash('sha256')
      .update(canonicalJson(partial))
      .digest('hex');
    return { ...partial, bundleHash };
  }

  /**
   * Drive the ProcessRun through preparing → running → settling → completed.
   * Each transition is validated against ALLOWED_TRANSITIONS; a row that
   * started in 'created' goes through the full path, a row that was already
   * advanced just continues from where it is.
   */
  private driveToCompleted(
    processRunId: number,
    outcome: string,
    output: ProcessModuleOutput | null,
    certificate: ProcessModuleCertificateRef,
  ): void {
    const run = this.processRunRepo.read(processRunId);
    if (!run) throw new Error(`formalization adapter: process_run ${processRunId} not found`);

    const steps: ReadonlyArray<{ from: ProcessRunStatus; to: ProcessRunStatus }> = [
      { from: 'created', to: 'preparing' },
      { from: 'preparing', to: 'running' },
      { from: 'running', to: 'settling' },
      { from: 'settling', to: 'completed' },
    ];
    let current: ProcessRunStatus = run.status;
    for (const step of steps) {
      if (current === step.to) continue;
      if (current === step.from) {
        assertTransitionAllowed(current, step.to);
        const isTerminal = step.to === 'completed';
        const updated = this.processRunRepo.update(processRunId, {
          status: step.to,
          ...(isTerminal ? {
            localOutcome: outcome,
            output,
            certificate,
          } : {}),
        });
        current = updated.status;
      }
    }
    if (current !== 'completed') {
      throw new Error(
        `formalization adapter: could not drive process_run ${processRunId} to completed (stuck at ${current})`,
      );
    }
  }

  private async failRun(
    context: ProcessModuleExecutionContext,
    errorMessage: string,
  ): Promise<ProcessModuleRunResult> {
    // Infrastructure failure: transition the run to failed with the error.
    const run = this.processRunRepo.read(context.processRunId);
    if (run && run.status !== 'failed' && run.status !== 'completed' && run.status !== 'cancelled') {
      try {
        this.processRunRepo.update(context.processRunId, { status: 'failed', error: errorMessage });
      } catch {
        // best-effort; the RunResult already carries the failure
      }
    }
    return {
      outcome: 'failed',
      output: null,
      certificate: null,
      authority: null,
      raw: { error: errorMessage },
    };
  }
}

/**
 * Helper: compute the input_hash for a FormalizationCase (the caller of
 * process_run_start uses this to fill the input_hash field). The hash is over
 * the canonical JSON of the case payload — matches what the persistence layer
 * stores in input_snapshot.
 */
export function hashFormalizationCase(casePayload: FormalizationCase): string {
  return createHash('sha256').update(canonicalJson(casePayload)).digest('hex');
}

/**
 * Helper: the module ref key for Formalization, for ProcessRun lookups.
 */
export const FORMALIZATION_MODULE_REF_KEY = processModuleKey(FORMALIZATION_PROCESS_MODULE_REF);
