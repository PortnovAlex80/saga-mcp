import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
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
import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
import type { NodeExecutionResult } from '../../../process-modules/application/node-executor.js';
import type { ProcessModuleExecutionContext } from '../../../process-modules/application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import type { ProcessOutputPayloadResolver } from '../../../process-modules/application/lifecycle-orchestrator.js';
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
  db: SqlDatabasePort;
  certificates: ProcessOutcomeCertificateRepository;
}): Record<string, KernelHandler> {
  return {
    'discovery-settlement-policy': createSettlementHandler(input),
  };
}

function createSettlementHandler(input: {
  db: SqlDatabasePort;
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
      // ADR-053 cutover: resolve submissions by EXACT sealed productRef,
      // NOT by presenter identity. The cell item's products[0] carries the
      // exact (schema, ref, digest) authority triple.
      if (!proposalCell.products[0]) throw new Error('DISCOVERY_PROPOSAL_PRODUCTREF_MISSING');
      if (!readinessCell.products[0]) throw new Error('DISCOVERY_READINESS_PRODUCTREF_MISSING');
      const proposal = readSubmission(
        input.db,
        ctx.processRunId,
        proposalCell.products[0],
        DISCOVERY_PROPOSAL_SCHEMA,
      );
      const readiness = readSubmission(
        input.db,
        ctx.processRunId,
        readinessCell.products[0],
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
          proposalSchema: proposalCell.products[0]!.schemaId,
          proposalRef: proposalCell.products[0]!.ref,
          proposalHash: proposalCell.products[0]!.digest,
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

function moduleCompletion(
  outcome: string,
  certificateRef: ProductRef,
): ModuleCompletion {
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  return { outcome, outputEnvelope, terminal: true };
}

interface DiscoveryProductRow {
  schema_id: string;
  artifact_ref: string;
  product_hash: string;
  payload_snapshot: string;
  payload_hash: string;
}

/** Resolve the exact accepted Discovery Proposal as the ProcessRun output. */
export function createDiscoveryOutputResolver(db: SqlDatabasePort): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (module, _terminalOutcome, terminalResult, context) => {
    if (module.identity.name !== DISCOVERY_PROCESS_MODULE_REF.name
      || module.identity.version !== DISCOVERY_PROCESS_MODULE_REF.version) {
      throw new Error('discovery output: module reference mismatch');
    }
    const bindings = terminalResult.production?.bindings ?? {};
    const schema = requireStringBinding(bindings, 'proposalSchema');
    // The CandidateSet member ref identifies the managed submission. The
    // ProcessRun output must identify the immutable process-product projection,
    // so resolve it by the exact schema+digest rather than reusing that ref.
    requireStringBinding(bindings, 'proposalRef');
    const contentHash = requireStringBinding(bindings, 'proposalHash');
    const resolved = requireExactDiscoveryProposal(
      db,
      context.processRunId,
      { schema, contentHash },
    );
    return {
      schema: resolved.row.schema_id,
      artifactRef: resolved.row.artifact_ref,
      contentHash: resolved.row.product_hash,
    };
  };
}

/** Dereference the exact ProcessRun output for the lifecycle handoff. */
export function createDiscoveryLifecycleOutputPayloadResolver(
  db: SqlDatabasePort,
): ProcessOutputPayloadResolver {
  return context => requireExactDiscoveryProposal(
    db,
    context.processRunId,
    context.output,
  ).payload;
}

function requireExactDiscoveryProposal(
  db: SqlDatabasePort,
  processRunId: number,
  expected: Pick<ProcessModuleOutput, 'schema' | 'contentHash'>
    & Partial<Pick<ProcessModuleOutput, 'artifactRef'>>,
): { row: DiscoveryProductRow; payload: DiscoveryProposalPayload } {
  const rows = db.prepare(
    `SELECT schema_id,artifact_ref,product_hash,payload_snapshot,payload_hash
       FROM factory_process_products
      WHERE process_run_id=? AND schema_id=?`,
  ).all(processRunId, DISCOVERY_PROPOSAL_SCHEMA) as DiscoveryProductRow[];
  if (rows.length !== 1) {
    throw new Error(`discovery output: expected one proposal for process_run ${processRunId}`);
  }
  const row = rows[0]!;
  const payload = JSON.parse(row.payload_snapshot) as DiscoveryProposalPayload;
  const payloadHash = sha256Hex(payload);
  if (row.schema_id !== expected.schema
    || (expected.artifactRef !== undefined && row.artifact_ref !== expected.artifactRef)
    || row.product_hash !== expected.contentHash
    || row.payload_hash !== payloadHash
    || row.product_hash !== payloadHash) {
    throw new Error(
      `discovery output: '${expected.artifactRef}' does not resolve to the exact proposal `
      + `for process_run ${processRunId}`,
    );
  }
  return { row, payload };
}

function requireStringBinding(bindings: Readonly<Record<string, unknown>>, key: string): string {
  const value = bindings[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`discovery output: missing terminal binding '${key}'`);
  }
  return value;
}

function readSubmission(
  db: SqlDatabasePort,
  processRunId: number,
  productRef: ProductRef,
  expectedSchema: string,
): SubmissionRow {
  // ADR-053 cutover: resolve the exact sealed ProductRef alias and verify its
  // content digest. Equal-content rows are provenance aliases, but selecting a
  // newer alias here would let post-seal chronology change the terminal output.
  const prefix = 'managed-node-submission:';
  if (!productRef.ref.startsWith(prefix)) {
    throw new Error(`DISCOVERY_PRODUCT_REF_UNSUPPORTED: ${productRef.ref}`);
  }
  const submissionId = Number(productRef.ref.slice(prefix.length));
  if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
    throw new Error(`DISCOVERY_PRODUCT_REF_INVALID: ${productRef.ref}`);
  }
  const row = db.prepare(
    `SELECT id,process_run_id,node_id,intent_id,task_id,execution_id,
            schema_version,payload_snapshot,content_hash,submitted_at
       FROM factory_managed_node_submissions
      WHERE id=? AND process_run_id=? AND schema_version=? AND content_hash=?`,
  ).get(submissionId, processRunId, expectedSchema, productRef.digest) as SubmissionRow | undefined;
  if (!row) throw new Error(`DISCOVERY_PRODUCT_MISSING: ${productRef.ref}`);
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
