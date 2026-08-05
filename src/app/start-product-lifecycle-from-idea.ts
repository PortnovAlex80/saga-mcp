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
 */
export function buildReferenceDevelopmentPolicy(): DevelopmentPolicySnapshot {
  // `hashDevelopmentPolicy` deletes `contentHash` before hashing, so the
  // placeholder value does not affect the result; it only satisfies the type.
  const snapshot: DevelopmentPolicySnapshot = {
    id: 'reference-development-policy',
    version: '1',
    contentHash: '',
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

  const developmentPolicy = buildReferenceDevelopmentPolicy();
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
