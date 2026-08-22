// tests/factory-proof/delivery-kernel-unification.test.mjs
//
// Structural pins for the kernel-unification repair
// (docs/testing/DELIVERY-KERNEL-REPAIR-PLAN.md §1):
//   1. The Delivery drive is a CONSUMER of the unified kernel — it imports
//      runScenario and does NOT carry its own evidence pipeline (no manual
//      drive/oracle-evaluate/bundle assembly).
//   2. readInstalledIdentity fingerprints the lifecycle definition it is
//      given — a delivery identity differs from a build identity for the
//      same otherwise-identical inputs (evidence binds to the EXECUTED
//      composition, §10.2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

test('delivery drive goes through runScenario — no per-workshop mini-runner', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'tests', 'factory-proof', 'delivery-scenario-drive.mjs'),
    'utf8',
  );
  assert.match(source, /import \{ runScenario \}/,
    'the drive must import the unified kernel runner');
  assert.doesNotMatch(source, /driveCanonicalProof/,
    'the drive must not drive the composition itself');
  assert.doesNotMatch(source, /oracle\.evaluate|\.evaluate\(/,
    'the drive must not evaluate oracles itself');
  assert.doesNotMatch(source, /buildScenarioEvidenceBundle/,
    'the drive must not assemble evidence bundles itself');
  assert.match(source, /lifecycleDefinition:\s*productDeliveryLifecycle/,
    'the drive must select the product-delivery lifecycle through the runner');
});

test('scenario-runner threads lifecycleDefinition into the canonical composition', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'tests', 'factory-proof', 'scenario-runner.mjs'),
    'utf8',
  );
  assert.match(source, /input\.lifecycleDefinition/,
    'runScenario accepts lifecycleDefinition');
  assert.match(
    source, /buildCanonicalProofComposition\([\s\S]{0,900}lifecycleDefinition/,
    'and forwards it into buildCanonicalProofComposition');
});

test('readInstalledIdentity fingerprints the ACTUAL lifecycle (build ≠ delivery)', async () => {
  const { projectLifecycleIdentity } = await import('./canonical-proof-composition.mjs');
  const buildLifecycle = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/process-modules/lifecycles/product-build-lifecycle.js')).href);
  const deliveryLifecycle = await import(pathToFileURL(path.resolve(
    REPO_ROOT, 'dist/process-modules/lifecycles/product-delivery-lifecycle.js')).href);

  const build = projectLifecycleIdentity(buildLifecycle.productBuildLifecycle);
  const delivery = projectLifecycleIdentity(deliveryLifecycle.productDeliveryLifecycle);

  assert.equal(build.id, 'product-build@1.2.0');
  assert.equal(delivery.id, 'product-delivery@1.0.0');
  assert.notEqual(build.id, delivery.id,
    'a product-delivery drive must NOT carry a product-build identity');
  assert.ok(delivery.stages.some(s => s.stageId === 'delivery-release'),
    'the delivery identity carries the delivery-release stage');
  assert.ok(!build.stages.some(s => s.stageId === 'delivery-release'),
    'the build identity has no delivery stage');
  assert.notEqual(
    JSON.stringify(build), JSON.stringify(delivery),
    'the fingerprint inputs differ beyond the id');
});
