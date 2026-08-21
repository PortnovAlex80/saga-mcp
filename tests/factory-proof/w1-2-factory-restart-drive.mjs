#!/usr/bin/env node
// tests/factory-proof/w1-2-factory-restart-drive.mjs
//
// W1-2 — the CONVEYOR §16 two-pass proof through the canonical composition:
//
//   Run A: a full product-build lifecycle, cold (every cell invokes).
//   Run B: a DELIBERATE NEW Factory Start (requestFreshHarnessLaunch — new
//          Process/Stage/Lifecycle, Workplace, CandidateSet, Gate identities)
//          with the SAME semantic input. Replay-first applies: compatible
//          cells replay run A's certified capsules through the PRODUCTION
//          capsule executor (zero scripted inferences on those cells).
//   Run C: another new Factory Start with INCOMPATIBLE key material (a
//          different semantic input) — capsule reuse is forbidden; every
//          cell resolves as a typed miss and runs cold.
//
// Not a resume: three distinct lifecycle runs. Evidence emitted as one JSON
// line for the test pack.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness, requestFreshHarnessLaunch } = harness;
const { HARNESS_CONCURRENCY_CEILING } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { buildCanonicalProofComposition, createScriptedObserver } = await import('./canonical-proof-composition.mjs');
const { W9_HAPPY_HANDLERS } = await import('../factory-e2e/w9-happy-handlers.mjs');

const IDEA_X = 'W1-2 semantic input X: the deterministic two-criteria pipeline product';
const IDEA_Y = 'W1-2 semantic input Y: a deliberately DIFFERENT product (incompatible key material)';

