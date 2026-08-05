import type Database from 'better-sqlite3';
import type { StageBinding } from '../process-modules/domain/lifecycle.js';
import {
  type ProductDeliveryLifecycleInput,
  type ProductDeliveryRepositoryBinding,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import {
  DEVELOPMENT_PROCESS_MODULE_REF,
} from '../process-modules/modules/development/development-process-module.js';
import type {
  DevelopmentCase,
  DevelopmentRepositoryBinding,
} from '../modules/development/domain/development-schemas.js';

interface RepositoryRow {
  id: number;
  name: string;
  role: string;
  integration_branch: string;
}

function repositoryRows(
  db: Database.Database,
  projectId: number,
  repository: ProductDeliveryRepositoryBinding,
): RepositoryRow[] {
  return db.prepare(
    `SELECT pr.id, r.name, pr.role, pr.integration_branch
       FROM project_repositories pr
       JOIN repositories r ON r.id=pr.repository_id
      WHERE pr.project_id=?
        AND pr.status='active'
        AND r.name=?
        AND pr.role=?
      ORDER BY pr.id`,
  ).all(
    projectId,
    repository.repositoryRef.repositoryName,
    repository.repositoryRef.role,
  ) as RepositoryRow[];
}

function isPortableBinding(value: ProductDeliveryRepositoryBinding): boolean {
  return 'repositoryRef' in value;
}

export function canonicalizeProductDeliveryLifecycleInput(
  _db: Database.Database,
  _projectId: number,
  input: ProductDeliveryLifecycleInput,
): ProductDeliveryLifecycleInput & {
  development: ProductDeliveryLifecycleInput['development'] & {
    repositories: readonly ProductDeliveryRepositoryBinding[];
  };
} {
  return {
    ...input,
    development: {
      ...input.development,
      repositories: input.development.repositories.map(binding => {
        if (!isPortableBinding(binding)) {
          throw new Error('PRODUCT_LIFECYCLE_PORTABLE_REPOSITORY_REF_REQUIRED');
        }
        return binding;
      }),
    },
  };
}

export function resolveProductDeliveryRepositories(
  db: Database.Database,
  projectId: number,
  repositories: readonly (ProductDeliveryRepositoryBinding | DevelopmentRepositoryBinding)[],
): DevelopmentRepositoryBinding[] {
  return repositories.map(repository => {
    // Already resolved (has projectRepositoryId, no repositoryRef) — return as-is.
    // This happens when resolveStageInput ran on a frozen stage run whose input
    // was already resolved in a prior cycle.
    if ('projectRepositoryId' in repository && !('repositoryRef' in repository)) {
      return repository as DevelopmentRepositoryBinding;
    }
    const portable = repository as ProductDeliveryRepositoryBinding;
    const matches = repositoryRows(db, projectId, portable);
    const ref = `${portable.repositoryRef.repositoryName}:${portable.repositoryRef.role}`;
    if (matches.length === 0) {
      throw new Error(`PRODUCT_LIFECYCLE_REPOSITORY_REF_NOT_FOUND: ${ref}`);
    }
    if (matches.length !== 1) {
      throw new Error(`PRODUCT_LIFECYCLE_REPOSITORY_REF_AMBIGUOUS: ${ref}`);
    }
    const match = matches[0]!;
    if (match.integration_branch !== portable.integrationBranch) {
      throw new Error(
        `PRODUCT_LIFECYCLE_REPOSITORY_BRANCH_MISMATCH: ${ref} expected `
        + `'${portable.integrationBranch}', current '${match.integration_branch}'`,
      );
    }
    return {
      projectRepositoryId: match.id,
      integrationBranch: portable.integrationBranch,
      expectedBaseCommit: portable.expectedBaseCommit,
    };
  });
}

/**
 * Resolve portable references only at the Development execution boundary.
 * The root LifecycleRun remains portable; the frozen StageRun receives an
 * explicit runtime binding which is fenced to this database and execution.
 */
export function resolveProductDeliveryStageInput(
  db: Database.Database,
  params: {
    projectId: number;
    stage: StageBinding;
    input: unknown;
  },
): unknown {
  if (
    params.stage.moduleRef.name !== DEVELOPMENT_PROCESS_MODULE_REF.name
    || params.stage.moduleRef.version !== DEVELOPMENT_PROCESS_MODULE_REF.version
  ) {
    return params.input;
  }
  const input = params.input as DevelopmentCase & {
    repositories: ProductDeliveryRepositoryBinding[];
  };
  if (!input || typeof input !== 'object' || !Array.isArray(input.repositories)) {
    throw new Error('PRODUCT_LIFECYCLE_DEVELOPMENT_REPOSITORIES_REQUIRED');
  }
  return {
    ...input,
    repositories: resolveProductDeliveryRepositories(
      db,
      params.projectId,
      input.repositories,
    ),
  } satisfies DevelopmentCase;
}
