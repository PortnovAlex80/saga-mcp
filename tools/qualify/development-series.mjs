#!/usr/bin/env node
/**
 * tools/qualify/development-series.mjs - the EK-11 DEVELOPMENT RELIABILITY
 * SERIES driver (WP-15): runs the canonical simple served product TEN times
 * from ten FRESH database paths + ten FRESH product repositories, under one
 * immutable kit (same build + same capsule), importing through the PUBLIC
 * ingress with the scripted actor (the WP-08 material chain), and requiring:
 *
 *   - 10/10 terminal successes (TerminalProof:run.success);
 *   - IDENTICAL normalized authority traces across all ten runs;
 *   - in EVERY run: product build, real server start, GET /healthz +
 *     GET /api/message (loopback), and the WP-08 acceptance layer's real
 *     browser smoke - all inside the run's own product repository;
 *   - the receipt-completeness law (pinned role contracts + unbroken
 *     PromptAssemblyReceipt sequence);
 *   - no manual stop/resume, no SQL, no repository patch, no actor repair
 *     (the driver is one straight public-command pass per run).
 *
 * Evidence per run (journal, receipts, normalized trace, product logs, the
 * run's own kernel database) lives under a build-addressed evidence root
 * OUTSIDE the source checkout; the series evidence manifest is hashed.
 *
 * Usage:
 *   npm run qualify:development -- --kit <manifest> [--series <id>]
 *   (EK_QUALIFY_EVIDENCE_ROOT overrides the evidence root)
 */

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);
const tests = (relative) => import(pathToFileURL(join(REPO_ROOT, 'tests', relative)).href);

import { freshDir, writeEvidence, sha256Of, environmentBlock } from './lib/fences.mjs';
import { okCheck, redCheck, receiptCompleteness, traceFingerprint, openSeries, writeSeriesRecord } from './lib/series.mjs';

const RUN_COUNT = 10;

