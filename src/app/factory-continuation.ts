import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-continuation-process-module.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { SqliteLifecycleContinuationRepository } from '../process-modules/persistence/sqlite-lifecycle-continuation-repository.js';
import { adoptIntegratedDevelopmentBaseline } from '../modules/development/infrastructure/sqlite-development-baseline-adoption.js';
import { authorizeEligibleAuthorCandidateCarryForward } from '../infrastructure/workplace/sqlite-author-candidate-carry-forward.js';
import { DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-verification-continuation-process-module.js';
import {
  adoptDevelopmentVerificationBaseline,
  recordDevelopmentVerificationObserverConfirmation,
} from '../modules/development/infrastructure/sqlite-development-verification-adoption.js';

export interface PrepareDevelopmentContinuationCommand {
  readonly orderRef: string;
  readonly parentLifecycleRunId: number;
  readonly adoptedTaskId?: number;
  readonly remainingChangeScopes?: readonly string[];
  readonly verificationOnly?: boolean;
  readonly observerConfirmation?: {
    readonly observerId: string;
    readonly statement: string;
  };
  readonly actorId: string;
  readonly reason: string;
}

export interface PreparedDevelopmentContinuation {
  readonly authorizationRef: string;
  readonly adoptionRef: string;
  readonly authorCarryForwardAuthorizationRef: string | null;
  readonly childLifecycleRunId: number;
  readonly childIdempotencyKey: string;
  readonly projectId: number;
  readonly epicId: number;
  readonly orderRef: string;
  readonly repositoryHead: string;
  readonly observerReceiptCount: number;
}

/**
 * Authority-complete recovery preparation for the current incident class.
 * All mechanisms used are generic/versioned; this application service merely
 * selects the Development suffix, managed module and verified baseline task.
 */
export function prepareDevelopmentContinuation(
  db: Database.Database,
  command: PrepareDevelopmentContinuationCommand,
): PreparedDevelopmentContinuation {
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
  const blockedBoundary = parent ? db.prepare(
    `SELECT sr.status AS stage_status,sr.local_outcome AS stage_outcome,
            pr.id AS process_run_id,
            pr.status AS process_status,pr.local_outcome AS process_outcome
       FROM factory_stage_runs sr
       JOIN factory_process_runs pr ON pr.id=sr.process_run_id
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='solution-development'
      ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
  ).get(command.parentLifecycleRunId) as {
    stage_status: string;
    stage_outcome: string | null;
    process_run_id: number;
    process_status: string;
    process_outcome: string | null;
  } | undefined : undefined;
  const infrastructureFailure = blockedBoundary?.process_outcome === 'failed'
    ? db.prepare(
      `SELECT reason_codes,rationale
         FROM factory_process_outcome_certificates
        WHERE process_run_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(blockedBoundary.process_run_id) as {
      reason_codes: string;
      rationale: string;
    } | undefined
    : undefined;
  const exactRecoverableInfrastructureFailure = Boolean(
    infrastructureFailure
    && JSON.parse(infrastructureFailure.reason_codes).length === 1
    && JSON.parse(infrastructureFailure.reason_codes)[0] === 'infrastructure-error'
    && infrastructureFailure.rationale
      === 'DEVELOPMENT_OUTPUT_PROCESS_RUN_BINDING_MISMATCH',
  );
  const terminalBoundaryExact = parent?.status === 'failed'
    ? parent.current_stage_id === 'solution-development'
    : parent?.status === 'completed'
      && parent.current_stage_id === null
      && blockedBoundary?.stage_status === 'completed'
      && blockedBoundary.process_status === 'completed'
      && (
        blockedBoundary.stage_outcome === 'blocked'
          && blockedBoundary.process_outcome === 'blocked'
        || blockedBoundary.stage_outcome === 'failed'
          && exactRecoverableInfrastructureFailure
        // 'rework-required' is the upstream-defect escalation boundary: the
        // verification cell deterministically refuted the FROZEN integrated
        // candidate (failureOwnership:'upstream'), so the product needs a new
        // work cycle — exactly what this continuation provisions (the
        // 'continuation-integrated-repair' development.code task).
        || blockedBoundary.stage_outcome === 'rework-required'
          && blockedBoundary.process_outcome === 'rework-required'
      );
  if (
    !parent
    || parent.epic_id === null
    || !terminalBoundaryExact
  ) {
    throw new Error('DEVELOPMENT_CONTINUATION_PARENT_NOT_EXACT');
  }
  const activeWorkers = db.prepare(
    `SELECT count(*) AS count FROM worker_executions
      WHERE epic_id=? AND state IN ('reserved','running','cancel_requested')`,
  ).get(parent.epic_id) as { count: number };
  if (activeWorkers.count !== 0) {
    throw new Error('DEVELOPMENT_CONTINUATION_ACTIVE_WORKERS');
  }
  const parentTerminalEvidence = parent.error
    ?? `TERMINAL_OUTCOME:${parent.terminal_status ?? 'missing'}`;
  const repositories = db.prepare(
    `SELECT id,local_path,integration_branch FROM project_repositories
      WHERE project_id=? AND status='active' ORDER BY id`,
  ).all(parent.project_id) as Array<{
    id: number;
    local_path: string | null;
    integration_branch: string;
  }>;
  if (repositories.length !== 1 || !repositories[0]!.local_path) {
    throw new Error('DEVELOPMENT_CONTINUATION_REPOSITORY_NOT_EXACT');
  }
  const repository = repositories[0]!;
  const head = git(
    repository.local_path!,
    'rev-parse',
    `refs/heads/${repository.integration_branch}`,
  );
  const changeScopes = [...new Set(command.remainingChangeScopes ?? [])].sort();
  if (!command.verificationOnly && (
    changeScopes.length === 0 || changeScopes.some(scope => !scope.trim())
  )) {
    throw new Error('DEVELOPMENT_CONTINUATION_CHANGE_SCOPES_INVALID');
  }

  const lifecycleRuns = new SqliteLifecycleRunRepository(db);
  const continuations = new SqliteLifecycleContinuationRepository(db, lifecycleRuns);
  const authorization = continuations.authorize({
    orderRef: command.orderRef,
    parentLifecycleRunId: command.parentLifecycleRunId,
    resumeStageId: 'solution-development',
    expectedParentError: parentTerminalEvidence,
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
      remainingChangeScopes: changeScopes,
    },
    stageOverrides: [{
      stageId: 'solution-development',
      moduleRef: command.verificationOnly
        ? DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF
        : DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
      additiveInputMapping: {
        repositories: '$.continuation.externalBaseline.repositories',
        continuationRecovery: '$.continuation',
      },
    }],
  });
  const adoption = command.verificationOnly
    ? adoptDevelopmentVerificationBaseline(db, {
      continuationRef: authorization.authorizationRef,
      parentLifecycleRunId: command.parentLifecycleRunId,
    })
    : adoptIntegratedDevelopmentBaseline(db, {
      continuationRef: authorization.authorizationRef,
      sourceTaskId: command.adoptedTaskId!,
      expectedIntegrationHead: head,
    });
  const carryForward = command.verificationOnly ? null
    : authorizeEligibleAuthorCandidateCarryForward(db, {
      continuationRef: authorization.authorizationRef,
      parentLifecycleRunId: command.parentLifecycleRunId,
    });
  const observerReceipts = command.observerConfirmation
    ? recordDevelopmentVerificationObserverConfirmation(db, {
      adoptionRef: adoption.adoptionRef,
      ...command.observerConfirmation,
    })
    : [];
  const consumed = continuations.consume(authorization.authorizationRef);
  return {
    authorizationRef: authorization.authorizationRef,
    adoptionRef: adoption.adoptionRef,
    authorCarryForwardAuthorizationRef: carryForward?.authorizationRef ?? null,
    childLifecycleRunId: consumed.childLifecycleRunId,
    childIdempotencyKey: consumed.childIdempotencyKey,
    projectId: parent.project_id,
    epicId: parent.epic_id,
    orderRef: command.orderRef,
    repositoryHead: head,
    observerReceiptCount: observerReceipts.length,
  };
}

function git(repositoryPath: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      `DEVELOPMENT_CONTINUATION_GIT_OBSERVATION_FAILED: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}
