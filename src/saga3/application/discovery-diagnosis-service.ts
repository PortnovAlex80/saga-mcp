/**
 * DiscoveryDiagnosisService — the kernel application layer that EXPLAINS an
 * already-issued authoritative DiscoveryOutcomeCertificate (roadmap D5).
 *
 * Core principle:
 *
 *   LM proposes. Advisor assesses. Kernel settles. Certificate proves.
 *   Diagnosis explains.
 *
 * D5 is ADVISORY ONLY (invariant I2). The diagnosis service can never change
 * the outcome, the certificate, the settlement, the stage, or any authoritative
 * field. It builds a deterministic DiagnosisCase in the kernel, runs a bounded
 * diagnosis worker, validates the worker's report deterministically, and
 * persists an accepted/rejected report. Diagnosis failure is isolated (I5): a
 * failed/invalid diagnosis NEVER invalidates a completed D4 result.
 *
 * The service depends only on the runtime persistence port (Phase B boundary:
 * no direct DB handle, no inline SQL, no WorkerExecutorFactory import in THIS
 * file's contract — the implementation may inject a worker spawn dependency
 * via the readiness-style service pattern, but the service itself never touches
 * the DB handle). The implementation is provided by
 * `Saga3DiscoveryDiagnosisService` (Stage 3 implementation file, separate from
 * this interface declaration).
 */
import type { Saga2HostRuntime } from '../../application/ports/saga2-host-runtime.js';
import type {
  AssignedWork,
  WorkerExecutorFactory,
  WorkAssignmentPort,
} from '../../application/ports/worker-executor.js';
import type { IdGeneratorPort } from '../../application/ports/conveyor-ports.js';
import type { SagaRuntimeConfig } from '../../runtime/saga-runtime-config.js';
import type { Saga3DiscoveryRuntimePersistence } from '../persistence/saga3-discovery-runtime-port.js';

/** What the engine passes to the diagnosis service. */
export interface DiagnoseRequest {
  projectId: number;
  epicId: number;
  /** The exact certificate to diagnose (from settlement.status=issued). */
  certificateId: number;
  certificateHash: string;
  /** Workspace root for the worker executor (unused in the no-spawn reuse path). */
  workspaceRoot: string;
  /** Heartbeat sink (mirrors the readiness/settlement service signatures). */
  heartbeat: (event: string, message: string) => void;
}

/**
 * The advisory diagnosis result projected into the engine's `diagnosis` section.
 * A DISCRIMINATED UNION on `status`:
 *   - 'completed': an accepted_by_kernel report exists; reportId/reportHash
 *     non-null; authority 'advisory_diagnosis'.
 *   - 'failed': the worker crashed, the payload was rejected, or recovery
 *     failed; error non-null; authority 'none'. The D4 result stays COMPLETE.
 *   - 'paused': the worker was interrupted; restart resumes it; authority 'none'.
 *   - 'not_run': no D4 certificate to diagnose; authority 'none'.
 *
 * authority is 'advisory_diagnosis' ONLY on 'completed' — never 'kernel_policy'
 * or 'discovery_settlement_policy' (invariant I2).
 */
export type DiscoveryDiagnosisResult =
  | {
      status: 'completed';
      authority: 'advisory_diagnosis';
      reportId: number;
      reportHash: string;
      target: { certificateId: number; certificateHash: string };
      summary: string;
      primaryCauses: string[];
      blockingGaps: string[];
      recommendedActions: string[];
      error: null;
    }
  | {
      status: 'failed' | 'paused';
      authority: 'none';
      reportId: number | null;
      reportHash: string | null;
      target: { certificateId: number; certificateHash: string };
      summary: null;
      primaryCauses: never[];
      blockingGaps: never[];
      recommendedActions: never[];
      error: string;
    }
  | {
      status: 'not_run';
      authority: 'none';
      reportId: null;
      reportHash: null;
      target: { certificateId: null; certificateHash: null };
      summary: null;
      primaryCauses: never[];
      blockingGaps: never[];
      recommendedActions: never[];
      error: null;
    };

export interface DiscoveryDiagnosisService {
  diagnose(request: DiagnoseRequest): Promise<DiscoveryDiagnosisResult>;
}

/**
 * Dependencies for the Saga3DiscoveryDiagnosisService implementation. The
 * implementation is in this file too (below), but the worker-spawn dependency
 * is injected so tests can substitute a fake. In production (composition-root)
 * the real executor factory is supplied.
 */
