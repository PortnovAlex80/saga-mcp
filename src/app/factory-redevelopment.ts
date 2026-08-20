// src/app/factory-redevelopment.ts
//
// STAGE-19 — the REDEVELOPMENT entry: re-enter solution-development with the
// STANDARD development module, consuming the parent run's frozen
// formalization capsule (the workshops 1-2 results), after a terminal
// development failure.
//
// Why this exists beside prepareDevelopmentContinuation: the existing
// continuation authorizes the MANAGED recovery module — a deterministic
// single recovery work item with textual SourceChangeCandidates and an empty
// author plan (authority-complete incident recovery). It can never exercise
// the standard development path. The stage-18 repairs (R1 authority
// delivery, R2 claim-surface monotonicity, R3 tree-stamp attribution) live
// on the STANDARD path: a planner that re-carves the graph from the
// formalization contract, real git authors, real gates. Redevelopment
// authorizes exactly that, with every formalization-sourced stage input
// supplied additively from the durable capsule (additive mapping keys
// override the normal $.stages.solution-formalization.* reads, which are
// empty in a child run that enters at solution-development).
//
// The capsule is the parent's LAST solution-development process-run
// input_snapshot — content-hashed durable state captured at formalization
// time (srs, solutionContract, acceptanceCriteria + hashes,
// formalizationCertificate, policy, repositories). NO adoption, NO
// carry-forward: the re-development is fresh authoring on a clean graph.

import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';

import { DEVELOPMENT_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-process-module.js';
import { DEVELOPMENT_CASE_SCHEMA } from '../modules/development/domain/development-schemas.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { SqliteLifecycleContinuationRepository } from '../process-modules/persistence/sqlite-lifecycle-continuation-repository.js';
import { sha256Hex } from '../shared/canonical-json.js';

export interface PrepareDevelopmentRedevelopmentCommand {
  readonly orderRef: string;
  readonly parentLifecycleRunId: number;
  readonly actorId: string;
  readonly reason: string;
}

export interface PreparedDevelopmentRedevelopment {
  readonly authorizationRef: string;
  readonly childLifecycleRunId: number;
  readonly childIdempotencyKey: string;
  readonly projectId: number;
  readonly epicId: number;
  readonly orderRef: string;
  /** sha256 over the exact capsule bytes consumed — the stage-19 run tracker
   *  pins this so the re-development's input provenance is auditable. */
  readonly capsuleHash: string;
}

/** The additive mapping that feeds every formalization-sourced input of the
 *  standard solution-development stage from the durable capsule. Key names
 *  mirror the stage's own inputMapping (product-delivery-lifecycle.ts). */
const REDEVELOPMENT_INPUT_MAPPING = {
  'formalizationCertificate.schema':
    '$.continuation.externalBaseline.redevelopment.formalizationCertificate.schema',
  'formalizationCertificate.ref':
    '$.continuation.externalBaseline.redevelopment.formalizationCertificate.ref',
  'formalizationCertificate.hash':
    '$.continuation.externalBaseline.redevelopment.formalizationCertificate.hash',
  'solutionContract.schema':
    '$.continuation.externalBaseline.redevelopment.solutionContract.schema',
  'solutionContract.ref':
    '$.continuation.externalBaseline.redevelopment.solutionContract.ref',
  'solutionContract.hash':
    '$.continuation.externalBaseline.redevelopment.solutionContract.hash',
  acceptanceBaselineHash:
    '$.continuation.externalBaseline.redevelopment.acceptanceBaselineHash',
  srs: '$.continuation.externalBaseline.redevelopment.srs',
  acceptanceCriteria:
    '$.continuation.externalBaseline.redevelopment.acceptanceCriteria',
  repositories: '$.continuation.externalBaseline.redevelopment.repositories',
  policy: '$.continuation.externalBaseline.redevelopment.policy',
} as const;

interface DevelopmentCapsule {
  readonly formalizationCertificate: Record<string, unknown>;
  readonly solutionContract: Record<string, unknown>;
  readonly acceptanceBaselineHash: unknown;
  readonly srs: unknown;
  readonly acceptanceCriteria: unknown;
  readonly repositories: unknown;
  readonly policy: unknown;
}

function parseCapsule(raw: string): DevelopmentCapsule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_CAPSULE_UNPARSABLE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_CAPSULE_UNPARSABLE');
  }
  const capsule = parsed as Record<string, unknown>;
  const required = [
    'formalizationCertificate', 'solutionContract', 'acceptanceBaselineHash',
    'srs', 'acceptanceCriteria', 'repositories', 'policy',
  ];
  for (const key of required) {
    if (capsule[key] === undefined) {
      throw new Error(`DEVELOPMENT_REDEVELOPMENT_CAPSULE_INCOMPLETE: ${key}`);
    }
  }
  return parsed as unknown as DevelopmentCapsule;
}

