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
  assertOrderConstraintUnknownsLifted,
  buildOrderConstraintRegisterV2,
  type OrderConstraintInjectionTable,
  type OrderConstraintRegister,
} from '../../../shared/constraint-register.js';
import {
  DiscoverySettlementPolicyV1,
} from '../domain/discovery-settlement-policy.js';

export const DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA =
  'factory.discovery-outcome-certificate.v1';

/**
 * ADR-090 (CC-IC-1): the typed no-obligations attestation a NEW v2 Factory
 * Start carries when (and only when) the order truly counts nothing — no
 * order_constraints drafts, no proposal unknowns, no injected obligations.
 * Null-binding grandfathering is frozen-legacy-v1-only: a new v2 settlement
 * NEVER silently produces a null register (mutation m6).
 */
export const DISCOVERY_NO_OBLIGATIONS_ATTESTATION_SCHEMA =
  'factory.discovery-no-obligations.v1';

/**
 * ADR-090 (CC-IC-1): the pinned per-run lifecycle definition read — the ONLY
 * normative path the frozen lifecycle classification takes into Discovery
 * settlement (`ctx.processRunId` → `factory_stage_runs.process_run_id` →
 * `lifecycle_run_id` → pinned `factory_lifecycle_runs` `definition_snapshot`
 * + `definition_hash`). Declared HERE as a structural port: Discovery
 * imports no lifecycle internals and constructs no repository — the typed
 * `readDefinitionByProcessRun` port/repository is implemented in
 * `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts` and
 * injected through `src/app/product-lifecycle-runtime.ts` /
 * `src/app/composition-root.ts` DI wiring. A missing row or definition hash
 * mismatch fails closed with a typed error — never an ambient/default
 * `lifecycleDefinition` fallback, never prose re-derivation.
 */
export interface LifecycleDefinitionClassificationRead {
  readonly lifecycleRunId: number;
  readonly lifecycleRefKey: string;
  /** The pinned definition snapshot (parsed JSON), consumed READ-ONLY. */
  readonly definition: Readonly<Record<string, unknown>>;
  readonly definitionHash: string;
}

export interface LifecycleDefinitionByProcessRunReader {
  readDefinitionByProcessRun(processRunId: number): LifecycleDefinitionClassificationRead;
}

/**
 * One declared, digest-pinned lifecycle obligation injection table delivered
 * by composition. The lifecycle that freezes a classification owns its
 * injection declaration (data, not engine inference) — e.g. the frozen
 * `runnable-local` terminal of the product-build lifecycle declares the
 * whole-product-synthesis + ordered-smoke table beside it.
 */
export interface LifecycleObligationInjectionDeclaration {
  readonly table: OrderConstraintInjectionTable;
  /** Content-addressed ref cited by the settlement record. */
  readonly tableRef: string;
  /** sha256 over the table — settlement verifies the digest pins what it consumed. */
  readonly tableDigest: string;
}

export interface DiscoveryProductionCellInstallationDeps {
  readonly db: SqlDatabasePort;
  readonly certificates: ProcessOutcomeCertificateRepository;
  /**
   * REQUIRED (fail-closed): the pinned per-run lifecycle definition reader.
   * No ambient default exists; the composition must inject it.
   */
  readonly lifecycleDefinitionReader: LifecycleDefinitionByProcessRunReader;
  /**
   * The declared injection tables + the classifications that REQUIRE one,
   * delivered by composition from the lifecycle owners (data only).
   */
  readonly lifecycleInjectionDeclarations: readonly LifecycleObligationInjectionDeclaration[];
  /** Classifications whose terminal presence REQUIRES a declared table (m4 red). */
  readonly lifecycleInjectionRequiredClassifications: readonly string[];
}

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

export function createDiscoveryProductionCellKernelHandlers(
  input: DiscoveryProductionCellInstallationDeps,
): Record<string, KernelHandler> {
  // ADR-090 (CC-IC-1): the pinned classification read is REQUIRED — a
  // composition that forgets it fails loudly here, before any settlement can
  // silently fall back to an ambient lifecycle definition.
  if (!input.lifecycleDefinitionReader
    || typeof input.lifecycleDefinitionReader.readDefinitionByProcessRun !== 'function') {
    throw new Error(
      'DISCOVERY_SETTLEMENT_LIFECYCLE_READER_REQUIRED: the pinned per-run lifecycle definition reader must be injected (no ambient default)',
    );
  }
  return {
    'discovery-settlement-policy': createSettlementHandler(input),
  };
}