export interface Saga3DiscoveryDiagnosisServiceDependencies {
  config: SagaRuntimeConfig;
  workerExecutorFactory: WorkerExecutorFactory;
  host: Saga2HostRuntime;
  runtimePersistence: Saga3DiscoveryRuntimePersistence;
  /** Single authority for selecting and fencing the projected card. */
  workAssignment: WorkAssignmentPort;
  /** Infrastructure identity source for workerExecutionId / workerId / runId. */
  idGenerator: IdGeneratorPort;
  /** Stable identity of the host that owns the worker execution. */
  machineId: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxRunSeconds?: number;
  pollMs?: number;
}

// ===========================================================================
// Saga3DiscoveryDiagnosisService — Stage 3 implementation (roadmap D5 §11).
// ===========================================================================
//
// Mirrors the D4 settlement-service VERIFICATION discipline (exact-id load,
// hash + lineage verify, snapshot re-derivation) and the D3 readiness-service
// BOUNDED WORKER LIFECYCLE (ensureControl → prepareIntentForExecution →
// restart-resume early-exit → executor spawn → terminal-detection loop →
// CAS conclude/pause). The diagnosis is ADVISORY: every code path that can
// throw is wrapped so the D4 result stays COMPLETE (invariant I5). The only
// top-level surface this service mutates is the advisory `diagnosis` section
// the engine projects — never outcome/outcomeAuthority/scopeCompleted/reason/
// finalStage (invariant I1).

import type { OutcomeCertificateRecord, SettlementRecord } from '../domain/discovery-settlement-records.js';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';
import type { ReadinessAssessmentPayload } from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  buildDiagnosisCase,
  diagnosisCaseHash,
  type BuildDiagnosisCaseInput,
  type DiagnosisCertificateRef,
  type DiagnosisProposalRef,
  type DiagnosisReadinessRef,
} from '../domain/discovery-diagnosis-case.js';
import {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  hashDiagnosisReport,
} from '../domain/discovery-diagnosis-report.js';
import { validateDiagnosisReport } from '../domain/discovery-diagnosis-validator.js';
import type {
  DiscoveryDiagnosisCase,
  DiagnosisDecision,
} from '../domain/discovery-diagnosis-case.js';
import type { DiagnosisControlExecution, DiagnosisReportRecord } from '../domain/discovery-diagnosis-records.js';
import type { SettlementProposalRecord } from '../persistence/saga3-discovery-runtime-port.js';
import { discoverySettlementPolicyV1 } from '../domain/discovery-settlement-policy.js';
import { canonicalJson } from '../shared/discovery-canonical.js';
// P0-3: the diagnosis target gate now calls the SAME full verifier D4 uses, so
// D5 no longer maintains a weaker independent copy of the certificate /
// settlement / snapshot / readiness verification. The bundle returns every
// verified input the DiagnosisCase is built from.
import {
  verifyDiscoveryCertificateBundle,
  type VerifiedCertificateBundle,
} from './discovery-certificate-bundle.js';
import {
  assignOneCard,
  releaseOneCardIfAssigned,
} from './assign-one-card.js';

/**
 * Thrown when the diagnosis target cannot be verified (missing certificate,
 * hash mismatch, settlement/certificate drift, corrupted snapshot). Because D5
 * is advisory, the service CATCHES this and returns status='failed' — the D4
 * result stays COMPLETE (invariant I5). It is exported so tests/the engine can
 * classify the failure.
 */
export class DiagnosisTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagnosisTargetError';
  }
}

/**
 * Saga 3 implementation. Orchestrates the advisory diagnosis worker over the
 * runtime persistence port. Stateless beyond its injected dependencies.
 */
