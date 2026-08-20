#!/usr/bin/env node
// tests/factory-e2e/w9-06-scope-widening-drive.mjs
//
// Standalone single-drive runner for W9-06 (scope insufficiency as a lawful
// transition — stage-13 TASK 1/2 end-to-end proof). Runs ONE scenario in an
// isolated process and prints a JSON evidence bundle on stdout. The companion
// test (w9-06-scope-widening.test.mjs) invokes this script per scenario.
//
// Scenario selection: W9_SCENARIO env var — see SCENARIO_MAP below.
//
// What every scenario proves (stage-13 brief):
//   - insufficiency declared (trajectory-detected or worker-declared);
//   - the carve authority decides on CONTENTION ONLY and grants (no other
//     live cell holds the claim): an append-only widening ledger carries
//     request + grant, and the grant re-freezes a WIDER scope revision;
//   - the SAME workplace is re-staffed (no orphan re-carve parked at idle);
//   - the retry passes its gates and the lifecycle completes runnable-local.
//
// RED baseline (pre-stage-13): the same drive parks REPLAN_MANDATED and the
// lifecycle never completes — that output is the deadlock evidence.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SCENARIO = process.env.W9_SCENARIO || '';
const label = process.env.W9_DRIVE_LABEL || SCENARIO;

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const { HARNESS_CONCURRENCY_CEILING } = manifestMod;
const { createScriptedObserver } = await import('./scripted-inference.mjs');
const { buildHarnessComposition } = await import('./harness-composition.mjs');
const handlersMod = await import('./w9-06-scope-widening-handlers.mjs');
const { defaultW9RunManifest, parseRunManifest } = manifestMod;

const SCENARIO_MAP = {
  grant: {
    manifestId: 'w9-06-scope-widening-grant',
    handlers: handlersMod.buildGrantHandlers,
    maxCycles: 320,
  },
  declared: {
    manifestId: 'w9-06-scope-declared',
    handlers: handlersMod.buildDeclaredHandlers,
    maxCycles: 320,
  },
};

const config = SCENARIO_MAP[SCENARIO];
if (!config) {
  throw new Error(`W9_SCENARIO must be one of: ${Object.keys(SCENARIO_MAP).join(', ')}`);
}

