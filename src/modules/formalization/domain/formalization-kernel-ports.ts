/**
 * Formalization kernel ports — the deterministic handlers behind the
 * 'kernel' Flow nodes in the formalization module.
 *
 * These are PORTS (interfaces), not implementations. The formalization
 * to these ports. Production wires SQLite-backed implementations (P5); tests
 * inject fakes. This keeps the module portable: a formalization run in a
 * different persistence substrate (e.g. a future factory-native artifact store)
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
// Managed-production ledger interfaces (Wave 7 type-leak fix / refactoring A4).
//
// These pure interface definitions previously lived inlined in this file and in
// `development-kernel-ports.ts` (structurally identical duplicates). They are
// now centralized as the CANONICAL source of truth in
// `shared/managed-production.ts`. This module re-exports them so existing
// imports keep compiling; the module-local aliases below
// (FormalizationManagedProductionLedger, etc.) preserve module-local naming.
//
// The concrete SQLite implementation imports its canonical copy from the
// shared module and `implements ManagedProductionLedger` — infrastructure
// depends inward (dependency inversion), which is allowed. TypeScript's
// structural typing means the concrete impl satisfies this module-local
// declaration byte-for-byte (the shapes are identical), so a Formalization
// handler typed against these local interfaces accepts the shared ledger
// instance the composition root injects.
// ---------------------------------------------------------------------------

import type {
  ManagedExecutionProductQuery,
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
  ManagedProductionLedger,
} from '../../../process-modules/shared/managed-production.js';

export type {
  ManagedExecutionProductQuery,
  ManagedArtifactProductionRecord,
  ManagedTraceProductionRecord,
  ManagedProductionLedger,
} from '../../../process-modules/shared/managed-production.js';

export type FormalizationArtifactStatus = 'draft' | 'in_review' | 'accepted' | 'superseded';

/**
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
 * (acceptedBaseline + assertTraceability + assertTasksReady) but exposes them
 * through a port so the policy is not coupled to SQLite internals.
 */
export interface FormalizationArtifactGraphPort {
  /** Load the accepted PRD/FR/NFR/RULE/UC/AC/SRS artifact ids for an epic. */
  /**
   * ADR-078 (K6): the EXACT accepted-material read, scoped to the CURRENT
   * lifecycle run through the ownership chain. Same shape as
   * {@link readAcceptedArtifacts}; material of other lifecycle runs under
   * the same epic drops out entirely.
   */
  readAcceptedArtifactsForLifecycle(epicId: number, lifecycleRunId: number): {
    prd: number | null;
    frs: readonly number[];
    nfrs: readonly number[];
    rules: readonly number[];
    ucs: readonly number[];
    acs: readonly number[];
    srs: number | null;
  };
  /**
   * ADR-078 (K6): lifecycle-scoped acceptance-baseline hash. Same shape as
   * {@link readAcceptanceBaselineHash}.
   */
  readAcceptanceBaselineHashForLifecycle(epicId: number, lifecycleRunId: number): {
    hash: string;
    clean: boolean;
    dirty: readonly number[];
  };
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
   *
   * AUTHORITATIVE for the settlement-certificate gate (RULE-012). A second,
   * deliberately different per-node exact-set check (`findContractGap` in
   * formalization-installation.ts) validates the same five canonical edges but
   * over an in-memory ContractSnapshot with broader PRD-root acceptance and an
   * aggregated-string return shape. The two are NOT duplicates — see the
   * DUPLICATE NOTICE in findContractGap's docblock for the full comparison.
   */
  findFirstTraceabilityGap(epicId: number): {
    artifactType: string;
    artifactId: number;
    missingEdge: string;
    description: string;
  } | null;

  /**
   * True if all formalization tasks of the epic that belong to the CURRENT
   * lifecycle run are done+integrated (workplace loop_state='terminal', plus
   * integration_state='merged' for git_change tasks).
   *
   * TB-11 (gate poisoning): readiness MUST be scoped to `lifecycleRunId`.
   * Tasks join their workplace by workplace_ref, and one epic accumulates
   * workplace rows across ALL of its lifecycle runs; a workplace frozen by a
   * DEAD previous run must not poison the settlement of a new run. Tasks whose
   * workplace belongs to an older lifecycle run are not gateable at all — they
   * belong to the dead run, not to this settlement.
   */
  areTasksReady(epicId: number, lifecycleRunId: number): {
    ready: boolean;
    blockingTaskIds: readonly number[];
  };

  /**
   * Resolve the lifecycle run that owns a process run (TB-11).
   *
   * WHY a graph-port method instead of a ctx field: KernelHandlerContext
   * carries processRunId but not the owning lifecycle run id, and threading
   * one through the executor's context construction lives outside this
   * module's boundary. factory_stage_runs is the authoritative
   * (process_run_id → lifecycle_run_id) mapping — its process_run_id is
   * UNIQUE, so the lookup is exact. Returns null when the process run is not
   * (yet) attached to a lifecycle run; callers must fail closed on that.
   */
  readOwningLifecycleRunId(processRunId: number): number | null;
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
 * of (graph, input, lifecycleRunId) — no time, no randomness, no LM.
 * Production wires a SQLite implementation; tests inject a fake.
 *
 * `lifecycleRunId` is passed out-of-band (not inside the input) on purpose:
 * the input is hashed into `inputHash` as the settlement contract, and the
 * lifecycle run is orchestration scoping (TB-11), not contract content — the
 * same accepted contract settles identically in any run of the lifecycle.
 */
export interface FormalizationSettlementPolicyPort {
  settle(
    graph: FormalizationArtifactGraphPort,
    input: FormalizationSettlementInput,
    lifecycleRunId: number,
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
    schemaVersion: 'factory.solution-contract-certificate.generic.v1',
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