export class Saga3DiscoveryDiagnosisService implements DiscoveryDiagnosisService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRunMs: number;
  private readonly pollMs: number;

  constructor(private readonly deps: Saga3DiscoveryDiagnosisServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    // Diagnosis is the most text-heavy stage (executive_summary + 4 causes
    // + 3 info_requests + 3 actions + 3 residual_risks). The previous 10-min
    // default was too tight for weaker LM models (qwen3.6-27b@q4_k_xl hit
    // timeout on epic 31 after filling the report but before calling
    // diagnosis_submit). Align with the engine's own 30-min default so the
    // inner service does not time out before the outer engine.
    this.maxRunMs = (deps.maxRunSeconds ?? 60 * 30) * 1000;
    this.pollMs = deps.pollMs ?? 3000;
  }

  async diagnose(request: DiagnoseRequest): Promise<DiscoveryDiagnosisResult> {
    const { runtimePersistence: rt } = this.deps;

    // -----------------------------------------------------------------------
    // TARGET VERIFICATION (kernel-only, mirrors D4 settlement verification).
    // Every failure here is caught and returned as status='failed' with the
    // D4 result untouched (invariant I5). We do NOT throw to the engine.
    // -----------------------------------------------------------------------
    let target: VerifiedTarget;
    try {
      target = this.verifyDiagnosisTarget(rt, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.heartbeat('DIAGNOSIS_FAILED', `target verification failed: ${message}`);
      return failedResult(request.certificateId, request.certificateHash, message);
    }

    // Build the immutable DiagnosisCase + its hash (deterministic; captured_at
    // excluded from the hash so restart is idempotent — invariant I7).
    const caseData = buildDiagnosisCase(target.caseInput);
    const caseHash = diagnosisCaseHash(caseData);
    const caseText = canonicalJson(caseData);

    // -----------------------------------------------------------------------
    // IDEMPOTENT CONTROL (one ControlIntent per immutable certificate target).
    // -----------------------------------------------------------------------
    let control: DiagnosisControlExecution;
    try {
      control = rt.ensureDiagnosisControl({
        epicId: request.epicId,
        projectId: request.projectId,
        certificateId: request.certificateId,
        certificateHash: request.certificateHash,
        settlementId: target.settlement.id,
        settlementInputHash: target.settlement.input_hash,
        sourceIntentId: target.proposalRow.intent_id,
        objective: target.epicObjective,
        diagnosisCase: caseText,
        diagnosisCaseHash: caseHash,
        diagnosisContractVersion: DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.heartbeat('DIAGNOSIS_FAILED', `control ensure failed: ${message}`);
      return failedResult(request.certificateId, request.certificateHash, message);
    }

    // -----------------------------------------------------------------------
    // RESTART-RESUME (invariant I7): if an accepted report already exists for
    // this target, return it WITHOUT spawning a worker. P0-2: the stored
    // accepted report is RE-VERIFIED against the freshly built verified case
    // before it is surfaced as completed — a tampered accepted payload must
    // NEVER be projected as a completed diagnosis. On verification failure the
    // diagnosis is treated as failed (the D4 result stays complete — I5).
    // -----------------------------------------------------------------------
    try {
      const accepted = rt.readAcceptedDiagnosisReport(control.controlIntentId);
      if (accepted) {
        // P0-2: full re-verification against the frozen verified case. This
        // catches content_hash tamper, payload tamper, target drift, schema
        // drift, status/errors contradiction, and any causal/coverage rule
        // violation a tampered payload might introduce.
        verifyAcceptedDiagnosisReport(accepted, caseData, control);
        request.heartbeat(
          'DIAGNOSIS_COMPLETED',
          `control=${control.controlIntentId} report=${accepted.id} (reused)`,
        );
        return completedResult(accepted);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.heartbeat('DIAGNOSIS_FAILED', `accepted-report verification failed: ${message}`);
      return failedResult(request.certificateId, request.certificateHash, message);
    }

    // -----------------------------------------------------------------------
    // BOUNDED WORKER LIFECYCLE (mirrors discovery-readiness-service.ts).
    // The whole worker phase is wrapped: ANY failure (crash, invalid payload,
    // persistence error) returns status='failed' — never throws (invariant I5).
    // -----------------------------------------------------------------------
    try {
      const outcome = await this.runDiagnosisWorker(request, control);
      // After worker closure: read the latest report the worker submitted via
      // diagnosis_submit (which already validated + persisted the verdict
      // atomically) and project the advisory result. P0-2: if the latest report
      // is accepted, it is re-verified against the frozen verified case before
      // being projected as completed.
      const result = this.persistAndProject(rt, request, control, caseData, outcome);
      request.heartbeat(
        result.status === 'completed' ? 'DIAGNOSIS_COMPLETED' : 'DIAGNOSIS_FAILED',
        result.status === 'completed'
          ? `control=${control.controlIntentId} report=${result.reportId}`
          : (result.error ?? 'diagnosis did not complete'),
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.heartbeat('DIAGNOSIS_FAILED', `worker phase failed: ${message}`);
      return failedResult(request.certificateId, request.certificateHash, message);
    }
  }

  // -------------------------------------------------------------------------
  // Target verification — the kernel-only gate that proves the diagnosis is
  // bound to an EXACT immutable certificate (invariant I3). P0-3: this now
  // calls the SAME full verifier D4 uses (verifyDiscoveryCertificateBundle), so
  // D5 no longer maintains a weaker independent copy. The bundle recomputes the
  // certificate_hash from the certificate_payload, rebuilds the expected
  // certificate, requires settlement.status === 'certificate_issued', verifies
  // reason-code / policy / readiness lineage, recomputes the input_hash, and
  // replays the policy — every check D4 does. The DiagnosisCase is built
  // EXCLUSIVELY from the returned VerifiedCertificateBundle. Read-only: D5
  // mutates nothing. Throws DiagnosisTargetError on any mismatch (the caller
  // catches it and returns status='failed', leaving D4 untouched — I5).
  // -------------------------------------------------------------------------
  private verifyDiagnosisTarget(
    rt: Saga3DiscoveryRuntimePersistence,
    request: DiagnoseRequest,
  ): VerifiedTarget {
    let bundle: VerifiedCertificateBundle;
    try {
      bundle = verifyDiscoveryCertificateBundle(
        rt,
        request.certificateId,
        request.certificateHash,
        discoverySettlementPolicyV1,
      );
    } catch (error) {
      // Re-surface CertificateBundleError as DiagnosisTargetError so the
      // caller's single catch maps it to status='failed' with the precise
      // message from the bundle verifier.
      const message = error instanceof Error ? error.message : String(error);
      throw new DiagnosisTargetError(message);
    }
    const { certificate: cert, settlement, proposal: proposalRow, snapshot } = bundle;

    // Bind the verified certificate's epic to the request epic (the bundle
    // verified cert.epic_id === settlement.epic_id; this is the cross-check
    // against the engine-supplied request epic).
    if (cert.epic_id !== request.epicId) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} epic_id ${cert.epic_id} != request epic_id ${request.epicId}`,
      );
    }

    const proposalPayload = proposalRow.payload as DiscoveryProposalPayload;

    // Build the readiness ref from the VERIFIED bundle. When the snapshot
    // readiness is accepted, the bundle re-loaded + re-verified the exact
    // assessment (status, proposal binding, full lineage, payload hash). When
    // it is missing/failed/paused, the bundle's snapshot null-anchor check
    // already ensured assessment_id/content_hash/payload are all null.
    let readiness: DiagnosisReadinessRef;
    if (snapshot.readiness.status === 'accepted_by_kernel') {
      const assessment = bundle.readinessAssessment;
      // The bundle guarantees non-null here; narrow for TS.
      if (!assessment) {
        throw new DiagnosisTargetError(
          `settlement ${settlement.id} snapshot readiness=accepted_by_kernel but bundle has no verified assessment`,
        );
      }
      readiness = {
        status: 'accepted_by_kernel',
        assessment_id: assessment.id,
        hash: assessment.content_hash,
        payload: assessment.payload as ReadinessAssessmentPayload,
      };
    } else {
      // missing | failed | paused — no assessment payload; the case's policy
      // conditions will mark the assessment-based predicates not_applicable.
      readiness = {
        status: snapshot.readiness.status,
        assessment_id: null,
        hash: null,
        payload: null,
      };
    }

    // Build the certificate ref + proposal ref for the DiagnosisCase directly
    // from the VERIFIED bundle rows.
    const certificateRef: DiagnosisCertificateRef = {
      id: cert.id,
      hash: cert.certificate_hash,
      decision: cert.decision,
      reason_codes: cert.reason_codes,
      policy_version: cert.policy_version,
      policy_hash: cert.policy_hash,
      settlement_id: cert.settlement_id,
      settlement_input_hash: cert.input_hash,
    };
    const proposalRef: DiagnosisProposalRef = {
      id: proposalRow.id,
      hash: proposalRow.content_hash,
      payload: proposalPayload,
    };

    const epicObjective = this.readEpicObjective(rt, request.epicId);

    const caseInput: BuildDiagnosisCaseInput = {
      epic_id: request.epicId,
      certificate: certificateRef,
      proposal: proposalRef,
      readiness,
      proposal_source_submission_id: proposalRow.source_submission_id,
      proposal_normalization_proposal_id: proposalRow.normalization_proposal_id,
      // captured_at is set by buildDiagnosisCase (default now); it is excluded
      // from diagnosisCaseHash so restart produces the same hash (I7).
    };

    return { cert, settlement, proposalRow, caseInput, epicObjective };
  }

  private readEpicObjective(
    rt: Saga3DiscoveryRuntimePersistence,
    epicId: number,
  ): string {
    const epic = rt.readEpicObjective(epicId);
    return epic ? epic.name : `Diagnose discovery outcome for epic ${epicId}`;
  }

  // -------------------------------------------------------------------------
  // Bounded worker lifecycle. Mirrors discovery-readiness-service.ts:
  // ensureControl → prepareIntentForExecution → restart-resume early-exit →
  // executor spawn → terminal-detection loop → CAS conclude on clean / CAS
  // pause on interrupt. Returns a WorkerOutcome the caller uses to read +
  // validate the latest report. NEVER throws (caller wraps in try/catch, but
  // this method is itself defensive — a worker crash is a 'failed' outcome).
  // -------------------------------------------------------------------------
  private async runDiagnosisWorker(
    request: DiagnoseRequest,
    control: DiagnosisControlExecution,
  ): Promise<WorkerOutcome> {
    const rt = this.deps.runtimePersistence;
    const preparation = rt.prepareIntentForExecution(control.authorityIntentId, control.taskId);

    // Restart-resume: if the diagnosis task is already done, NO new worker
    // spawns. The latest report (accepted or rejected) is the durable answer.
    if (preparation.state === 'done') {
      if (control.authorityIntentStatus === 'executing') {
        rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      } else if (control.authorityIntentStatus === 'paused') {
        rt.setIntentStatus(control.authorityIntentId, 'paused', 'concluded');
      }
      if (control.controlStatus === 'executing') {
        rt.setDiagnosisControlStatus(control.controlIntentId, 'executing', 'concluded');
      } else if (control.controlStatus === 'paused') {
        rt.setDiagnosisControlStatus(control.controlIntentId, 'paused', 'concluded');
      }
      return { terminal: 'clean', error: null };
    }
    if (preparation.state === 'blocked' || preparation.state === 'active') {
      return { terminal: 'failed', error: preparation.detail };
    }

    let controlStatus = control.controlStatus;
    if (controlStatus === 'executing') {
      rt.setDiagnosisControlStatus(control.controlIntentId, 'executing', 'paused');
      controlStatus = 'paused';
    }

    const { workerExecutorFactory, host, config } = this.deps;
    const executor = workerExecutorFactory({
      projectId: request.projectId,
      epicId: request.epicId,
      workspaceRoot: request.workspaceRoot,
      dbPath: config.dbPath,
      sagaEntry: host.workerPaths.sagaEntry,
      sagaSkillRoot: host.workerPaths.sagaSkillRoot,
      claudePath: config.claudePath,
      logRoot: host.workerPaths.logRoot,
      heartbeatLog: host.workerPaths.heartbeatLog,
      lmStudioUrl: config.lmStudioUrl,
    });

    const startedAt = this.now().getTime();
    let terminal: 'clean' | 'failed' | 'stopped' | 'timeout' | 'blocked' = 'timeout';
    let caughtError: string | null = null;
    let assignment: AssignedWork | null = null;
    /** Whether the control/intent were advanced to 'executing' (release gate). */
    let workerLaunched = false;

    try {
      // Conveyor model (Slice 1 Zones 1-4): assign the projected diagnosis
      // card BEFORE the worker is launched. A null assignment means the card
      // was not claimable (lost race / already claimed / unmet deps / fence
      // held) — treat it like the existing 'blocked' preparation path: pause
      // the control and do NOT spawn a worker (no fence to leak).
      assignment = assignOneCard({
        workAssignment: this.deps.workAssignment,
        idGenerator: this.deps.idGenerator,
        machineId: this.deps.machineId,
        projectId: request.projectId,
        epicId: request.epicId,
        taskId: control.taskId,
        runPrefix: 'diagnosis-run',
      });
      if (!assignment) {
        rt.setIntentStatus(control.authorityIntentId, preparation.intentStatus, 'paused');
        rt.setDiagnosisControlStatus(control.controlIntentId, controlStatus, 'paused');
        return {
          terminal: 'failed',
          error: `diagnosis card task=${control.taskId} was not assignable (lost race or fence held)`,
        };
      }
      executor.start({
        projectId: request.projectId,
        epicId: request.epicId,
        concurrency: 1,
        assignment,
      });
      workerLaunched = true;
      rt.setIntentStatus(control.authorityIntentId, preparation.intentStatus, 'executing');
      rt.setDiagnosisControlStatus(control.controlIntentId, controlStatus, 'executing');

      while (true) {
        const taskStatus = rt.readTaskState(control.taskId);
        const run = executor.status(request.projectId);
        const active = run?.active?.some(worker => worker.task_id === control.taskId) ?? false;
        if (run === null || run.status === 'failed') { terminal = 'failed'; break; }
        if (run.status === 'stopped') { terminal = 'stopped'; break; }
        if (taskStatus === 'done' && !active) { terminal = 'clean'; break; }
        if (taskStatus === 'blocked' && !active) { terminal = 'blocked'; break; }
        if (run.status === 'completed' && taskStatus !== 'done') { terminal = 'failed'; break; }
        if (this.now().getTime() - startedAt > this.maxRunMs) { terminal = 'timeout'; break; }
        await this.sleep(this.pollMs);
      }
    } catch (error) {
      terminal = 'failed';
      caughtError = error instanceof Error ? error.message : String(error);
    } finally {
      // Only a clean closure leaves the card released (worker_done handled it).
      // On start/spawn failure the card is still fenced to this execution —
      // release it BEFORE disposing the executor so it is not stranded. The
      // release is gated on workerLaunched so a null-assignment early return
      // (no card obtained) never calls releaseAssignment.
      if (workerLaunched && terminal !== 'clean') {
        releaseOneCardIfAssigned(
          this.deps.workAssignment,
          assignment,
          `diagnosis worker ${terminal}: ${caughtError ?? 'non-clean closure'}`,
        );
        try { executor.stop(request.projectId); } catch { /* best effort */ }
      }
      try { executor.dispose(); } catch { /* best effort */ }
    }

    if (terminal === 'clean') {
      rt.setIntentStatus(control.authorityIntentId, 'executing', 'concluded');
      rt.setDiagnosisControlStatus(control.controlIntentId, 'executing', 'concluded');
      return { terminal: 'clean', error: null };
    }

    // Interruption/timeout → paused. Restart reuses the same ControlIntent/task.
    rt.setIntentStatus(control.authorityIntentId, 'executing', 'paused');
    rt.setDiagnosisControlStatus(control.controlIntentId, 'executing', 'paused');
    const error = caughtError ?? `diagnosis worker did not close cleanly (terminal=${terminal})`;
    return { terminal, error };
  }

  // -------------------------------------------------------------------------
  // After worker closure: read the latest report the worker submitted (via
  // diagnosis_submit, Deliverable 2), validate it against the immutable case,
  // and persist the verdict. If no report was submitted, or the report is
  // invalid, the result is 'failed' (advisory — D4 result stays complete).
  //
  // NOTE: diagnosis_submit ALREADY runs validateDiagnosisReport and persists
  // the accepted/rejected verdict atomically. So by the time the worker
  // closes, the report row carries its final status. This method READS that
  // row and projects the advisory result. If no report row exists, the
  // diagnosis failed without producing a report.
  //
  // P0-2: if the latest report is accepted_by_kernel, it is RE-VERIFIED against
  // the frozen verified case before being projected as completed. A tampered
  // accepted payload must never surface as a completed diagnosis. On
  // verification failure the result is 'failed' (advisory — I5).
  // -------------------------------------------------------------------------
  private persistAndProject(
    rt: Saga3DiscoveryRuntimePersistence,
    request: DiagnoseRequest,
    control: DiagnosisControlExecution,
    verifiedCase: DiscoveryDiagnosisCase,
    outcome: WorkerOutcome,
  ): DiscoveryDiagnosisResult {
    // A non-clean terminal with no accepted report is a failure.
    if (outcome.terminal !== 'clean') {
      return failedResult(
        request.certificateId,
        request.certificateHash,
        outcome.error ?? `diagnosis worker terminal=${outcome.terminal}`,
      );
    }

    const latest = rt.readLatestDiagnosisReport(control.controlIntentId);
    if (!latest) {
      // Worker closed cleanly but never submitted a report → failed (advisory).
      return failedResult(
        request.certificateId,
        request.certificateHash,
        'diagnosis worker closed without submitting a report',
      );
    }

    // Defence in depth: the report's target must bind to this control's target.
    if (latest.certificate_id !== request.certificateId
        || latest.certificate_hash !== request.certificateHash) {
      return failedResult(
        request.certificateId,
        request.certificateHash,
        `report ${latest.id} target drift (cert ${latest.certificate_id} != ${request.certificateId})`,
      );
    }

    if (latest.status === 'accepted_by_kernel') {
      // P0-2: full re-verification against the frozen verified case before
      // projecting completed. A tampered accepted payload is treated as a
      // diagnosis failure, never a completed diagnosis.
      try {
        verifyAcceptedDiagnosisReport(latest, verifiedCase, control);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failedResult(
          request.certificateId,
          request.certificateHash,
          `accepted report ${latest.id} verification failed: ${message}`,
        );
      }
      return completedResult(latest);
    }

    // rejected_by_kernel (or submitted without a verdict) → failed, but the
    // row is durable for audit (validation_errors non-empty on rejection).
    const errors = latest.validation_errors.length > 0
      ? latest.validation_errors
      : [`diagnosis report ${latest.id} status='${latest.status}' is not accepted_by_kernel`];
    return failedResult(
      request.certificateId,
      request.certificateHash,
      `diagnosis report rejected: ${errors.join('; ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private). These build the discriminated result union. They
// NEVER touch top-level outcome/authority/scopeCompleted/reason/finalStage —
// the diagnosis result is advisory only (invariants I1, I2).
// ---------------------------------------------------------------------------

interface VerifiedTarget {
  cert: OutcomeCertificateRecord;
  settlement: SettlementRecord;
  proposalRow: SettlementProposalRecord;
  caseInput: BuildDiagnosisCaseInput;
  epicObjective: string;
}

interface WorkerOutcome {
  terminal: 'clean' | 'failed' | 'stopped' | 'timeout' | 'blocked';
  error: string | null;
}

// ---------------------------------------------------------------------------
// verifyAcceptedDiagnosisReport (P0-2) — the kernel-only gate that re-verifies
// a stored accepted_by_kernel report BEFORE surfacing it as a completed
// diagnosis. Without this, a tampered accepted payload (payload rewritten,
// content_hash recomputed, status left 'accepted_by_kernel') would be projected
// as a completed diagnosis on restart and after the worker closes.
//
// It runs at every place the service READS an accepted report and projects it
// as 'completed': restart-resume reuse, post-worker projection, and the
// service-side replay path of submitDiagnosisReportAtomically. On ANY mismatch
// it THROWS — the caller maps the throw to status='failed' so a corrupt accepted
// report is NEVER surfaced as a completed diagnosis (the D4 result stays
// complete — I5).
//
// Checks (any failure throws):
//  1. report.control_intent_id === control.id           (report belongs to this control)
//  2. report.certificate_id === control.certificate_id
//     AND report.certificate_hash === control.certificate_hash (cert target binding)
//  3. report.task_id === control.taskId                 (task binding)
//  4. report.schema_version === DISCOVERY_DIAGNOSIS_REPORT_SCHEMA
//  5. recompute hashDiagnosisReport(report.payload) === report.content_hash
//     (canonical payload integrity — catches payload tamper with a recomputed hash
//     AND hash-only tamper)
//  6. report.status === 'accepted_by_kernel' AND report.validation_errors is EMPTY
//     (an accepted report with non-empty errors is a contradiction)
//  7. the payload's target (certificate_id/certificate_hash/settlement_input_hash/
//     decision) matches the control + verified case certificate tuple
//  8. validateDiagnosisReport(report.payload, verifiedCase) is valid (re-validation
//     against the frozen case catches invented evidence / coverage gaps / causal-
//     rule violations a tampered payload might introduce)
//
// The function goes through the port/domain only — it never touches the DB
// handle directly and contains no inline SQL (architecture F1/F2).
// ---------------------------------------------------------------------------
export function verifyAcceptedDiagnosisReport(
  report: DiagnosisReportRecord,
  verifiedCase: DiscoveryDiagnosisCase,
  control: DiagnosisControlExecution,
): void {
  // 1. The report belongs to this control.
  if (report.control_intent_id !== control.controlIntentId) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} control_intent_id ${report.control_intent_id} != control ${control.controlIntentId}`,
    );
  }
  // 2. Cert target binding.
  if (report.certificate_id !== control.certificateId) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} certificate_id ${report.certificate_id} != control ${control.certificateId}`,
    );
  }
  if (report.certificate_hash !== control.certificateHash) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} certificate_hash ${report.certificate_hash} != control ${control.certificateHash}`,
    );
  }
  // 3. Task binding.
  if (report.task_id !== control.taskId) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} task_id ${report.task_id} != control task ${control.taskId}`,
    );
  }
  // 4. Schema version.
  if (report.schema_version !== DISCOVERY_DIAGNOSIS_REPORT_SCHEMA) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} schema_version ${JSON.stringify(report.schema_version)} != ${DISCOVERY_DIAGNOSIS_REPORT_SCHEMA}`,
    );
  }
  // 5. Canonical payload integrity: recompute the content hash from the stored
  //    payload and require it to equal the stored content_hash. A tampered
  //    payload whose hash was recomputed to match would still fail step 8
  //    (re-validation against the frozen case); a tampered payload whose hash
  //    was NOT recomputed fails here.
  const recomputedHash = hashDiagnosisReport(report.payload as Parameters<typeof hashDiagnosisReport>[0]);
  if (recomputedHash !== report.content_hash) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} content_hash ${report.content_hash} does not match a recomputation of its stored payload (tampered payload or hash)`,
    );
  }
  // 6. An accepted report with non-empty validation_errors is a contradiction.
  if (report.status !== 'accepted_by_kernel') {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} status ${JSON.stringify(report.status)} is not 'accepted_by_kernel'`,
    );
  }
  if (report.validation_errors.length > 0) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} carries non-empty validation_errors (${JSON.stringify(report.validation_errors)}); an accepted report must have empty errors`,
    );
  }
  // 7. The payload's target must match the control + verified case certificate
  //    tuple. The verified case's certificate slice is the authoritative target.
  const payload = report.payload as { target?: { certificate_id?: unknown; certificate_hash?: unknown; settlement_input_hash?: unknown; decision?: unknown } };
  const target = payload?.target;
  const cert = verifiedCase.certificate;
  const targetFields: Array<[string, unknown, unknown]> = [
    ['target.certificate_id', target?.certificate_id, control.certificateId],
    ['target.certificate_hash', target?.certificate_hash, control.certificateHash],
    ['target.settlement_input_hash', target?.settlement_input_hash, cert.settlement_input_hash],
    ['target.decision', target?.decision, cert.decision as DiagnosisDecision],
  ];
  for (const [field, actual, expected] of targetFields) {
    if (actual !== expected) {
      throw new DiagnosisTargetError(
        `accepted report ${report.id} payload ${field} ${JSON.stringify(actual)} != verified case ${JSON.stringify(expected)}`,
      );
    }
  }
  // 8. Re-validate the stored payload against the FROZEN verified case. This
  //    catches invented evidence / coverage gaps / causal-rule violations that a
  //    tampered payload might introduce even when its hash agrees.
  const validation = validateDiagnosisReport(report.payload, verifiedCase);
  if (!validation.valid) {
    throw new DiagnosisTargetError(
      `accepted report ${report.id} payload failed re-validation against the frozen case: ${validation.errors.join('; ')}`,
    );
  }
}

