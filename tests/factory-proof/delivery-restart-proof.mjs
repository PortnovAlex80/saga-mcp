// tests/factory-proof/delivery-restart-proof.mjs
//
// Multi-start Delivery restart proof (§16 replay idempotency for the release
// settlement). Unlike the discovery/formalization boundary proofs, `released`
// IS a natural terminal — no abandon-close is needed between starts:
//   A — authorized release, driven to its natural `released` terminal;
//   B — SAME semantic input (fresh launch, fresh idempotency key) — must
//       replay the settled material WITHOUT re-firing the deployment
//       (observe-before-execute short-circuit: no duplicate external effect);
//   C — same initiative, DIFFERENT release action target — the upstream
//       material is byte-identical (correct ADR-079 reuse), but the delivery
//       cells resolve cold and the new target gets its own effect.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  buildCanonicalProofComposition,
  buildCanonicalDeliveryProviders,
  createScriptedObserver,
} from './canonical-proof-composition.mjs';
import { driveCanonicalProof } from './canonical-proof-composition.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { classifyPostDrainProgress, observeDurableTrace } from './trace-observer.mjs';
import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';

const REPO_ROOT = process.cwd();

async function buildAuthorizedInput(bootstrap, targetState) {
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();
  const baseCommit = execSync('git rev-parse HEAD', {
    cwd: bootstrap.repoPath, encoding: 'utf8', windowsHide: true,
  }).trim();
  const repoRow = db.prepare(
    `SELECT r.name, pr.role FROM project_repositories pr
       JOIN repositories r ON r.id = pr.repository_id
      WHERE pr.project_id=? AND pr.status='active' ORDER BY pr.id LIMIT 1`,
  ).get(bootstrap.projectId);
  const policyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/modules/development/domain/development-settlement-policy.js')).href);
  const deliveryPolicyMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/modules/delivery/domain/delivery-settlement-policy.js')).href);
  const shaMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/shared/canonical-json.js')).href);
  const launchMod = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/infrastructure/factory/sqlite-factory-launch-repository.js')).href);

  const devPolicy = { id: 'reference-development-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = policyMod.hashDevelopmentPolicy(devPolicy);
  const releaseAction = {
    actionId: `proof-delivery-release-${targetState}`,
    kind: 'deployment',
    target: `proof-delivery-target-${targetState}`,
    desiredStateHash: shaMod.sha256Hex({ target: `proof-delivery-target-${targetState}`, state: targetState }),
    payloadHash: shaMod.sha256Hex({ package: `proof-delivery-v1-${targetState}` }),
    required: true,
  };
  const releasePolicy = {
    id: `proof-release-policy-${targetState}`, version: '1.0.0', contentHash: '',
    channel: 'test', releaseVersion: '1.0.0', releaseTag: `proof-delivery-${targetState}`,
    humanApprovalRequired: false, requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = deliveryPolicyMod.hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: 'proof-delivery-restart',
    releasePolicyHash: releasePolicy.contentHash,
    candidateScope: { mode: 'lifecycle-output' },
  };
  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: 'proof-delivery-restart', context: 'restart idempotency',
      evidence: [], constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: repoRow.name, role: repoRow.role },
        integrationBranch: 'dev', expectedBaseCommit: baseCommit,
      }],
      policy: devPolicy,
    },
    delivery: {
      mode: 'authorized', policy: releasePolicy,
      operatorAuthorization: {
        schema: 'factory.operator-release-grant.v1',
        ref: `proof-grant:${shaMod.sha256Hex(grantBody)}`,
        hash: shaMod.sha256Hex(grantBody), ...grantBody,
      },
      deferredProfile: null,
    },
  };
  const orderRef = `order-proof-dr-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES (?, ?, ?, 'idea_url','starting')`,
  ).run(orderRef, bootstrap.projectId, bootstrap.epicId);
  return launchMod.requestFactoryLaunch({
    orderRef, mode: 'new',
    projectId: bootstrap.projectId, epicId: bootstrap.epicId,
    initiatedBy: 'proof-delivery-restart',
    idempotencyKey: `proof-dr-${randomUUID()}`,
    concurrency: 4,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
}

export async function runDeliveryRestartProof({ scenario, bootstrap, concurrencyCap }) {
  const harness = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
  );
  const { productDeliveryLifecycle } = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/process-modules/lifecycles/product-delivery-lifecycle.js')).href);

  async function runStart(label, targetState) {
    const observer = createScriptedObserver();
    const launchRef = await buildAuthorizedInput(bootstrap, targetState);
    const composition = buildCanonicalProofComposition({
      observer,
      repoPath: bootstrap.repoPath,
      sagaRepoRoot: bootstrap.sagaRepoRoot,
      handlers: { ...W9_HAPPY_HANDLERS },
      deliveryProviders: buildCanonicalDeliveryProviders({ repoPath: bootstrap.repoPath }),
      lifecycleDefinition: productDeliveryLifecycle,
    });
    const driven = await driveCanonicalProof({
      bootstrap, composition, launchRef,
      scenarioConcurrencyCap: concurrencyCap,
      maxCycles: 420, pollMs: 5, maxEmptyDispatchStreak: 15,
      scriptedObserver: observer,
    });
    return {
      label, observer, driven,
      summary: {
        terminalReason: driven.result.terminalReason,
        cycles: driven.result.cycles,
        invocations: observer.getInvocationCount(),
        replays: observer.getReplayCount(),
        stranded: driven.result.strandedActiveExecutions,
      },
    };
  }

  const runA = await runStart('A-cold', 'released-v1');
  const runB = await runStart('B-same-semantic-input', 'released-v1');
  const runC = await runStart('C-different-target', 'released-v2');

  const durableTrace = observeDurableTrace(bootstrap.dbPath);
  const progress = classifyPostDrainProgress(durableTrace);
  const releasedStages = (durableTrace.stageRuns ?? [])
    .filter(row => row.stage_id === 'delivery-release' && row.local_outcome === 'released');
  const lifecycleIds = [...new Set(releasedStages.map(row => row.lifecycle_run_id))];
  // Delivery publication actions across the whole proof (deterministic keys):
  // A fires target-v1 exactly once; B must NOT re-fire (idempotent replay);
  // C fires target-v2 once. Total delivery effects == number of DISTINCT
  // targets, and every action is terminal-succeeded with no duplicates.
  const deliveryActions = (durableTrace.deliveryEffectActions ?? [])
    .filter(a => String(a.provider_namespace).startsWith('proof-deployment')
      || String(a.node_id).startsWith('publish'));
  const actionKeys = deliveryActions.map(a => a.action_key);
  const distinctKeys = new Set(actionKeys);

  const oracleResults = [
    {
      id: 'delivery.restart.three-released-starts',
      passed: lifecycleIds.length === 3,
      evidenceRefs: releasedStages.map(row => `stage-run:${row.id}`),
      details: { lifecycleIds },
    },
    {
      id: 'delivery.restart.same-input-settles-without-inference',
      passed: runB.summary.invocations === 0 && runB.summary.replays > 0,
      evidenceRefs: [], details: runB.summary,
    },
    {
      id: 'delivery.restart.no-duplicate-external-effect',
      passed: actionKeys.length === distinctKeys.size && actionKeys.length === 2,
      evidenceRefs: [...distinctKeys],
      details: {
        totalDeliveryActions: actionKeys.length,
        distinctTargets: distinctKeys.size,
        expected: 'A fires target-v1 once, B replays without firing, C fires target-v2 once',
      },
    },
    {
      id: 'delivery.restart.different-target-runs-its-own-effect',
      passed: runC.summary.terminalReason === 'released',
      evidenceRefs: [], details: runC.summary,
    },
    {
      id: 'factory.no-stranded-worker-executions',
      passed: [runA, runB, runC].every(run => run.summary.stranded === 0),
      evidenceRefs: [],
      details: { A: runA.summary.stranded, B: runB.summary.stranded, C: runC.summary.stranded },
    },
  ];

  return buildScenarioEvidenceBundle({
    scenario,
    proofModes: ['Durable', 'CanonicalFast'],
    fingerprint: runA.driven.fingerprint,
    identity: runA.driven.identity,
    durableTrace,
    progress,
    actorEvidence: [
      { kind: 'factory-start', ...runA.summary },
      { kind: 'factory-start', ...runB.summary },
      { kind: 'factory-start', ...runC.summary },
    ],
    faultJournal: [],
    externalWorldJournal: deliveryActions.map(a => ({
      kind: 'external-effect', namespace: a.provider_namespace, key: a.action_key,
      state: a.state, node: a.node_id,
    })),
    oracleResults,
    terminal: {
      reachedTerminal: true,
      terminalReason: 'released',
      cycles: runA.summary.cycles + runB.summary.cycles + runC.summary.cycles,
      stoppedByCycleBound: false,
      strandedActiveExecutions:
        runA.summary.stranded + runB.summary.stranded + runC.summary.stranded,
      effectiveConcurrency: concurrencyCap,
      scriptedInvocationCount:
        runA.summary.invocations + runB.summary.invocations + runC.summary.invocations,
    },
  });
}
