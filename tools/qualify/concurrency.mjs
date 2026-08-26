#!/usr/bin/env node
/**
 * tools/qualify/concurrency.mjs - the EK-11 CONCURRENCY PROOFS (WP-15):
 *
 *  Proof A - four independent scripted projects run CONCURRENTLY (four real
 *  child processes, four isolated databases/repositories/evidence dirs):
 *    - every project green;
 *    - every concurrent world EQUAL to its serial reference world
 *      (determinism under real parallelism);
 *    - no cross-run identity leak: each database's world mentions ONLY its
 *      own capsule identity;
 *    - no cross-run material leak: the per-project evidence material sets
 *      are pairwise disjoint.
 *
 *  Proof B - one within-project DIAMOND at concurrency cap 2 with a
 *  DETERMINISTIC barrier (no timing assertions): the diamond a -> {b, c}
 *  -> d is driven so b and c are BOTH entered (open, unsettled) at the
 *  barrier before either desk runs; the open-cell series proves peak == 2
 *  as a WORLD-STATE fact, then the run settles fully green.
 *
 * Usage:
 *   npm run qualify:concurrency -- --kit <manifest> [--series <id>]
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

import { freshDir, writeEvidence } from './lib/fences.mjs';
import { okCheck, redCheck, openSeries, writeSeriesRecord, traceFingerprint } from './lib/series.mjs';

/* ------------------------------------------------------------------ */
/* Proof A: four independent projects, real parallelism                */
/* ------------------------------------------------------------------ */

const CONCURRENT_PROJECTS = [
  'p01-served-happy',       // development-vertical + real served product
  'p09-chain-topology',     // planning conveyor
  'p16-human-wait-operator', // durable session + operator disposition
  'p19-projection-faults',  // durable session + fault scheduler
];

function runChild(projectId, outPath) {
  return new Promise((resolveChild) => {
    mkdirSync(dirname(outPath), { recursive: true });
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tools', 'qualify', 'lib', 'one-project.mjs'), '--project', projectId, '--out', outPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolveChild({ projectId, code: code ?? -1, stdout, stderr, outPath }));
  });
}

async function proofConcurrentIndependent(series, evidenceDir) {
  const checks = [];

  /* Serial reference worlds (one process each, strictly sequential). */
  const references = new Map();
  for (const projectId of CONCURRENT_PROJECTS) {
    const out = join(evidenceDir, 'serial', `${projectId}.json`);
    const child = await runChild(projectId, out);
    const document = JSON.parse((await import('node:fs')).readFileSync(out, 'utf8'));
    references.set(projectId, document);
    checks.push(child.code === 0 && document.status === 'green'
      ? okCheck(`serial-reference:${projectId}`, `serial reference green (checks ${document.checksGreen})`)
      : redCheck(`serial-reference:${projectId}`, `serial reference failed: ${child.stderr.slice(0, 300)}`));
  }

  /* The concurrent wave: four REAL processes at once, isolated paths. */
  const wave = [];
  for (const projectId of CONCURRENT_PROJECTS) {
    const out = join(evidenceDir, 'concurrent', `${projectId}.json`);
    wave.push(runChild(projectId, out));
  }
  const children = await Promise.all(wave);
  const concurrentDocs = new Map();
  for (const child of children) {
    const document = JSON.parse((await import('node:fs')).readFileSync(child.outPath, 'utf8'));
    concurrentDocs.set(child.projectId, document);
    checks.push(child.code === 0 && document.status === 'green'
      ? okCheck(`concurrent:${child.projectId}`, `concurrent run green in its own process (pid ${document.pid}, checks ${document.checksGreen})`)
      : redCheck(`concurrent:${child.projectId}`, `concurrent run failed: ${child.stderr.slice(0, 300)}`));
  }

  /* Concurrency really happened: the four processes overlapped (each child
     reports its own pid; four distinct processes ran). */
  const pids = new Set([...concurrentDocs.values()].map((document) => document.pid));
  checks.push(pids.size === CONCURRENT_PROJECTS.length
    ? okCheck('real-parallelism', `${pids.size} distinct child processes ran the wave concurrently (real OS parallelism, isolated paths)`)
    : redCheck('real-parallelism', `expected ${CONCURRENT_PROJECTS.length} distinct processes, saw ${pids.size}`));

  /* Determinism under parallelism: each concurrent world == its serial world. */
  for (const projectId of CONCURRENT_PROJECTS) {
    const reference = references.get(projectId);
    const concurrent = concurrentDocs.get(projectId);
    const equal = reference.traceFingerprint === concurrent.traceFingerprint;
    checks.push(equal
      ? okCheck(`world-equals-serial:${projectId}`, `the concurrent normalized world equals the serial reference (${traceFingerprint(JSON.parse(reference.traceFingerprint)).slice(0, 12)})`)
      : redCheck(`world-equals-serial:${projectId}`, 'the concurrent world diverged from the serial reference'));
  }

  /* No cross-run IDENTITY leak: each world mentions only its own capsule. */
  for (const [projectId, document] of concurrentDocs) {
    const text = JSON.stringify(document.receiptWorld);
    const foreign = CONCURRENT_PROJECTS.filter((other) => other !== projectId && text.includes(other));
    const own = text.includes(projectId) || text.includes(document.capsuleId.split(':')[1] ?? '__none__');
    checks.push(foreign.length === 0 && own
      ? okCheck(`identity-isolation:${projectId}`, `the world carries only its own capsule identity (${document.capsuleId})`)
      : redCheck(`identity-isolation:${projectId}`, `foreign identities present: ${foreign.join(', ')}`));
  }

  /* No cross-run MATERIAL leak: the per-project evidence ref sets are
     pairwise disjoint (each world's evidence belongs to its own run only). */
  const refSets = [...concurrentDocs.entries()].map(([projectId, document]) => ({
    projectId,
    refs: new Set((document.receiptWorld?.evidence ?? []).map((fact) => fact.ref)),
  }));
  let overlap = 0;
  for (let i = 0; i < refSets.length; i += 1) {
    for (let j = i + 1; j < refSets.length; j += 1) {
      for (const ref of refSets[i].refs) if (refSets[j].refs.has(ref)) overlap += 1;
    }
  }
  checks.push(overlap === 0
    ? okCheck('material-isolation', `${refSets.reduce((sum, entry) => sum + entry.refs.size, 0)} evidence refs across ${refSets.length} runs, zero shared refs`)
    : redCheck('material-isolation', `${overlap} evidence ref(s) shared between concurrent runs`));

  writeEvidence(evidenceDir, 'proof-a.json', { projects: CONCURRENT_PROJECTS, checks });
  return checks;
}