function createSettlementHandler(
  input: DiscoveryProductionCellInstallationDeps,
): KernelHandler {
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
      // AC-drift remedy (network 0) + ADR-090 (CC-IC-1): build the
      // digest-pinned constraint register ONCE, here, while the constraints
      // are still visible. The register rides the immutable certificate
      // payload (covered by certificateHash), so it is frozen with the
      // decision it belongs to.
      //
      // The lifecycle classification reaches settlement ONLY through the
      // pinned per-run read (fail-closed typed errors — never an ambient
      // lifecycleDefinition); the classification is derived deterministically
      // from the pinned definition's terminal statuses (data, no prose
      // rereading, no workshop-name branch); the injected obligations are
      // consumed READ-ONLY from the declared, digest-pinned injection table
      // and APPENDED after the proposal-derived block in declared table
      // order; and every proposal unknown is drafted 1:1/positionally as a
      // kind `open-question` entry (asserted conserved below — m1 red).
      const proposalPayload
        = JSON.parse(proposal.payload_snapshot) as DiscoveryProposalPayload;
      const lifecycle = classifyPinnedLifecycle(input, ctx.processRunId);
      const constraintRegister: OrderConstraintRegister | null =
        buildOrderConstraintRegisterV2({
          drafts: proposalPayload.order_constraints,
          unknowns: proposalPayload.unknowns,
          injections: lifecycle.injections,
        });
      // m1: a proposal unknown absent from the register's open-question
      // entries is a typed settlement red, never a silent under-count.
      assertOrderConstraintUnknownsLifted(constraintRegister, proposalPayload.unknowns ?? []);
      // The settlement record cites the classification read + every consumed
      // injection table digest; a new v2 Factory Start carries non-null typed
      // authority — the built register, or the explicit typed no-obligations
      // attestation (never a silent null binding — m6 red).
      const lifecycleBinding = {
        lifecycleRunId: lifecycle.pinned.lifecycleRunId,
        terminalClassifications: lifecycle.terminalClassifications,
        definitionHash: lifecycle.pinned.definitionHash,
        ...(lifecycle.consumedTableRefs.length > 0
          ? { injectionTableRefs: lifecycle.consumedTableRefs }
          : {}),
      } as const;
      const payload = {
        schemaVersion: DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA,
        decision: decision.decision,
        reasonCodes: decision.reason_codes,
        rationale: decision.rationale,
        inputHash: snapshotHash,
        ...(constraintRegister === null
          ? {
              noObligationsAttestation: {
                schemaVersion: DISCOVERY_NO_OBLIGATIONS_ATTESTATION_SCHEMA,
                attestation: 'no-obligations',
                lifecycleBinding,
                attestationDigest: sha256Hex({
                  schemaVersion: DISCOVERY_NO_OBLIGATIONS_ATTESTATION_SCHEMA,
                  attestation: 'no-obligations',
                  lifecycleBinding,
                }),
              },
            }
          : { constraintRegister, lifecycleBinding }),
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
  return (module, terminalOutcome, terminalResult, context) => {
    if (module.identity.name !== DISCOVERY_PROCESS_MODULE_REF.name
      || module.identity.version !== DISCOVERY_PROCESS_MODULE_REF.version) {
      throw new Error('discovery output: module reference mismatch');
    }
    // A failed Discovery module (e.g. the §15 recovery-budget terminal) has
    // NO accepted proposal to project — the resolver must step aside and let
    // the failure settlement path complete the stage with local outcome
    // 'failed', exactly as the Formalization resolver does for non-
    // 'formalized' outcomes. Requiring proposal bindings on a failed run
    // turned the honest terminal into an exception path (2026-08-21
    // discovery retry-exhaustion finding).
    if (!['go', 'clarify', 'reject'].includes(terminalOutcome)) return null;
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
  // A repair round appends a NEW immutable product row for the same schema —
  // after reject → repair the run carries the rejected original AND the
  // accepted repair. Exact-authority selection is by the expected content
  // hash (ADR-053: exact ref, never count-uniqueness or recency); demanding
  // exactly one row per run turned every repaired Discovery into a stage
  // failure (2026-08-21 discovery proposal-feedback-exact finding: both
  // workplaces terminal accepted, stage dead on 'expected one proposal').
  const exact = rows.filter(row => row.schema_id === expected.schema
    && row.product_hash === expected.contentHash
    && (expected.artifactRef === undefined || row.artifact_ref === expected.artifactRef));
  if (exact.length !== 1) {
    throw new Error(
      `discovery output: expected exactly one proposal matching the accepted digest `
      + `for process_run ${processRunId}, got ${exact.length} matching of ${rows.length} total`,
    );
  }
  const row = exact[0]!;
  const payload = JSON.parse(row.payload_snapshot) as DiscoveryProposalPayload;
  const payloadHash = sha256Hex(payload);
  if (row.payload_hash !== payloadHash
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

/**
 * ADR-090 (CC-IC-1): resolve the pinned lifecycle definition for THIS
 * process run and derive the frozen classification deterministically from
 * the definition's declared terminal statuses — pure data inspection of the
 * pinned snapshot (no lifecycle module import, no prose rereading, no
 * workshop-name branch, no ambient default). When a REQUIRED classification
 * is present but no declared injection table matches, settlement fails
 * closed: a runnable-local classification without its injected
 * whole-product-synthesis + ordered-smoke obligations is a typed red (m4).
 */
function classifyPinnedLifecycle(
  input: DiscoveryProductionCellInstallationDeps,
  processRunId: number,
): {
  pinned: LifecycleDefinitionClassificationRead;
  terminalClassifications: readonly string[];
  injections: readonly { table: OrderConstraintInjectionTable; tableRef: string }[];
  consumedTableRefs: readonly string[];
} {
  const pinned = input.lifecycleDefinitionReader.readDefinitionByProcessRun(processRunId);
  const terminalClassifications = terminalClassificationsOf(pinned.definition);
  const applicable = input.lifecycleInjectionDeclarations
    .filter(declaration => terminalClassifications.includes(declaration.table.classification));
  for (const requiredClassification of input.lifecycleInjectionRequiredClassifications) {
    if (
      terminalClassifications.includes(requiredClassification)
      && !applicable.some(d => d.table.classification === requiredClassification)
    ) {
      throw new Error(
        `LIFECYCLE_INJECTION_TABLE_MISSING: the pinned lifecycle definition freezes terminal `
        + `classification '${requiredClassification}' but no declared injection table maps it `
        + '(a runnable-local classification without the injected whole-product-synthesis and '
        + 'ordered-smoke obligations is a settlement red)',
      );
    }
  }
  for (const declaration of applicable) {
    const derivedDigest = sha256Hex(declaration.table);
    if (
      derivedDigest !== declaration.tableDigest
      || declaration.tableRef !== `lifecycle-obligation-injection:${declaration.tableDigest}`
    ) {
      throw new Error(
        `LIFECYCLE_INJECTION_TABLE_DIGEST_MISMATCH: declared table for `
        + `'${declaration.table.classification}' is not pinned by its digest `
        + `(${declaration.tableRef}) — ad-hoc tables are never injected`,
      );
    }
  }
  return {
    pinned,
    terminalClassifications,
    injections: applicable.map(d => ({ table: d.table, tableRef: d.tableRef })),
    consumedTableRefs: applicable.map(d => d.tableRef),
  };
}

/**
 * Deterministic terminal-classification projection of a pinned lifecycle
 * definition: every outcomeRoute of every stage whose target is
 * `{ type: 'terminal', status }` contributes `status`. Data-only, ordered by
 * stage declaration then route key (both pinned by the definition hash).
 */
function terminalClassificationsOf(
  definition: Readonly<Record<string, unknown>>,
): readonly string[] {
  const stages = definition['stages'];
  if (!Array.isArray(stages)) {
    throw new Error(
      'DISCOVERY_LIFECYCLE_DEFINITION_INVALID: the pinned definition snapshot carries no stages array',
    );
  }
  const classifications: string[] = [];
  for (const stage of stages) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error('DISCOVERY_LIFECYCLE_DEFINITION_INVALID: stage entries must be objects');
    }
    const routes = (stage as Record<string, unknown>)['outcomeRoutes'];
    if (routes === undefined || routes === null) continue;
    if (typeof routes !== 'object' || Array.isArray(routes)) {
      throw new Error('DISCOVERY_LIFECYCLE_DEFINITION_INVALID: outcomeRoutes must be an object');
    }
    for (const route of Object.values(routes as Record<string, unknown>)) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
      const target = route as Record<string, unknown>;
      if (target['type'] === 'terminal' && typeof target['status'] === 'string') {
        classifications.push(target['status']);
      }
    }
  }
  return classifications;
}
