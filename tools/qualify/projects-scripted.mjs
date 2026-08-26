#!/usr/bin/env node
/**
 * tools/qualify/projects-scripted.mjs - the EK-11 TWENTY-PROJECT SCRIPTED
 * CORPUS driver (WP-15): wraps the EK-9 project-corpus drivers (the
 * production composition + the scripted cognition actor over fresh
 * greenfield databases, public commands only) with the qualification laws:
 *
 *   - the immutable-kit fence (every digest verified before the series);
 *   - fresh product repositories per run (outside the source checkout);
 *   - ACTUAL PRODUCT OUTPUT verification per plan kind (build/test/start,
 *     browser smoke for browser products, API/CLI smoke otherwise, local
 *     Delivery/package effect receipts) - statuses alone never qualify;
 *   - the receipt-completeness law per run;
 *   - per-run evidence (journal, checks, receipts, product logs) under a
 *     build-addressed evidence root, hashed into the series manifest.
 *
 * The corpus descriptors carry the EK-11 alignment block (ek11: planId /
 * kind / fixture / profile) mapping every plan product P01..P20 onto its
 * corpus project and its product-evidence profile.
 *
 * Usage:
 *   npm run qualify:projects:scripted -- --kit <manifest> --all
 *   npm run qualify:projects:scripted -- --kit <manifest> --project p01-served-happy
 */

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

import { freshDir, writeEvidence, environmentBlock } from './lib/fences.mjs';
import { okCheck, redCheck, receiptCompleteness, traceFingerprint, openSeries, writeSeriesRecord } from './lib/series.mjs';
import { runProductEvidence, stageProductRepo } from './lib/product-evidence.mjs';