async function runLifecycle(bootstrap, launchRef, idea, label) {
  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: W9_HAPPY_HANDLERS,
  });
  let result;
  try {
    result = await driveFreshHarness({
      bootstrap,
      composition,
      ...(launchRef ? { launchRef } : {}),
      scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
      maxCycles: 200, pollMs: 5, maxEmptyDispatchStreak: 12, scriptedObserver: observer,
    });
  } catch (error) {
    process.stderr.write(`[w1-2] run ${label} FAILED: ${error instanceof Error ? error.message : String(error)} `
      + `cycles? lifecycles=${JSON.stringify(dbMod_getDb().prepare('SELECT id,status FROM factory_lifecycle_runs ORDER BY id').all())}
`);
    throw error;
  }
  return { observer, result };
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const keepDir = process.env.W12_KEEP_DIR;
function dbMod_getDb() { return dbGetter(); }
let dbGetter = () => { throw new Error('db not ready'); };
const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: IDEA_X,
  ...(keepDir ? { tempDir: keepDir } : {}),
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  // ---- Run A: cold -------------------------------------------------------
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  dbGetter = getDb;
  const db = getDb();
  const A = await runLifecycle(bootstrap, null, IDEA_X, 'A');
  const lifecyclesAfterA = db.prepare('SELECT COUNT(*) AS n FROM factory_lifecycle_runs').get().n;

  process.stderr.write(`[w1-2] after A: terminal=${A.result.terminalReason} `
    + `invocations=${A.observer.getInvocationCount()} replays=${A.observer.getReplayCount()} `
    + `lifecycles=${JSON.stringify(db.prepare('SELECT id,status,terminal_status FROM factory_lifecycle_runs ORDER BY id').all())}
`);

  // ---- Run B: NEW Factory Start, same semantic input ---------------------
  const launchB = requestFreshHarnessLaunch(bootstrap, { idea: IDEA_X });
  const B = await runLifecycle(bootstrap, launchB, IDEA_X, 'B');

  process.stderr.write(`[w1-2] after B: terminal=${B.result.terminalReason} cycles=${B.result.cycles} `
    + `stoppedByCycleBound=${B.result.stoppedByCycleBound} invocations=${B.observer.getInvocationCount()} replays=${B.observer.getReplayCount()} `
    + `wp=${JSON.stringify(db.prepare("SELECT production_cell_id,kanban_phase,loop_state FROM factory_workplaces WHERE process_run_id IN (SELECT process_run_id FROM factory_stage_runs WHERE lifecycle_run_id=2 AND process_run_id IS NOT NULL) AND kanban_phase<>'done'").all())}
`);

  // ---- Run C: NEW Factory Start, incompatible key material ---------------
  const launchC = requestFreshHarnessLaunch(bootstrap, { idea: IDEA_Y });
  const C = await runLifecycle(bootstrap, launchC, IDEA_Y, 'C');

  // ---- Evidence ----------------------------------------------------------
  const lifecycles = db.prepare('SELECT id, status, terminal_status FROM factory_lifecycle_runs ORDER BY id').all();
  const identities = lifecycles.map(lif => {
    const processRuns = db.prepare(
      `SELECT process_run_id FROM factory_stage_runs WHERE lifecycle_run_id=? AND process_run_id IS NOT NULL`,
    ).all(lif.id).map(r => r.process_run_id);
    const workplaces = processRuns.length
      ? db.prepare(
          `SELECT DISTINCT w.workplace_ref FROM factory_workplaces w WHERE w.process_run_id IN (${processRuns.map(() => '?').join(',')})`,
        ).all(...processRuns).map(r => r.workplace_ref)
      : [];
    const candidates = processRuns.length
      ? db.prepare(
          `SELECT DISTINCT cs.candidate_set_ref FROM factory_candidate_sets cs
            JOIN factory_workplaces w ON w.workplace_ref=cs.workplace_ref
           WHERE w.process_run_id IN (${processRuns.map(() => '?').join(',')})`,
        ).all(...processRuns).map(r => r.candidate_set_ref)
      : [];
    const gates = processRuns.length
      ? db.prepare(
          `SELECT DISTINCT gd.decision_key FROM factory_gate_decisions gd
            JOIN factory_workplaces w ON w.workplace_ref=gd.workplace_ref
           WHERE w.process_run_id IN (${processRuns.map(() => '?').join(',')})`,
        ).all(...processRuns).map(r => r.decision_key)
      : [];
    const capsuleBound = processRuns.length
      ? db.prepare(
          `SELECT COUNT(*) AS n FROM worker_executions we JOIN tasks t ON t.id=we.task_id
            WHERE t.workplace_ref IN (SELECT workplace_ref FROM factory_workplaces WHERE process_run_id IN (${processRuns.map(() => '?').join(',')}'))
              AND json_extract(we.metadata,'$.execution_context.replay.capsule_ref') IS NOT NULL`,
        ).get(...processRuns).n
      : 0;
    return { lif, workplaces, candidates, gates, capsuleBound };
  });

  const overlap = (setKey) => {
    const sets = identities.map(i => new Set(i[setKey]));
    const shared = [];
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        for (const item of sets[i]) if (sets[j].has(item)) shared.push(`${i}∩${j}:${item}`);
      }
    }
    return shared;
  };

  process.stdout.write(JSON.stringify({
    runA: {
      terminalReason: A.result.terminalReason,
      invocations: A.observer.getInvocationCount(),
      replays: A.observer.getReplayCount(),
    },
    runB: {
      terminalReason: B.result.terminalReason,
      invocations: B.observer.getInvocationCount(),
      replays: B.observer.getReplayCount(),
      capsuleBoundExecutions: identities[1]?.capsuleBound ?? 0,
    },
    runC: {
      terminalReason: C.result.terminalReason,
      invocations: C.observer.getInvocationCount(),
      replays: C.observer.getReplayCount(),
      capsuleBoundExecutions: identities[2]?.capsuleBound ?? 0,
    },
    lifecycles,
    lifecyclesAfterA,
    disjoint: {
      workplaces: overlap('workplaces'),
      candidates: overlap('candidates'),
      gates: overlap('gates'),
    },
    counts: identities.map(i => ({
      workplaces: i.workplaces.length,
      candidates: i.candidates.length,
      gates: i.gates.length,
      capsuleBound: i.capsuleBound,
    })),
    stranded: A.result.strandedActiveExecutions + B.result.strandedActiveExecutions + C.result.strandedActiveExecutions,
  }) + '\n');
} finally {
  bootstrap.cleanup();
}
