#!/usr/bin/env node
// tests/factory-proof/formalization-scenario-drive.mjs
//
// Execute ONE Formalization closure scenario on a fresh canonical Factory and
// print one ScenarioEvidenceBundle JSON line. Each scenario is isolated so DB,
// composition singletons and actor closure state cannot leak between cases.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import {
  FORMALIZATION_CLOSURE_SCENARIOS,
  buildFormalizationUnifiedRuntimeCase,
} from './formalization-resilience-pack.mjs';
import {
  FORMALIZATION_RESTART_IDEA,
  runFormalizationRestartProof,
} from './formalization-restart-proof.mjs';
import {
  runFormalizationRetryExhaustionProof,
} from './formalization-retry-exhaustion-proof.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.FORMALIZATION_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) {
  throw new Error(
    `FORMALIZATION_SCENARIO required; known=${FORMALIZATION_CLOSURE_SCENARIOS.map(s => s.id).join(',')}`,
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

const runtime = buildFormalizationUnifiedRuntimeCase(scenarioId);
const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: runtime.specialDrive === 'formalization-restart-idempotency'
    ? FORMALIZATION_RESTART_IDEA
    : `Unified Formalization proof scenario: ${scenarioId}`,
});

try {
  let bundle;
  if (runtime.specialDrive === 'formalization-restart-idempotency') {
    bundle = await runFormalizationRestartProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtime.handlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
    });
  } else if (runtime.specialDrive === 'formalization-retry-exhaustion') {
    bundle = await runFormalizationRetryExhaustionProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtime.handlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
      targetName: runtime.targetName,
    });
  } else {
    bundle = await runScenario({
      scenario: runtime.scenario,
      bootstrap,
      proofModes: ['Durable', 'CanonicalFast'],
      handlers: runtime.handlers,
      crashPoint: runtime.crashPoint,
      oracles: runtime.oracles,
      actorEvidence: runtime.actorEvidence,
      faultJournal: runtime.faultJournal,
      externalWorldJournal: runtime.externalWorldJournal,
      driveOptions: {
        scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
        pollMs: 5,
        maxEmptyDispatchStreak: 12,
        ...runtime.driveOptions,
      },
    });
  }
  process.stdout.write(JSON.stringify(bundle) + '\n');
  if (bundle.verdict !== 'pass') process.exitCode = 1;
} finally {
  bootstrap.cleanup();
}
