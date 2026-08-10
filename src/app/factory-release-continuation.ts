import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sha256Hex } from '../shared/canonical-json.js';
import { hashDeliveryReleasePolicy } from '../modules/delivery/domain/delivery-settlement-policy.js';
import type {
  AuthorizedDeliveryReleaseCase,
  DeliveryReleasePolicySnapshot,
} from '../modules/delivery/domain/delivery-schemas.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { SqliteLifecycleContinuationRepository } from '../process-modules/persistence/sqlite-lifecycle-continuation-repository.js';

export interface PrepareLocalReleaseContinuationCommand {
  orderRef: string;
  parentLifecycleRunId: number;
  actorId: string;
  reason: string;
}

export function prepareLocalReleaseContinuation(
  db: Database.Database,
  command: PrepareLocalReleaseContinuationCommand,
) {
  const parent = db.prepare(
    `SELECT project_id,epic_id,status,terminal_status,error
       FROM factory_lifecycle_runs WHERE id=?`,
  ).get(command.parentLifecycleRunId) as {
    project_id: number; epic_id: number | null; status: string;
    terminal_status: string | null; error: string | null;
  } | undefined;
  if (!parent || parent.epic_id === null || parent.status !== 'completed'
    || parent.terminal_status !== 'approval-required') {
    throw new Error('LOCAL_RELEASE_PARENT_NOT_APPROVAL_REQUIRED');
  }
  const boundary = db.prepare(
    `SELECT pr.input_snapshot FROM factory_stage_runs sr
       JOIN factory_process_runs pr ON pr.id=sr.process_run_id
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='delivery-release'
        AND sr.status='completed' AND sr.local_outcome='approval-required'
        AND pr.status='completed' AND pr.local_outcome='approval-required'
      ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
  ).get(command.parentLifecycleRunId) as { input_snapshot: string } | undefined;
  if (!boundary) throw new Error('LOCAL_RELEASE_BOUNDARY_NOT_EXACT');
  const previous = JSON.parse(boundary.input_snapshot) as AuthorizedDeliveryReleaseCase;
  const repository = db.prepare(
    `SELECT id,local_path,integration_branch FROM project_repositories
      WHERE project_id=? AND status='active' ORDER BY id`,
  ).all(parent.project_id) as Array<{ id: number; local_path: string | null; integration_branch: string }>;
  if (repository.length !== 1 || !repository[0]!.local_path) {
    throw new Error('LOCAL_RELEASE_REPOSITORY_NOT_EXACT');
  }
  const repo = repository[0]!;
  const commit = git(repo.local_path!, 'rev-parse', `refs/heads/${repo.integration_branch}`);
  const tree = git(repo.local_path!, 'rev-parse', `${commit}^{tree}`);
  const tag = `saga/local/${previous.integratedCandidate.hash.slice(0, 12)}`;
  const target = `project-repository:${repo.id}|${tag}|${commit}|${tree}`;
  const desiredStateHash = sha256Hex({ repositoryId: repo.id, tag, commit, tree });
  const policyBody: Omit<DeliveryReleasePolicySnapshot, 'contentHash'> = {
    id: 'saga-local-source-tag', version: '1.0.0', channel: 'local',
    releaseVersion: previous.integratedCandidate.hash.slice(0, 12),
    releaseTag: tag,
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [{
      actionId: 'local-source-tag', kind: 'source-tag', target,
      desiredStateHash, payloadHash: sha256Hex({ target, desiredStateHash }), required: true,
    }],
  };
  const policy: DeliveryReleasePolicySnapshot = {
    ...policyBody,
    contentHash: hashDeliveryReleasePolicy({ ...policyBody, contentHash: '' }),
  };
  const grantBody = {
    schema: 'factory.delivery-operator-authorization.v1',
    requestedBy: command.actorId,
    releasePolicyHash: policy.contentHash,
    candidateScope: { mode: 'exact' as const, candidateHash: previous.integratedCandidate.hash },
    localOnly: true,
    reason: command.reason,
  };
  const grantHash = sha256Hex(grantBody);
  const operatorAuthorization = {
    ...grantBody,
    ref: `delivery-operator-authorization:${grantHash}`,
    hash: grantHash,
  };
  const externalBaseline = { delivery: {
    mode: 'authorized', policy, operatorAuthorization, deferredProfile: null,
  }, repository: { id: repo.id, branch: repo.integration_branch, commit, tree }, tag };
  const continuations = new SqliteLifecycleContinuationRepository(
    db, new SqliteLifecycleRunRepository(db),
  );
  const authorization = continuations.authorize({
    orderRef: command.orderRef,
    parentLifecycleRunId: command.parentLifecycleRunId,
    resumeStageId: 'delivery-release',
    expectedParentError: parent.error ?? 'TERMINAL_OUTCOME:approval-required',
    actorId: command.actorId,
    reason: command.reason,
    externalBaselineSnapshot: externalBaseline,
    stageOverrides: [{
      stageId: 'delivery-release',
      moduleRef: { name: 'delivery-release', version: '1.0.0' },
      additiveInputMapping: {
        deliveryMode: '$.continuation.externalBaseline.delivery.mode',
        policy: '$.continuation.externalBaseline.delivery.policy',
        operatorAuthorization: '$.continuation.externalBaseline.delivery.operatorAuthorization',
        deferredProfile: '$.continuation.externalBaseline.delivery.deferredProfile',
      },
    }],
  });
  const consumed = continuations.consume(authorization.authorizationRef);
  return {
    authorizationRef: authorization.authorizationRef,
    childLifecycleRunId: consumed.childLifecycleRunId,
    childIdempotencyKey: consumed.childIdempotencyKey,
    projectId: parent.project_id,
    epicId: parent.epic_id,
    orderRef: command.orderRef,
    tag, commit, tree, candidateHash: previous.integratedCandidate.hash,
  };
}

function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
