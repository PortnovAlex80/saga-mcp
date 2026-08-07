/**
 * Declarative ports required to install the Development module.
 *
 * Development declares what it needs to read, decide and persist. Universal
 * Production Cells own author, reviewer and verification desks; the global
 * dispatcher performs physical execution.
 *
 * The descriptor names handlers but does not choose SQLite, Git, worker, CI or
 * human implementations. Composition supplies these ports. Every port here is
 * DECLARATIVE (read / persist / decide a pure function of its inputs). There are
 * no executive ports: the module does not hire workers, does not merge and does
 * not run tests. That is infrastructure's job.
 *
 *   ledger          — read managed-production provenance for the planner node.
 *   graph           — read canonical artifacts/traces by exact id.
 *   taskGraph       — persist a kernel-validated graph.
 *   settlementState — read sealed cell products by exact refs/hashes and assemble the deterministic
 *                     DevelopmentSettlementInput. The only input to settlement;
 *                     no epic-wide "latest" lookup is allowed.
 *   outputRepository— write-once canonical store for the VerifiedIntegrationBundle.
 *   taskGraphPolicy — pure validation function over (case, graph).
 *   settlementPolicy— pure decision function over the settlement input.
 */

import type {
  ManagedNodeSubmissionReader,
} from '../../../process-modules/application/managed-node-submission.js';
import type {
  ProcessOutcomeCertificateRepository,
} from '../../../process-modules/persistence/process-outcome-certificate-repository.js';
import type {
  DevelopmentSettlementInput,
  DevelopmentTaskGraphSnapshot,
  IntegratedReleaseCandidate,
  VerifiedIntegrationBundle,
  ContentAddressedReference,
  DevelopmentCase,
} from './development-schemas.js';

// ---------------------------------------------------------------------------
// Managed-production ledger interfaces (Wave 7 type-leak fix / refactoring A4).
//
// These pure interface definitions previously lived inlined in this file and in
// `formalization-kernel-ports.ts` (structurally identical duplicates). They are
// now centralized as the CANONICAL source of truth in
// `shared/managed-production.ts`. This module re-exports them so existing
// imports keep compiling; the module-local aliases below
// (DevelopmentManagedProductionLedger, etc.) preserve module-local naming.
//
// The concrete SQLite implementation in
// `persistence/sqlite-managed-production-ledger.ts` imports them and
// `implements ManagedProductionLedger` — infrastructure depends inward
// (dependency inversion), which is allowed. No module ever imports the
// concrete persistence file.
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
import type {
  DevelopmentSettlementPolicyPort,
  DevelopmentTaskGraphPolicyPort,
} from './development-settlement-policy.js';

export const DEVELOPMENT_KERNEL_HANDLER_IDS = {
  resolveTaskGraph: 'development-resolve-task-graph',
  freezeIntegratedCandidate: 'development-freeze-integrated-candidate',
  settle: 'development-settlement-policy',
} as const;

/**
 * Canonical tracker row used by the development resolver. Mirrors the
 * Formalization canonical-graph snapshot shape so the resolver re-reads only
 * exact ids obtained from the managed-production ledger and validates every
 * fence/hash/type itself. Pure read; no mutation.
 */
export interface DevelopmentArtifactSnapshot {
  id: number;
  projectId: number;
  epicId: number;
  type: string;
  code: string | null;
  status: string;
  contentHash: string | null;
  acceptedHash: string | null;
  driftState: string;
  tags: readonly string[];
  metadata: Record<string, unknown>;
}

export interface DevelopmentTraceSnapshot {
  id: number;
  sourceArtifactId: number;
  targetType: 'artifact' | 'task';
  targetId: number;
  linkType: string;
}

/**
 * Read-only view of the canonical artifact graph. The development resolver uses
 * this to re-read exact ids the managed-production ledger points at. Pure read.
 */
export interface DevelopmentCanonicalGraphPort {
  readArtifactsByIds(ids: readonly number[]): readonly DevelopmentArtifactSnapshot[];
  readTracesByIds(ids: readonly number[]): readonly DevelopmentTraceSnapshot[];
  readOutgoingArtifactTraces(
    sourceArtifactIds: readonly number[],
  ): readonly DevelopmentTraceSnapshot[];
}

/**
 * Development names the generic managed-production ledger in module language,
 * while keeping byte-for-byte type compatibility with the shared ledger.
 */
export type DevelopmentManagedProductionLedger = ManagedProductionLedger;
export type DevelopmentManagedProductionQuery = ManagedExecutionProductQuery;
export type DevelopmentArtifactWriteRecord = ManagedArtifactProductionRecord;
export type DevelopmentTraceWriteRecord = ManagedTraceProductionRecord;

export interface DevelopmentTaskGraphPort {
  /**
   * Persist an already kernel-validated graph. Implementations have no access
   * to the advisory proposal, so they cannot persist before authorization.
   */
  materializeValidatedTaskGraph(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    graph: DevelopmentTaskGraphSnapshot;
  }): {
    graph: DevelopmentTaskGraphSnapshot;
    reference: ContentAddressedReference;
  };
}

