import {
  acceptanceCriterionIdentity,
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  type DevelopmentCase,
} from '../domain/development-schemas.js';

interface WorkspacePreparationInput {
  readonly profile: { readonly id: string };
  readonly task: { readonly metadata?: string | Record<string, unknown> | null };
  readonly materializedName: string;
  readonly currentContent: string;
}

interface TaskGraphProductCall {
  readonly schema: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
  readonly content: {
    readonly schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
    readonly implementationItems: readonly Record<string, unknown>[];
    readonly verificationItems: readonly Record<string, unknown>[];
    readonly integrationTargets: readonly Record<string, unknown>[];
  };
}

function metadataRecord(
  value: WorkspacePreparationInput['task']['metadata'],
): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function developmentCaseFromTask(
  task: WorkspacePreparationInput['task'],
): DevelopmentCase | null {
  const value = metadataRecord(task.metadata).process_node_input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DevelopmentCase>;
  if (
    candidate.schemaVersion !== DEVELOPMENT_CASE_SCHEMA
    || !Array.isArray(candidate.acceptanceCriteria)
    || candidate.acceptanceCriteria.length === 0
    || !Array.isArray(candidate.repositories)
    || candidate.repositories.length === 0
  ) return null;
  if (
    candidate.acceptanceCriteria.some(criterion =>
      !Number.isInteger(criterion?.artifactId)
      || typeof criterion?.code !== 'string'
      || typeof criterion?.implementationRequired !== 'boolean')
    || candidate.repositories.some(repository =>
      !Number.isInteger(repository?.projectRepositoryId)
      || typeof repository?.integrationBranch !== 'string'
      || typeof repository?.expectedBaseCommit !== 'string')
  ) return null;
  return candidate as DevelopmentCase;
}

function keySuffix(code: string | null, artifactId: number): string {
  const normalized = (code ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `artifact-${artifactId}`;
}

/**
 * Machine-fill only immutable lineage scaffolding from the frozen
 * DevelopmentCase. Implementation decomposition remains planner-owned; AC
 * cardinality never silently becomes implementation task cardinality.
 */
export function buildDevelopmentTaskGraphSubmitCallFromCase(
  developmentCase: DevelopmentCase,
): TaskGraphProductCall {
  const repositories = [...developmentCase.repositories]
    .sort((left, right) =>
      left.projectRepositoryId - right.projectRepositoryId);
  const criteria = [...developmentCase.acceptanceCriteria]
    .sort((left, right) => left.artifactId - right.artifactId);

  const implementationItems: Record<string, unknown>[] = [];
  const verificationItems = criteria.map(criterion => ({
    key: `verify-${keySuffix(criterion.code, criterion.artifactId)}`,
    kind: 'verification',
    taskKind: 'verification.ac',
    executionSkill: 'saga-verifier',
    executionMode: 'read_only_evidence',
    projectRepositoryId: repositories.length === 1
      ? repositories[0]!.projectRepositoryId
      : 0,
    acceptanceCriterionKeys: [acceptanceCriterionIdentity(criterion)],
    dependsOnKeys: [],
    changeScopes: [],
    required: true,
    criticality: criterion.criticality,
    // AC-drift relay: the frozen criterion's constraint coverage rides the
    // machine-filled card (absent when the criterion carries none).
    ...(criterion.coveredConstraintIds && criterion.coveredConstraintIds.length > 0
      ? { coveredConstraintIds: [...criterion.coveredConstraintIds] }
      : {}),
  }));
  const integrationTargets = repositories.map(repository => ({
    projectRepositoryId: repository.projectRepositoryId,
    sourceWorkItemKeys: [],
    targetBranch: repository.integrationBranch,
    expectedBaseCommit: repository.expectedBaseCommit,
  }));

  return {
    schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    content: {
      schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      implementationItems,
      verificationItems,
      integrationTargets,
    },
  };
}

function numberSet(values: unknown): Set<number> | null {
  if (!Array.isArray(values) || !values.every(Number.isInteger)) return null;
  return new Set(values as number[]);
}

function keySet(values: unknown): Set<string> | null {
  if (!Array.isArray(values) || !values.every(v => typeof v === 'string')) return null;
  return new Set(values as string[]);
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

export function isReusableDevelopmentTaskGraphCall(
  content: string,
  developmentCase: DevelopmentCase,
): boolean {
  let call: Record<string, unknown>;
  try {
    call = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return false;
  }
  const body = call.content;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const product = body as Record<string, unknown>;
  if (
    call.schema !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
    || product.schemaVersion !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
    || !Array.isArray(product.implementationItems)
    || !Array.isArray(product.verificationItems)
    || !Array.isArray(product.integrationTargets)
  ) return false;

  const acceptedKeys = new Set(
    developmentCase.acceptanceCriteria.map(acceptanceCriterionIdentity),
  );
  const implementationRequiredKeys = new Set(
    developmentCase.acceptanceCriteria
      .filter(item => item.implementationRequired)
      .map(acceptanceCriterionIdentity),
  );
  const implementationKeys = keySet(
    product.implementationItems.flatMap(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).acceptanceCriterionKeys as unknown[] ?? []
        : []),
  );
  const verificationKeys = keySet(
    product.verificationItems.flatMap(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).acceptanceCriterionKeys as unknown[] ?? []
        : []),
  );
  const repositoryIds = numberSet(
    product.integrationTargets.map(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).projectRepositoryId
        : null),
  );
  const expectedRepositoryIds = new Set(
    developmentCase.repositories.map(item => item.projectRepositoryId),
  );
  return implementationKeys !== null
    && verificationKeys !== null
    && repositoryIds !== null
    && [...implementationRequiredKeys].every(key => implementationKeys.has(key))
    && [...implementationKeys].every(key => acceptedKeys.has(key))
    && sameSet(verificationKeys, acceptedKeys)
    && sameSet(repositoryIds, expectedRepositoryIds);
}

export function prepareDevelopmentWorkspaceTemplate(
  context: WorkspacePreparationInput,
): string | null {
  if (
    context.profile.id !== 'development-task-graph-planner'
    || context.materializedName !== 'task-graph-submit-call.json'
  ) return null;
  const developmentCase = developmentCaseFromTask(context.task);
  if (!developmentCase) return null;
  if (isReusableDevelopmentTaskGraphCall(context.currentContent, developmentCase)) {
    return null;
  }
  return `${JSON.stringify(
    buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase),
    null,
    2,
  )}\n`;
}
