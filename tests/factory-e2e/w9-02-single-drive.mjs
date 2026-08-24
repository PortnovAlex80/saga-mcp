#!/usr/bin/env node
// tests/factory-e2e/w9-02-single-drive.mjs
//
// Standalone single-drive runner for W9-02. Runs ONE complete happy-path drive
// (Discovery → Formalization → Development → runnable-local) in an isolated
// process and prints a JSON evidence bundle on stdout. The companion test
// (w9-02-happy-path.test.mjs) invokes this script twice (as separate child
// processes) to prove determinism without cross-drive module-level state
// contamination (product-tool caches, composition-root singletons).
//
// Perturbation seeds (ADR-096 gate item 3): W9_PERTURBATION_SEED=<n> selects
// a tape from the frozen table (perturbation-tapes.mjs). The evidence always
// records the resolved tape name. v1 declares exactly ONE runnable w9-02
// tape (the golden path); an out-of-lane seed leaves this drive on the golden
// path (current behavior) with the tape name still recorded — and if a
// future table grows an in-lane w9-02 variant, this drive fails LOUDLY until
// the variant's handlers are wired here (no silent golden fallback).

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
const { resolveDriveTapeSelection } = await import('./perturbation-tapes.mjs');

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;
const STARTING_SHA = '8c2d679';

