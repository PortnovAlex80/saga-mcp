/**
 * Formalization kernel ports — the deterministic handlers behind the
 * 'kernel' Flow nodes in the formalization module.
 *
 * These are PORTS (interfaces), not implementations. The formalization
 * settlement policy never imports saga2 lifecycle tools directly — it talks
 * to these ports. Production wires SQLite-backed implementations (P5); tests
 * inject fakes. This keeps the module portable: a formalization run in a
 * different persistence substrate (e.g. a future saga3-native artifact store)
 * just provides different port implementations, no policy change.
 *
 * Two ports:
 *   FormalizationArtifactGraphPort   — reads accepted artifacts + baseline +
 *                                       trace edges. Pure read; no mutation.
 *   FormalizationSettlementPolicyPort — consumes the graph + the settlement
 *                                       input, returns a decision. Pure
 *                                       function of its inputs (deterministic).
 *
 * The policy port NEVER writes — it returns a decision + payload; the caller
 * (the formalization pump in P5) is what persists the certificate via the
 * generic ProcessOutcomeCertificateRepository.
 */

import type {
  FormalizationCertificatePayload,
  FormalizationDecision,
  FormalizationReasonCode,
  FormalizationSettlementInput,
  SolutionContractBundle,
} from './formalization-schemas.js';

// ---------------------------------------------------------------------------
// Managed-production ledger interfaces (Wave 7 type-leak fix).
//
// These pure interface definitions previously lived in
// `persistence/sqlite-managed-production-ledger.ts`, which forced this module
// to import a concrete persistence adapter (a Rule 2 violation). They are now
// inlined here as a CANONICAL module-local declaration. The concrete SQLite
// implementation imports its canonical copy from the development module's
// kernel-ports and `implements ManagedProductionLedger` — infrastructure
// depends inward (dependency inversion), which is allowed. TypeScript's
// structural typing means the concrete impl satisfies this module-local
// declaration byte-for-byte (the shapes are identical), so a Formalization
// handler typed against these local interfaces accepts the shared ledger
// instance the composition root injects.
// ---------------------------------------------------------------------------

export interface ManagedExecutionProductQuery {
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
}

export interface ManagedArtifactProductionRecord {
  ledgerId: number;
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
  artifactId: number;
  artifactType: string;
  artifactStatus: string;
  contentHash: string | null;
  operation: 'create' | 'upsert' | 'update';
  recordedAt: string;
}

export interface ManagedTraceProductionRecord {
  ledgerId: number;
  processRunId: number;
  moduleRef: string;
  nodeId: string;
  intentId: number;
  taskId: number;
  executionId: string;
  traceId: number;
  sourceId: number;
  targetType: 'artifact' | 'task';
  targetId: number;
  linkType: string;
  traceHash: string;
  recordedAt: string;
}

export interface ManagedProductionLedger {
  // WAVE 6 CUTOVER: listArtifactsForExecution / listTracesForExecution were
  // REMOVED (execution-scoped product-resolution fallback retired by the
  // exact-ProductRef cutover — execution-context-assembler §9.11). The live
  // product-resolution path is listArtifactsForNodeInProcessRun (durable node-
  // scope, CGAD P18) and ProcessProductRepository.getByProductRef. Re-
  // introducing an execution-scoped lookup is forbidden by
  // tests/architecture/no-execution-scoped-lookup.test.mjs.
  /**
   * Read the durable product accumulated by one reviewed task across its
   * author/reviewer retry executions. A different recovery task is a new
   * product attempt and must write or carry an explicit product reference.
   */
  listArtifactsForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedArtifactProductionRecord[];
  listTracesForTaskInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
    taskId: number,
  ): readonly ManagedTraceProductionRecord[];
  /** Node-wide audit query. Product resolvers must not use it as fallback. */
  listArtifactsForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedArtifactProductionRecord[];
  listTracesForNodeInProcessRun(
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): readonly ManagedTraceProductionRecord[];
}

export type FormalizationArtifactStatus = 'draft' | 'in_review' | 'accepted' | 'superseded';

/**
 * Canonical tracker row used by the generic-flow resolvers. Unlike the legacy
 * aggregate graph port below, these reads are exact-id reads: a resolver first
 * obtains ids from the machine-owned managed-production ledger, then re-reads
 * only those rows and validates every fence/hash/type itself.
 */
export interface FormalizationArtifactSnapshot {
  id: number;
  projectId: number;
  epicId: number;
  type: string;
  code: string | null;
  status: FormalizationArtifactStatus;
  contentHash: string | null;
  acceptedHash: string | null;
  driftState: string;
  tags: readonly string[];
  metadata: Record<string, unknown>;
}

export interface FormalizationTraceSnapshot {
  id: number;
  sourceArtifactId: number;
  targetType: 'artifact' | 'task';
  targetId: number;
  linkType: string;
}

export interface FormalizationCanonicalGraphPort {
  readArtifactsByIds(ids: readonly number[]): readonly FormalizationArtifactSnapshot[];
  readTracesByIds(ids: readonly number[]): readonly FormalizationTraceSnapshot[];
  readOutgoingArtifactTraces(
    sourceArtifactIds: readonly number[],
  ): readonly FormalizationTraceSnapshot[];
}

