#!/usr/bin/env node
// tests/factory-proof/formalization-coverage-drive.mjs
//
// Run every Formalization closure scenario in an isolated child, aggregate only
// PASS ScenarioEvidenceBundles, and require 100% demonstrated workshop closure.
// Internal kernel/effect timing faults remain explicitly assigned to K4.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  buildEvidenceCoverageMatrix,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';
import {
  FORMALIZATION_PHASE1_REQUIRED_COVERAGE,
  FORMALIZATION_PLATFORM_FAULT_EDGES,
} from './formalization-scenario-pack.mjs';
import {
  FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
  FORMALIZATION_CLOSURE_SCENARIOS,
  planFormalizationClosureCoverage,
} from './formalization-resilience-pack.mjs';

const REPO_ROOT = process.cwd();
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/formalization-scenario-drive.mjs');
// Five retry-exhaustion scenarios intentionally cross the real one-minute
// production backoff. Keep per-scenario timeout comfortably above that bound.
const TIMEOUT_MS = Number(process.env.FORMALIZATION_SCENARIO_TIMEOUT_MS ?? 300_000);

function parseBundle(stdout, scenarioId) {
  const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.scenario?.id === scenarioId && parsed?.bundleDigest) return parsed;
    } catch {
      // diagnostic/log line, keep scanning backwards
    }
  }
  return null;
}

const bundles = [];
const runs = [];
for (const scenario of FORMALIZATION_CLOSURE_SCENARIOS) {
  const child = spawnSync(process.execPath, [DRIVE, scenario.id], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORMALIZATION_SCENARIO: scenario.id },
    encoding: 'utf8',
    windowsHide: true,
    timeout: TIMEOUT_MS,
  });
  const bundle = parseBundle(child.stdout, scenario.id);
  if (bundle) bundles.push(bundle);
  runs.push({
    id: scenario.id,
    exitStatus: child.status,
    signal: child.signal ?? null,
    verdict: bundle?.verdict ?? 'no-evidence',
    bundleDigest: bundle?.bundleDigest ?? null,
    stderrTail: String(child.stderr ?? '').trim().slice(-2000),
  });
}

const phase1Matrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: FORMALIZATION_PHASE1_REQUIRED_COVERAGE,
});
const closureMatrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
});
const planned = planFormalizationClosureCoverage();

const report = {
  schemaVersion: 'factory.proof.formalization-coverage-report.v1',
  closureDefinition: {
    workshopRequiredItems: FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE.length,
    platformFaultEdges: FORMALIZATION_PLATFORM_FAULT_EDGES,
  },
  scenarios: runs,
  planned: {
    closure: planned.summary,
    minimalScenarioCover: planned.minimalScenarioCover,
  },
  demonstrated: {
    phase1: summarizeCoverage(phase1Matrix),
    closure: summarizeCoverage(closureMatrix),
    minimalScenarioCover: selectScenarioCover(closureMatrix),
    excludedBundles: closureMatrix.excluded,
  },
};

process.stdout.write(JSON.stringify(report) + '\n');

const failedRuns = runs.filter(run => run.exitStatus !== 0 || run.verdict !== 'pass');
if (
  failedRuns.length > 0
  || report.planned.closure.uncovered.length > 0
  || report.planned.closure.percent !== 100
  || report.demonstrated.closure.uncovered.length > 0
  || report.demonstrated.closure.percent !== 100
) {
  process.exitCode = 1;
}
