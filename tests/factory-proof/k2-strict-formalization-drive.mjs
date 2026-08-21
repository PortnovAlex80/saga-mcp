#!/usr/bin/env node
// tests/factory-proof/k2-strict-formalization-drive.mjs
//
// The K2-B strict drive. One lifecycle per invocation, driven through the
// canonical composition in STRICT mode (workerSpawn; no in-process
// executor), stopped at the Formalization stage outcome. Emits one JSON
// evidence line (the last stdout line) for the test pack.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const VARIANT = process.env.K2_VARIANT ?? 'positive';

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { buildCanonicalProofComposition, createScriptedObserver } = await import('./canonical-proof-composition.mjs');
const { createScriptedChildSpawn } = await import('./k2-spawn-override.mjs');

const PROGRAM = path.resolve(REPO_ROOT, 'tests/factory-proof/k2-corpus-formalization.mjs');
const FABRICATED = 'dcddb474aa26b7f8ff7a81f5324bbf4c1cb1f1e5b3b8f1f6d5f9d0c2b8a7e4f1';

const spawnDir = mkdtempSync(path.join(tmpdir(), `k2-${VARIANT}-`));
const spawnLog = path.join(spawnDir, 'spawn.jsonl');
process.env.DB_PATH = '';
process.env.SAGA_REAL_CLAUDE_PATH = `node ${path.resolve(REPO_ROOT, 'tools/agent-proxy/claude-shim.mjs')}`;
process.env.SAGA_CLAUDE_PATH = process.env.SAGA_REAL_CLAUDE_PATH;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: `K2-B strict formalization vertical (${VARIANT})`,
});

try {
  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    workerSpawn: createScriptedChildSpawn({
      programPath: PROGRAM,
      spawnLog,
      variant: VARIANT,
      stripMcpConfig: VARIANT === 'no-mcp-config',
    }),
  });

  const result = await driveFreshHarness({
    bootstrap,
    composition,
    scenarioConcurrencyCap: 1,
    maxCycles: 90,
    pollMs: 5,
    maxEmptyDispatchStreak: 25,
    stopOnStageOutcome: 'formalized',
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();
  const lifecycle = db.prepare('SELECT id, status, terminal_status FROM factory_lifecycle_runs ORDER BY id').all();
  const lif = lifecycle[lifecycle.length - 1];
  const stage = db.prepare(
    `SELECT local_outcome FROM factory_stage_runs WHERE stage_id='solution-formalization' AND lifecycle_run_id=? ORDER BY id DESC`,
  ).get(lif.id);
  const runIds = db.prepare(
    `SELECT process_run_id FROM factory_stage_runs WHERE lifecycle_run_id=? AND process_run_id IS NOT NULL`,
  ).all(lif.id).map(r => r.process_run_id);
  const capsule = runIds.length
    ? db.prepare(
        `SELECT payload FROM factory_formalization_acceptance_baselines
          WHERE process_run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
      ).get(...runIds)
    : undefined;
  const capsuleCodes = capsule
    ? JSON.parse(capsule.payload).acceptanceCriteria.map(m => m.code).sort() : null;
  const acceptanceWp = db.prepare(
    `SELECT kanban_phase FROM factory_workplaces WHERE production_cell_id='formalization-acceptance-contract'`,
  ).get();
  const stasisPark = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_workplace_park_reasons WHERE reason_code='SUBMISSION_STASIS_IDENTICAL_BYTES'`,
  ).get().n;
  const durableRejections = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_submission_validation_rejections WHERE rejection_code LIKE 'ARTIFACT_CONTENT%'`,
  ).get().n;
  const unverifiableRejections = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_submission_validation_rejections WHERE rejection_code='ARTIFACT_CONTENT_HASH_UNVERIFIABLE'`,
  ).get().n;

  let spawns = 0;
  let spawnLogRaw = '';
  try { spawnLogRaw = readFileSync(spawnLog, 'utf8'); } catch { /* none */ }
  spawns = spawnLogRaw.split('\n').filter(Boolean).length;
  // The fabricated attempt is rejected AT TOOL INTAKE (zero durable mutation
  // — the W1-1 property); the typed witness lives in the child's stderr rail.
  const fabricatedFaultSeen = spawnLogRaw.includes('FABRICATED_REJECTED');
  const envelopeRefused = spawnLogRaw.includes('no --mcp-config in envelope');
  const stasisRejections = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_submission_validation_rejections`,
  ).get().n;
  const diagWp = db.prepare(
    `SELECT workplace_ref, kanban_phase, loop_state, terminal_reason FROM factory_workplaces ORDER BY workplace_ref`,
  ).all().map(w => [w.workplace_ref.split('/', 2)[1] ?? w.workplace_ref, w.kanban_phase, w.loop_state, w.terminal_reason]);
  const diagParks = db.prepare(
    `SELECT workplace_ref, reason_code, substr(message,1,200) FROM factory_workplace_park_reasons`,
  ).all();
  const diagComments = db.prepare(
    `SELECT t.id, substr(c.content,1,300) FROM comments c JOIN tasks t ON t.id=c.task_id ORDER BY c.id DESC LIMIT 6`,
  ).all();

  process.stdout.write(JSON.stringify({
    variant: VARIANT,
    stage: stage?.local_outcome ?? null,
    stoppedByStageOutcome: result.stoppedByStageOutcome,
    lifecycleStatus: lif.status,
    capsuleCodes,
    fabricatedHashInCapsule: capsule ? capsule.payload.includes(FABRICATED) : false,
    acceptancePhase: acceptanceWp?.kanban_phase ?? null,
    stasisPark: stasisPark > 0,
    durableRejections: durableRejections + stasisRejections,
    unverifiableRejections,
    fabricatedFaultSeen,
    envelopeRefused,
    spawns,
    inProcessInferences: observer.getInvocationCount(),
    stranded: result.strandedActiveExecutions,
    diagWp, diagParks, diagComments,
  }) + '\n');
} finally {
  bootstrap.cleanup();
  if (!process.env.K2_KEEP_SPAWN) { try { rmSync(spawnDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  else { process.stderr.write(`[k2-drive] spawn log kept: ${spawnLog}
`); }
}
