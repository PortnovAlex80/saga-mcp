import type Database from 'better-sqlite3';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../../process-modules/application/kernel-handler-registry.js';
import { requireAcceptedSingletonCellItem } from '../../../process-modules/application/production-cell-output.js';
import type { ProcessOutcomeCertificateRepository } from '../../../process-modules/persistence/process-outcome-certificate-repository.js';
import type { IssueProcessOutcomeCertificateCommand } from '../../../process-modules/persistence/process-outcome-certificate.js';
import type {
  ModuleCompletion,
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/index.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DISCOVERY_PROCESS_MODULE_REF,
} from '../../../process-modules/modules/discovery/discovery-process-module.js';
import {
  DISCOVERY_PROPOSAL_SCHEMA,
  type DiscoveryProposalPayload,
} from '../domain/discovery-proposal.js';
import {
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  type ReadinessAssessmentPayload,
} from '../domain/discovery-readiness-assessment.js';
import {
  DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
  buildSettlementInputHash,
  type DiscoverySettlementInputSnapshot,
} from '../domain/discovery-settlement-input.js';
import {
  DiscoverySettlementPolicyV1,
} from '../domain/discovery-settlement-policy.js';

export const DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA =
  'factory.discovery-outcome-certificate.v1';

interface SubmissionRow {
  id: number;
  process_run_id: number;
  node_id: string;
  intent_id: number;
  task_id: number;
  execution_id: string;
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  submitted_at: string;
}

export function createDiscoveryProductionCellKernelHandlers(input: {
  db: Database.Database;
  certificates: ProcessOutcomeCertificateRepository;
}): Record<string, KernelHandler> {
  return {
    'discovery-settlement-policy': createSettlementHandler(input),
  };
}

