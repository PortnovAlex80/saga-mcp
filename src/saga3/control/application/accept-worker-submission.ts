/**
 * Application service for accepting worker submissions.
 *
 * This is the single authority boundary between an LM-facing transport and
 * authoritative Saga 3 state. The worker can submit artifact content and a
 * proposed verification procedure. It cannot write evidence, select trust,
 * or mutate a condition.
 */

import { createHash } from 'node:crypto';
import type {
  ConditionStatus,
  EvidenceRecord,
  EvidenceVerdict,
} from '../../domain/types.js';
import type {
  Clock,
  IdSource,
  OraclePort,
} from '../../ports/ports.js';
import type {
  ArtifactProposal,
  ArtifactWriter,
  OracleAuthorizationPolicy,
  VerificationProposal,
  WorkerSubmissionRepository,
} from '../ports/worker-submission-ports.js';

export interface AcceptWorkerSubmissionDependencies {
  readonly submissions: WorkerSubmissionRepository;
  readonly artifacts: ArtifactWriter;
  readonly oracle: OraclePort;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly oraclePolicy: OracleAuthorizationPolicy;
}

export class AcceptWorkerSubmission {
  constructor(private readonly deps: AcceptWorkerSubmissionDependencies) {}

  proposeArtifact(input: {
    readonly executionId: string;
    readonly kind: string;
    readonly path: string;
    readonly content: string;
    readonly digest?: string;
  }): { readonly submissionId: string } {
    this.requireAuthority(input.executionId);
    const computedDigest = sha256(input.content);
    if (input.digest && input.digest !== computedDigest) {
      throw new Error('Artifact digest does not match submitted content.');
    }

    const proposal: ArtifactProposal = {
      submissionId: this.deps.ids.next('submission'),
      executionId: input.executionId,
      kind: input.kind,
      path: input.path,
      content: input.content,
      digest: computedDigest,
    };
    this.deps.submissions.appendArtifact(proposal);
    return { submissionId: proposal.submissionId };
  }

  proposeVerification(input: {
    readonly executionId: string;
    readonly oracleId: string;
    readonly oracleVersion: string;
    readonly command: string;
    readonly diagnosticSummary?: string;
  }): { readonly submissionId: string } {
    const authority = this.requireAuthority(input.executionId);
    const required = this.deps.oraclePolicy.requiredOracle(authority.conditionType);
    if (!required) {
      throw new Error(`No oracle policy is registered for ${authority.conditionType}.`);
    }
    if (required.oracleId !== input.oracleId || required.oracleVersion !== input.oracleVersion) {
      throw new Error(
        `Condition ${authority.conditionType} requires ${required.oracleId}@${required.oracleVersion}.`,
      );
    }
    if (input.command.trim().length === 0) {
      throw new Error('Verification proposal requires a non-empty command.');
    }

    const proposal: VerificationProposal = {
      submissionId: this.deps.ids.next('submission'),
      executionId: input.executionId,
      oracleId: input.oracleId,
      oracleVersion: input.oracleVersion,
      command: input.command,
      diagnosticSummary: input.diagnosticSummary ?? '',
    };
    this.deps.submissions.appendVerification(proposal);
    return { submissionId: proposal.submissionId };
  }

  async complete(input: {
    readonly executionId: string;
    readonly workerDeclaredResult: 'completed' | 'failed';
  }): Promise<{
    readonly conditionStatus: ConditionStatus;
    readonly acceptedArtifactIds: readonly string[];
    readonly evidenceId: string | null;
  }> {
    const authority = this.requireAuthority(input.executionId);
    const pending = this.deps.submissions.listPending(input.executionId);

    const acceptedArtifacts = pending
      .filter((item) => item.kind === 'artifact')
      .map((item) => {
        if (item.kind !== 'artifact') {
          throw new Error('Unreachable artifact submission branch.');
        }
        const written = this.deps.artifacts.write({
          path: item.proposal.path,
          content: item.proposal.content,
          expectedDigest: item.proposal.digest,
        });
        return {
          id: this.deps.ids.next('artifact'),
          kind: item.proposal.kind,
          path: written.path,
          digest: written.digest,
        };
      });

    const verification = [...pending]
      .reverse()
      .find((item) => item.kind === 'verification');

    let evidence: EvidenceRecord | null = null;
    let conditionStatus: ConditionStatus = 'Unknown';

    if (verification?.kind === 'verification') {
      const required = this.deps.oraclePolicy.requiredOracle(authority.conditionType);
      if (!required) {
        throw new Error(`No oracle policy is registered for ${authority.conditionType}.`);
      }
      if (
        verification.proposal.oracleId !== required.oracleId
        || verification.proposal.oracleVersion !== required.oracleVersion
      ) {
        throw new Error('Stored verification proposal no longer matches oracle policy.');
      }

      const observation = await this.deps.oracle.observe(
        {
          oracleId: required.oracleId,
          oracleVersion: required.oracleVersion,
          generation: authority.generation,
          command: verification.proposal.command,
        },
        this.deps.clock.deadline(15 * 60 * 1000),
      );
      const verdict = normalizeVerdict(observation.verdict, observation.executed);
      evidence = {
        id: this.deps.ids.next('evidence'),
        episodeSpecId: authority.episodeSpecId,
        conditionType: authority.conditionType,
        obligationId: authority.obligationId,
        generation: authority.generation,
        sourceFingerprint: authority.sourceFingerprint,
        environmentFingerprint: authority.environmentFingerprint,
        oracleId: required.oracleId,
        oracleVersion: required.oracleVersion,
        trustClass: required.trustClass,
        verdict,
        rawDigest: observation.rawDigest,
        observedAt: this.deps.clock.now(),
        freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      };
      conditionStatus = verdict === 'passed'
        ? 'True'
        : verdict === 'failed'
          ? 'False'
          : 'Unknown';
    }

    this.deps.submissions.commitCompletion({
      authority,
      artifacts: acceptedArtifacts,
      evidence,
      conditionStatus,
      workerDeclaredResult: input.workerDeclaredResult,
    });

    return {
      conditionStatus,
      acceptedArtifactIds: acceptedArtifacts.map((artifact) => artifact.id),
      evidenceId: evidence?.id ?? null,
    };
  }

  private requireAuthority(executionId: string) {
    const authority = this.deps.submissions.loadAuthority(executionId);
    if (!authority) {
      throw new Error(`No active Saga 3 assignment for execution ${executionId}.`);
    }
    if (authority.assignmentState !== 'running' && authority.assignmentState !== 'submitted') {
      throw new Error(`Assignment ${authority.assignmentId} is not accepting submissions.`);
    }
    return authority;
  }
}

function normalizeVerdict(verdict: string, executed: boolean): EvidenceVerdict {
  if (!executed) return 'unknown';
  if (verdict === 'passed' || verdict === 'failed' || verdict === 'unknown' || verdict === 'error') {
    return verdict;
  }
  return 'error';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