/** Run one corpus project under the qualification wrapper. */
async function qualifyOneProject(series, descriptor) {
  const startedAt = Date.now();
  const runId = `${descriptor.ek11.planId}-${descriptor.projectId}`;
  const evidenceDir = series.runEvidence(runId);
  const checks = [];
  const context = { planId: descriptor.ek11.planId, kind: descriptor.ek11.kind, driveMode: descriptor.drive.mode };

  /* 1. The kernel drive - the EK-9 corpus engine, unchanged (fresh
   *    greenfield DBs internally, public commands, the closed invariant
   *    battery). */
  const { runProject } = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'project-corpus', 'lib', 'execute.mjs')).href);
  const result = await runProject(descriptor);
  const kernelChecks = result.checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail }));
  for (const check of kernelChecks) checks.push(check);
  context.corpusStatus = result.status;
  context.elapsedKernelMs = result.elapsedMs;

  /* Evidence of the kernel run (the corpus engine's own temp databases are
   * ephemeral by design; the normalized observed world is the durable
   * evidence - it rehydrates identically from any of its ledger rows). */
  if (result.invariants !== undefined) context.invariants = result.invariants.map((invariant) => ({ id: invariant.id, status: invariant.status }));

  /* 2. Receipt completeness over the observed world (when the corpus
   *    engine exposed it). The run-terminal law is kind-aware: a project
   *    whose declared expected world leaves factory-run non-terminal (the
   *    honest early-refusal / pending-disposition / human-decision oracles)
   *    legitimately carries no run terminal proof - duplication is still
   *    forbidden. */
  if (result.observed !== null && result.observed !== undefined) {
    const observed = result.observed;
    context.traceFingerprint = traceFingerprint(observed.summary);
    const requireRunTerminal = descriptor.expectedWorld.heads.some((head) => head.instanceId === 'factory-run:1' && head.status === 'terminal');
    const completeness = receiptCompleteness(observed.receiptWorld, { requireRunTerminal });
    for (const check of completeness.checks) checks.push(check.ok ? okCheck(check.id, check.detail) : redCheck(check.id, check.detail));
    writeEvidence(evidenceDir, 'receipts.json', completeness.receipts);
    writeEvidence(evidenceDir, 'normalized-trace.json', observed.summary);
    writeEvidence(evidenceDir, 'journal.json', observed.events);
  }

  /* 3. ACTUAL PRODUCT OUTPUT verification per plan kind, in the run's own
   *    FRESH product repository. */
  const productRepo = freshDir(join(evidenceDir, 'product-repo'), 'product repository');
  const staged = stageProductRepo(descriptor.ek11.fixture, productRepo);
  const product = await runProductEvidence(descriptor.ek11.kind, descriptor.ek11.profile, productRepo);
  context.product = { fixture: staged.fixture, buildDigests: product.buildDigests, packageDigest: product.packageDigest, packageReceiptOwner: product.packageReceiptOwner };
  checks.push(product.ok
    ? okCheck('product-outputs-verified', `${descriptor.ek11.kind}: ${product.steps.map((step) => `${step.label}=${step.code}`).join(', ')} (package receipt ${String(product.packageDigest).slice(0, 12)})`)
    : redCheck('product-outputs-verified', String(product.failure)));
  writeEvidence(evidenceDir, 'product-steps.json', product.steps);
  writeEvidence(evidenceDir, 'delivery-receipt.json', { packageDigest: product.packageDigest, receiptOwner: product.packageReceiptOwner });

  /* 4. Persist the run record. */
  writeEvidence(evidenceDir, 'checks.json', checks);
  writeEvidence(evidenceDir, 'run.json', {
    runId,
    planId: descriptor.ek11.planId,
    kind: descriptor.ek11.kind,
    projectId: descriptor.projectId,
    kitId: series.kitId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    environment: await environmentBlock(),
    ...context,
  });

  const status = checks.every((check) => check.status === 'green') ? 'green' : 'red';
  return {
    id: runId,
    planId: descriptor.ek11.planId,
    status,
    elapsedMs: Date.now() - startedAt,
    checksGreen: `${checks.filter((check) => check.status === 'green').length}/${checks.length}`,
    evidenceDir: evidenceDir.replaceAll('\\', '/'),
    checks,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
  };
  const kitReference = value('kit');
  const seriesId = value('series') ?? `projects-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  try {
    const { loadCorpus } = await import(pathToFileURL(join(REPO_ROOT, 'tests', 'project-corpus', 'registry.mjs')).href);
    const corpus = await loadCorpus();
    const selected = args.includes('--all')
      ? corpus
      : value('project') !== undefined
        ? corpus.filter((descriptor) => descriptor.projectId === value('project'))
        : [];
    if (selected.length === 0) {
      process.stderr.write('usage: projects-scripted.mjs --kit <manifest> (--all | --project <id>) [--series <id>]\n');
      process.exit(2);
    }
    const series = await openSeries({ kitReference, seriesId, evidenceRootOverride: value('evidence-root') });
    process.stdout.write(`series ${seriesId} | kit ${series.kitId} | evidence root ${series.evidenceRoot.replaceAll('\\', '/')}\n`);
    const results = [];
    for (const descriptor of selected) {
      process.stdout.write(`  ${descriptor.ek11.planId} ${descriptor.projectId} (${descriptor.drive.mode}) ... `);
      const result = await qualifyOneProject(series, descriptor);
      results.push(result);
      process.stdout.write(`${result.status.toUpperCase()} in ${result.elapsedMs}ms (checks ${result.checksGreen})\n`);
      for (const check of result.checks.filter((check) => check.status === 'red')) {
        process.stdout.write(`      [RED] ${check.id}: ${check.detail}\n`);
      }
    }
    const { summary, sealed, record } = await series.seal(results.map((result) => ({
      id: result.id,
      planId: result.planId,
      status: result.status,
      elapsedMs: result.elapsedMs,
      checksGreen: result.checksGreen,
      evidenceDir: result.evidenceDir,
    })));
    const recordPath = writeSeriesRecord(record, join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'series'));
    const green = results.filter((result) => result.status === 'green').length;
    process.stdout.write(`\n=== scripted product diversity: ${green}/${results.length} green ===\n`);
    process.stdout.write(`evidence: ${series.evidenceRoot.replaceAll('\\', '/')} (manifest digest ${sealed.treeHash})\n`);
    process.stdout.write(`record: ${recordPath.replaceAll('\\', '/')}\n`);
    process.exit(summary.allGreen ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
