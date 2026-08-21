#!/usr/bin/env node
// tests/factory-proof/discovery-coverage-drive.mjs
//
// Run every Discovery scenario in an isolated child, aggregate PASS evidence
// through the mathematical coverage kernel, and print one compact report.
//
// Exit 0 means:
//   - every Phase-1 scenario produced a PASS ScenarioEvidenceBundle;
//   - demonstrated (not merely declared) Phase-1 coverage is 100%;
//   - no required Phase-1 coverage item is uncovered.
// Full-conformance gaps remain visible in report.full and do NOT fail this
// tranche until the strict recovery/fault scenarios are implemented.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  buildEvidenceCoverageMatrix,
  selectScenarioCover,
  summarizeCoverage,
} from './coverage-kernel.mjs';
import {
  DISCOVERY_FULL_COVERAGE_UNIVERSE,
  DISCOVERY_PHASE1_REQUIRED_COVERAGE,
  DISCOVERY_SCENARIOS,
  planDiscoveryCoverage,
} from './discovery-scenario-pack.mjs';

const REPO_ROOT = process.cwd();
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/discovery-scenario-drive.mjs');
const TIMEOUT_MS = Number(process.env.DISCOVERY_SCENARIO_TIMEOUT_MS ?? 180_000);

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
for (const scenario of DISCOVERY_SCENARIOS) {
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
    stderrTail: String(child.stderr ?? '').trim().slice(-1200),
  });
}

const phase1Matrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: DISCOVERY_PHASE1_REQUIRED_COVERAGE,
});
const fullMatrix = buildEvidenceCoverageMatrix(bundles, {
  requiredItems: DISCOVERY_FULL_COVERAGE_UNIVERSE,
});
const planned = planDiscoveryCoverage();

const report = {
  schemaVersion: 'factory.proof.discovery-coverage-report.v1',
  scenarios: runs,
  planned: {
    phase1: planned.phase1.summary,
    phase1MinimalScenarioCover: planned.phase1.minimalScenarioCover,
    full: planned.full.summary,
  },
  demonstrated: {
    phase1: summarizeCoverage(phase1Matrix),
    phase1MinimalScenarioCover: selectScenarioCover(phase1Matrix),
    full: summarizeCoverage(fullMatrix),
    fullMinimalScenarioCover: selectScenarioCover(fullMatrix),
    excludedBundles: phase1Matrix.excluded,
  },
};

process.stdout.write(JSON.stringify(report) + '\n');

const failedRuns = runs.filter(run => run.exitStatus !== 0 || run.verdict !== 'pass');
if (
  failedRuns.length > 0
  || report.demonstrated.phase1.uncovered.length > 0
  || report.demonstrated.phase1.percent !== 100
) {
  process.exitCode = 1;
}
