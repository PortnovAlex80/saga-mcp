/**
 * Declarative ports required to install the Development module.
 *
 * Development was rebuilt on the Formalization mechanical pattern: the module
 * Flow is lm-node + kernel-node only. The module DECLARES what it needs to
 * read/decide/persist; the infrastructure (global worker pool via
 * worker_next / worker_done / worker_merge_release) performs all execution.
 *
 * The descriptor names handlers but does not choose SQLite, Git, worker, CI or
 * human implementations. Composition supplies these ports. Every port here is
 * DECLARATIVE (read / persist / decide a pure function of its inputs). There are
 * no executive ports: the module does not hire workers, does not merge and does
 * not run tests. That is infrastructure's job.
 *
 *   ledger          — read managed-production provenance for the planner node
 *                     (the only lm node; implementation/integration/verification
 *                     run as ordinary kanban tasks driven by worker_next, not
 *                     as nodes inside this module's Flow).
 *   graph           — read canonical artifacts/traces by exact id.
 *   taskGraph       — persist a kernel-validated graph AND atomically find-or-
 *                     create its tracker task projections. Persisting a validated
 *                     graph + projecting canonical tasks is legitimate kernel
 *                     work (same tier as Formalization persisting a contract),
 *                     not execution: the module never starts a worker.
 *   settlementState — re-read exact durable products by refs/hashes carried
 *                     through the run (task-graph products, tracker tasks,
 *                     integration_state) and assemble the deterministic
 *                     DevelopmentSettlementInput. The only input to settlement;
 *                     no epic-wide "latest" lookup is allowed.
 *   outputRepository— write-once canonical store for the VerifiedIntegrationBundle.
 *   taskGraphPolicy — pure validation function over (case, graph).
 *   settlementPolicy— pure decision function over the settlement input.
 */

import type {
  ManagedNodeSubmissionReader,
} from '../../application/managed-node-submission.js';
import type {
  ManagedArtifactProductionRecord,
  ManagedExecutionProductQuery,
  ManagedProductionLedger,
  ManagedTraceProductionRecord,
} from '../../persistence/sqlite-managed-production-ledger.js';
import type {
  DevelopmentSettlementInput,
  DevelopmentTaskGraphSnapshot,
  VerifiedIntegrationBundle,
  ContentAddressedReference,
  DevelopmentCase,
} from './development-schemas.js';
import type {
  DevelopmentSettlementPolicyPort,
  DevelopmentTaskGraphPolicyPort,
} from './development-settlement-policy.js';

export const DEVELOPMENT_KERNEL_HANDLER_IDS = {
  resolveTaskGraph: 'development-resolve-task-graph',
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
   * Persist an ALREADY kernel-validated graph and atomically find-or-create its
   * task projections by stable generation key. Implementations have no access
   * to the advisory proposal, so they cannot materialize before authorization.
   *
   * Materializing the projected kanban tasks is declarative kernel work: it
   * makes work CLAIMABLE by workers, it does not hire or drive them. Workers
   * claim these tasks through the global worker_next queue (infrastructure).
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
  /**
   * Re-read exact durable products by refs/hashes carried through the run — the
   * validated task graph, the projected tracker tasks and integration_state —
   * and observe the candidate again. This is the only input to deterministic
   * settlement; no epic-wide "latest" lookup is allowed.
   *
   * The implementation reconstructs the implementation workset, integrated
   * release candidate and acceptance-verification workset as INNER data of the
   * DevelopmentSettlementInput by reading tracker state (these are no longer
   * produced by dedicated external Flow nodes).
   */
  buildSettlementInput(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): DevelopmentSettlementInput;

  /**
   * Conveyor gate: are ALL projected implementation/integration/verification
   * kanban tasks for this ProcessRun in a terminal state (done/blocked)?
   *
   * Used by settle-development to decide whether to proceed or release the run
   * to the conveyor. When this returns false, settle-development returns
   * runtimeEvent 'paused': the run pauses, orchestrate-cli drains the shared
   * worker_next queue (workers claim the todo tasks, execute code, review,
   * merge, record evidence), and once every projected task is terminal it
   * resumes the run; the generic-flow-executor re-executes settle-development
   * and this method now returns true.
   *
   * Implementations read the projected tracker task rows and their status.
   */
  areProjectedTasksTerminal(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): boolean;
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
}
