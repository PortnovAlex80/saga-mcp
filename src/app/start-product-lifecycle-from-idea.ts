/**
 * Application use case: start a Product Delivery Lifecycle from a bare idea.
 *
 * A bare idea has no release policy and no operator authorization. The
 * assembler records an explicit, content-addressed deferred Delivery profile.
 * Delivery can therefore settle as `approval-required` without inventing a
 * release channel, version, action plan or provider call.
 *
 * Repository identity and expected base commit still come from real DB/Git
 * state.
 */

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  assertProductDeliveryLifecycleInput,
  type ProductDeliveryLifecycleInput,
  type ProductDeliveryRepositoryBinding,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { lifecycleInputPolicyValidation } from '../infrastructure/process-modules/lifecycle-input-policy-validation.js';
import type { DevelopmentPolicySnapshot } from '../modules/development/domain/development-schemas.js';
import { hashDevelopmentPolicy } from '../modules/development/domain/development-settlement-policy.js';
import {
  deriveRequiredChangeScopesFromSrs,
} from '../modules/development/domain/srs-derived-change-scopes.js';
import {
  DELIVERY_DEFERRED_PROFILE_SCHEMA,
  type DeliveryDeferredProfile,
} from '../modules/delivery/domain/delivery-schemas.js';
import { hashDeliveryDeferredProfile } from '../modules/delivery/domain/delivery-settlement-policy.js';

/**
 * Build a deterministic deferred Delivery profile. It carries no release
 * policy, action plan or authorization and therefore cannot grant effects.
 */
export function buildDeferredDeliveryProfile(): DeliveryDeferredProfile {
  const profile: DeliveryDeferredProfile = {
    schemaVersion: DELIVERY_DEFERRED_PROFILE_SCHEMA,
    reason: 'authorization-required',
    source: 'start-from-idea',
    profileHash: '',
  };
  return {
    ...profile,
    profileHash: hashDeliveryDeferredProfile(profile),
  };
}

/**
 * Build a deterministic ReferenceDevelopmentPolicy snapshot. The development
 * policy has only three fields; its hash is computed by the canonical hashing
 * and is therefore reproducible across processes, not invented.
 *
 * `requiredChangeScopes` is derived from the accepted SRS file surface when
 * its content is supplied (see `deriveRequiredChangeScopesFromSrs`). When
 * nothing is derivable the scopes stay EMPTY — no invented fallback (BM-5
 * repair, 2026-08-24): the historical `['package.json','tests/']` default
 * was invented authority that pushed plans away from the SRS delivery shape
 * (workshop P07/todo) and froze scopes unrelated to the actual product. The
 * case's own frozen SRS governs file-identity coverage at the plan gate.
 */
export function buildReferenceDevelopmentPolicy(
  srsContent?: string | null,
): DevelopmentPolicySnapshot {
  const derivedScopes = deriveRequiredChangeScopesFromSrs(srsContent);
  if (derivedScopes === null) {
    console.warn(
      '[start-from-idea] no SRS file declarations available — '
        + 'requiredChangeScopes stay EMPTY (no invented fallback); the case SRS '
        + 'governs file-identity coverage at the plan gate',
    );
  }
  // `hashDevelopmentPolicy` deletes `contentHash` before hashing, so the
  // placeholder value does not affect the result; it only satisfies the type.
  const snapshot: DevelopmentPolicySnapshot = {
    id: 'reference-development-policy',
    version: '1.2.0',
    contentHash: '',
    requiredChangeScopes: derivedScopes ?? [],
  };
  return { ...snapshot, contentHash: hashDevelopmentPolicy(snapshot) };
}

interface ActiveRepositoryRow {
  id: number;
  name: string;
  role: string;
  integration_branch: string;
  local_path: string | null;
}

/**
 * Resolve the single active repository for a project. Returns the DB identity
 * plus the REAL current git HEAD commit of its local checkout.
 *
 * Fails closed with `PROJECT_REPOSITORY_NOT_BOUND` when no active repository is
 * bound, and with `REPOSITORY_HEAD_UNRESOLVABLE` when git cannot resolve a HEAD
 * (the checkout is missing or has no commits) — the assembler never substitutes
 * a zero or placeholder hash.
 */
