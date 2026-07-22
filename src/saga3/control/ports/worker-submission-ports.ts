/**
 * Semantic ports for the worker-submission boundary.
 *
 * MCP, SQLite and the filesystem implement these contracts. The application
 * service depends only on these interfaces and on existing Saga 3 control
 * ports. LM-facing transports may append submissions, but only the application
 * service may accept them into authoritative state.
 */

import type {
  ConditionStatus,
  EvidenceRecord,
  TrustClass,
} from '../../domain/types.js';

export interface ArtifactProposal {
  readonly submissionId: string;
  readonly executionId: string;
  readonly kind: string;
  readonly path: string;
  readonly content: string;
  readonly digest: string;
}

export interface VerificationProposal {
  readonly submissionId: string;
  readonly executionId: string;
  readonly oracleId: string;
  readonly oracleVersion: string;
  readonly command: string;
  readonly diagnosticSummary: string;
}

export type PendingWorkerSubmission =
  | { readonly kind: 'artifact'; readonly proposal: ArtifactProposal }
  | { readonly kind: 'verification'; readonly proposal: VerificationProposal };

export interface WorkerExecutionAuthority {
  readonly assignmentId: string;
  readonly workIntentId: string;
  readonly executionId: string;
  readonly episodeSpecId: string;
  readonly generation: number;
  readonly conditionType: string;
  readonly obligationId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly leaseEpoch: number;
  readonly assignmentState: 'running' | 'submitted';
  readonly sourceFingerprint: string;
  readonly environmentFingerprint: string;
}

export interface AcceptedArtifact {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly digest: string;
}

export interface CompletionAcceptance {
  readonly authority: WorkerExecutionAuthority;
  readonly artifacts: readonly AcceptedArtifact[];
  readonly evidence: EvidenceRecord | null;
  readonly conditionStatus: ConditionStatus;
  readonly workerDeclaredResult: 'completed' | 'failed';
}

export interface WorkerSubmissionRepository {
  appendArtifact(proposal: ArtifactProposal): void;
  appendVerification(proposal: VerificationProposal): void;
  loadAuthority(executionId: string): WorkerExecutionAuthority | null;
  listPending(executionId: string): readonly PendingWorkerSubmission[];
  commitCompletion(acceptance: CompletionAcceptance): void;
  listArtifacts(input: {
    readonly episodeSpecId?: string;
    readonly path?: string;
  }): readonly {
    readonly id: string;
    readonly episodeSpecId: string;
    readonly kind: string;
    readonly path: string;
    readonly digest: string;
    readonly createdAt: string;
  }[];
  listConditions(episodeSpecId: string): readonly {
    readonly conditionType: string;
    readonly status: ConditionStatus;
    readonly obligationId: string;
  }[];
}

export interface ArtifactWriter {
  write(input: {
    readonly path: string;
    readonly content: string;
    readonly expectedDigest: string;
  }): { readonly path: string; readonly digest: string };
}

export interface OracleAuthorizationPolicy {
  requiredOracle(conditionType: string): {
    readonly oracleId: string;
    readonly oracleVersion: string;
    readonly trustClass: TrustClass;
  } | null;
}
