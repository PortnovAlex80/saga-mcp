// tests/factory-e2e/fresh-harness.self-test.mjs
//
// W9-01 HARNESS SELF-TEST. Proves the fresh scripted completion harness is
// VALID — NOT the W9-02 acceptance run. Asserts exactly the four harness
// properties from the W9-01 gate:
//
//   1. BOOTS FRESH — a clean per-run DB + git repo; zero authority rows before
//      the drive (no manual authority writes, ever).
//   2. CONCURRENCY ≤ 2 OBSERVABLE — effectiveConcurrency === cap AND the
//      scripted observer's high-water mark never exceeds the cap.
//   3. SETUP VIA PRODUCTION APIs — lifecycle input assembled + validated by the
//      production assembler; launch requested via the production launch API;
//      workshop manifest installed; drive runs the production runEpisode +
//      dispatch loop in-process. The scripted executor substitutes ONLY
//      inference (the workerExecutorFactory seam) — every authority row is
//      created by the production runtime.
//   4. MANIFEST PARSES — defaultW9RunManifest validates and declares both the
//      W9-02 (happy) and W9-03 (adversarial) scenarios.
//
// This is run TWICE to confirm determinism (no child-process / replay-capsule
// flakiness — the whole drive is in-process).

import { test } from 'node:test';
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const {
  bootstrapFreshHarness,
  driveFreshHarness,
} = harness;

const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const {
  parseRunManifest,
  defaultW9RunManifest,
  W9_AUTHORITY_INVARIANTS,
  HARNESS_CONCURRENCY_CEILING,
} = manifestMod;

const { createScriptedObserver } = await import('./scripted-inference.mjs');
const { buildHarnessComposition } = await import('./harness-composition.mjs');

const STARTING_SHA = '465b3ad';
const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING; // 2

test('run manifest parses and declares W9-02 (happy) + W9-03 (adversarial) scenarios', () => {
  const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: STARTING_SHA }));
  assert.equal(manifest.manifestVersion, 'factory-e2e.run-manifest.v1');
  assert.equal(manifest.baseline.startingSha, STARTING_SHA);
  assert.equal(manifest.baseline.inferenceMode, 'scripted');
  assert.equal(manifest.baseline.authorityModel, 'workplace-production-revision');
  assert.ok(
    manifest.baseline.concurrencyCap <= HARNESS_CONCURRENCY_CEILING,
    `baseline cap ${manifest.baseline.concurrencyCap} must be ≤ ${HARNESS_CONCURRENCY_CEILING}`,
  );

  const lanes = new Set(manifest.scenarios.map(s => s.lane));
  assert.ok(lanes.has('W9-02'), 'manifest declares the W9-02 happy path');
  assert.ok(lanes.has('W9-03'), 'manifest declares the W9-03 adversarial path');

  for (const scenario of manifest.scenarios) {
    assert.equal(scenario.freshState, true, `${scenario.scenarioId} starts fresh`);
    assert.ok(scenario.concurrencyCap <= HARNESS_CONCURRENCY_CEILING);
    assert.equal(scenario.scriptedInference.mode, 'scripted');
    assert.ok(scenario.scriptedInference.scenarioKey.length > 0);
    assert.ok(
      scenario.expectedAuthorityInvariants.length > 0,
      `${scenario.scenarioId} declares invariants`,
    );
    // Crash points must be deterministic (named + trigger), never random.
    for (const cp of scenario.deterministicCrashPoints) {
      assert.ok(cp.name.length > 0);
      assert.ok(cp.trigger === 'invocation-count' || cp.trigger === 'named-marker');
      if (cp.trigger === 'invocation-count') {
        assert.ok(Number.isInteger(cp.atInvocation) && cp.atInvocation >= 1);
      }
    }
  }

  // The adversarial cross-execution scenario must declare a deterministic
  // crash point (the W9-03 contract: no random fault injection).
  const crossExec = manifest.scenarios.find(s => s.scenarioId === 'w9-03-cross-execution-durability');
  assert.ok(crossExec, 'cross-execution-durability scenario declared');
  assert.ok(crossExec.deterministicCrashPoints.length >= 1);

  // Every scenario preserves the no-authority-hacks invariant.
  for (const scenario of manifest.scenarios) {
    const ids = scenario.expectedAuthorityInvariants.map(i => i.id);
    assert.ok(ids.includes('no-authority-hacks'), `${scenario.scenarioId} preserves no-authority-hacks`);
  }
  assert.ok(W9_AUTHORITY_INVARIANTS.length >= 5);
});