export function resolveActiveRepositoryWithHead(
  db: Database.Database,
  projectId: number,
): {
  projectRepositoryId: number;
  repositoryName: string;
  role: string;
  integrationBranch: string;
  localPath: string | null;
  headCommitSha: string;
} {
  const rows = db.prepare(
    `SELECT pr.id, r.name, pr.role, pr.integration_branch, pr.local_path
       FROM project_repositories pr
       JOIN repositories r ON r.id = pr.repository_id
      WHERE pr.project_id = ? AND pr.status = 'active'
      ORDER BY pr.id`,
  ).all(projectId) as ActiveRepositoryRow[];
  if (rows.length === 0) {
    throw new Error(`PROJECT_REPOSITORY_NOT_BOUND: project ${projectId}`);
  }
  // The first active binding is the project's primary control/component repo.
  // A lifecycle targets one initiative/repo pair from the idea bootstrap.
  const row = rows[0]!;
  const localPath = row.local_path?.trim() ? row.local_path.trim() : null;
  const headCommitSha = localPath
    ? resolveHeadCommit(localPath)
    : null;
  if (!headCommitSha || !/[0-9a-f]{7,40}/i.test(headCommitSha)) {
    throw new Error(
      `REPOSITORY_HEAD_UNRESOLVABLE: ${row.name}:${row.role} `
      + `(local_path=${localPath ?? '<null>'} has no resolvable git HEAD commit)`,
    );
  }
  return {
    projectRepositoryId: row.id,
    repositoryName: row.name,
    role: row.role,
    integrationBranch: row.integration_branch,
    localPath,
    headCommitSha,
  };
}

