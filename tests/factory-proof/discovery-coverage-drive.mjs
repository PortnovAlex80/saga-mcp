#!/usr/bin/env node
// tests/factory-proof/discovery-coverage-drive.mjs
//
// Run every Discovery closure scenario in an isolated child, aggregate only
// PASS ScenarioEvidenceBundles, and require 100% demonstrated workshop closure.
// The one internal settlement-exception edge remains explicitly classified as
// a platform K4 fault-scheduler obligation, not silently counted as covered.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  buildEvidenceCoverageMatrix,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';
import {
  DISCOVERY_PHASE1_REQUIRED_COVERAGE,
} from './discovery-scenario-pack.mjs';
import {
  DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
  DISCOVERY_CLOSURE_SCENARIOS,
  DISCOVERY_PLATFORM_FAULT_EDGES,
  planDiscoveryClosureCoverage,
} from './discovery-resilience-pack.mjs';

const REPO_ROOT = process.cwd();
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/discovery-scenario-drive.mjs');
const TIMEOUT_MS = Number(process.env.DISCOVERY_SCENARIO_TIMEOUT_MS ?? 240_000);

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
for (const scenario of DISCOVERY_CLOSURE_SCENARIOS) {
  const child = spawnSync(process.execPath, [DRIVE, scenario.id], {
    cwd: REPO_ROOT,
    env: { ...process.env, DISCOVERY_SCENARIO: scenario.id },
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
    stderrTail: String(child.stderr ?? '').trim().slice(-1600),
  });
}

const phase1Matrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: DISCOVERY_PHASE1_REQUIRED_COVERAGE,
});
const closureMatrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
});
const planned = planDiscoveryClosureCoverage();

const report = {
  schemaVersion: 'factory.proof.discovery-coverage-report.v2',
  closureDefinition: {
    workshopRequiredItems: DISCOVERY_CLOSURE_COVERAGE_UNIVERSE.length,
    platformFaultEdges: DISCOVERY_PLATFORM_FAULT_EDGES,
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