test('manifest parser rejects forbidden authority models + carry-over + random cap', () => {
  const good = defaultW9RunManifest({ startingSha: STARTING_SHA });
  // carry-over forbidden
  assert.throws(
    () => parseRunManifest({
      ...good,
      scenarios: [{ ...good.scenarios[0], scenarioId: 'x', freshState: false }],
    }),
    /freshState=true/,
  );
  // cap above ceiling forbidden
  assert.throws(
    () => parseRunManifest({
      ...good,
      baseline: { ...good.baseline, concurrencyCap: 3 },
    }),
    /concurrencyCap must be an integer in 1\.\.2/,
  );
  // real-model inference forbidden
  assert.throws(
    () => parseRunManifest({
      ...good,
      scenarios: good.scenarios.map(s => ({
        ...s,
        scriptedInference: { ...s.scriptedInference, mode: 'real-model' },
      })),
    }),
    /mode must be 'scripted'/,
  );
  // execution-scoped authority model forbidden
  assert.throws(
    () => parseRunManifest({
      ...good,
      baseline: { ...good.baseline, authorityModel: 'execution-scoped' },
    }),
    /authorityModel must be 'workplace-production-revision'/,
  );
  // random (undefined) crash trigger forbidden
  assert.throws(
    () => parseRunManifest({
      ...good,
      scenarios: [{
        ...good.scenarios[0],
        deterministicCrashPoints: [{
          name: 'x', trigger: 'random', effect: 'exit-without-done', description: 'd',
        }],
      }],
    }),
    /trigger must be 'invocation-count' or 'named-marker'/,
  );
});

async function runOneHarnessDrive(label) {
  const bootstrap = await bootstrapFreshHarness({
    repoRoot: REPO_ROOT,
    concurrencyCap: SCENARIO_CAP,
    idea: `fresh harness self-test (${label}): prove scripted-inference machinery`,
  });
  try {
    // (1) BOOTS FRESH: zero authority rows before the drive.
    bootstrap.assertNoAuthorityWritesYet();

    // (4 + 3) manifest parses; setup already happened via production APIs
    // inside bootstrap (assembleProductLifecycleInput + installProductionModules
    // + requestFactoryLaunch). Re-parse to confirm the declaration is stable.
    const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: STARTING_SHA }));
    assert.equal(manifest.baseline.concurrencyCap, SCENARIO_CAP);

    const observer = createScriptedObserver();
    const composition = buildHarnessComposition({
      observer,
      repoPath: bootstrap.repoPath,
      sagaRepoRoot: bootstrap.sagaRepoRoot,
    });

    // (3) DRIVE via production APIs, in-process, bounded. The scripted executor
    // substitutes ONLY inference; this is NOT the W9-02 acceptance run.
    //
    // maxCycles=1 is intentional and sufficient for the HARNESS VALIDITY proof:
    // one runEpisode starts the lifecycle via the production runtime and pauses
    // for a worker; one dispatch round assigns a card through the production
    // WorkAssignmentPort and the scripted executor drives it to a clean
    // semantic completion. That proves every harness property (fresh boot, cap
    // enforced, production-API setup, scripted seam works, no stranded
    // executions). Driving the lifecycle to terminal convergence is W9-02's
    // job (it supplies full per-module handlers + further cycles).
    const result = await driveFreshHarness({
      bootstrap,
      composition,
      scenarioConcurrencyCap: SCENARIO_CAP,
      maxCycles: 1,
      pollMs: 5,
      maxEmptyDispatchStreak: 2,
      scriptedObserver: observer,
    });

    // (2) CONCURRENCY ≤ 2 OBSERVABLE: the durable admission enforces the cap,
    // and the scripted executor's high-water mark never exceeded it.
    assert.equal(
      result.effectiveConcurrency,
      SCENARIO_CAP,
      `${label}: effectiveConcurrency must equal the cap ${SCENARIO_CAP}`,
    );
    assert.ok(
      result.maxObservedConcurrency <= SCENARIO_CAP,
      `${label}: observed concurrency ${result.maxObservedConcurrency} exceeded cap ${SCENARIO_CAP}`,
    );
    assert.ok(
      result.maxObservedConcurrency >= 0 && result.maxObservedConcurrency <= SCENARIO_CAP,
      `${label}: maxObservedConcurrency in range`,
    );

    // The drive must terminate (bounded), leave no stranded active executions,
    // and not hang. stoppedByCycleBound proves the loop exited because the
    // declared cycle budget was reached (not an exception, not a hang).
    assert.equal(
      result.strandedActiveExecutions,
      0,
      `${label}: no stranded active executions (got ${result.strandedActiveExecutions})`,
    );
    assert.ok(
      result.reachedTerminal || result.stoppedByCycleBound,
      `${label}: drive exited via terminal or cycle bound (reason=${result.terminalReason})`,
    );
    assert.equal(result.cycles, 1, `${label}: exactly one runEpisode cycle ran`);
    // The scripted executor MUST have been invoked at least once — proving the
    // workerExecutorFactory seam carried an assigned card to scripted inference.
    assert.ok(
      result.scriptedInvocationCount >= 1,
      `${label}: scripted executor invoked at least once (got ${result.scriptedInvocationCount})`,
    );

    return result;
  } finally {
    bootstrap.cleanup();
  }
}

test('harness self-test drive #1: fresh boot, cap ≤ 2, production APIs, scripted seam', async () => {
  await runOneHarnessDrive('drive-1');
});

test('harness self-test drive #2: identical inputs produce an identical-shaped result (not flaky)', async () => {
  await runOneHarnessDrive('drive-2');
});
