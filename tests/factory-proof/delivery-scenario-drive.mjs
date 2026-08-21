#!/usr/bin/env node
// tests/factory-proof/delivery-scenario-drive.mjs
//
// Execute ONE Delivery scenario on the canonical Factory through the FULL
// product-delivery lifecycle (discovery -> formalization -> development ->
// delivery-release) with an AUTHORIZED release input (approval not
// required) built by the same production hash/policy modules the temporal
// conformance fixtures use — no test-side authority writes beyond the
// operator grant the production input schema itself demands.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runScenario } from './scenario-runner.mjs';
import {
  buildCanonicalProofComposition,
  buildCanonicalDeliveryProviders,
  createScriptedObserver,
} from './canonical-proof-composition.mjs';
import { buildDeliveryRuntimeCase } from './delivery-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.DELIVERY_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) throw new Error('DELIVERY_SCENARIO required; known=delivery/happy-released-authorized');

const runtime = buildDeliveryRuntimeCase(scenarioId);

const harness = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);
const { bootstrapFreshHarness } = harness;
const manifest = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { HARNESS_CONCURRENCY_CEILING } = manifest;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  ...(process.env.PROOF_KEEP_DIR ? { tempDir: process.env.PROOF_KEEP_DIR } : {}),
  idea: 'Unified Delivery proof: authorized release through the real product-delivery lifecycle',
});

try {
  // Build the AUTHORIZED delivery input against the harness's own repo HEAD
  // (temporal conformance recipe: tests/factory-temporal/lib/fresh-db.mjs).
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();
  const baseCommit = execSync('git rev-parse HEAD', {
    cwd: bootstrap.repoPath, encoding: 'utf8', windowsHide: true,
  }).trim();
  // The lifecycle input binds the REGISTERED repository identity
  // (resolveActiveRepositoryWithHead: project_repositories.name/role) —
  // inventing a name fails closed with REPOSITORY_REF_NOT_FOUND.
  const repoRow = db.prepare(
    `SELECT r.name, pr.role FROM project_repositories pr
       JOIN repositories r ON r.id=pr.repository_id
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
    actionId: 'proof-delivery-release',
    kind: 'deployment',
    target: 'proof-delivery-target',
    desiredStateHash: shaMod.sha256Hex({ target: 'proof-delivery-target', state: 'released-v1' }),
    payloadHash: shaMod.sha256Hex({ package: 'proof-delivery-v1' }),
    required: true,
  };
  const releasePolicy = {
    id: 'proof-release-policy', version: '1.0.0', contentHash: '',
    channel: 'test', releaseVersion: '1.0.0', releaseTag: 'proof-delivery-v1',
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = deliveryPolicyMod.hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: 'proof-delivery-night',
    releasePolicyHash: releasePolicy.contentHash,
    candidateScope: { mode: 'lifecycle-output' },
  };
  const operatorAuthorization = {
    schema: 'factory.operator-release-grant.v1',
    ref: `proof-grant:${shaMod.sha256Hex(grantBody)}`,
    hash: shaMod.sha256Hex(grantBody),
    ...grantBody,
  };

  const lifecycleInput = {
    schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
    initiative: {
      subject: 'proof-delivery-night',
      context: 'Unified Delivery conformance: authorized release spine',
      evidence: [], constraints: {},
    },
    development: {
      repositories: [{
        repositoryRef: { repositoryName: repoRow.name, role: repoRow.role },
        integrationBranch: 'dev',
        expectedBaseCommit: baseCommit,
      }],
      policy: devPolicy,
    },
    delivery: {
      mode: 'authorized',
      policy: releasePolicy,
      operatorAuthorization,
      deferredProfile: null,
    },
  };

  const orderRef = `order-proof-delivery-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES (?, ?, ?, 'idea_url','starting')`,
  ).run(orderRef, bootstrap.projectId, bootstrap.epicId);
  const launchRef = launchMod.requestFactoryLaunch({
    orderRef, mode: 'new',
    projectId: bootstrap.projectId, epicId: bootstrap.epicId,
    initiatedBy: 'proof-delivery-night',
    idempotencyKey: `proof-delivery-${randomUUID()}`,
    concurrency: HARNESS_CONCURRENCY_CEILING,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);

  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: runtime.handlers,
    deliveryProviders: buildCanonicalDeliveryProviders({ repoPath: bootstrap.repoPath }),
  });
  const driven = await (await import('./canonical-proof-composition.mjs')).driveCanonicalProof({
    bootstrap,
    composition,
    launchRef,
    scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
    ...(runtime.driveOptions ?? {}),
    scriptedObserver: observer,
  });

  const traceApi = await import('./trace-observer.mjs');
  const durableTrace = traceApi.observeDurableTrace(bootstrap.dbPath);
  const progress = traceApi.classifyPostDrainProgress(durableTrace, {});
  const oracleResults = [{
    id: 'kernel.post-drain-progress',
    passed: progress.ok,
    details: progress.ok ? { classifications: progress.rows.length } : { stalls: progress.stalls },
  }];
  const context = Object.freeze({
    scenario: runtime.scenario, bootstrap, result: driven.result,
    durableTrace, progress, observer,
  });
  for (const oracle of runtime.oracles) {
    const r = await oracle.evaluate(context);
    oracleResults.push({ id: oracle.id, ...r });
  }

  const verdict = oracleResults.every(r => r.passed) ? 'pass' : 'fail';
  process.stdout.write(JSON.stringify({
    schemaVersion: 'factory.proof.scenario-evidence.v1',
    scenario: runtime.scenario,
    verdict,
    oracleResults,
    terminal: {
      terminalReason: driven.result.terminalReason,
      cycles: driven.result.cycles,
      strandedActiveExecutions: driven.result.strandedActiveExecutions,
      scriptedInvocationCount: observer.getInvocationCount(),
    },
    lifecycleRuns: durableTrace.lifecycleRuns,
    deliveryStageRuns: (durableTrace.stageRuns ?? []).filter(row => row.stage_id === 'delivery-release'),
    effectReceipts: durableTrace.effectReceipts ?? [],
    externalEffectEvents: durableTrace.externalEffectEvents ?? [],
  }) + '\n');
  await bootstrap.cleanup();
  process.exit(verdict === 'pass' ? 0 : 1);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  await bootstrap.cleanup();
  process.exit(2);
}