function gitRepositoryPath(repositoryPath: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function prepareDevelopmentRedevelopment(
  db: Database.Database,
  command: PrepareDevelopmentRedevelopmentCommand,
): PreparedDevelopmentRedevelopment {
  const parent = db.prepare(
    `SELECT project_id,epic_id,status,current_stage_id,terminal_status,error
       FROM factory_lifecycle_runs WHERE id=?`,
  ).get(command.parentLifecycleRunId) as {
    project_id: number;
    epic_id: number | null;
    status: string;
    current_stage_id: string | null;
    terminal_status: string | null;
    error: string | null;
  } | undefined;
  // The exact parent class: a run that TERMINATED as failed while sitting on
  // solution-development (the stage-15 stop shape). A paused/abandoned run is
  // not terminal and must not be redeveloped; a failed discovery or
  // formalization has no capsule to consume.
  if (
    !parent
    || parent.epic_id === null
    || parent.status !== 'failed'
    || parent.current_stage_id !== 'solution-development'
  ) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_PARENT_NOT_EXACT');
  }
  const activeWorkers = db.prepare(
    `SELECT count(*) AS count FROM worker_executions
      WHERE epic_id=? AND state IN ('reserved','running','cancel_requested')`,
  ).get(parent.epic_id) as { count: number };
  if (activeWorkers.count !== 0) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_ACTIVE_WORKERS');
  }
  const repositories = db.prepare(
    `SELECT id,local_path,integration_branch FROM project_repositories
      WHERE project_id=? AND status='active' ORDER BY id`,
  ).all(parent.project_id) as Array<{
    id: number; local_path: string | null; integration_branch: string;
  }>;
  if (repositories.length !== 1 || !repositories[0]!.local_path) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_REPOSITORY_NOT_EXACT');
  }
  const repository = repositories[0]!;

  // The capsule: the parent's LAST solution-development process-run input.
  const failedStage = db.prepare(
    `SELECT sr.process_run_id
       FROM factory_stage_runs sr
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='solution-development'
      ORDER BY sr.attempt DESC, sr.id DESC LIMIT 1`,
  ).get(command.parentLifecycleRunId) as { process_run_id: number } | undefined;
  if (!failedStage) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_CAPSULE_MISSING');
  }
  const processRun = db.prepare(
    `SELECT input_schema,input_snapshot,input_hash
       FROM factory_process_runs WHERE id=?`,
  ).get(failedStage.process_run_id) as {
    input_schema: string;
    input_snapshot: string;
    input_hash: string;
  } | undefined;
  if (!processRun || processRun.input_schema !== DEVELOPMENT_CASE_SCHEMA) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_CAPSULE_MISSING');
  }
  // Integrity: the stored snapshot must still hash to its frozen input_hash —
  // the capsule is consumed only as the exact bytes formalization produced.
  if (sha256Hex(processRun.input_snapshot) !== processRun.input_hash
    && sha256Hex(JSON.parse(processRun.input_snapshot)) !== processRun.input_hash) {
    throw new Error('DEVELOPMENT_REDEVELOPMENT_CAPSULE_HASH_MISMATCH');
  }
  const capsule = parseCapsule(processRun.input_snapshot);
  const capsuleHash = processRun.input_hash;

  const head = gitRepositoryPath(
    repository.local_path!,
    'rev-parse',
    `refs/heads/${repository.integration_branch}`,
  );

  const lifecycleRuns = new SqliteLifecycleRunRepository(db);
  const continuations = new SqliteLifecycleContinuationRepository(db, lifecycleRuns);
  const authorization = continuations.authorize({
    orderRef: command.orderRef,
    parentLifecycleRunId: command.parentLifecycleRunId,
    resumeStageId: 'solution-development',
    expectedParentError: parent.error
      ?? `TERMINAL_OUTCOME:${parent.terminal_status ?? 'missing'}`,
    actorId: command.actorId,
    reason: command.reason,
    externalBaselineSnapshot: {
      head,
      repositories: [{
        repositoryRef: { repositoryName: repository.local_path, role: 'component' },
        projectRepositoryId: repository.id,
        integrationBranch: repository.integration_branch,
        expectedBaseCommit: head,
      }],
      // The workshops 1-2 capsule, consumed additively by the standard
      // development stage mapping (REDEVELOPMENT_INPUT_MAPPING).
      redevelopment: capsule,
    },
    stageOverrides: [{
      stageId: 'solution-development',
      // The STANDARD module — NOT the managed recovery variant: the
      // planner re-carves the graph, real authors write real git worktrees,
      // the stage-18 gates (R1/R2/R3) stand in their production path.
      moduleRef: DEVELOPMENT_PROCESS_MODULE_REF,
      additiveInputMapping: REDEVELOPMENT_INPUT_MAPPING,
    }],
  });
  // No adoption, no carry-forward: fresh authoring from the capsule.
  const consumed = continuations.consume(authorization.authorizationRef);
  return {
    authorizationRef: authorization.authorizationRef,
    childLifecycleRunId: consumed.childLifecycleRunId,
    childIdempotencyKey: consumed.childIdempotencyKey,
    projectId: parent.project_id,
    epicId: parent.epic_id,
    orderRef: command.orderRef,
    capsuleHash,
  };
}
