#!/usr/bin/env node
// tests/factory-e2e/w9-04-outcome-edge-drive.mjs
//
// Standalone single-drive runner for W9-04 (lifecycle outcome edges). Runs ONE
// outcome-edge scenario in an isolated process and prints a JSON evidence
// bundle on stdout. The companion test (w9-04-outcome-edges.test.mjs) invokes
// this script per scenario.
//
// Scenario selection: W9_SCENARIO env var — see SCENARIO_MAP below.
//
// What every scenario proves (CONVEYOR §23 L3 item 7):
//   - the lifecycle reached the declared terminal/stage for that outcome edge
//     (factory_stage_runs.local_outcome + factory_lifecycle_runs.terminal_status);
//   - settlement wrote what the terminal implies (the module's outcome
//     certificate records the decision; discovery records the strength code);
//   - for Discovery strength codes: routing still FORWARDED to Formalization
//     (the permissive gate), the certificate carries the emitted code;
//   - no stranded worker executions (harness invariant).

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
const handlersMod = await import('./w9-04-outcome-edge-handlers.mjs');
const { defaultW9RunManifest, parseRunManifest } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);

// edgeKey = `<stageId>:<outcomeCode>` (the registry's key grammar).
// expectedTerminal = the lifecycle terminal_status the route table declares.
const SCENARIO_MAP = {

  'frm-inconsistent': {
    manifestId: 'w9-04-frm-inconsistent',
    handlers: handlersMod.buildFormalizationInconsistentHandlers,
    edgeKey: 'solution-formalization:inconsistent',
    expectedTerminal: 'formalization-inconsistent',
    expectCertificate: true,
    maxCycles: 120,
  },
  // 'frm-failed' is RETIRED: its producer (AC document headings contradicting
  // the artifact code, accepted by the then-structural acceptance gate, then
  // terminal-failing at the baseline freeze) was the freeze-kills-finished-runs
  // defect class extinguished by the heading-resolution gate v1.2.0. The
  // §D2-gap variant is pre-validated by FORMALIZATION_SRS_INCOMPLETE; drifted
  // bytes route to complete-inconsistent. The edge stays installed — its
  // remaining producers (kernel-seam faults, bounded budget ceilings) are
  // classified PENDING in lifecycle-outcome-edge-coverage.test.mjs.

  'dev-blocked': {
    manifestId: 'w9-04-dev-blocked',
    handlers: handlersMod.buildDevelopmentBlockedHandlers,
    edgeKey: 'solution-development:blocked',
    expectedTerminal: 'development-blocked',
    expectCertificate: true,
    maxCycles: 220,
  },


  'disc-deleted-word': {
    manifestId: 'w9-04-disc-deleted-word-rejected',
    handlers: () => handlersMod.buildDeletedOutcomeWordHandlers(),
    edgeKey: 'initial-discovery:deleted-word',
    // Not an edge trace: this scenario proves fail-closed REJECTION of a
    // deleted outcome word. The lifecycle must NOT complete discovery.
    expectDeletedWordRejected: 'defer',
    maxCycles: 60,
  },
  ...Object.fromEntries(['clarify', 'reject'].map(code => [
    `disc-${code}`,
    {
      manifestId: `w9-04-disc-${code}`,
      handlers: () => handlersMod.buildDiscoveryStrengthCodeHandlers(code),
      edgeKey: `initial-discovery:${code}`,
      // Discovery routes FORWARD to Formalization; the lifecycle finishes the
      // happy path. The edge trace is the CERTIFICATE code, not a terminal.
      expectedTerminal: 'runnable-local',
      discoveryCode: code,
      expectCertificate: true,
      maxCycles: 220,
    },
  ])),
};

const config = SCENARIO_MAP[SCENARIO];
if (!config) {
  throw new Error(`W9_SCENARIO must be one of: ${Object.keys(SCENARIO_MAP).join(', ')}`);
}

