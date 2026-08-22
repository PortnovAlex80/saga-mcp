#!/usr/bin/env node
// tests/factory-proof/delivery-scenario-drive.mjs
//
// Execute ONE Delivery scenario through the UNIFIED conformance kernel:
// buildDeliveryRuntimeCase → runScenario → ScenarioEvidenceBundle v1.
//
// This file owns only INPUT CONSTRUCTION (the authorized release input built
// by the same production hash/policy modules the temporal fixtures use, and
// the production factory launch that selects the product-DELIVERY lifecycle).
// The evidence pipeline — canonical composition, drive, read-only trace,
// independent oracles, bundle digest — belongs to scenario-runner.mjs, the
// same kernel every other workshop drives through. No per-workshop
// mini-runner (kernel-unification repair, docs/testing/
// DELIVERY-KERNEL-REPAIR-PLAN.md §1.3).

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runScenario } from './scenario-runner.mjs';
import {
  buildCanonicalDeliveryProviders,
  deliveryProviderTelemetry,
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
  let launchRef = null;
  if (runtime.launchMode !== 'harness-default') {
  // ── INPUT CONSTRUCTION (production modules only — no test-side authority) ──
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
    humanApprovalRequired: runtime.humanApprovalRequired === true,
    requiredPreflightCheckIds: ['candidate-integrity'],
    actions: [releaseAction],
  };
  releasePolicy.contentHash = deliveryPolicyMod.hashDeliveryReleasePolicy(releasePolicy);
  const grantBody = {
    requestedBy: 'proof-delivery-night',
    // grant-mismatch scenario: the grant pins a policy hash that does NOT
    // match the submitted policy's contentHash — settlement must reject it.
    releasePolicyHash: runtime.corruptGrantPolicyHash
      ? shaMod.sha256Hex({ stale: 'diverted-policy' })
      : releasePolicy.contentHash,
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
  const launchRef0 = launchMod.requestFactoryLaunch({
    orderRef, mode: 'new',
    projectId: bootstrap.projectId, epicId: bootstrap.epicId,
    initiatedBy: 'proof-delivery-night',
    idempotencyKey: `proof-delivery-${randomUUID()}`,
    concurrency: HARNESS_CONCURRENCY_CEILING,
    lifecycleInput,
    lifecycleInputSchema: 'factory.product-delivery-lifecycle-input.v2',
  }, db);
  launchRef = launchRef0;
  } // end authorized input construction

  // ── THE UNIFIED KERNEL ──
  const { productDeliveryLifecycle } = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/process-modules/lifecycles/product-delivery-lifecycle.js')).href);
  const providers = buildCanonicalDeliveryProviders({
    repoPath: bootstrap.repoPath,
    ...(runtime.approvalStatus ? { approvalStatus: runtime.approvalStatus } : {}),
    ...(runtime.observeMismatch ? { observeMismatch: true } : {}),
    ...(runtime.executeUncertain ? { executeUncertain: true } : {}),
    ...(runtime.driftCandidate ? { driftCandidate: true } : {}),
    ...(runtime.worldAlreadyApplied ? { worldAlreadyApplied: true } : {}),
  });
  // observe-before-retry: the zero-duplicate oracle reads the provider
  // double's REAL mutation counter — the world was pre-seeded, so any
  // provider.execute() is a duplicate non-idempotent effect.
  const oracles = [...(runtime.oracles ?? [])];
  if (runtime.worldAlreadyApplied) {
    oracles.push({
      id: 'delivery.no-duplicate.provider-real-executions',
      evaluate() {
        const telemetry = deliveryProviderTelemetry(providers);
        return {
          passed: telemetry !== null
            && telemetry.realExecutions === 0
            && telemetry.worldPreseeded === true,
          evidenceRefs: ['provider-double:realExecutions'],
          details: telemetry === null
            ? { telemetry: null }
            : {
              realExecutions: telemetry.realExecutions,
              worldPreseeded: telemetry.worldPreseeded,
            },
        };
      },
    });
  }
  const bundle = await runScenario({
    scenario: runtime.scenario,
    bootstrap,
    proofModes: ['Durable', 'CanonicalFast'],
    handlers: runtime.handlers,
    oracles,
    actorEvidence: runtime.actorEvidence ?? [],
    ...(runtime.expectError ? { expectError: runtime.expectError } : {}),
    deliveryProviders: providers,
    // The production launch above is INPUT construction (factory_orders +
    // launch rows) — it wrote no authority tables; the kernel's clean-bootstrap
    // assertion stays meaningful for the authority surfaces it guards.
    assertCleanBootstrap: false,
    lifecycleDefinition: productDeliveryLifecycle,
    driveOptions: {
      ...(launchRef ? { launchRef } : {}),
      scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
      ...(runtime.driveOptions ?? {}),
    },
  });

  process.stdout.write(JSON.stringify(bundle) + '\n');
  await bootstrap.cleanup();
  process.exit(bundle.verdict === 'pass' ? 0 : 1);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  await bootstrap.cleanup();
  process.exit(2);
}