export interface DevelopmentSettlementStatePort {
  freezeIntegratedCandidate(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }):
    | { status: 'frozen'; candidate: IntegratedReleaseCandidate; reference: ContentAddressedReference }
    | { status: 'waiting'; reasonCodes: readonly string[] }
    | { status: 'failed'; reasonCodes: readonly string[] };

  /**
   * Re-read the validated task graph and accepted cell products by exact
   * refs/hashes, then observe the candidate again. This is the only input to deterministic
   * settlement; no epic-wide "latest" lookup is allowed.
   *
   * The implementation reconstructs the implementation workset, integrated
   * release candidate and acceptance-verification workset as INNER data of the
   * DevelopmentSettlementInput from sealed CandidateSets.
   */
  buildSettlementInput(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): DevelopmentSettlementInput;

}

export interface DevelopmentOutputRecord {
  processRunId: number;
  projectId: number;
  epicId: number;
  artifactRef: string;
  contentHash: string;
  payload: VerifiedIntegrationBundle;
}

/**
 * Durable canonical output store. `contentHash` is SHA-256 over the complete
 * payload (including its internal bundleHash); this is the hash exposed by
 * ProcessModuleOutput and independently checked during lifecycle handoff.
 */
export interface DevelopmentOutputRepository {
  persist(input: {
    processRunId: number;
    projectId: number;
    epicId: number;
    payload: VerifiedIntegrationBundle;
  }): {
    record: DevelopmentOutputRecord;
    replayed: boolean;
  };
  readByProcessRun(processRunId: number): DevelopmentOutputRecord | null;
}

/**
 * Driver-neutral port for the v1 process-product repository (keyed by
 * processRunId + productKind). Development's settlement state reads/writes its
 * task-graph product through this surface; the concrete SQLite implementation
 * is supplied by the composition root. Defined inline (record types only) so
 * the module does not import the concrete `SqliteProcessProductRepository`
 * adapter — Wave 7 hex extraction.
 */
export interface ProcessProductReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface ProcessProductRecord<T = unknown> {
  processRunId: number;
  productKind: string;
  reference: ProcessProductReference;
  payload: T;
  payloadHash: string;
  createdAt: string;
}

export interface ProcessProductRepositoryPort {
  persist<T>(input: {
    processRunId: number;
    productKind: string;
    schema: string;
    productHash: string;
    payload: T;
    artifactRefPrefix: string;
  }): { record: ProcessProductRecord<T>; replayed: boolean };
  read<T>(processRunId: number, productKind: string): ProcessProductRecord<T> | null;
}

/**
 * Driver-neutral git side-effect port (Wave 7 hex extraction). Development's
 * settlement reads commit/tree hashes from a repository checkout; this port
 * isolates the `git` shell-out so the module has no `child_process` import.
 * Implementations live in infrastructure; the module speaks only read-only git
 * queries (no writes — committing/merging is the worker's job, not the module).
 */
export interface GitPort {
  /** Run `git -C repoPath <args>` and return trimmed stdout, or null on failure. */
  read(repoPath: string, args: readonly string[]): string | null;
  /** Run `git -C repoPath <args>` and return whether it exited 0. */
  ok(repoPath: string, args: readonly string[]): boolean;
}

/**
 * Driver-neutral machine-identity port (Wave 7). Replaces `os.hostname()`
 * inside the module so it has no `node:os` import.
 */
export interface MachinePort {
  hostname(): string;
}

/**
 * Concrete composition/installation dependencies. There are intentionally no
 * defaults here: the composition root must choose every persistence
 * implementation explicitly. There are NO executive ports — the module does not
 * hire, merge or test; that is the infrastructure's job.
 */
export interface DevelopmentModuleInstallationDependencies {
  plannerSubmissions: ManagedNodeSubmissionReader;
  ledger: DevelopmentManagedProductionLedger;
  graph: DevelopmentCanonicalGraphPort;
  taskGraph: DevelopmentTaskGraphPort;
  settlementState: DevelopmentSettlementStatePort;
  outputRepository: DevelopmentOutputRepository;
  taskGraphPolicy: DevelopmentTaskGraphPolicyPort;
  settlementPolicy: DevelopmentSettlementPolicyPort;
  /**
   * Uncle Bob Wave 4 — the settlement kernel now AUTHORS its own certificate
   * (issuing it through this repo) and emits an explicit ModuleCompletion that
   * points at the resulting certificateRef. Previously the generic-flow-executor
   * issued the certificate from the magic-bindings branch on settlement's
   * behalf; Wave 5 will delete that branch. The kernel became the single
   * authority for its certificate the moment it started emitting completion.
   *
   * Mirrors how Discovery already issues its certificate through its own
   * settlement service before binding the ref.
   */
  certificateRepository: ProcessOutcomeCertificateRepository;
}
