import type Database from 'better-sqlite3';
import type { StageBinding } from '../process-modules/domain/lifecycle.js';
import {
  type ProductDeliveryLifecycleInput,
  type LegacyProductDeliveryRepositoryBinding,
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

function isPortableBinding(
  value: ProductDeliveryRepositoryBinding | LegacyProductDeliveryRepositoryBinding,
): value is ProductDeliveryRepositoryBinding {
  return 'repositoryRef' in value;
}

function portableBindingForLegacyId(
  db: Database.Database,
  projectId: number,
  binding: LegacyProductDeliveryRepositoryBinding,
): ProductDeliveryRepositoryBinding {
  const row = db.prepare(
    `SELECT r.name, pr.role, pr.integration_branch
       FROM project_repositories pr
       JOIN repositories r ON r.id=pr.repository_id
      WHERE pr.id=? AND pr.project_id=? AND pr.status='active'`,
  ).get(binding.projectRepositoryId, projectId) as {
    name: string;
    role: string;
    integration_branch: string;
  } | undefined;
  if (!row) {
    throw new Error(
      `PRODUCT_LIFECYCLE_LOCAL_REPOSITORY_ID_STALE_OR_FOREIGN: `
      + binding.projectRepositoryId,
    );
  }
  if (row.integration_branch !== binding.integrationBranch) {
    throw new Error(
      `PRODUCT_LIFECYCLE_REPOSITORY_BRANCH_MISMATCH: `
      + `${row.name}:${row.role} expected '${binding.integrationBranch}', `
      + `current '${row.integration_branch}'`,
    );
  }
  return {
    repositoryRef: {
      repositoryName: row.name,
      role: row.role,
    },
    integrationBranch: binding.integrationBranch,
    expectedBaseCommit: binding.expectedBaseCommit,
  };
}

export function canonicalizeProductDeliveryLifecycleInput(
  db: Database.Database,
  projectId: number,
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
      repositories: input.development.repositories.map(binding =>
        isPortableBinding(binding)
          ? binding
          : portableBindingForLegacyId(db, projectId, binding)),
    },
  };
}

export function resolveProductDeliveryRepositories(
  db: Database.Database,
  projectId: number,
  repositories: readonly ProductDeliveryRepositoryBinding[],
): DevelopmentRepositoryBinding[] {
  return repositories.map(repository => {
    const matches = repositoryRows(db, projectId, repository);
    const ref = `${repository.repositoryRef.repositoryName}:${repository.repositoryRef.role}`;
    if (matches.length === 0) {
      throw new Error(`PRODUCT_LIFECYCLE_REPOSITORY_REF_NOT_FOUND: ${ref}`);
    }
    if (matches.length !== 1) {
      throw new Error(`PRODUCT_LIFECYCLE_REPOSITORY_REF_AMBIGUOUS: ${ref}`);
    }
    const match = matches[0]!;
    if (match.integration_branch !== repository.integrationBranch) {
      throw new Error(
        `PRODUCT_LIFECYCLE_REPOSITORY_BRANCH_MISMATCH: ${ref} expected `
        + `'${repository.integrationBranch}', current '${match.integration_branch}'`,
      );
    }
    return {
      projectRepositoryId: match.id,
      integrationBranch: repository.integrationBranch,
      expectedBaseCommit: repository.expectedBaseCommit,
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