// Verify the manifest declares this scenario.
const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: '404c086f' }));
const scenario = manifest.scenarios.find(s => s.scenarioId === config.manifestId);
if (!scenario) throw new Error(`${config.manifestId} scenario not declared in manifest`);

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: `W9-04 outcome edge ${config.edgeKey} (${label}): one targeted worker override, factory classifies`,
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
    maxEmptyDispatchStreak: 12,
    scriptedObserver: observer,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  // ---- Edge evidence: the stage outcome + lifecycle terminal + certificate ----
  const [stageId, outcomeCode] = config.edgeKey.split(':');

  const stageRun = db.prepare(
    `SELECT sr.id, sr.stage_id, sr.local_outcome, sr.status
       FROM factory_stage_runs sr
      WHERE sr.stage_id=? AND sr.local_outcome=?
      ORDER BY sr.id DESC LIMIT 1`,
  ).get(stageId, outcomeCode);

  const lifecycleRun = db.prepare(
    `SELECT id, status, terminal_status, current_stage_id
       FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1`,
  ).get();

  const certificate = db.prepare(
    `SELECT module_ref_key, decision, reason_codes, rationale
       FROM factory_process_outcome_certificates
      WHERE module_ref_key LIKE ?
      ORDER BY id DESC LIMIT 1`,
  ).get(stageId === 'initial-discovery' ? '%discovery%' : `%${stageId.split('-')[1]}%`);

  // Deleted-word scenario: the submission must be REJECTED, the discovery
  // stage must never complete, and no discovery certificate may exist.
  const proposalGateRejections = config.expectDeletedWordRejected
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM factory_check_receipts cr
           JOIN factory_gate_decisions gd
             ON gd.gate_run_ref=cr.check_run_ref
          WHERE cr.provider_id LIKE 'discovery.proposal%' AND cr.outcome='failed'`,
      ).get().n
    : null;
  const anyDiscoveryCertificate = config.expectDeletedWordRejected
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM factory_process_outcome_certificates
          WHERE module_ref_key LIKE '%discovery%'`,
      ).get().n
    : null;

  // Discovery scenarios: the certificate must carry the emitted strength code
  // AND routing must have forwarded (a formalization stage run exists).
  const discoveryCertificate = stageId === 'initial-discovery'
    ? db.prepare(
        `SELECT decision FROM factory_process_outcome_certificates
          WHERE module_ref_key LIKE '%discovery%' ORDER BY id DESC LIMIT 1`,
      ).get()
    : null;
  const formalizationRan = stageId === 'initial-discovery'
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM factory_stage_runs WHERE stage_id='solution-formalization'`,
      ).get().n
    : null;

  const developmentOutcome = db.prepare(
    `SELECT local_outcome FROM factory_stage_runs
      WHERE stage_id='solution-development' ORDER BY id DESC LIMIT 1`,
  ).get();

  const evidence = {
    label,
    scenario: SCENARIO,
    edgeKey: config.edgeKey,
    stageOutcomeRecorded: Boolean(stageRun),
    stageRunOutcome: stageRun?.local_outcome ?? null,
    lifecycleStatus: lifecycleRun?.status ?? null,
    lifecycleTerminalStatus: lifecycleRun?.terminal_status ?? null,
    certificateDecision: (discoveryCertificate ?? certificate)?.decision ?? null,
    certificateReasonCodes: certificate?.reason_codes ?? null,
    formalizationStageRunsAfterDiscovery: formalizationRan,
    deletedWordProposalGateRejections: proposalGateRejections,
    deletedWordDiscoveryCertificates: anyDiscoveryCertificate,
    developmentOutcome: developmentOutcome?.local_outcome ?? null,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    reachedTerminal: result.reachedTerminal,
    stoppedByCycleBound: result.stoppedByCycleBound,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    scriptedInvocationCount: result.scriptedInvocationCount,
    invariantsDeclared: scenario.expectedAuthorityInvariants.map(i => i.id),
  };

  if (!evidence.stageOutcomeRecorded) {
    const diagnostic = {
      stages: db.prepare(
        `SELECT stage_id, local_outcome, status FROM factory_stage_runs ORDER BY id`,
      ).all(),
      lifecycle: lifecycleRun,
      certificates: db.prepare(
        `SELECT module_ref_key, decision, substr(rationale,1,300) AS rationale
           FROM factory_process_outcome_certificates ORDER BY id`,
      ).all(),
      processRuns: db.prepare(
        `SELECT id, module_name, status, local_outcome FROM factory_process_runs ORDER BY id`,
      ).all(),
      openWorkplaces: db.prepare(
        `SELECT workplace_ref, kanban_phase, loop_state, next_role, terminal_reason
           FROM factory_workplaces
          WHERE loop_state<>'terminal' ORDER BY workplace_ref`,
      ).all(),
      nonAcceptedGates: db.prepare(
        `SELECT workplace_ref, gate_phase, verdict FROM factory_gate_decisions
          WHERE verdict<>'accepted' ORDER BY decided_at`,
      ).all(),
      pendingObligations: db.prepare(
        `SELECT source_kind, handoff_kind, state, substr(last_error,1,200) AS err
           FROM factory_transition_obligations
          WHERE state<>'completed' ORDER BY obligation_key`,
      ).all(),
      devReceipts: db.prepare(
        `SELECT provider_id, outcome FROM factory_check_receipts
          WHERE provider_id='factory.local-runnability.v1' ORDER BY rowid`,
      ).all(),
      artifacts: db.prepare(
        `SELECT id, type, code, status, drift_state FROM artifacts ORDER BY id`,
      ).all(),
      latestCheckReceipts: db.prepare(
        `SELECT provider_id, outcome, substr(evidence_refs,1,500) AS evidence
           FROM factory_check_receipts ORDER BY check_receipt_ref DESC LIMIT 6`,
      ).all(),
      recoveryEpochs: db.prepare(
        `SELECT workplace_ref, role, epoch, substr(last_diagnosis,1,400) AS diagnosis
           FROM factory_workplace_recovery_epochs ORDER BY rowid DESC LIMIT 4`,
      ).all(),
      implementationProducts: db.prepare(
        `SELECT s.task_id,
                json_extract(s.payload_snapshot,'$.terminalStatus') AS status,
                json_extract(s.payload_snapshot,'$.workItemKey') AS item
           FROM factory_managed_node_submissions s
          WHERE s.schema_version='factory.development-implementation-result.v1'
          ORDER BY s.id`,
      ).all(),
      verificationProducts: db.prepare(
        `SELECT s.id, s.task_id, json_extract(s.payload_snapshot,'$.outcome') AS outcome, json_extract(s.payload_snapshot,'$.verificationItemKey') AS item
           FROM factory_managed_node_submissions s
          WHERE s.schema_version='factory.candidate-verification-evidence-product.v2'
          ORDER BY s.id`,
      ).all(),
      allGateDecisions: db.prepare(
        `SELECT workplace_ref, gate_phase, verdict, repair_target_role,
                substr(decided_at,1,19) AS at
           FROM factory_gate_decisions ORDER BY decided_at`,
      ).all(),
      effectAttempts: db.prepare(
        `SELECT effect_id, outcome FROM factory_effect_attempts ORDER BY rowid`,
      ).all(),
      executionErrors: db.prepare(
        `SELECT state, substr(COALESCE(last_error,''),1,400) AS err
           FROM worker_executions ORDER BY started_at`,
      ).all(),
      workplaceStates: db.prepare(
        `SELECT substr(workplace_ref,-64) AS wp, kanban_phase, loop_state, next_role
           FROM factory_workplaces ORDER BY workplace_ref`,
      ).all(),
    };
    process.stderr.write(`[w9-04-diagnostic] ${JSON.stringify(diagnostic)}\n`);
  }

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.ok(result.effectiveConcurrency <= SCENARIO_CAP, `${label}: concurrency ≤ cap`);
  if (config.expectDeletedWordRejected) {
    // Not an edge trace: this scenario proves REJECTION. No stage outcome,
    // no terminal, no certificate — see the dedicated assertions below.
    A.ok((evidence.deletedWordProposalGateRejections ?? 0) >= 1,
      `${label}: the proposal gate must REJECT the deleted word (failed check receipts)`);
    A.equal(evidence.deletedWordDiscoveryCertificates, 0,
      `${label}: no discovery certificate may exist`);
    A.notEqual(evidence.lifecycleTerminalStatus, 'runnable-local',
      `${label}: the lifecycle must not complete on a deleted word`);
    A.equal(evidence.effectiveConcurrency, SCENARIO_CAP, `${label}: concurrency`);
  } else {
  A.ok(evidence.stageOutcomeRecorded,
    `${label}: stage ${stageId} must record local_outcome='${outcomeCode}'`);
  A.equal(evidence.stageRunOutcome, outcomeCode, `${label}: stage outcome code`);
  A.equal(evidence.lifecycleTerminalStatus, config.expectedTerminal,
    `${label}: lifecycle terminal_status must be '${config.expectedTerminal}'`);
  A.equal(result.reachedTerminal, true, `${label}: the lifecycle must reach terminal`);
  A.equal(result.stoppedByCycleBound, false, `${label}: stopped by cycle bound, not terminal`);
  A.equal(evidence.effectiveConcurrency, SCENARIO_CAP, `${label}: concurrency`);

  if (stageId === 'initial-discovery') {
    A.equal(evidence.certificateDecision, config.discoveryCode,
      `${label}: the discovery certificate must record '${config.discoveryCode}'`);
    A.ok((evidence.formalizationStageRunsAfterDiscovery ?? 0) >= 1,
      `${label}: routing must forward to Formalization (permissive strength gate)`);
    A.equal(evidence.developmentOutcome, 'verified',
      `${label}: the forwarded run still completes the lifecycle (verified)`);
  } else if (config.expectCertificate) {
    A.equal(evidence.certificateDecision, outcomeCode,
      `${label}: the module certificate must record '${outcomeCode}'`);
  } else {
    A.equal(evidence.certificateDecision, null,
      `${label}: this edge fails before settlement — no module certificate may exist`);
  }
  }

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}
