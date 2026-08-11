import type Database from 'better-sqlite3';
import type { KernelHandler } from '../../../process-modules/application/kernel-handler-registry.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type { DevelopmentModuleInstallationDependencies } from '../domain/development-kernel-ports.js';
import {
  acceptanceCriterionIdentity,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  DEVELOPMENT_BASELINE_ADOPTION_SCHEMA,
  type AcceptanceCriticality,
  type DevelopmentCase,
  type DevelopmentTaskGraphProposal,
} from '../domain/development-schemas.js';
import { buildCanonicalDevelopmentTaskGraph } from '../domain/development-task-graph.js';

/**
 * Deterministic graph resolver for an authorized child run. The accepted
 * Formalization contract still defines WHAT; recovery receipts define the
 * current repository baseline. No planner may silently reinterpret either.
 */
export function createDevelopmentContinuationTaskGraphHandler(
  db: Database.Database,
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const developmentCase = requireDevelopmentCase(ctx.frame.runInput, ctx.projectId, ctx.epicId);
    const recovery = requireRecord(
      (ctx.frame.runInput as Record<string, unknown>).continuationRecovery,
      'continuation recovery',
    );
    const authorizationRef = requireString(recovery.authorizationRef, 'authorization ref');
    const adoptions = recovery.adoptions;
    if (!Array.isArray(adoptions) || adoptions.length !== 1) {
      throw new Error('DEVELOPMENT_CONTINUATION_EXACTLY_ONE_ADOPTION_REQUIRED');
    }
    const adoptionRef = requireString(
      requireRecord(adoptions[0], 'adoption').ref,
      'adoption ref',
    );
    const adoptionDigest = requireString(
      requireRecord(adoptions[0], 'adoption').digest,
      'adoption digest',
    );
    const adoption = db.prepare(
      `SELECT project_repository_id,integration_branch,integrated_commit,
              evidence_digest,covered_acceptance_criteria
         FROM factory_production_adoption_decisions
        WHERE adoption_ref=? AND continuation_ref=?`,
    ).get(adoptionRef, authorizationRef) as {
      project_repository_id: number;
      integration_branch: string;
      integrated_commit: string;
      evidence_digest: string;
      covered_acceptance_criteria: string;
    } | undefined;
    if (!adoption || adoption.evidence_digest !== adoptionDigest) {
      throw new Error('DEVELOPMENT_CONTINUATION_ADOPTION_DRIFT');
    }
    const external = requireRecord(recovery.externalBaseline, 'external baseline');
    const head = requireString(external.head, 'external baseline head');
    if (head !== adoption.integrated_commit) {
      throw new Error('DEVELOPMENT_CONTINUATION_BASELINE_HEAD_MISMATCH');
    }
    const changeScopes = stringArray(external.remainingChangeScopes, 'remaining change scopes');
    if (changeScopes.length === 0) {
      throw new Error('DEVELOPMENT_CONTINUATION_CHANGE_SCOPES_REQUIRED');
    }
    if (
      developmentCase.repositories.length !== 1
      || developmentCase.repositories[0]!.projectRepositoryId
        !== adoption.project_repository_id
    ) {
      throw new Error('DEVELOPMENT_CONTINUATION_REPOSITORY_MISMATCH');
    }
    const acceptanceCriterionIds = developmentCase.acceptanceCriteria
      .map(acceptanceCriterionIdentity)
      .sort((left, right) => left - right);
    if (acceptanceCriterionIds.length === 0) {
      throw new Error('DEVELOPMENT_CONTINUATION_ACCEPTANCE_EMPTY');
    }
    const criticality = highestCriticality(
      developmentCase.acceptanceCriteria.map(criterion => criterion.criticality),
    );
    const proposal: DevelopmentTaskGraphProposal = {
      schemaVersion: 'factory.development-task-graph-proposal.v1',
      implementationItems: [{
        key: 'continuation-integrated-repair',
        kind: 'implementation',
        taskKind: 'development.code',
        executionSkill: 'saga-managed-source-author',
        executionMode: 'artifact_change',
        projectRepositoryId: adoption.project_repository_id,
        acceptanceCriterionIds,
        dependsOnKeys: [],
        changeScopes,
        required: true,
        criticality,
      }],
      verificationItems: developmentCase.acceptanceCriteria.map((criterion, index) => ({
        key: `verify-ac-${index + 1}`,
        kind: 'verification',
        taskKind: 'verification.ac',
        executionSkill: 'saga-verifier',
        executionMode: 'read_only_evidence',
        projectRepositoryId: adoption.project_repository_id,
        acceptanceCriterionIds: [acceptanceCriterionIdentity(criterion)],
        dependsOnKeys: [],
        changeScopes: [],
        required: true,
        criticality: criterion.criticality,
      })),
      integrationTargets: [{
        projectRepositoryId: adoption.project_repository_id,
        sourceWorkItemKeys: ['continuation-integrated-repair'],
        targetBranch: adoption.integration_branch,
        expectedBaseCommit: head,
      }],
    };
    const graph = buildCanonicalDevelopmentTaskGraph(
      developmentCase,
      proposal,
      {
        schema: DEVELOPMENT_BASELINE_ADOPTION_SCHEMA,
        ref: adoptionRef,
        hash: adoptionDigest,
      },
    );
    const validation = deps.taskGraphPolicy.validate(developmentCase, graph);
    if (!validation.valid) {
      throw new Error(
        `DEVELOPMENT_CONTINUATION_GRAPH_INVALID: ${validation.errors.join('; ')}`,
      );
    }
    const materialized = deps.taskGraph.materializeValidatedTaskGraph({
      processRunId: ctx.processRunId,
      developmentCase,
      graph,
    });
    if (
      materialized.graph.graphHash !== graph.graphHash
      || sha256Hex(materialized.graph) !== sha256Hex(graph)
    ) {
      throw new Error('DEVELOPMENT_CONTINUATION_GRAPH_MATERIALIZATION_DRIFT');
    }
    return {
      event: 'valid',
      production: {
        schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
        artifactRef: materialized.reference.ref,
        contentHash: materialized.reference.hash,
        semanticDigest: graph.graphHash,
        bindings: {
          graphHash: graph.graphHash,
          items: graph.implementationItems,
          verificationItems: graph.verificationItems,
          integrationTargets: graph.integrationTargets,
          taskGraph: graph,
          resolutionStatus: 'valid',
          continuationAuthorizationRef: authorizationRef,
          adoptionRef,
        },
      },
    };
  };
}

function requireDevelopmentCase(
  value: unknown,
  projectId: number,
  epicId: number | null,
): DevelopmentCase {
  const result = requireRecord(value, 'development case');
  if (
    result.schemaVersion !== 'factory.development-case.v1'
    || result.projectId !== projectId
    || result.epicId !== epicId
    || !Array.isArray(result.acceptanceCriteria)
    || !Array.isArray(result.repositories)
  ) {
    throw new Error('DEVELOPMENT_CONTINUATION_CASE_INVALID');
  }
  return result as unknown as DevelopmentCase;
}

function highestCriticality(values: readonly AcceptanceCriticality[]): AcceptanceCriticality {
  if (values.includes('blocker')) return 'blocker';
  if (values.includes('degradable')) return 'degradable';
  return 'nice_to_have';
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`DEVELOPMENT_CONTINUATION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`DEVELOPMENT_CONTINUATION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`DEVELOPMENT_CONTINUATION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return [...new Set(value)].sort();
}
