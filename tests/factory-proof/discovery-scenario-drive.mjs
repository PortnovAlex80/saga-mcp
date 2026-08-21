#!/usr/bin/env node
// tests/factory-proof/discovery-scenario-drive.mjs
//
// Execute ONE Discovery closure scenario on a fresh canonical Factory and
// print one ScenarioEvidenceBundle JSON line. Each scenario gets an isolated
// process so DB/composition singletons and scripted actor closures never leak.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScenario } from './scenario-runner.mjs';
import {
  DISCOVERY_CLOSURE_SCENARIOS,
  buildDiscoveryUnifiedRuntimeCase,
} from './discovery-resilience-pack.mjs';
import {
  DISCOVERY_RESTART_IDEA,
  runDiscoveryRestartProof,
} from './discovery-restart-proof.mjs';
import { runDiscoveryRetryExhaustionProof }
  from './discovery-retry-exhaustion-proof.mjs';

const REPO_ROOT = process.cwd();
const scenarioId = process.env.DISCOVERY_SCENARIO ?? process.argv[2] ?? '';
if (!scenarioId) {
  throw new Error(
    `DISCOVERY_SCENARIO required; known=${DISCOVERY_CLOSURE_SCENARIOS.map(s => s.id).join(',')}`,
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

const runtime = buildDiscoveryUnifiedRuntimeCase(scenarioId);
const retryTarget = /^discovery\/(proposal|readiness)-retry-exhaustion$/.exec(scenarioId)?.[1] ?? null;
const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: runtime.specialDrive === 'discovery-restart-idempotency'
    ? DISCOVERY_RESTART_IDEA
    : `Unified Discovery proof scenario: ${scenarioId}`,
});

try {
  let bundle;
  if (runtime.specialDrive === 'discovery-restart-idempotency') {
    bundle = await runDiscoveryRestartProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtime.handlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
    });
  } else if (retryTarget) {
    bundle = await runDiscoveryRetryExhaustionProof({
      scenario: runtime.scenario,
      bootstrap,
      handlers: runtime.handlers,
      concurrencyCap: HARNESS_CONCURRENCY_CEILING,
      target: {
        name: retryTarget,
        workplaceFragment: retryTarget === 'proposal'
          ? 'discovery-proposal'
          : 'discovery-readiness',
      },
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
