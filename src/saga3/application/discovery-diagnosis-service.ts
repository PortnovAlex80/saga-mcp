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
import type { WorkerExecutorFactory } from '../../application/ports/worker-executor.js';
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

import { createHash } from 'node:crypto';

import type { OutcomeCertificateRecord, SettlementRecord } from '../domain/discovery-settlement-records.js';
import type { ReadinessAssessmentRecord } from '../domain/discovery-readiness-records.js';
import type { DiscoveryProposalPayload } from '../domain/discovery-proposal.js';
import { DISCOVERY_PROPOSAL_SCHEMA, validateDiscoveryProposal } from '../domain/discovery-proposal.js';
import type { ReadinessAssessmentPayload } from '../domain/discovery-readiness-assessment.js';
import { validateReadinessAssessment } from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  type DiscoverySettlementInputSnapshot,
} from '../domain/discovery-settlement-input.js';
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
import { DISCOVERY_DIAGNOSIS_REPORT_SCHEMA } from '../domain/discovery-diagnosis-report.js';
import type { DiagnosisControlExecution, DiagnosisReportRecord } from '../domain/discovery-diagnosis-records.js';
import type { SettlementProposalRecord } from '../persistence/saga3-discovery-runtime-port.js';
import { canonicalJson, collectDiscoverySourceRefs, sha256Hex } from '../shared/discovery-canonical.js';

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
    this.maxRunMs = (deps.maxRunSeconds ?? 60 * 10) * 1000;
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
    // this target, return it WITHOUT spawning a worker.
    // -----------------------------------------------------------------------
    try {
      const accepted = rt.readAcceptedDiagnosisReport(control.controlIntentId);
      if (accepted) {
        // The accepted report is the durable answer. Validate its target still
        // binds to this control (defence in depth — the atomic insert already
        // enforces this, but a corrupted row must not be projected as success).
        if (accepted.certificate_id !== request.certificateId
            || accepted.certificate_hash !== request.certificateHash) {
          throw new DiagnosisTargetError(
            `accepted report ${accepted.id} target drift (cert ${accepted.certificate_id} != ${request.certificateId})`,
          );
        }
        request.heartbeat(
          'DIAGNOSIS_COMPLETED',
          `control=${control.controlIntentId} report=${accepted.id} (reused)`,
        );
        return completedResult(accepted);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.heartbeat('DIAGNOSIS_FAILED', `accepted-report read failed: ${message}`);
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
      // atomically) and project the advisory result.
      const result = this.persistAndProject(rt, request, control, outcome);
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
  // bound to an EXACT immutable certificate (invariant I3). Mirrors the D4
  // settlement verification discipline but read-only (D5 mutates nothing).
  // Throws DiagnosisTargetError on any mismatch; the caller catches it.
  // -------------------------------------------------------------------------
  private verifyDiagnosisTarget(
    rt: Saga3DiscoveryRuntimePersistence,
    request: DiagnoseRequest,
  ): VerifiedTarget {
    // 1. Load the certificate by EXACT id.
    const cert = rt.readOutcomeCertificate(request.certificateId);
    if (!cert) {
      throw new DiagnosisTargetError(
        `certificate ${request.certificateId} not found`,
      );
    }
    // 2. Verify the certificate hash matches the engine-supplied hash (I3).
    if (cert.certificate_hash !== request.certificateHash) {
      throw new DiagnosisTargetError(
        `certificate ${request.certificateId} hash mismatch (stored ${cert.certificate_hash.slice(0, 12)}, request ${request.certificateHash.slice(0, 12)})`,
      );
    }
    // 3. Load the settlement that issued this certificate.
    const settlement = rt.readSettlement(cert.settlement_id);
    if (!settlement) {
      throw new DiagnosisTargetError(
        `settlement ${cert.settlement_id} for certificate ${cert.id} not found`,
      );
    }
    // 4. Verify settlement/certificate relation.
    if (cert.settlement_id !== settlement.id) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} settlement_id ${cert.settlement_id} != settlement.id ${settlement.id}`,
      );
    }
    if (cert.input_hash !== settlement.input_hash) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} input_hash ${cert.input_hash.slice(0, 12)} != settlement.input_hash ${settlement.input_hash.slice(0, 12)}`,
      );
    }
    if (cert.epic_id !== settlement.epic_id) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} epic_id ${cert.epic_id} != settlement epic_id ${settlement.epic_id}`,
      );
    }
    if (cert.epic_id !== request.epicId) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} epic_id ${cert.epic_id} != request epic_id ${request.epicId}`,
      );
    }
    // 5. Verify the certificate row's decision/policy/reason lineage agrees with
    //    the settlement row (defence in depth — both come from D4, must agree).
    if (cert.decision !== settlement.decision) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} decision ${cert.decision} != settlement.decision ${settlement.decision}`,
      );
    }
    if (cert.policy_version !== settlement.policy_version
        || cert.policy_hash !== settlement.policy_hash) {
      throw new DiagnosisTargetError(
        `certificate ${cert.id} policy version/hash does not match the settlement`,
      );
    }

    // 6. Parse the stored settlement input_snapshot (the immutable D4 input the
    //    certificate was issued against) and derive the proposal + readiness
    //    slices needed to build the DiagnosisCase. We do NOT re-run the policy
    //    (D4 already settled); we re-derive the case inputs from the snapshot
    //    so the diagnosis explains the EXACT settled inputs.
    const snapshot = this.parseSettlementSnapshot(settlement);

    // 7. Re-load + verify the canonical Proposal (the snapshot embeds its hash
    //    + payload, but we bind to the LIVE canonical row so the case carries
    //    the same lineage the D4 settlement verified). Mirrors D4 step 1-2.
    const proposalRow = rt.readProposalForSettlement(snapshot.proposal.id);
    if (!proposalRow) {
      throw new DiagnosisTargetError(
        `proposal ${snapshot.proposal.id} (from settlement snapshot) not found`,
      );
    }
    this.verifyProposalLineage(proposalRow, settlement, snapshot);

    const proposalPayload = proposalRow.payload as DiscoveryProposalPayload;

    // 8. Re-load + verify the accepted readiness assessment (when the snapshot
    //    says one exists). Mirrors D4 step 3.
    let readiness: DiagnosisReadinessRef;
    if (snapshot.readiness.status === 'accepted_by_kernel') {
      const assessmentId = snapshot.readiness.assessment_id;
      if (assessmentId === null) {
        throw new DiagnosisTargetError(
          `settlement ${settlement.id} snapshot readiness=accepted_by_kernel but assessment_id is null`,
        );
      }
      const assessment = rt.readReadinessAssessment(assessmentId);
      if (!assessment || assessment.status !== 'accepted_by_kernel') {
        throw new DiagnosisTargetError(
          `readiness assessment ${assessmentId} not found or not accepted_by_kernel`,
        );
      }
      this.verifyAssessmentLineage(assessment, proposalRow, snapshot);
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

    // 9. Build the certificate ref + proposal ref for the DiagnosisCase.
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

  /** Parse + structurally verify the settlement input_snapshot. */
  private parseSettlementSnapshot(settlement: SettlementRecord): DiscoverySettlementInputSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settlement.input_snapshot);
    } catch {
      throw new DiagnosisTargetError(
        `settlement ${settlement.id}: input_snapshot is not valid JSON`,
      );
    }
    const snap = parsed as DiscoverySettlementInputSnapshot;
    if (snap.schema_version !== DISCOVERY_SETTLEMENT_INPUT_SCHEMA) {
      throw new DiagnosisTargetError(
        `settlement ${settlement.id}: snapshot schema_version '${snap.schema_version}' is not ${DISCOVERY_SETTLEMENT_INPUT_SCHEMA}`,
      );
    }
    if (snap.epic_id !== settlement.epic_id) {
      throw new DiagnosisTargetError(
        `settlement ${settlement.id}: snapshot epic_id ${snap.epic_id} != settlement epic_id ${settlement.epic_id}`,
      );
    }
    if (snap.proposal.id !== settlement.proposal_id
        || snap.proposal.content_hash !== settlement.proposal_content_hash) {
      throw new DiagnosisTargetError(
        `settlement ${settlement.id}: snapshot proposal id/hash does not match the settlement`,
      );
    }
    return snap;
  }

  /** Verify the canonical Proposal row binds to the settlement snapshot. */
  private verifyProposalLineage(
    proposalRow: SettlementProposalRecord,
    settlement: SettlementRecord,
    snapshot: DiscoverySettlementInputSnapshot,
  ): void {
    if (proposalRow.id !== settlement.proposal_id
        || proposalRow.content_hash !== settlement.proposal_content_hash
        || proposalRow.id !== snapshot.proposal.id
        || proposalRow.content_hash !== snapshot.proposal.content_hash) {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} id/hash does not match the settlement/snapshot`,
      );
    }
    if (proposalRow.epic_id !== settlement.epic_id) {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} epic_id ${proposalRow.epic_id} != settlement epic_id ${settlement.epic_id}`,
      );
    }
    if (proposalRow.kind !== 'discovery'
        || proposalRow.schema_version !== DISCOVERY_PROPOSAL_SCHEMA
        || proposalRow.status !== 'submitted') {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} is not a submitted discovery proposal of the canonical schema`,
      );
    }
    // Recompute the proposal content hash from the canonical payload and
    // compare to the stored hash. Catches a tampered payload.
    const recomputed = createHash('sha256')
      .update(canonicalJson(proposalRow.payload)).digest('hex');
    if (recomputed !== proposalRow.content_hash) {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} content_hash mismatch (tampered payload)`,
      );
    }
    // The canonical payload must agree with the snapshot's embedded payload.
    if (canonicalJson(proposalRow.payload) !== canonicalJson(snapshot.proposal.payload)) {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} payload does not match the settlement snapshot payload`,
      );
    }
    // Structural validation of the payload (defence in depth).
    const validation = validateDiscoveryProposal(proposalRow.payload);
    if (!validation.valid) {
      throw new DiagnosisTargetError(
        `proposal ${proposalRow.id} payload failed re-validation: ${validation.errors.join('; ')}`,
      );
    }
  }

  /** Verify the accepted readiness assessment binds to the proposal + snapshot. */
  private verifyAssessmentLineage(
    assessment: ReadinessAssessmentRecord,
    proposalRow: SettlementProposalRecord,
    snapshot: DiscoverySettlementInputSnapshot,
  ): void {
    if (assessment.proposal_id !== proposalRow.id
        || assessment.proposal_content_hash !== proposalRow.content_hash) {
      throw new DiagnosisTargetError(
        `assessment ${assessment.id} targets proposal ${assessment.proposal_id}, not ${proposalRow.id}`,
      );
    }
    if (snapshot.readiness.assessment_id !== assessment.id) {
      throw new DiagnosisTargetError(
        `assessment ${assessment.id} != snapshot.readiness.assessment_id ${snapshot.readiness.assessment_id}`,
      );
    }
    // Recompute the assessment content hash; must match the stored hash.
    const recomputed = sha256Hex(assessment.payload);
    if (recomputed !== assessment.content_hash) {
      throw new DiagnosisTargetError(
        `assessment ${assessment.id} content_hash mismatch (tampered payload)`,
      );
    }
    // Structural validation of the assessment payload (defence in depth).
    const allowedRefs = collectDiscoverySourceRefs(
      {
        proposalId: proposalRow.id,
        sourceSubmissionId: proposalRow.source_submission_id,
        normalizationProposalId: proposalRow.normalization_proposal_id,
      },
      proposalRow.payload as DiscoveryProposalPayload,
    );
    const validation = validateReadinessAssessment(
      assessment.payload,
      proposalRow.id,
      proposalRow.content_hash,
      allowedRefs,
    );
    if (!validation.valid) {
      throw new DiagnosisTargetError(
        `assessment ${assessment.id} failed re-validation: ${validation.errors.join('; ')}`,
      );
    }
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

    try {
      executor.start({
        projectId: request.projectId,
        epicId: request.epicId,
        concurrency: 1,
        claimScope: { taskIds: [control.taskId] },
      });
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
      if (terminal !== 'clean') {
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
  // row and projects the advisory result. It does NOT re-validate (the atomic
  // insert is the kernel gate); it only projects. If no report row exists,
  // the diagnosis failed without producing a report.
  // -------------------------------------------------------------------------
  private persistAndProject(
    rt: Saga3DiscoveryRuntimePersistence,
    request: DiagnoseRequest,
    control: DiagnosisControlExecution,
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