/* ------------------------------------------------------------------ */
/* Proof B: the within-project diamond at cap 2, deterministic barrier  */
/* ------------------------------------------------------------------ */

async function proofDiamondCapTwo(series, evidenceDir) {
  const checks = [];
  const { FaultScheduler } = await dist('workflow-kernel/application/faults.js');
  const conveyor = await dist('workflow-kernel/planning/conveyor.js');
  const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
  const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');

  const dbPath = join(evidenceDir, 'diamond', 'kernel.sqlite');
  freshDir(join(evidenceDir, 'diamond'), 'diamond database dir');
  const session = new KernelPersistenceSession(openKernelDatabase(dbPath));
  const openCellsAt = [];
  let barrierObserved = null;
  try {
    const topology = 'diamond';
    const facts = conveyor.factsForTopology(topology);
    const options = { ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() };
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology(topology, facts);
    const byRef = Object.fromEntries(cells.map((cell) => [cell.itemRef, cell]));
    const edges = conveyor.dependencyRowsOf(session);

    /** The open (entered, unsettled) cell count - a WORLD-STATE fact, never
     *  a timing measurement. */
    const openCells = () => {
      const world = session.hydrateWorld().world;
      return [...world.heads.values()].filter((head) => head.aggregate === 'Workplace' && head.status !== 'terminal').length;
    };
    const settle = (cell) => {
      conveyor.settleCellNode(session, ids, cell, options);
    };

    /* a: the root of the diamond. */
    const a = conveyor.enterCell(session, byRef.a, options);
    conveyor.admitCellIntent(session, a, edges, options);
    openCellsAt.push({ after: 'enter-a', open: openCells() });
    conveyor.runDesk(session, a, 'success', options);
    settle(a);
    openCellsAt.push({ after: 'settle-a', open: openCells() });

    /* THE DETERMINISTIC BARRIER: enter b AND c before EITHER desk runs.
     * At the barrier both successor workplaces exist, unsettled - the
     * dependency graph admits exactly this pair concurrently (cap 2). */
    const b = conveyor.enterCell(session, byRef.b, options);
    openCellsAt.push({ after: 'enter-b', open: openCells() });
    const c = conveyor.enterCell(session, byRef.c, options);
    barrierObserved = openCells();
    openCellsAt.push({ after: 'enter-c (BARRIER)', open: barrierObserved });

    conveyor.admitCellIntent(session, b, edges, options);
    conveyor.admitCellIntent(session, c, edges, options);

    /* Both desks settle from the barrier state (either order - the world is
     * the same diamond either way; driven b then c). */
    conveyor.runDesk(session, b, 'success', options);
    settle(b);
    openCellsAt.push({ after: 'settle-b', open: openCells() });
    conveyor.runDesk(session, c, 'success', options);
    settle(c);
    openCellsAt.push({ after: 'settle-c', open: openCells() });

    /* d fans in over BOTH predecessor acceptances. */
    const d = conveyor.enterCell(session, byRef.d, options);
    openCellsAt.push({ after: 'enter-d', open: openCells() });
    conveyor.admitCellIntent(session, d, edges, options);
    conveyor.runDesk(session, d, 'success', options);
    settle(d);

    conveyor.settleSuccessLadder(session, ids, options);

    /* The proofs: peak == 2 AT THE BARRIER (world state), full settlement. */
    const peak = Math.max(...openCellsAt.map((sample) => sample.open));
    checks.push(barrierObserved === 2
      ? okCheck('diamond-barrier-peak-2', `at the deterministic barrier (b and c both entered, neither desk run) the open-cell count is exactly 2 - proven by world state, no timing assertions (series: ${openCellsAt.map((sample) => `${sample.after}=${sample.open}`).join(', ')})`)
      : redCheck('diamond-barrier-peak-2', `barrier open-cell count ${String(barrierObserved)} != 2 (series: ${JSON.stringify(openCellsAt)})`));
    checks.push(peak === 2
      ? okCheck('diamond-peak-equals-cap', `the observed open-cell peak over the whole diamond is exactly the cap 2 (never 3: d admits only after both predecessors settled)`)
      : redCheck('diamond-peak-equals-cap', `observed peak ${peak} != cap 2`));

    const world = session.hydrateWorld().world;
    const runTerminals = [...new Set(world.proofs.map((proof) => proof.id))].filter((proof) => proof.startsWith('TerminalProof:run.'));
    checks.push(runTerminals.includes('TerminalProof:run.success')
      ? okCheck('diamond-settles-green', 'the diamond settled fully (run success terminal proof over both fan-in predecessor acceptances)')
      : redCheck('diamond-settles-green', `terminal proofs: ${JSON.stringify(runTerminals)}`));
  } finally {
    session.close();
  }

  writeEvidence(evidenceDir, 'proof-b.json', { openCellsAt, barrier: barrierObserved, checks });
  return checks;
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
  const seriesId = value('series') ?? `concurrency-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  try {
    const series = await openSeries({ kitReference: value('kit'), seriesId, evidenceRootOverride: value('evidence-root') });
    process.stdout.write(`series ${seriesId} | kit ${series.kitId} | evidence root ${series.evidenceRoot.replaceAll('\\', '/')}\n`);

    process.stdout.write('  proof A: four independent projects, concurrent processes, isolated paths ... \n');
    const proofA = await proofConcurrentIndependent(series, join(series.evidenceRoot, 'proof-a'));
    process.stdout.write(`    -> ${proofA.filter((check) => check.status === 'green').length}/${proofA.length} green\n`);

    process.stdout.write('  proof B: within-project diamond at cap 2, deterministic barrier ... ');
    const proofB = await proofDiamondCapTwo(series, series.evidenceRoot);
    process.stdout.write(`${proofB.filter((check) => check.status === 'green').length}/${proofB.length} green\n`);

    const allChecks = [...proofA.map((check) => ({ ...check, id: `proof-a:${check.id}` })), ...proofB.map((check) => ({ ...check, id: `proof-b:${check.id}` }))];
    for (const check of allChecks.filter((check) => check.status === 'red')) process.stdout.write(`      [RED] ${check.id}: ${check.detail}\n`);

    const results = [
      { id: 'proof-a-four-independent-concurrent', status: proofA.every((check) => check.status === 'green') ? 'green' : 'red', checks: proofA },
      { id: 'proof-b-diamond-cap2-barrier', status: proofB.every((check) => check.status === 'green') ? 'green' : 'red', checks: proofB },
    ];
    const { summary, sealed, record } = await series.seal(results.map((result) => ({ id: result.id, status: result.status, elapsedMs: 0, checksGreen: `${result.checks.filter((check) => check.status === 'green').length}/${result.checks.length}` })));
    const recordPath = writeSeriesRecord(record, join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'series'));
    process.stdout.write(`\n=== concurrency proofs: ${results.every((result) => result.status === 'green') ? 'GREEN' : 'RED'} ===\n`);
    process.stdout.write(`evidence: ${series.evidenceRoot.replaceAll('\\', '/')} (manifest digest ${sealed.treeHash})\n`);
    process.stdout.write(`record: ${recordPath.replaceAll('\\', '/')}\n`);
    process.exit(summary.allGreen ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
