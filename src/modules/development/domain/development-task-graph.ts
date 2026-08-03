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
    implementationItems: canonicalItems(proposal.implementationItems),
    verificationItems: canonicalItems(proposal.verificationItems),
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
    if (kind !== 'implementation' && kind !== 'verification') {
      errors.push(`${path}.kind must be implementation|verification`);
    }
    for (const key of ['key', 'taskKind', 'executionSkill', 'executionMode']) {
      if (typeof value[key] !== 'string') {
        errors.push(`${path}.${key} must be a string`);
      }
    }
    if (
      projectRepositoryId !== null
      && !Number.isInteger(projectRepositoryId)
    ) {
      errors.push(`${path}.projectRepositoryId must be integer|null`);
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
      && (projectRepositoryId === null
        || Number.isInteger(projectRepositoryId))
      && acceptanceCriterionIds
      && dependsOnKeys
      && typeof value.required === 'boolean'
    ) {
      result.push({
        key: value.key,
        kind,
        taskKind: value.taskKind,
        executionSkill: value.executionSkill,
        executionMode: value.executionMode,
        projectRepositoryId: projectRepositoryId as number | null,
        acceptanceCriterionIds,
        dependsOnKeys,
        required: value.required,
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
): DevelopmentTaskGraphItem[] {
  return items.map(item => ({
    ...item,
    acceptanceCriterionIds: [...item.acceptanceCriterionIds]
      .sort((left, right) => left - right),
    dependsOnKeys: [...item.dependsOnKeys].sort(),
  })).sort((left, right) => left.key.localeCompare(right.key));
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