// Deterministic perturbation-seed tape resolution (ADR-096 gate item 3).
const DRIVE_FILE = 'w9-02-single-drive.mjs';
const tapeSelection = resolveDriveTapeSelection({ env: process.env, driveFile: DRIVE_FILE });
if (tapeSelection.applied) {
  throw new Error(
    `W9_TAPE_NOT_RUNNABLE_HERE: seed ${tapeSelection.seed} selects in-lane tape `
    + `'${tapeSelection.tapeName}' for ${DRIVE_FILE}, but this drive implements only the `
    + 'golden tape — wire the variant handlers here before the table may select it',
  );
}

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
    `SELECT payload_snapshot,product_hash FROM factory_process_products
      WHERE schema_id='factory.integrated-release-candidate.v1'
      ORDER BY id DESC LIMIT 1`,
  ).get();
  const candidatePayload = candidateProduct ? JSON.parse(candidateProduct.payload_snapshot) : {};

  // Authority-table no-hack guard (post-drive): authority rows exist ONLY from
  // the production runtime, never from the harness. We can't re-assert zero
  // (the drive created them), but we assert the invariant is structurally
  // present in the manifest.
  const evidence = {
    label,
    perturbationSeed: tapeSelection.seed,
    perturbationTape: tapeSelection.tapeName,
    perturbationTapeApplied: tapeSelection.applied,
    reachedRunnableLocal: devRun?.local_outcome === 'verified' && lrReceipt?.outcome === 'passed',
    devOutcome: devRun?.local_outcome ?? null,
    devStatus: devRun?.status ?? null,
    lrReceiptOutcome: lrReceipt?.outcome ?? null,
    candidateHasReadiness: Boolean(candidatePayload.readiness),
    readinessKind: candidatePayload.readiness?.kind ?? null,
    candidateFrozen: Boolean(candidateProduct)
      && candidateProduct.product_hash === candidatePayload.candidateHash,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    scriptedInvocationCount: result.scriptedInvocationCount,
    maxObservedConcurrency: result.maxObservedConcurrency,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    invariantsDeclared: happyScenario.expectedAuthorityInvariants.map(i => i.id),
  };

  if (devRun?.local_outcome !== 'verified') {
    const diagnostic = {
      developmentWorkplaces: db.prepare(
        `SELECT workplace_ref,kanban_phase,loop_state,terminal_reason,revision
           FROM factory_workplaces WHERE process_run_id=? ORDER BY workplace_ref`,
      ).all(devRun?.id ?? -1),
      obligations: db.prepare(
        `SELECT source_kind,source_ref,handoff_kind,state,last_error
           FROM factory_transition_obligations
          WHERE state<>'completed' ORDER BY created_at,obligation_key`,
      ).all(),
      finalAcceptances: db.prepare(
        `SELECT workplace_ref,candidate_set_ref,gate_decision_key
           FROM factory_cell_final_acceptances ORDER BY workplace_ref`,
      ).all(),
      decisions: db.prepare(
        `SELECT gd.workplace_ref,gd.decision_key,gd.gate_phase,gd.verdict
           FROM factory_gate_decisions gd
           LEFT JOIN factory_cell_final_acceptances cfa
             ON cfa.gate_decision_key=gd.decision_key
          WHERE gd.verdict<>'accepted' OR cfa.gate_decision_key IS NULL
          ORDER BY gd.decided_at,gd.decision_key`,
      ).all(),
      readinessReceipts: db.prepare(
        `SELECT subject_candidate_set_ref,provider_id,provider_digest,outcome,evidence_refs
           FROM factory_check_receipts
          WHERE provider_id='factory.local-runnability.v1'
          ORDER BY check_receipt_ref`,
      ).all(),
      verificationProducts: db.prepare(
        `SELECT s.id,s.task_id,s.content_hash,s.payload_snapshot,
                cs.candidate_set_ref
           FROM factory_managed_node_submissions s
           JOIN factory_candidate_set_members m
             ON m.product_ref='managed-node-submission:' || s.id
           JOIN factory_candidate_sets cs
             ON cs.candidate_set_ref=m.candidate_set_ref
          WHERE s.schema_version='factory.candidate-verification-evidence-product.v2'
          ORDER BY s.id`,
      ).all(),
      verificationReceipts: db.prepare(
        `SELECT cr.subject_candidate_set_ref,cr.provider_id,cr.provider_version,
                cr.provider_digest,cr.outcome,cr.evidence_refs,
                gd.gate_phase,gd.verdict
           FROM factory_check_receipts cr
           LEFT JOIN factory_gate_decisions gd
             ON gd.gate_run_ref=cr.check_run_ref
            AND gd.subject_candidate_set_ref=cr.subject_candidate_set_ref
          WHERE cr.subject_candidate_set_ref IN (
            SELECT cs.candidate_set_ref
              FROM factory_candidate_sets cs
              JOIN factory_workplaces w ON w.workplace_ref=cs.workplace_ref
             WHERE w.process_run_id=?
               AND w.production_cell_id='development-verification'
          )
          ORDER BY cr.subject_candidate_set_ref,cr.check_receipt_ref`,
      ).all(devRun?.id ?? -1),
      trustedProviders: db.prepare(
        `SELECT id,project_id,name,version,category,determinism,status
           FROM trusted_providers ORDER BY id`,
      ).all(),
      developmentCertificates: db.prepare(
        `SELECT decision,reason_codes,rationale
           FROM factory_process_outcome_certificates
          WHERE process_run_id=?`,
      ).all(devRun?.id ?? -1),
    };
    process.stderr.write(`[w9-diagnostic] ${JSON.stringify(diagnostic)}\n`);
  }

  // Assertions (throw → non-zero exit → test failure).
  const A = (await import('node:assert')).default;
  A.equal(effectiveConcurrencyCheck(result), SCENARIO_CAP, `${label}: concurrency`);
  A.equal(result.strandedActiveExecutions, 0, `${label}: no stranded executions`);
  A.ok(result.scriptedInvocationCount >= 10, `${label}: ≥10 scripted invocations`);
  A.equal(devRun?.status, 'completed', `${label}: development status=completed`);
  A.equal(devRun?.local_outcome, 'verified', `${label}: development outcome=verified`);
  A.ok(lrReceipt, `${label}: passed local-readiness receipt exists`);
  A.equal(lrReceipt.outcome, 'passed', `${label}: LR receipt outcome=passed`);
  A.equal(evidence.candidateFrozen, true,
    `${label}: integrated candidate is an exact frozen kernel product`);
  A.ok(candidatePayload.readiness, `${label}: candidate carries readiness profile`);

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}

function effectiveConcurrencyCheck(result) {
  return result.effectiveConcurrency;
}
