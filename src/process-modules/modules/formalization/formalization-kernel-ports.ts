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
import type {
  ManagedArtifactProductionRecord,
  ManagedExecutionProductQuery,
  ManagedProductionLedger,
  ManagedTraceProductionRecord,
} from '../../persistence/sqlite-managed-production-ledger.js';

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
