/**
 * Ports required to install the Development module.
 *
 * The descriptor names handlers/adapters but does not choose SQLite, Git,
 * worker, CI, or human implementations. Composition supplies these ports.
 * External operations return durable, payload-bound receipts so an uncertain
 * response is recovered by observation rather than by blindly repeating work.
 */

import type {
  ManagedNodeSubmissionReader,
} from '../../application/managed-node-submission.js';
import type {
  AcceptanceVerificationWorkset,
  DevelopmentCase,
  DevelopmentImplementationWorkset,
  DevelopmentSettlementInput,
  DevelopmentTaskGraphSnapshot,
  IntegratedReleaseCandidate,
  VerifiedIntegrationBundle,
  ContentAddressedReference,
} from './development-schemas.js';
import type {
  DevelopmentSettlementPolicyPort,
  DevelopmentTaskGraphPolicyPort,
} from './development-settlement-policy.js';

export const DEVELOPMENT_KERNEL_HANDLER_IDS = {
  resolveTaskGraph: 'development-resolve-task-graph',
  settle: 'development-settlement-policy',
} as const;

export const DEVELOPMENT_EXTERNAL_ADAPTER_IDS = {
  executeImplementationWorkset: 'development-execute-implementation-workset',
  integrateReleaseCandidate: 'development-integrate-release-candidate',
  verifyAcceptanceWorkset: 'development-verify-acceptance-workset',
} as const;

export type DevelopmentExternalActionKind =
  | 'implementation-workset'
  | 'candidate-integration'
  | 'acceptance-verification';

export interface DevelopmentExternalActionReceipt {
  actionKey: string;
  actionKind: DevelopmentExternalActionKind;
  payloadHash: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'uncertain';
  /** Durable product or durable failure-manifest reference. */
  resultRef: string;
  resultHash: string;
  replayed: boolean;
}

export interface DevelopmentTaskGraphPort {
  /**
   * Persist an ALREADY kernel-validated graph and atomically find-or-create its
   * task projections by stable generation key. Implementations have no access
   * to the advisory proposal, so they cannot materialize before authorization.
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

export interface DevelopmentImplementationWorksetPort {
  execute(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    /** Renew the owning ProcessRun lease while bounded workers are active. */
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    workset: DevelopmentImplementationWorkset | null;
  }>;
}

export interface DevelopmentCandidateIntegrationPort {
  /**
   * Integrate reviewed source commits with deterministic intents/CAS and freeze
   * the resulting repository + build snapshot before verification starts.
   */
  integrateAndFreeze(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    implementationWorkset: DevelopmentImplementationWorkset;
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    candidate: IntegratedReleaseCandidate | null;
  }>;
}

export interface DevelopmentAcceptanceVerificationPort {
  verify(input: {
    processRunId: number;
    actionKey: string;
    payloadHash: string;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    candidate: IntegratedReleaseCandidate;
    heartbeat: () => void;
  }): Promise<{
    receipt: DevelopmentExternalActionReceipt;
    verification: AcceptanceVerificationWorkset | null;
  }>;
}

export interface DevelopmentSettlementStatePort {
  /**
   * Re-read exact durable products by refs/hashes carried through the run and
   * observe the candidate again. This is the only input to deterministic
   * settlement; no epic-wide "latest" lookup is allowed.
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
 * Concrete composition/installation dependencies. There are intentionally no
 * defaults here: the composition root must choose every persistence/external
 * implementation explicitly.
 */
export interface DevelopmentModuleInstallationDependencies {
  plannerSubmissions: ManagedNodeSubmissionReader;
  taskGraph: DevelopmentTaskGraphPort;
  implementationWorkset: DevelopmentImplementationWorksetPort;
  candidateIntegration: DevelopmentCandidateIntegrationPort;
  acceptanceVerification: DevelopmentAcceptanceVerificationPort;
  settlementState: DevelopmentSettlementStatePort;
  outputRepository: DevelopmentOutputRepository;
  taskGraphPolicy: DevelopmentTaskGraphPolicyPort;
  settlementPolicy: DevelopmentSettlementPolicyPort;
}
