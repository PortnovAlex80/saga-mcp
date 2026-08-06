import {
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

interface TaskGraphSubmitCall {
  readonly tool: 'process_node_submit';
  readonly arguments: {
    readonly schema: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
    readonly payload: {
      readonly schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
      readonly implementationItems: readonly Record<string, unknown>[];
      readonly verificationItems: readonly Record<string, unknown>[];
      readonly integrationTargets: readonly Record<string, unknown>[];
    };
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
  ) {
    return null;
  }
  if (
    candidate.acceptanceCriteria.some(criterion =>
      !Number.isInteger(criterion?.artifactId)
      || typeof criterion?.code !== 'string'
      || typeof criterion?.implementationRequired !== 'boolean')
    || candidate.repositories.some(repository =>
      !Number.isInteger(repository?.projectRepositoryId)
      || typeof repository?.integrationBranch !== 'string'
      || typeof repository?.expectedBaseCommit !== 'string')
  ) {
    return null;
  }
  return candidate as DevelopmentCase;
}

function keySuffix(code: string | null, artifactId: number): string {
  const normalized = (code ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `artifact-${artifactId}`;
}

/**
 * Build a complete, policy-submittable seed from the frozen DevelopmentCase.
 *
 * IDs, implementationRequired flags, repository bindings and expected base
 * commits come from the node input pinned by the lifecycle handoff. Mutable
 * tracker tables and the current checkout are intentionally not consulted.
 */
export function buildDevelopmentTaskGraphSubmitCallFromCase(
  developmentCase: DevelopmentCase,
): TaskGraphSubmitCall {
  const repositories = [...developmentCase.repositories]
    .sort((left, right) =>
      left.projectRepositoryId - right.projectRepositoryId);
  const primaryRepositoryId = repositories[0]!.projectRepositoryId;
  const criteria = [...developmentCase.acceptanceCriteria]
    .sort((left, right) => left.artifactId - right.artifactId);

  const implementationItems: Record<string, unknown>[] = [];
  const implementationKeyByCriterion = new Map<number, string>();
  for (const criterion of criteria) {
    if (!criterion.implementationRequired) continue;
    const key = `impl-${keySuffix(criterion.code, criterion.artifactId)}`;
    implementationKeyByCriterion.set(criterion.artifactId, key);
    implementationItems.push({
      key,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: primaryRepositoryId,
      acceptanceCriterionIds: [criterion.artifactId],
      dependsOnKeys: [],
      required: true,
      criticality: criterion.criticality,
    });
  }

  const verificationItems = criteria.map(criterion => {
    const implementationKey =
      implementationKeyByCriterion.get(criterion.artifactId);
    return {
      key: `verify-${keySuffix(criterion.code, criterion.artifactId)}`,
      kind: 'verification',
      taskKind: 'verification.ac',
      executionSkill: 'saga-verifier',
      executionMode: 'read_only_evidence',
      projectRepositoryId: primaryRepositoryId,
      acceptanceCriterionIds: [criterion.artifactId],
      dependsOnKeys: implementationKey ? [implementationKey] : [],
      required: true,
      criticality: criterion.criticality,
    };
  });

  const implementationKeys = implementationItems
    .map(item => String(item.key));
  const integrationTargets = repositories.map(repository => ({
    projectRepositoryId: repository.projectRepositoryId,
    sourceWorkItemKeys:
      repository.projectRepositoryId === primaryRepositoryId
        ? implementationKeys
        : [],
    targetBranch: repository.integrationBranch,
    expectedBaseCommit: repository.expectedBaseCommit,
  }));

  return {
    tool: 'process_node_submit',
    arguments: {
      schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      payload: {
        schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
        implementationItems,
        verificationItems,
        integrationTargets,
      },
    },
  };
}

function numberSet(values: unknown): Set<number> | null {
  if (!Array.isArray(values) || !values.every(Number.isInteger)) return null;
  return new Set(values as number[]);
}

function sameSet<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

/**
 * A prior execution draft is reusable only when its frozen IDs still match the
 * current DevelopmentCase. Semantic keys/dependencies remain model-owned.
 */
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
  const args = call.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const payload = (args as Record<string, unknown>).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const body = payload as Record<string, unknown>;
  if (
    call.tool !== 'process_node_submit'
    || (args as Record<string, unknown>).schema
      !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
    || body.schemaVersion !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA
    || !Array.isArray(body.implementationItems)
    || !Array.isArray(body.verificationItems)
    || !Array.isArray(body.integrationTargets)
  ) {
    return false;
  }

  const acceptedIds = new Set(
    developmentCase.acceptanceCriteria.map(item => item.artifactId),
  );
  const implementationRequiredIds = new Set(
    developmentCase.acceptanceCriteria
      .filter(item => item.implementationRequired)
      .map(item => item.artifactId),
  );
  const implementationIds = numberSet(
    body.implementationItems.flatMap(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).acceptanceCriterionIds as unknown[] ?? []
        : []),
  );
  const verificationIds = numberSet(
    body.verificationItems.flatMap(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).acceptanceCriterionIds as unknown[] ?? []
        : []),
  );
  const repositoryIds = numberSet(
    body.integrationTargets.map(item =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).projectRepositoryId
        : null),
  );
  const expectedRepositoryIds = new Set(
    developmentCase.repositories.map(item => item.projectRepositoryId),
  );
  return implementationIds !== null
    && verificationIds !== null
    && repositoryIds !== null
    && [...implementationRequiredIds].every(id => implementationIds.has(id))
    && [...implementationIds].every(id => acceptedIds.has(id))
    && sameSet(verificationIds, acceptedIds)
    && sameSet(repositoryIds, expectedRepositoryIds);
}

/** Package-owned callback registered at the application composition root. */
export function prepareDevelopmentWorkspaceTemplate(
  context: WorkspacePreparationInput,
): string | null {
  if (
    context.profile.id !== 'development-task-graph-planner'
    || context.materializedName !== 'task-graph-submit-call.json'
  ) {
    return null;
  }
  const developmentCase = developmentCaseFromTask(context.task);
  if (!developmentCase) return null;
  if (
    isReusableDevelopmentTaskGraphCall(
      context.currentContent,
      developmentCase,
    )
  ) {
    return null;
  }
  return `${JSON.stringify(
    buildDevelopmentTaskGraphSubmitCallFromCase(developmentCase),
    null,
    2,
  )}\n`;
}
