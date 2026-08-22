#!/usr/bin/env node
// tests/factory-proof/development-scenario-drive.mjs
//
// Execute ONE Development scenario on a fresh canonical Factory and print
// one ScenarioEvidenceBundle JSON line (same contract as the Formalization
// drive). Tranche D-A: the positive spine.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import { buildDevelopmentRuntimeCase } from './development-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.DEVELOPMENT_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) {
  throw new Error('DEVELOPMENT_SCENARIO required; known=development/happy-verified');
}

const runtime = buildDevelopmentRuntimeCase(scenarioId);

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
  idea: `Unified Development proof scenario: ${scenarioId}`,
});

try {
  const evidence = await runScenario({
    scenario: runtime.scenario,
    proofModes: ['Durable', 'CanonicalFast'],
    bootstrap,
    handlers: runtime.handlers,
    oracles: runtime.oracles,
    driveOptions: runtime.driveOptions,
  });
  process.stdout.write(JSON.stringify(evidence) + '\n');
  await bootstrap.cleanup();
  process.exit(evidence.verdict === 'pass' ? 0 : 1);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  await bootstrap.cleanup();
  process.exit(2);
}
