#!/usr/bin/env node
// tests/factory-proof/canonical-happy-drive.mjs
//
// W0-1 acceptance: ONE minimal scripted happy path through the CANONICAL proof
// composition — real assignment (WorkAssignmentPort), real MCP (production
// product_submit/artifact/worker_done handlers), real gates (factory_gate_
// decisions). Runs in an isolated child process (composition-root singletons
// must not leak across drives) and prints a JSON evidence bundle on stdout.
//
// The scenario handlers are the proven W9 happy set (per-module scripted
// workers for Discovery → Formalization → Development); the drive goes through
// driveCanonicalProof, which asserts the overlay allowlist on the REAL
// composition object and fingerprints the installed production identity.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const label = process.env.CANONICAL_DRIVE_LABEL || 'canonical';

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness } = harness;
const manifestMod = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href);
const { HARNESS_CONCURRENCY_CEILING } = manifestMod;

const { buildCanonicalProofComposition, driveCanonicalProof, createScriptedObserver }
  = await import('./canonical-proof-composition.mjs');
const { W9_HAPPY_HANDLERS } = await import('../factory-e2e/w9-happy-handlers.mjs');

const SCENARIO_CAP = HARNESS_CONCURRENCY_CEILING;

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: SCENARIO_CAP,
  idea: `W0-1 canonical composition happy path (${label})`,
});

try {
  bootstrap.assertNoAuthorityWritesYet();

  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: W9_HAPPY_HANDLERS,
  });

  const { result, identity, fingerprint } = await driveCanonicalProof({
    bootstrap,
    composition,
    scenarioConcurrencyCap: SCENARIO_CAP,
    maxCycles: 120,
    pollMs: 5,
    maxEmptyDispatchStreak: 10,
    scriptedObserver: observer,
  });

  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  // Authority rows that must have appeared NATURALLY (production runtime only).
  const gateDecisions = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_gate_decisions`,
  ).get().n;
  const acceptedGates = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE verdict='accepted'`,
  ).get().n;
  const workplaces = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_workplaces`,
  ).get().n;
  const acceptedHeads = db.prepare(
    `SELECT COUNT(*) AS n FROM factory_accepted_authority_head`,
  ).get().n;
  const commandReceipts = db.prepare(
    `SELECT COUNT(*) AS n FROM command_receipts`,
  ).get().n;

  const devRun = db.prepare(
    `SELECT id, status, local_outcome
       FROM factory_process_runs
      WHERE module_name LIKE '%development%' ORDER BY id DESC LIMIT 1`,
  ).get();

  const evidence = {
    label,
    reachedRunnableLocal: devRun?.local_outcome === 'verified',
    devOutcome: devRun?.local_outcome ?? null,
    cycles: result.cycles,
    terminalReason: result.terminalReason,
    reachedTerminal: result.reachedTerminal,
    scriptedInvocationCount: result.scriptedInvocationCount,
    strandedActiveExecutions: result.strandedActiveExecutions,
    effectiveConcurrency: result.effectiveConcurrency,
    // Real machinery the canonical composition had to carry the run through.
    gateDecisions,
    acceptedGates,
    workplaces,
    acceptedHeads,
    commandReceipts,
    // Composition discipline evidence.
    lifecycleIdentity: identity.lifecycle.id,
    moduleCount: identity.modules.length,
    overlayKeys: fingerprint.overlayKeys,
    compositionFingerprint: fingerprint.fingerprint,
  };

  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  bootstrap.cleanup();
}