const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: '404c086f' }));
const scenario = manifest.scenarios.find(s => s.scenarioId === config.manifestId);
if (!scenario) throw new Error(`${config.manifestId} scenario not declared in manifest`);

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: `W9-06 scope widening ${SCENARIO} (${label}): honest out-of-scope work, lawful transition`,
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  const observer = createScriptedObserver();
  const composition = buildHarnessComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: config.handlers(),
  });

  const result = await driveFreshHarness({
    bootstrap,
    composition,
    scenarioConcurrencyCap: SCENARIO_CAP,
    maxCycles: config.maxCycles,
    pollMs: 5,
    maxEmptyDispatchStreak: 20,
    scriptedObserver: observer,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  const lifecycleRun = db.prepare(
    'SELECT id, status, terminal_status FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1',
  ).get();

  const scopeReceipts = db.prepare(
    `SELECT cr.outcome, substr(cr.evidence_refs,1,600) AS evidence
       FROM factory_check_receipts cr
      WHERE cr.provider_id='development.implementation-scope.v1'
      ORDER BY cr.check_receipt_ref`,
  ).all();

  const wideningEvents = (() => {
    try {
      return db.prepare(
        `SELECT event_kind, source, requested_scopes, holders, granted_revision, granted_scopes
           FROM factory_scope_widening_events ORDER BY id`,
      ).all();
    } catch {
      return [];
    }
  })();

  const replanMandates = (() => {
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM factory_replan_mandates').get().n;
    } catch {
      return 0;
    }
  })();

  const parks = db.prepare(
    `SELECT reason_code FROM factory_workplace_park_reasons ORDER BY id`,
  ).all().map(r => r.reason_code);

  const workplaces = db.prepare(
    `SELECT substr(workplace_ref,-56) AS wp, kanban_phase, loop_state, next_role, terminal_reason
       FROM factory_workplaces ORDER BY workplace_ref`,
  ).all();

  const evidence = {
    label,
    scenario: SCENARIO,
    lifecycleStatus: lifecycleRun?.status ?? null,
    lifecycleTerminalStatus: lifecycleRun?.terminal_status ?? null,
    scopeReceiptCount: scopeReceipts.length,
    scopeReceiptOutcomes: scopeReceipts.map(r => r.outcome),
    firstScopeReceiptEvidence: scopeReceipts[0]?.evidence ?? null,
    wideningEvents,
    replanMandates,
    parks,
    workplaces,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    reachedTerminal: result.reachedTerminal,
    stoppedByCycleBound: result.stoppedByCycleBound,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    scriptedInvocationCount: result.scriptedInvocationCount,
    invariantsDeclared: scenario.expectedAuthorityInvariants.map(i => i.id),
  };

  // Diagnostics when the lawful transition did not complete.
  if (evidence.lifecycleTerminalStatus !== 'runnable-local') {
    const diagnostic = {
      stages: db.prepare(
        'SELECT stage_id, local_outcome, status FROM factory_stage_runs ORDER BY id',
      ).all(),
      lifecycle: lifecycleRun,
      nonAcceptedGates: db.prepare(
        `SELECT substr(workplace_ref,-56) AS wp, gate_phase, verdict, substr(decided_at,1,19) AS at
           FROM factory_gate_decisions WHERE verdict<>'accepted' ORDER BY decided_at`,
      ).all(),
      recoveryEpochs: db.prepare(
        'SELECT substr(workplace_ref,-56) AS wp, role, epoch FROM factory_workplace_recovery_epochs ORDER BY rowid',
      ).all(),
      pendingObligations: db.prepare(
        `SELECT source_kind, handoff_kind, state, substr(last_error,1,200) AS err
           FROM factory_transition_obligations WHERE state<>'completed' ORDER BY obligation_key`,
      ).all(),
      executionErrors: db.prepare(
        `SELECT state, substr(COALESCE(last_error,''),1,300) AS err
           FROM worker_executions ORDER BY started_at DESC LIMIT 8`,
      ).all(),
      parkReasons: db.prepare(
        'SELECT reason_code, substr(message,1,300) AS message FROM factory_workplace_park_reasons ORDER BY id',
      ).all(),
    };
    process.stderr.write(`[w9-06-diagnostic] ${JSON.stringify(diagnostic)}\n`);
  }

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.ok(result.effectiveConcurrency <= SCENARIO_CAP, `${label}: concurrency ≤ cap`);
  A.equal(evidence.lifecycleTerminalStatus, 'runnable-local',
    `${label}: the lifecycle must complete — the lawful transition lets honest work proceed`);
  A.equal(result.reachedTerminal, true, `${label}: reached terminal`);
  A.equal(result.stoppedByCycleBound, false, `${label}: stopped by cycle bound, not terminal`);
  A.ok(evidence.scopeReceiptOutcomes.includes('failed'),
    `${label}: the scope fence must honestly reject the out-of-scope attempt(s) first`);
  A.ok(evidence.wideningEvents.some(e => e.event_kind === 'request'),
    `${label}: an insufficiency request must be recorded`);
  const grant = evidence.wideningEvents.find(e => e.event_kind === 'grant');
  A.ok(grant, `${label}: the carve authority must GRANT the widening (no contention)`);
  if (grant) {
    A.ok(grant.granted_revision >= 1, `${label}: the grant re-freezes a NEW scope revision`);
    const scopes = JSON.parse(grant.granted_scopes);
    A.ok(
      scopes.includes('atlas/registry-map.json') || scopes.includes('atlas/'),
      `${label}: the widened revision must cover the honestly needed path (exact file or its directory)`,
    );
  }
  A.equal(evidence.replanMandates, 0,
    `${label}: no re-plan mandate may be minted — one mechanism for one event (§27)`);
  A.ok(!evidence.parks.includes('REPLAN_MANDATED'),
    `${label}: the card must not park REPLAN_MANDATED`);
  A.ok(evidence.workplaces.every(w => w.loop_state !== 'idle' || w.terminal_reason !== null
    || w.kanban_phase === 'todo'),
  `${label}: no orphan workplace minted outside the flow`);

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}
