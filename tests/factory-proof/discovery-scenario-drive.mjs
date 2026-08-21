#!/usr/bin/env node
// tests/factory-proof/discovery-scenario-drive.mjs
//
// Execute ONE Discovery pack scenario on a fresh canonical Factory and print
// one ScenarioEvidenceBundle JSON line. Intended to be child-spawned by the
// coverage drive so DB/composition singletons never leak between scenarios.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import { buildDiscoveryRuntimeCase, DISCOVERY_SCENARIOS }
  from './discovery-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.DISCOVERY_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) {
  throw new Error(
    `DISCOVERY_SCENARIO required; known=${DISCOVERY_SCENARIOS.map(s => s.id).join(',')}`,
  );
}

const harness = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);
const manifest = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { bootstrapFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = manifest;

const runtime = buildDiscoveryRuntimeCase(scenarioId);
const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: `Unified Discovery proof scenario: ${scenarioId}`,
});

try {
  const bundle = await runScenario({
    scenario: runtime.scenario,
    bootstrap,
    proofModes: ['Durable', 'CanonicalFast'],
    handlers: runtime.handlers,
    oracles: runtime.oracles,
    driveOptions: {
      scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
      pollMs: 5,
      maxEmptyDispatchStreak: 12,
      ...runtime.driveOptions,
    },
  });
  process.stdout.write(JSON.stringify(bundle) + '\n');
  if (bundle.verdict !== 'pass') process.exitCode = 1;
} finally {
  bootstrap.cleanup();
}