function resolveHeadCommit(localPath: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: localPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

interface AcceptedSrsArtifactRow {
  id: number;
  path: string;
  storage_kind: string;
  metadata: string;
}

/**
 * Read the content of the project's most recent ACCEPTED SRS artifact.
 *
 * Access path (evidence): the `artifacts` table stores the accepted SRS of a
 * previous formalization (`type='SRS'`, `status='accepted'`) with either
 * `storage_kind='file_backed'` — a real file at `path` under the bound
 * repository's `local_path` — or `storage_kind='db_native'` with the
 * canonical content in `metadata.content`. Both are reachable from the
 * assembler's own inputs (the same `db` + the repository binding resolved by
 * `resolveActiveRepositoryWithHead`), so the policy can be SRS-derived at
 * lifecycle-start time without new ports or schema changes.
 *
 * Fail-safe by construction: any missing row, unreadable file or malformed
 * metadata returns null and the caller keeps the scopes EMPTY (no invented
 * fallback).
 */
function readAcceptedSrsContent(
  db: Database.Database,
  projectId: number,
  repository: {
    projectRepositoryId: number;
    localPath: string | null;
  },
): string | null {
  let row: AcceptedSrsArtifactRow | undefined;
  try {
    row = db.prepare(
      `SELECT id, path, storage_kind, metadata
         FROM artifacts
        WHERE project_id = ?
          AND type = 'SRS'
          AND status = 'accepted'
          AND (project_repository_id IS NULL OR project_repository_id = ?)
        ORDER BY CASE WHEN project_repository_id = ? THEN 0 ELSE 1 END, id DESC
        LIMIT 1`,
    ).get(
      projectId,
      repository.projectRepositoryId,
      repository.projectRepositoryId,
    ) as AcceptedSrsArtifactRow | undefined;
  } catch {
    return null;
  }
  return row === undefined ? null : decodeAcceptedSrsRow(row, repository);
}

function decodeAcceptedSrsRow(
  row: AcceptedSrsArtifactRow,
  repository: { localPath: string | null },
): string | null {
  if (row.storage_kind === 'db_native') {
    try {
      const metadata = JSON.parse(row.metadata) as { content?: unknown };
      return typeof metadata.content === 'string'
        && metadata.content.trim().length > 0
        ? metadata.content
        : null;
    } catch {
      return null;
    }
  }
  if (row.storage_kind !== 'file_backed' || !repository.localPath) {
    return null;
  }
  const artifactPath = row.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = artifactPath.split('/');
  if (
    artifactPath.length === 0
    || path.isAbsolute(artifactPath)
    || segments.some(segment =>
      segment.length === 0 || segment === '.' || segment === '..')
    || segments[0]?.toLocaleLowerCase('en-US') === '.git'
  ) {
    return null;
  }
  try {
    const repoRoot = path.resolve(repository.localPath);
    const artifactFile = path.resolve(repoRoot, artifactPath);
    if (artifactFile !== repoRoot && !artifactFile.startsWith(repoRoot + path.sep)) {
      return null;
    }
    const content = readFileSync(artifactFile, 'utf8');
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Assemble the validated, portable ProductDeliveryLifecycleInput from a bare
 * idea. This is the pure assembly half of the use case (no LifecycleRun side
 * effect); it is exported separately so tests and the composition can assert it
 * passes `assertProductDeliveryLifecycleInput` without starting a run.
 */
export function assembleProductLifecycleInput(params: {
  projectId: number;
  epicId: number;
  idea: string;
  db?: Database.Database;
}): ProductDeliveryLifecycleInput {
  const db = params.db ?? getDb();
  verifyEpicBelongsToProject(db, params.projectId, params.epicId);
  if (!params.idea || params.idea.trim().length === 0) {
    throw new Error('IDEA_REQUIRED: a non-empty initiative subject is required');
  }
  const repository = resolveActiveRepositoryWithHead(db, params.projectId);

  const repositoryBinding: ProductDeliveryRepositoryBinding = {
    repositoryRef: {
      repositoryName: repository.repositoryName,
      role: repository.role,
    },
    integrationBranch: repository.integrationBranch,
    expectedBaseCommit: repository.headCommitSha,
  };

  const srsContent = readAcceptedSrsContent(
    db,
    params.projectId,
    repository,
  );
  const developmentPolicy = buildReferenceDevelopmentPolicy(srsContent);
  const deferredProfile = buildDeferredDeliveryProfile();

  const input: ProductDeliveryLifecycleInput = {
    initiative: {
      subject: params.idea,
      context: {},
      evidence: {},
      constraints: {},
    },
    development: {
      repositories: [repositoryBinding],
      policy: developmentPolicy,
    },
    delivery: {
      mode: 'deferred',
      policy: null,
      operatorAuthorization: null,
      deferredProfile,
    },
  };

  // Fail closed BEFORE any LifecycleRun is created: the assembled input must
  // satisfy the exact structural contract the runtime's resolveInput enforces.
  assertProductDeliveryLifecycleInput(input, lifecycleInputPolicyValidation);
  return input;
}

function verifyEpicBelongsToProject(
  db: Database.Database,
  projectId: number,
  epicId: number,
): void {
  const row = db.prepare(
    'SELECT project_id FROM epics WHERE id = ?',
  ).get(epicId) as { project_id: number } | undefined;
  if (!row) {
    throw new Error(`EPIC_NOT_FOUND: epic ${epicId}`);
  }
  if (Number(row.project_id) !== Number(projectId)) {
    throw new Error(
      `EPIC_PROJECT_MISMATCH: epic ${epicId} belongs to project `
      + `${row.project_id}, not ${projectId}`,
    );
  }
}

/**
 * Port that actually starts a durable LifecycleRun from a validated input.
 * Decoupling this from the assembler keeps the use case testable (inject a
 * fake) and lets the production host decide HOW the run is started
 * (in-process execution plane, or a spawned engine carrying the validated
 * input in memory).
 */
export interface LifecycleRunStarter {
  start(params: {
    orderRef: string;
    projectId: number;
    epicId: number;
    lifecycleInput: ProductDeliveryLifecycleInput;
    lifecycleInputSchema: string;
    initiatedBy: string;
    concurrency: number;
    idempotencyKey?: string;
  }): Promise<{ lifecycleRunId: number }>;
}

export interface StartProductLifecycleFromIdeaParams {
  orderRef: string;
  projectId: number;
  epicId: number;
  idea: string;
  initiatedBy: string;
  concurrency: number;
  db?: Database.Database;
  /**
   * The port that starts the durable LifecycleRun. In production the tracker-
   * view route injects an adapter that calls the execution-plane
   * `application.runEpisode` (no JSON file, no orchestrate-cli spawn for the
   * input). In tests a fake is injected to assert the validated snapshot.
   */
  starter: LifecycleRunStarter;
  idempotencyKey?: string;
}

/**
 * Start a Product Delivery Lifecycle from a bare idea.
 *
 * Verifies the epic belongs to the project, resolves the real repository
 * binding + current git HEAD, assembles and validates the full
 * `ProductDeliveryLifecycleInput` (with explicit missing release
 * authorization), and starts the LifecycleRun through the injected application port.
 */
export async function startProductLifecycleFromIdea(
  params: StartProductLifecycleFromIdeaParams,
): Promise<{ lifecycleRunId: number }> {
  const lifecycleInput = assembleProductLifecycleInput({
    projectId: params.projectId,
    epicId: params.epicId,
    idea: params.idea,
    db: params.db,
  });
  const started = await params.starter.start({
    orderRef: params.orderRef,
    projectId: params.projectId,
    epicId: params.epicId,
    lifecycleInput,
    lifecycleInputSchema: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
    initiatedBy: params.initiatedBy,
    concurrency: params.concurrency,
    idempotencyKey: params.idempotencyKey,
  });
  return { lifecycleRunId: started.lifecycleRunId };
}