function completedResult(report: DiagnosisReportRecord): DiscoveryDiagnosisResult {
  const payload = report.payload as { executive_summary?: string; cause_analysis?: Array<{ cause_id: string; severity: string }>; recommended_actions?: Array<{ action_id: string }> };
  const summary = typeof payload?.executive_summary === 'string' ? payload.executive_summary : '';
  const primaryCauses = Array.isArray(payload?.cause_analysis)
    ? payload.cause_analysis.map(c => c.cause_id)
    : [];
  const blockingGaps = Array.isArray(payload?.cause_analysis)
    ? payload.cause_analysis.filter(c => c.severity === 'blocking').map(c => c.cause_id)
    : [];
  const recommendedActions = Array.isArray(payload?.recommended_actions)
    ? payload.recommended_actions.map(a => a.action_id)
    : [];
  return {
    status: 'completed',
    authority: 'advisory_diagnosis',
    reportId: report.id,
    reportHash: report.content_hash,
    target: { certificateId: report.certificate_id, certificateHash: report.certificate_hash },
    summary,
    primaryCauses,
    blockingGaps,
    recommendedActions,
    error: null,
  };
}

function failedResult(
  certificateId: number,
  certificateHash: string,
  error: string,
): DiscoveryDiagnosisResult {
  return {
    status: 'failed',
    authority: 'none',
    reportId: null,
    reportHash: null,
    target: { certificateId, certificateHash },
    summary: null,
    primaryCauses: [],
    blockingGaps: [],
    recommendedActions: [],
    error,
  };
}

// Re-export the contract constants for the composition root / tool handlers.
export {
  DISCOVERY_DIAGNOSIS_CONTRACT_VERSION,
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
};

