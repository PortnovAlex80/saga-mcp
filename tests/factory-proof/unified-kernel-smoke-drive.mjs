#!/usr/bin/env node
// tests/factory-proof/unified-kernel-smoke-drive.mjs
//
// Manual/local first drive of the unified ScenarioRunner + EvidenceBundle.
// It deliberately leaves the legacy canonical-happy drive untouched so the
// migration can compare old and new evidence before deleting anything.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  KERNEL_SCENARIO_SCHEMA_VERSION,
  runScenario,
} from './scenario-runner.mjs';
import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';

const REPO_ROOT = process.cwd();
const harness = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);
const manifest = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { bootstrapFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = manifest;

const scenario = Object.freeze({
  schemaVersion: KERNEL_SCENARIO_SCHEMA_VERSION,
  id: 'kernel/canonical-happy-discovery-formalization-development',
  kind: 'positive',
  proves: [],
  coverageItems: [
    'path:discovery>formalization>development',
    'transition-class:positive',
    'actor-mode:scripted-cognition',
  ],
});

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: 'Unified kernel smoke: deterministic Hello World delivery pipeline',
});

try {
  const evidence = await runScenario({
    scenario,
    proofModes: ['CanonicalFast'],
    bootstrap,
    handlers: W9_HAPPY_HANDLERS,
    driveOptions: {
      scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
      maxCycles: 120,
      pollMs: 5,
      maxEmptyDispatchStreak: 10,
    },
    oracles: [
      {
        id: 'kernel.smoke.development-verified',
        evaluate: ({ durableTrace }) => {
          const development = durableTrace.processRuns
            .filter(run => String(run.module_name).includes('development'))
            .at(-1);
          return {
            passed: development?.local_outcome === 'verified',
            evidenceRefs: development ? [`process-run:${development.id}`] : [],
            details: development ?? { reason: 'development process run absent' },
          };
        },
      },
      {
        id: 'kernel.smoke.real-gates-observed',
        evaluate: ({ durableTrace }) => ({
          passed: durableTrace.gateDecisions.length > 0,
          evidenceRefs: durableTrace.gateDecisions
            .slice(0, 8)
            .map(decision => `gate:${decision.decision_key}`),
          details: { count: durableTrace.gateDecisions.length },
        }),
      },
    ],
  });

  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (evidence.verdict !== 'pass') process.exitCode = 1;
} finally {
  bootstrap.cleanup();
}
