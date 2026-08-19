/**
 * Pure Development proposal decoding and canonical graph construction.
 *
 * No task or repository write is allowed here. The resulting snapshot is
 * passed through DevelopmentTaskGraphPolicy before the materialization port is
 * invoked.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  acceptanceCriterionIdentity,
  type CandidateIntegrationTarget,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentTaskGraphItem,
  type DevelopmentTaskGraphProposal,
  type DevelopmentTaskGraphSnapshot,
} from './development-schemas.js';

export type DevelopmentProposalDecodeResult =
  | { ok: true; value: DevelopmentTaskGraphProposal }
  | { ok: false; errors: readonly string[] };

export function decodeDevelopmentTaskGraphProposal(
  payload: unknown,
): DevelopmentProposalDecodeResult {
  const errors: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, errors: ['proposal must be a JSON object'] };
  }
  if (payload.schemaVersion !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA) {
    errors.push(
      `schemaVersion must be ${DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA}`,
    );
  }
  const implementationItems = decodeItems(
    payload.implementationItems,
    'implementationItems',
    errors,
  );
  const verificationItems = decodeItems(
    payload.verificationItems,
    'verificationItems',
    errors,
  );
  const integrationTargets = decodeTargets(
    payload.integrationTargets,
    errors,
  );
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      implementationItems: implementationItems!,
      verificationItems: verificationItems!,
      integrationTargets: integrationTargets!,
    },
  };
}

export function buildCanonicalDevelopmentTaskGraph(
  developmentCase: DevelopmentCase,
  proposal: DevelopmentTaskGraphProposal,
  plannerSubmission: ContentAddressedReference,
): DevelopmentTaskGraphSnapshot {
  const body = {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_SCHEMA,
    epicId: developmentCase.epicId,
    formalizationCertificateHash:
      developmentCase.formalizationCertificate.hash,
    solutionContractHash: developmentCase.solutionContract.hash,
    acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
    srsHash: developmentCase.srs.hash,
    plannerSubmission: { ...plannerSubmission },
    implementationItems: canonicalItems(proposal.implementationItems, developmentCase),
    verificationItems: canonicalItems(proposal.verificationItems, developmentCase),
    integrationTargets: canonicalTargets(proposal.integrationTargets),
  } as const;
  return {
    ...body,
    graphHash: sha256Hex(body),
  };
}

function decodeItems(
  raw: unknown,
  label: string,
  errors: string[],
): DevelopmentTaskGraphItem[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  const result: DevelopmentTaskGraphItem[] = [];
  raw.forEach((value, index) => {
    const path = `${label}[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const kind = value.kind;
    const projectRepositoryId = value.projectRepositoryId;
    const acceptanceCriterionIds = integerArray(
      value.acceptanceCriterionIds,
      `${path}.acceptanceCriterionIds`,
      errors,
    );
    const dependsOnKeys = stringArray(
      value.dependsOnKeys,
      `${path}.dependsOnKeys`,
      errors,
    );
    const changeScopes = stringArray(
      value.changeScopes,
      `${path}.changeScopes`,
      errors,
    );
    if (kind !== 'implementation' && kind !== 'verification') {
      errors.push(`${path}.kind must be implementation|verification`);
    }
    for (const key of ['key', 'taskKind', 'executionSkill', 'executionMode']) {
      if (typeof value[key] !== 'string') {
        errors.push(`${path}.${key} must be a string`);
      }
    }
    if (!Number.isInteger(projectRepositoryId)) {
      errors.push(`${path}.projectRepositoryId must be an integer`);
    }
    if (typeof value.required !== 'boolean') {
      errors.push(`${path}.required must be a boolean`);
    }
    if (
      (kind === 'implementation' || kind === 'verification')
      && typeof value.key === 'string'
      && typeof value.taskKind === 'string'
      && typeof value.executionSkill === 'string'
      && typeof value.executionMode === 'string'
      && Number.isInteger(projectRepositoryId)
      && acceptanceCriterionIds
      && dependsOnKeys
      && changeScopes
      && typeof value.required === 'boolean'
    ) {
      const criticalityRaw = value.criticality;
      if (
        criticalityRaw !== 'blocker'
        && criticalityRaw !== 'degradable'
        && criticalityRaw !== 'nice_to_have'
      ) {
        errors.push(`${path}.criticality must be blocker|degradable|nice_to_have`);
        return;
      }
      const criticality = criticalityRaw;
      result.push({
        key: value.key,
        kind,
        taskKind: value.taskKind,
        executionSkill: value.executionSkill,
        executionMode: value.executionMode,
        projectRepositoryId: projectRepositoryId as number,
        acceptanceCriterionIds,
        dependsOnKeys,
        changeScopes,
        required: value.required,
        criticality,
      });
    }
  });
  return result;
}

function decodeTargets(
  raw: unknown,
  errors: string[],
): CandidateIntegrationTarget[] | null {
  if (!Array.isArray(raw)) {
    errors.push('integrationTargets must be an array');
    return null;
  }
  const result: CandidateIntegrationTarget[] = [];
  raw.forEach((value, index) => {
    const path = `integrationTargets[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const sourceWorkItemKeys = stringArray(
      value.sourceWorkItemKeys,
      `${path}.sourceWorkItemKeys`,
      errors,
    );
    if (!Number.isInteger(value.projectRepositoryId)) {
      errors.push(`${path}.projectRepositoryId must be an integer`);
    }
    if (typeof value.targetBranch !== 'string') {
      errors.push(`${path}.targetBranch must be a string`);
    }
    if (typeof value.expectedBaseCommit !== 'string') {
      errors.push(`${path}.expectedBaseCommit must be a string`);
    }
    if (
      Number.isInteger(value.projectRepositoryId)
      && typeof value.targetBranch === 'string'
      && typeof value.expectedBaseCommit === 'string'
      && sourceWorkItemKeys
    ) {
      result.push({
        projectRepositoryId: value.projectRepositoryId as number,
        sourceWorkItemKeys,
        targetBranch: value.targetBranch,
        expectedBaseCommit: value.expectedBaseCommit,
      });
    }
  });
  return result;
}

function canonicalItems(
  items: readonly DevelopmentTaskGraphItem[],
  developmentCase: DevelopmentCase,
): DevelopmentTaskGraphItem[] {
  // AC-drift relay: the kernel derives each item's coveredConstraintIds as
  // the union over the FROZEN criteria the item references — the planner
  // proposes acceptanceCriterionIds only; coverage is inherited, never
  // proposed, so it cannot be forged or silently dropped at the handoff.
  const coverageByCriterionId = new Map<number, readonly string[]>();
  for (const criterion of developmentCase.acceptanceCriteria) {
    if (criterion.coveredConstraintIds && criterion.coveredConstraintIds.length > 0) {
      coverageByCriterionId.set(
        acceptanceCriterionIdentity(criterion),
        criterion.coveredConstraintIds,
      );
    }
  }
  return items.map(item => {
    const inherited = [...new Set(
      item.acceptanceCriterionIds
        .flatMap(id => coverageByCriterionId.get(id) ?? []),
    )].sort();
    return {
      ...item,
      acceptanceCriterionIds: [...item.acceptanceCriterionIds]
        .sort((left, right) => left - right),
      dependsOnKeys: [...item.dependsOnKeys].sort(),
      changeScopes: [...(item.changeScopes
        ?? (item.kind === 'implementation' ? [`work-item:${item.key}`] : []))].sort(),
      ...(inherited.length > 0 ? { coveredConstraintIds: inherited } : {}),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function canonicalTargets(
  targets: readonly CandidateIntegrationTarget[],
): CandidateIntegrationTarget[] {
  return targets.map(target => ({
    ...target,
    sourceWorkItemKeys: [...target.sourceWorkItemKeys].sort(),
  })).sort((left, right) =>
    left.projectRepositoryId - right.projectRepositoryId);
}

function integerArray(
  raw: unknown,
  label: string,
  errors: string[],
): number[] | null {
  if (!Array.isArray(raw) || !raw.every(Number.isInteger)) {
    errors.push(`${label} must be an integer array`);
    return null;
  }
  return raw as number[];
}

function stringArray(
  raw: unknown,
  label: string,
  errors: string[],
): string[] | null {
  if (!Array.isArray(raw) || !raw.every(value => typeof value === 'string')) {
    errors.push(`${label} must be a string array`);
    return null;
  }
  return raw as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