/** One qualification run of the canonical product. All paths fresh. */
async function runOnce(series, runId) {
  const startedAt = Date.now();
  const evidenceDir = series.runEvidence(runId);
  const dbPath = join(evidenceDir, 'kernel', 'kernel.sqlite');
  const productRepo = join(evidenceDir, 'product-repo');
  const checks = [];

  /* Fresh-path provisioning (the fence refuses reused paths). */
  freshDir(join(evidenceDir, 'kernel'), 'run database dir');
  freshDir(productRepo, 'run product repository');

  /* Stage the canonical product into the run's own repository. */
  const { stageProductRepo } = await import('./lib/product-evidence.mjs');
  const staged = stageProductRepo('repo:simple-server', productRepo);
  const repoDigest = sha256Of(JSON.stringify({ fixture: 'repo:simple-server', capsule: series.kit.capsule.capsuleDigest, build: series.kit.build.distTreeHash }));
  checks.push(okCheck('fresh-paths', `fresh database ${dbPath.replaceAll('\\', '/')} + fresh product repository ${productRepo.replaceAll('\\', '/')}`));

  /* The kernel drive: fresh session, PUBLIC ingress, scripted actor. */
  const support = await tests('workflow-kernel/development/support.mjs');
  const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
  const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');
  const session = new KernelPersistenceSession(openKernelDatabase(dbPath));
  let trace = null;
  let receipts = null;
  let journal = [];
  try {
    const capsule = await support.buildCapsuleFixture();
    const ingress = await dist('workflow-kernel/development/capsule.js');
    const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(support.CAPSULE_BYTES), {
      expectedLineageId: support.LINEAGE.lineageId,
      expectedParentLifecycleRef: support.LINEAGE.parentLifecycleRef,
    });
    checks.push(imported.imported
      ? okCheck('capsule-ingress', `the capsule imported through the public ingress (${imported.ingressReceiptRef})`)
      : redCheck('capsule-ingress', `ingress refused: ${JSON.stringify(imported)}`));

    /* Same immutable capsule every run: the kit digest pins it. */
    const capsuleDigest = sha256Of(JSON.stringify(capsule));
    checks.push(capsuleDigest === series.kit.capsule.capsuleDigest
      ? okCheck('same-capsule', `capsule digest ${capsuleDigest.slice(0, 12)} equals the kit's frozen capsule digest`)
      : redCheck('same-capsule', `capsule digest drifted: ${capsuleDigest} != ${series.kit.capsule.capsuleDigest}`));

    /* The material chain with the scripted actor + the run's product repo. */
    const chain = await dist('workflow-kernel/development/material-chain.js');
    const acceptance = await dist('workflow-kernel/development/product-acceptance.js');
    const verifyProduct = async () => {
      const check = await acceptance.checkProductAcceptance(productRepo);
      if (check.ok) return { ok: true, detail: `verified in the run's product repository: ${check.verified.join(', ')}`, digest: check.evidenceDigest };
      return { ok: false, detail: `${check.reason}: ${check.detail}`, digest: sha256Of(String(check.detail)) };
    };
    const { runtime, authorLaunchKind, reviewerLaunchKind } = await support.roleRuntime();
    runtime.resolveOnce(authorLaunchKind);
    runtime.resolveOnce(reviewerLaunchKind);
    const task = await support.taskManifest();
    const { transport } = await support.sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2', 'activity-attempt:3'] });
    const run = await chain.driveDevelopmentVertical({
      session,
      roles: runtime,
      authorLaunchKind,
      reviewerLaunchKind,
      transport,
      taskSummary: 'EK-11 development reliability run (the canonical simple served product)',
      requiredInfo: task,
      verifyProduct,
      externalEvidence: chain.externalInputEvidence(`sha256:${sha256Of(`ek11-dev-${runId}`)}`, true),
    }, {
      authorScript: await support.authorScript(),
      reviewerScript: await support.reviewerScript('accepted'),
    });
    journal = run.steps.map((step) => ({ step: step.step, status: step.result.status }));
    const refused = run.steps.filter((step) => step.result.status === 'refused' || step.result.status === 'actor-refused' || step.result.status === 'acceptance-refused');
    checks.push(run.blockedAt === undefined && refused.length === 0
      ? okCheck('material-chain', `the vertical settled in one straight pass (${run.steps.length} steps, no refusal, no manual repair)`)
      : redCheck('material-chain', `blocked at ${String(run.blockedAt)}: ${JSON.stringify(refused.map((step) => ({ step: step.step, result: step.result })))}`));

    /* The normalized authority trace of the run. */
    const worldLib = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'project-corpus', 'lib', 'world.mjs')).href);
    const observed = worldLib.observedWorldView(session, [], undefined);
    trace = observed.summary;
    const world = observed.world;
    const terminal = [...new Set(world.proofs.map((proof) => proof.id))].sort().find((proof) => proof.startsWith('TerminalProof:run.'));
    checks.push(terminal === 'TerminalProof:run.success'
      ? okCheck('terminal-success', 'the run terminalized in TerminalProof:run.success')
      : redCheck('terminal-success', `terminal proof family: ${String(terminal)}`));

    /* Receipt completeness (the EK-11 law). */
    const completeness = receiptCompleteness(world);
    receipts = completeness.receipts;
    for (const check of completeness.checks) checks.push(check.ok ? okCheck(check.id, check.detail) : redCheck(check.id, check.detail));

    /* Evidence capture. */
    writeEvidence(evidenceDir, 'journal.json', journal);
    writeEvidence(evidenceDir, 'receipts.json', receipts);
    writeEvidence(evidenceDir, 'normalized-trace.json', trace);
    writeEvidence(evidenceDir, 'checks.json', checks);
    writeEvidence(evidenceDir, 'run.json', {
      runId,
      kitId: series.kitId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      database: dbPath.replaceAll('\\', '/'),
      productRepository: productRepo.replaceAll('\\', '/'),
      productRepoFixture: staged.fixture,
      repoBindingDigest: repoDigest,
      environment: await environmentBlock(),
    });
  } finally {
    session.close();
  }

  const status = checks.every((check) => check.status === 'green') ? 'green' : 'red';
  return {
    id: runId,
    status,
    elapsedMs: Date.now() - startedAt,
    checksGreen: `${checks.filter((check) => check.status === 'green').length}/${checks.length}`,
    traceFingerprint: trace === null ? null : traceFingerprint(trace),
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
  const seriesId = value('series') ?? `dev-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  try {
    const series = await openSeries({ kitReference, seriesId, evidenceRootOverride: value('evidence-root') });
    process.stdout.write(`series ${seriesId} | kit ${series.kitId} | evidence root ${series.evidenceRoot.replaceAll('\\', '/')}\n`);
    const results = [];
    for (let index = 1; index <= RUN_COUNT; index += 1) {
      const runId = `run-${String(index).padStart(2, '0')}`;
      process.stdout.write(`  ${runId} ... `);
      const result = await runOnce(series, runId);
      results.push(result);
      process.stdout.write(`${result.status.toUpperCase()} in ${result.elapsedMs}ms (checks ${result.checksGreen})\n`);
    }
    /* The identical-trace law across all ten runs. */
    const fingerprints = new Set(results.filter((result) => result.traceFingerprint !== null).map((result) => result.traceFingerprint));
    const identical = results.every((result) => result.status === 'green') && fingerprints.size === 1;
    process.stdout.write(identical
      ? `  identical normalized traces: yes (${[...fingerprints][0].slice(0, 12)} across ${results.length} runs)\n`
      : `  identical normalized traces: NO (${fingerprints.size} distinct fingerprints)\n`);
    const { summary, sealed, record } = await series.seal([
      ...results.map((result) => ({ id: result.id, status: result.status, elapsedMs: result.elapsedMs, checksGreen: result.checksGreen, traceFingerprint: result.traceFingerprint, evidenceDir: result.evidenceDir })),
      { id: 'identical-normalized-traces', status: identical ? 'green' : 'red', elapsedMs: 0, checksGreen: identical ? '1/1' : '0/1', detail: `${fingerprints.size} distinct trace fingerprints across ${results.length} runs` },
    ]);
    const recordPath = writeSeriesRecord(record, join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'series'));
    const green = results.filter((result) => result.status === 'green').length;
    process.stdout.write(`\n=== development reliability series: ${green}/${RUN_COUNT} green, traces ${identical ? 'IDENTICAL' : 'DIVERGENT'} ===\n`);
    process.stdout.write(`evidence: ${series.evidenceRoot.replaceAll('\\', '/')} (manifest digest ${sealed.treeHash})\n`);
    process.stdout.write(`record: ${recordPath.replaceAll('\\', '/')}\n`);
    process.exit(summary.allGreen && identical ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