function createSettlementHandler(input: {
  db: Database.Database;
  certificates: ProcessOutcomeCertificateRepository;
}): KernelHandler {
  const policy = new DiscoverySettlementPolicyV1();
  return ctx => {
    try {
      const proposalManifest = ctx.frame.productions['produce-proposal'];
      if (!proposalManifest) throw new Error('DISCOVERY_PROPOSAL_CELL_OUTPUT_MISSING');
      const proposalCell = requireAcceptedSingletonCellItem(
        proposalManifest,
        'discovery-settlement/proposal',
      );
      const readinessCell = requireAcceptedSingletonCellItem(
        ctx.input,
        'discovery-settlement/readiness',
      );
      const proposal = readSubmission(
        input.db,
        ctx.processRunId,
        proposalCell.producerExecutionRef,
        DISCOVERY_PROPOSAL_SCHEMA,
      );
      const readiness = readSubmission(
        input.db,
        ctx.processRunId,
        readinessCell.producerExecutionRef,
        DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
      );
      const run = input.db.prepare(
        `SELECT input_hash,started_at FROM factory_process_runs WHERE id=?`,
      ).get(ctx.processRunId) as { input_hash: string; started_at: string } | undefined;
      if (!run) throw new Error('DISCOVERY_PROCESS_RUN_MISSING');

      const snapshot: DiscoverySettlementInputSnapshot = {
        schema_version: DISCOVERY_SETTLEMENT_INPUT_SCHEMA,
        epic_id: requireEpicId(ctx),
        proposal: {
          id: proposal.id,
          content_hash: proposal.content_hash,
          payload: JSON.parse(proposal.payload_snapshot) as DiscoveryProposalPayload,
          source_intent_id: proposal.intent_id,
          source_submission_id: proposal.id,
          normalization_proposal_id: null,
        },
        readiness: {
          status: 'accepted_by_kernel',
          assessment_id: readiness.id,
          content_hash: readiness.content_hash,
          payload: JSON.parse(readiness.payload_snapshot) as ReadinessAssessmentPayload,
        },
        policy: {
          version: policy.version,
          content_hash: policy.contentHash,
        },
        // Replays of the same ProcessRun must produce byte-identical settlement
        // input. The ProcessRun start timestamp is immutable; wall clock is not.
        captured_at: run.started_at,
      };
      const snapshotHash = buildSettlementInputHash(snapshot);
      const decision = policy.settle(snapshot);
      const payload = {
        schemaVersion: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
        decision: decision.decision,
        reasonCodes: decision.reason_codes,
        rationale: decision.rationale,
        inputHash: snapshotHash,
        payload: {
          processInputHash: run.input_hash,
          settlementInput: snapshot,
          settlementInputHash: snapshotHash,
          policyVersion: decision.policy_version,
          policyHash: decision.policy_hash,
          proposalProductRef: proposalCell.products[0] ?? null,
          readinessProductRef: readinessCell.products[0] ?? null,
        },
      };
      const certificateHash = sha256Hex(payload);
      const issued = input.certificates.issue({
        processRunId: ctx.processRunId,
        moduleRef: DISCOVERY_PROCESS_MODULE_REF,
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        payload,
        certificateHash,
        authority: 'discovery-settlement-policy',
      } satisfies IssueProcessOutcomeCertificateCommand);
      const certificateRef: ProductRef = {
        schemaId: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
        ref: `certificate:${issued.record.id}`,
        digest: issued.record.certificateHash,
      };
      return settlementResult(
        decision.decision,
        certificateHash,
        certificateRef,
        {
          authority: 'discovery-settlement-policy',
          reasonCodes: decision.reason_codes,
          settlementInputHash: snapshotHash,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        event: 'failed',
        production: {
          schema: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
          artifactRef: `discovery-settlement-failed:${ctx.processRunId}:${sha256Hex(message)}`,
          contentHash: sha256Hex({ processRunId: ctx.processRunId, message }),
          bindings: { authority: 'discovery-settlement-policy', error: message },
        },
      };
    }
  };
}

function settlementResult(
  decision: 'go' | 'clarify' | 'reject',
  certificateHash: string,
  certificateRef: ProductRef,
  bindings: Record<string, unknown>,
): KernelHandlerResult {
  return {
    event: decision,
    production: {
      schema: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
      artifactRef: `discovery-settlement:${certificateHash}`,
      contentHash: certificateHash,
      bindings,
    },
    completion: moduleCompletion(decision, certificateRef),
  };
}

function moduleCompletion(outcome: string, certificateRef: ProductRef): ModuleCompletion {
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  return { outcome, outputEnvelope, terminal: true };
}

function readSubmission(
  db: Database.Database,
  processRunId: number,
  executionId: string,
  expectedSchema: string,
): SubmissionRow {
  const row = db.prepare(
    `SELECT id,process_run_id,node_id,intent_id,task_id,execution_id,
            schema_version,payload_snapshot,content_hash,submitted_at
       FROM factory_managed_node_submissions
      WHERE process_run_id=? AND execution_id=?
      ORDER BY id DESC LIMIT 1`,
  ).get(processRunId, executionId) as SubmissionRow | undefined;
  if (!row) throw new Error(`DISCOVERY_PRODUCT_MISSING: ${executionId}`);
  if (row.schema_version !== expectedSchema) {
    throw new Error(
      `DISCOVERY_PRODUCT_SCHEMA_MISMATCH: expected ${expectedSchema}, got ${row.schema_version}`,
    );
  }
  if (sha256Hex(JSON.parse(row.payload_snapshot)) !== row.content_hash) {
    throw new Error(`DISCOVERY_PRODUCT_HASH_MISMATCH: ${row.id}`);
  }
  return row;
}

function requireEpicId(ctx: KernelHandlerContext): number {
  if (!Number.isSafeInteger(ctx.epicId) || (ctx.epicId ?? 0) < 1) {
    throw new Error('DISCOVERY_EPIC_REQUIRED');
  }
  return ctx.epicId as number;
}
