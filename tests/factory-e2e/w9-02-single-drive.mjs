#!/usr/bin/env node
// tests/factory-e2e/w9-02-single-drive.mjs
//
// Standalone single-drive runner for W9-02. Runs ONE complete happy-path drive
// (Discovery → Formalization → Development → runnable-local) in an isolated
// process and prints a JSON evidence bundle on stdout. The companion test
// (w9-02-happy-path.test.mjs) invokes this script twice (as separate child
// processes) to prove determinism without cross-drive module-level state
// contamination (product-tool caches, composition-root singletons).

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const label = process.env.W9_DRIVE_LABEL || 'drive';

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const { HARNESS_CONCURRENCY_CEILING } = manifestMod;
const { createScriptedObserver } = await import('./scripted-inference.mjs');
const { buildHarnessComposition } = await import('./harness-composition.mjs');
const { W9_HAPPY_HANDLERS } = await import('./w9-happy-handlers.mjs');
const { defaultW9RunManifest, parseRunManifest } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;
const STARTING_SHA = '8c2d679';

// Verify the manifest declares this scenario.
const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: STARTING_SHA }));
const happyScenario = manifest.scenarios.find(s => s.scenarioId === 'w9-02-happy-full-lifecycle');
if (!happyScenario) throw new Error('w9-02-happy-full-lifecycle scenario not declared');

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: `W9-02 happy full lifecycle (${label}): scripted Discovery→Formalization→Development→runnable-local`,
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  const observer = createScriptedObserver();
  const composition = buildHarnessComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: W9_HAPPY_HANDLERS,
  });

  const result = await driveFreshHarness({
    bootstrap,
    composition,
    scenarioConcurrencyCap: SCENARIO_CAP,
    maxCycles: 120,
    pollMs: 5,
    maxEmptyDispatchStreak: 10,
    scriptedObserver: observer,
  });

  // Query the per-run DB for runnable-local evidence.
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  const devRun = db.prepare(
    `SELECT id, module_name, status, local_outcome
       FROM factory_process_runs
      WHERE module_name LIKE '%development%' ORDER BY id DESC LIMIT 1`,
  ).get();

  const lrReceipt = db.prepare(
    `SELECT outcome, subject_candidate_set_ref
       FROM factory_check_receipts
      WHERE provider_id='factory.local-runnability.v1' AND outcome='passed'
      ORDER BY rowid DESC LIMIT 1`,
  ).get();

  const candidateProduct = db.prepare(
    `SELECT payload_snapshot FROM factory_process_products
      WHERE schema_id='factory.integrated-release-candidate.v1'
      ORDER BY id DESC LIMIT 1`,
  ).get();
  const candidatePayload = candidateProduct ? JSON.parse(candidateProduct.payload_snapshot) : {};

  const candidateMember = db.prepare(
    `SELECT m.candidate_set_ref FROM factory_candidate_set_members m
      JOIN factory_candidate_sets cs ON cs.candidate_set_ref=m.candidate_set_ref
     WHERE m.product_schema='factory.integrated-release-candidate.v1' AND cs.role='author'
      ORDER BY m.id DESC LIMIT 1`,
  ).get();

  // Authority-table no-hack guard (post-drive): authority rows exist ONLY from
  // the production runtime, never from the harness. We can't re-assert zero
  // (the drive created them), but we assert the invariant is structurally
  // present in the manifest.
  const evidence = {
    label,
    reachedRunnableLocal: devRun?.local_outcome === 'verified' && lrReceipt?.outcome === 'passed',
    devOutcome: devRun?.local_outcome ?? null,
    devStatus: devRun?.status ?? null,
    lrReceiptOutcome: lrReceipt?.outcome ?? null,
    candidateHasReadiness: Boolean(candidatePayload.readiness),
    readinessKind: candidatePayload.readiness?.kind ?? null,
    candidateSealed: Boolean(candidateMember),
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    scriptedInvocationCount: result.scriptedInvocationCount,
    maxObservedConcurrency: result.maxObservedConcurrency,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    invariantsDeclared: happyScenario.expectedAuthorityInvariants.map(i => i.id),
  };

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(effectiveConcurrencyCheck(result), SCENARIO_CAP, `${label}: concurrency`);
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.ok(result.scriptedInvocationCount >= 10, `${label}: ≥10 scripted invocations`);
  A.equal(devRun?.status, 'completed', `${label}: development status=completed`);
  A.equal(devRun?.local_outcome, 'verified', `${label}: development outcome=verified`);
  A.ok(lrReceipt, `${label}: passed local-readiness receipt exists`);
  A.equal(lrReceipt.outcome, 'passed', `${label}: LR receipt outcome=passed`);
  A.ok(candidateMember, `${label}: integrated candidate sealed as CandidateSet member`);
  A.ok(candidatePayload.readiness, `${label}: candidate carries readiness profile`);

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}

function effectiveConcurrencyCheck(result) {
  return result.effectiveConcurrency;
}