/**
 * Formalization names the generic managed-production port in module language,
 * while keeping byte-for-byte type compatibility with the shared ledger.
 */
export type ManagedProductionQuery = ManagedExecutionProductQuery;
export type ManagedArtifactWriteRecord = ManagedArtifactProductionRecord;
export type ManagedTraceWriteRecord = ManagedTraceProductionRecord;
export type FormalizationManagedProductionLedger = ManagedProductionLedger;

/**
 * Read-only view of the formalization artifact graph for one episode.
 *
 * The policy uses this to verify the WHAT/HOW contract is complete and
 * traceable before issuing a certificate. It mirrors the saga2 checks
 * (acceptedBaseline + assertTraceability + assertTasksReady) but exposes them
 * through a port so the policy is not coupled to SQLite internals.
 */
export interface FormalizationArtifactGraphPort {
  /** Load the accepted PRD/FR/NFR/RULE/UC/AC/SRS artifact ids for an epic. */
  readAcceptedArtifacts(epicId: number): {
    prd: number | null;
    frs: readonly number[];
    nfrs: readonly number[];
    rules: readonly number[];
    ucs: readonly number[];
    acs: readonly number[];
    srs: number | null;
  };

  /** Compute the acceptance baseline hash from accepted AC artifacts. */
  readAcceptanceBaselineHash(epicId: number): {
    hash: string;
    /** True if every AC is accepted+clean (no drift); false otherwise. */
    clean: boolean;
    /** AC ids that failed the clean check (empty when clean=true). */
    dirty: readonly number[];
  };

  /**
   * Verify the canonical traceability edges for one episode:
   *   PRD → brief, SRS → PRD, each UC → PRD + ≥1 FR, each AC → ≥1 FR/NFR.
   * Returns the first gap (null when the graph is complete).
   */
  findFirstTraceabilityGap(epicId: number): {
    artifactType: string;
    artifactId: number;
    missingEdge: string;
    description: string;
  } | null;

  /** True if all formalization tasks for the epic are done+integrated. */
  areTasksReady(epicId: number): {
    ready: boolean;
    blockingTaskIds: readonly number[];
  };
}

/**
 * Result of running the settlement policy over a graph + input.
 */
export interface FormalizationSettlementResult {
  decision: FormalizationDecision;
  reasonCodes: readonly FormalizationReasonCode[];
  rationale: string;
  /** SHA-256 over the canonical JSON of the settlement input. Caller checks. */
  inputHash: string;
}

/**
 * The deterministic settlement policy. Given a snapshot of the artifact graph
 * + the settlement input, it returns a decision. It MUST be a pure function
 * of (graph, input) — no time, no randomness, no LM. Production wires a SQLite
 * implementation; tests inject a fake.
 */
export interface FormalizationSettlementPolicyPort {
  settle(
    graph: FormalizationArtifactGraphPort,
    input: FormalizationSettlementInput,
  ): FormalizationSettlementResult;
}

/**
 * Helper: build a FormalizationCertificatePayload from a settlement result +
 * the bundle. Pure function — used by the pump (P5) after the policy decides.
 */
export function buildFormalizationCertificatePayload(
  result: FormalizationSettlementResult,
  bundle: SolutionContractBundle,
  input: FormalizationSettlementInput,
): FormalizationCertificatePayload {
  return {
    schemaVersion: 'saga3.solution-contract-certificate.generic.v1',
    decision: result.decision,
    reasonCodes: result.reasonCodes,
    rationale: result.rationale,
    inputHash: result.inputHash,
    discoveryCertificateRef: input.discoveryCertificateRef,
    discoveryCertificateHash: input.discoveryCertificateHash,
    bundleHash: bundle.bundleHash,
    acceptanceBaselineHash: bundle.acceptanceBaselineHash,
  };
}

// ---------------------------------------------------------------------------
// Brief provisioning port (Wave 7 — Isolate modules behind ports).
//
// The formalization product resolver auto-provisions a synthetic `brief`
// artifact + PRD->brief `derived_from` trace when discovery did not register a
// brief artifact row. This used to be done via a direct `getDb()` call inside
// `ensureBriefRootTrace` (formalization-installation.ts) — a Rule 2 violation.
//
// This port lifts that side-effect behind a module-local capability. The
// composition root injects a concrete (SQLite-backed) implementation; tests
// inject fakes. The module never imports `db.ts`.
//
// The optional `BriefProvisioningPort` on `FormalizationInstallationDeps`
// currently defaults to a `getDb()`-backed adapter to keep the build green
// while the orchestrator wires the real port. Once wired, the default is
// removed and the `getDb()` import leaves the module.
// ---------------------------------------------------------------------------

export interface BriefProvisioningContext {
  projectId: number;
  epicId: number;
  processRunId: number;
  /** The PRD artifact id that needs a root ancestor trace. */
  prdArtifactId: number;
}

/**
 * Idempotently ensure a PRD has an accepted non-product root ancestor trace.
 * Returns silently when the PRD already has one; otherwise provisions a brief
 * (reusing a pre-existing accepted brief in the epic when one exists, else
 * creating a synthetic one) and attaches the `derived_from` trace.
 */
export interface BriefProvisioningPort {
  ensureBriefRoot(ctx: BriefProvisioningContext): void;
}
