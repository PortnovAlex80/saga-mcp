import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';
import { productDeliveryLifecycle } from '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js';
import {
  RUNNABLE_LOCAL_CLASSIFICATION,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';
import { canonicalJson } from '../../dist/shared/canonical-json.js';

test('default product build terminates after verified Development without Delivery', () => {
  assert.equal(productBuildLifecycle.identity.name, 'product-build');
  assert.deepEqual(
    productBuildLifecycle.stages.map(stage => stage.id),
    ['initial-discovery', 'solution-formalization', 'solution-development'],
  );
  const development = productBuildLifecycle.stages.at(-1);
  assert.deepEqual(development.outcomeRoutes.verified, {
    type: 'terminal', status: 'runnable-local',
  });
  assert.equal(
    productBuildLifecycle.stages.some(stage => stage.id === 'delivery-release'),
    false,
  );
});

test('legacy product-delivery definition remains unchanged for pinned runs', () => {
  assert.equal(productDeliveryLifecycle.identity.name, 'product-delivery');
  assert.equal(
    productDeliveryLifecycle.stages.some(stage => stage.id === 'delivery-release'),
    true,
  );
});

// ---- ADR-090 (CC-IC-1): the declared, digest-pinned injection table -------
// Blocking mutations m4/m4a: the frozen `runnable-local` classification owns
// its injection declaration — data declared BESIDE the classification in the
// SAME file, digest-pinned, domain-free, in the normative table order.

test('the frozen runnable-local terminal carries a declared, digest-pinned obligation injection table beside it (m4)', () => {
  // The classification is frozen by THIS definition's terminal route.
  const terminals = productBuildLifecycle.stages.flatMap(stage =>
    Object.values(stage.outcomeRoutes)
      .filter(route => route.type === 'terminal')
      .map(route => route.status),
  );
  assert.ok(terminals.includes(RUNNABLE_LOCAL_CLASSIFICATION));

  // The table maps exactly that classification, in declaration order:
  // whole-product-synthesis FIRST, then ordered-smoke (never interleaved).
  assert.equal(RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.schemaVersion, 'factory.lifecycle-obligation-injection.v1');
  assert.equal(RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.classification, 'runnable-local');
  assert.deepEqual(
    RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.entries.map(entry => entry.kind),
    ['synthesis', 'ordered-smoke'],
  );
  for (const entry of RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE.entries) {
    assert.equal(entry.class, 'execution');
    assert.ok(entry.text.trim().length > 0);
    assert.equal(entry.evidence_ref, 'lifecycle.classification.runnable-local');
  }

  // The table is digest-pinned: the declared digest content-addresses the
  // table, and the ref is that digest (m4a — an ad-hoc table can never pose
  // as the declared one).
  const recomputed = createHash('sha256')
    .update(canonicalJson(RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE)).digest('hex');
  assert.equal(RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST, recomputed);
  assert.equal(
    RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
    `lifecycle-obligation-injection:${RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_DIGEST}`,
  );
});

test('the injection declaration is domain-free data — no browser/canvas/frontend specifics, no workshop-name branch (m4, LEGO)', () => {
  const blob = canonicalJson(RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE).toLowerCase();
  for (const forbidden of ['browser', 'canvas', 'chrome', 'html', 'dom', 'react', 'npm']) {
    assert.equal(blob.includes(forbidden), false, `the declared table must stay domain-free (found '${forbidden}')`);
  }
  // The declaration lives beside the frozen classification in the lifecycle
  // file (data, not engine inference): no engine/settlement file re-derives
  // obligations by rereading prose or branching on workshop identity.
  const lifecycleSource = readFileSync(
    new URL('../../src/process-modules/lifecycles/product-build-lifecycle.ts', import.meta.url),
    'utf8',
  );
  assert.match(lifecycleSource, /RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE/);
  assert.doesNotMatch(lifecycleSource, /import .*modules\/discovery/);
  assert.doesNotMatch(lifecycleSource, /moduleRef\s*===?\s*['"]/);
});

test('generic Factory Start does not silently force static/no-dependency product architecture', () => {
  const gateway = readFileSync(new URL('../../scripts/factory.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /staticFilesOnly\s*:\s*true/);
  assert.doesNotMatch(gateway, /noDependencies\s*:\s*true/);
  assert.match(gateway, /localRunRequired\s*:\s*true/);
  assert.match(gateway, /deploymentExcluded\s*:\s*true/);
  assert.match(gateway, /humanAcceptanceAfterLocalStart\s*:\s*true/);
  assert.match(gateway, /buildReferenceDevelopmentPolicy\(\)/);
  assert.doesNotMatch(gateway, /reference-development-policy['"],\s*version/);
});

test('Factory Start keeps the immutable package store beside the durable DB by default', () => {
  // The engine-child env (package store default included) moved to the
  // extracted detached-spawn module (E-P1); the gateway delegates to it.
  const gateway = readFileSync(new URL('../../scripts/factory.mjs', import.meta.url), 'utf8');
  const spawnModule = readFileSync(
    new URL('../../scripts/factory-engine-spawn.mjs', import.meta.url), 'utf8',
  );
  assert.match(gateway, /spawnOrchestrateCliEngine/);
  assert.match(spawnModule, /SAGA_PACKAGE_STORE_DIR:\s*baseEnv\.SAGA_PACKAGE_STORE_DIR/);
  assert.match(spawnModule, /join\(dirname\(resolve\(dbPath\)\),\s*'package-store'\)/);
  assert.doesNotMatch(spawnModule, /SAGA_PACKAGE_STORE_DIR:\s*join\(repoRoot/);
});
