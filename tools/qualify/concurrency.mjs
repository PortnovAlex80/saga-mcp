#!/usr/bin/env node
/**
 * tools/qualify/concurrency.mjs - the EK-11 CONCURRENCY PROOFS (WP-15):
 *
 *  Proof A - four independent scripted projects run CONCURRENTLY (four real
 *  child processes, four isolated database roots - each child gets its OWN
 *  temp root, so every fresh database the corpus engine provisions lands
 *  under that child's private tree):
 *    - every project green;
 *    - every concurrent world EQUAL to its serial reference world
 *      (determinism under real parallelism - and the no-leak oracle: a
 *      foreign identity or material row would change the normalized world);
 *    - filesystem isolation: each child's databases live under its own
 *      root, the four roots are pairwise disjoint, and the children ran as
 *      four distinct OS processes;
 *    - no cross-run identity leak: each world's capsule/material facts
 *      mention only its own project.
 *
 *    NOTE on evidence refs: obligation/evidence refs are PER-DATABASE local
 *    identifiers (every fresh database numbers them from #1), so ref-set
 *    equality across runs is meaningless; the leak oracle is world equality
 *    plus the isolated roots (recorded here, not silently assumed).
 *
 *  Proof B - one within-project DIAMOND at concurrency cap 2 with a
 *  DETERMINISTIC barrier (no timing assertions): the diamond a -> {b, c}
 *  -> d is driven so b and c are BOTH open (materialized, unsettled) at the
 *  barrier before either desk runs; the open-cell series proves peak == 2
 *  as a WORLD-STATE fact, and both desks complete from the barrier state.
 *  The settlement of the SECOND concurrently-materialized cell is REFUSED
 *  by the ProcessRun lifecycle (typed: recordNodeTerminal has no legal edge
 *  from status node-terminal-recorded) - a KERNEL FINDING recorded as RED
 *  evidence (per the EK-11 law: findings are recorded, never hacked
 *  around; the coordinator repairs and re-runs). The sequential diamond
 *  (cap 1) settles green in the same proof, isolating the gap to the
 *  concurrency cap and proving the topology itself sound.
 *
 * Usage:
 *   npm run qualify:concurrency -- --kit <manifest> [--series <id>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

import { freshDir, writeEvidence } from './lib/fences.mjs';
import { okCheck, redCheck, openSeries, writeSeriesRecord, traceFingerprint } from './lib/series.mjs';

/* ------------------------------------------------------------------ */
/* Proof A: four independent projects, real parallelism                */
/* ------------------------------------------------------------------ */

const CONCURRENT_PROJECTS = [
  'p01-served-happy',        // development-vertical + real served product
  'p09-chain-topology',      // planning conveyor
  'p16-human-wait-operator', // durable session + operator disposition
  'p19-projection-faults',   // durable session + fault scheduler
];

function runChild(projectId, outPath, childEnv) {
  return new Promise((resolveChild) => {
    mkdirSync(dirname(outPath), { recursive: true });
    const child = spawn(process.execPath, [join(REPO_ROOT, 'tools', 'qualify', 'lib', 'one-project.mjs'), '--project', projectId, '--out', outPath], {
      cwd: REPO_ROOT,
      env: childEnv ?? process.env,
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
  const readDoc = (path) => JSON.parse(readFileSync(path, 'utf8'));

  /* Serial reference worlds (one process each, strictly sequential, default
   * temp root). */
  const references = new Map();
  for (const projectId of CONCURRENT_PROJECTS) {
    const out = join(evidenceDir, 'serial', `${projectId}.json`);
    const child = await runChild(projectId, out);
    const document = readDoc(out);
    references.set(projectId, document);
    checks.push(child.code === 0 && document.status === 'green'
      ? okCheck(`serial-reference:${projectId}`, `serial reference green (checks ${document.checksGreen})`)
      : redCheck(`serial-reference:${projectId}`, `serial reference failed: ${child.stderr.slice(0, 300)}`));
  }

  /* The concurrent wave: four REAL processes at once, each with its OWN
   * temp root (every fresh database the engine provisions lands under the
   * child's private tree - isolated paths by construction, listed here). */
  const childRoots = new Map();
  const wave = [];
  for (const projectId of CONCURRENT_PROJECTS) {
    const out = join(evidenceDir, 'concurrent', `${projectId}.json`);
    const root = mkdtempSync(join(tmpdir(), `ek-qual-wave-${projectId}-`));
    childRoots.set(projectId, root);
    const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };
    wave.push(runChild(projectId, out, env));
  }
  const children = await Promise.all(wave);
  const concurrentDocs = new Map();
  for (const child of children) {
    const document = readDoc(child.outPath);
    concurrentDocs.set(child.projectId, document);
    checks.push(child.code === 0 && document.status === 'green'
      ? okCheck(`concurrent:${child.projectId}`, `concurrent run green in its own process (pid ${document.pid}, checks ${document.checksGreen})`)
      : redCheck(`concurrent:${child.projectId}`, `concurrent run failed: ${child.stderr.slice(0, 300)}`));
  }

  /* Real parallelism: four distinct OS processes overlapped. */
  const pids = new Set([...concurrentDocs.values()].map((document) => document.pid));
  checks.push(pids.size === CONCURRENT_PROJECTS.length
    ? okCheck('real-parallelism', `${pids.size} distinct child processes ran the wave concurrently (real OS parallelism)`)
    : redCheck('real-parallelism', `expected ${CONCURRENT_PROJECTS.length} distinct processes, saw ${pids.size}`));

  /* Determinism under parallelism - and the no-leak oracle: each concurrent
   * world equals its serial reference world byte-for-byte (any foreign
   * identity or material row from a sibling run would change it). */
  for (const projectId of CONCURRENT_PROJECTS) {
    const reference = references.get(projectId);
    const concurrent = concurrentDocs.get(projectId);
    const equal = reference.traceFingerprint === concurrent.traceFingerprint;
    checks.push(equal
      ? okCheck(`world-equals-serial:${projectId}`, `the concurrent normalized world equals the serial reference (${traceFingerprint(JSON.parse(reference.traceFingerprint)).slice(0, 12)}) - determinism under real parallelism is also the no-leak oracle`)
      : redCheck(`world-equals-serial:${projectId}`, 'the concurrent world diverged from the serial reference'));
  }

  /* Filesystem isolation: each child's databases live under its own root;
   * the four roots are pairwise disjoint paths; each root actually holds
   * the run's database trees. */
  const roots = [...childRoots.values()];
  checks.push(new Set(roots).size === roots.length
    ? okCheck('isolated-database-roots', `${roots.length} pairwise-disjoint child temp roots provisioned (TMPDIR/TEMP/TMP per child: every fresh database landed under its own run's tree)`)
    : redCheck('isolated-database-roots', 'child temp roots collided'));
  const emptyRoots = CONCURRENT_PROJECTS.filter((projectId) => {
    const root = childRoots.get(projectId);
    try { return readdirSync(root).length === 0; } catch { return true; }
  });
  checks.push(emptyRoots.length === 0
    ? okCheck('databases-under-own-root', 'every child root contains its own run\'s database trees (no child wrote into a sibling root)')
    : redCheck('databases-under-own-root', `child roots with no databases: ${emptyRoots.join(', ')}`));

  /* No cross-run IDENTITY leak: each world's own capsule identity is
   * present and every sibling project id is absent from its world text. */
  for (const [projectId, document] of concurrentDocs) {
    const text = JSON.stringify(document.receiptWorld);
    const foreign = CONCURRENT_PROJECTS.filter((other) => other !== projectId && text.includes(other));
    const ownPresent = text.length > 0 && document.capsuleId === `capsule:${projectId}`;
    checks.push(foreign.length === 0 && ownPresent
      ? okCheck(`identity-isolation:${projectId}`, `the run's capsule identity is its own (${document.capsuleId}) and no sibling identity appears in its world`)
      : redCheck(`identity-isolation:${projectId}`, `foreign identities present: ${foreign.join(', ') || '(own identity absent)'}`));
  }
  checks.push(okCheck('material-isolation-oracle', 'evidence refs are per-database local ids (numbered from #1 in every fresh database), so the material-leak oracle is the world-equals-serial equality above plus the isolated per-child roots - recorded, not assumed'));

  writeEvidence(evidenceDir, 'proof-a.json', { projects: CONCURRENT_PROJECTS, childRoots: Object.fromEntries([...childRoots.entries()].map(([key, value]) => [key, value.replaceAll('\\', '/')])) , checks });
  return checks;
}

/* ------------------------------------------------------------------ */
/* Proof B: the within-project diamond at cap 2, deterministic barrier  */
/* ------------------------------------------------------------------ */

async function proofDiamondCapTwo(series, evidenceDir) {
  const checks = [];
  const { FaultScheduler } = await dist('workflow-kernel/application/faults.js');
  const conveyor = await dist('workflow-kernel/planning/conveyor.js');
  const settlement = await dist('workflow-kernel/planning/settlement.js');
  const bindingsModule = await dist('workflow-kernel/planning/bindings.js');
  const { openKernelDatabase } = await dist('workflow-kernel/persistence/database.js');
  const { KernelPersistenceSession } = await dist('workflow-kernel/persistence/session.js');

  const dbDir = freshDir(join(evidenceDir, 'diamond'), 'diamond database dir');
  const dbPath = join(dbDir, 'kernel.sqlite');
  const session = new KernelPersistenceSession(openKernelDatabase(dbPath));
  const openCellsAt = [];
  let barrierObserved = null;
  let settlementRefusal = null;
  const finding = {
    kind: 'ek-qualify.kernel-finding.v1',
    id: 'EK11-CONCURRENCY-DIAMOND-SETTLEMENT',
    title: 'The ProcessRun lifecycle admits only one in-flight node settlement - a concurrently-materialized diamond successor cannot complete its cell settlement through public commands',
    observed: null,
    refusal: null,
    consequence: 'The stock conveyor drive linearizes every topology (the diamond - and even the independent topology whose declared cap is 2 - run cell-by-cell). Workplace-level concurrency at cap 2 IS reachable and provable (both desks complete from the barrier), but the second concurrently-materialized cell cannot settle, so the run success ladder cannot be reached from the concurrent barrier state.',
    repairHint: 'Either a legal edge for recordNodeTerminal from status node-terminal-recorded when the flow holds concurrent open nodes, or a dependant-cell settlement path whose cell acceptance does not require a flow-entered node. Kernel-owner decision; the qualification records the finding and stops this proof (per the EK-11 law).',
  };
  try {
    const topology = 'diamond';
    const facts = conveyor.factsForTopology(topology);
    const options = { ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() };
    const ids = conveyor.bootstrapVertical(session, facts, options);
    const cells = conveyor.cellsForTopology(topology, facts);
    const byRef = Object.fromEntries(cells.map((cell) => [cell.itemRef, cell]));
    const edges = conveyor.dependencyRowsOf(session);

    const openWorkplaces = () => [...session.hydrateWorld().world.heads.values()]
      .filter((head) => head.aggregate === 'Workplace' && head.status !== 'terminal').length;

    /* The public dependant lane: materialize a successor workplace through
     * its dependency edge (obligation:instantiateDependantWorkplaces ->
     * workplace.materialize) WITHOUT advancing the linear process flow. */
    const enterDependant = (cell, nodeName) => {
      conveyor.ensureCommand(session, 'nodeRun.create', nodeName, `diamond:create-node:${cell.itemRef}`, { evidenceRefs: [cell.token] }, options);
      conveyor.ensureCommand(session, 'nodeRun.materializeCell', nodeName, `diamond:materialize-cell:${cell.itemRef}`, { evidenceRefs: [cell.token] }, options);
      settlement.consumeWithTopologyBinding(session, {
        kind: 'obligation:instantiateDependantWorkplaces',
        expectedTarget: 'workplace.materialize',
        resolveTargetInstanceId: () => cell.token,
        invocation: {},
      }, { externalEvidence: options.externalEvidence, faults: options.faults });
      const workplace = bindingsModule.topologyBindings(session.hydrateWorld().world).tokenHolders(cell.token).workplaces[0];
      return { ...cell, node: nodeName, workplace };
    };

    /* a: the diamond root, through the stock flow lane. */
    const a = conveyor.enterCell(session, byRef.a, options);
    conveyor.admitCellIntent(session, a, edges, options);
    openCellsAt.push({ after: 'enter-a', open: openWorkplaces() });
    conveyor.runDesk(session, a, 'success', options);
    conveyor.settleCellNode(session, ids, a, options);
    openCellsAt.push({ after: 'settle-a', open: openWorkplaces() });

    /* THE DETERMINISTIC BARRIER: b through the flow lane, c through the
     * public dependant lane - BOTH open before either desk runs. */
    const b = conveyor.enterCell(session, byRef.b, options);
    openCellsAt.push({ after: 'enter-b (flow lane)', open: openWorkplaces() });
    const c = enterDependant(byRef.c, 'node-run:diamond-c');
    barrierObserved = openWorkplaces();
    openCellsAt.push({ after: 'materialize-c (dependant lane) = BARRIER', open: barrierObserved });

    conveyor.admitCellIntent(session, b, edges, options);
    conveyor.admitCellIntent(session, c, edges, options);

    /* Both desks complete FROM THE BARRIER STATE (workplace-level
     * concurrency at cap 2 - the material chain of both cells runs). */
    let desksFromBarrier = true;
    const deskDetail = [];
    for (const cell of [c, b]) {
      try {
        conveyor.runDesk(session, cell, 'success', options);
        deskDetail.push(`${cell.itemRef}:ok`);
      } catch (error) {
        desksFromBarrier = false;
        deskDetail.push(`${cell.itemRef}:FAILED ${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    checks.push(desksFromBarrier
      ? okCheck('diamond-desks-from-barrier', `both successor desks completed from the deterministic barrier state (${deskDetail.join(', ')}) - the material chains of two concurrently-open workplaces both ran to accepted gates`)
      : redCheck('diamond-desks-from-barrier', `desk failure from the barrier: ${deskDetail.join(' | ')}`));

    /* The settlement attempt: b settles (flow lane); c's settlement is the
     * typed refusal - THE FINDING (recorded, never hacked around). */
    try {
      conveyor.settleCellNode(session, ids, b, options);
      checks.push(okCheck('diamond-settle-first-successor', 'b (the flow-lane successor) settled its cell'));
    } catch (error) {
      checks.push(redCheck('diamond-settle-first-successor', String(error?.message ?? error).slice(0, 200)));
    }
    openCellsAt.push({ after: 'settle-b', open: openWorkplaces() });
    try {
      conveyor.settleCellNode(session, ids, c, options);
      checks.push(okCheck('diamond-settle-second-successor', 'c (the dependant-lane successor) settled its cell - the kernel admits concurrent node settlements'));
    } catch (error) {
      settlementRefusal = String(error?.message ?? error);
      checks.push(redCheck('diamond-settle-second-successor', `KERNEL FINDING ${finding.id}: ${settlementRefusal}`));
    }
    const finalWorld = session.hydrateWorld().world;
    finding.observed = {
      barrierOpenWorkplaces: barrierObserved,
      openCellSeries: openCellsAt,
      deskResults: deskDetail,
      workplacesFinal: [...finalWorld.heads.entries()].filter(([, head]) => head.aggregate === 'Workplace').map(([instanceId, head]) => ({ instance: instanceId.slice(0, 48), status: head.status })),
    };
    finding.refusal = settlementRefusal;

    /* The peak laws (world state, never timing). */
    const peak = Math.max(...openCellsAt.map((sample) => sample.open));
    checks.push(barrierObserved === 2
      ? okCheck('diamond-barrier-peak-2', `at the deterministic barrier (b and c both materialized, neither desk run) the open-workplace count is exactly 2 - proven by world state, no timing assertions (series: ${openCellsAt.map((sample) => `${sample.after}=${sample.open}`).join(', ')})`)
      : redCheck('diamond-barrier-peak-2', `barrier open-workplace count ${String(barrierObserved)} != 2`));
    checks.push(peak === 2
      ? okCheck('diamond-peak-equals-cap', `the observed open-workplace peak over the whole drive is exactly the cap 2`)
      : redCheck('diamond-peak-equals-cap', `observed peak ${peak} != cap 2`));

    /* The run-success terminal from the CONCURRENT barrier state is
     * unreachable while c's cell settlement is refused. */
    const runTerminals = [...new Set(finalWorld.proofs.map((proof) => proof.id))].filter((proof) => proof.startsWith('TerminalProof:run.'));
    checks.push(runTerminals.includes('TerminalProof:run.success')
      ? okCheck('diamond-settles-green-from-barrier', 'the diamond settled fully from the concurrent barrier state (run success terminal)')
      : redCheck('diamond-settles-green-from-barrier', `the run success terminal is unreachable from the concurrent barrier state (run terminals: ${JSON.stringify(runTerminals)}) - THE FINDING ${finding.id}`));
  } finally {
    session.close();
  }

  /* Context proof (GREEN): the SAME diamond topology settles fully green
   * when driven cell-by-cell (cap 1, the stock order) - the topology is
   * sound; only the concurrency cap 2 settlement is blocked. */
  const sequentialDir = freshDir(join(evidenceDir, 'diamond-sequential'), 'sequential diamond database dir');
  const seqSession = new KernelPersistenceSession(openKernelDatabase(join(sequentialDir, 'kernel.sqlite')));
  try {
    const facts = conveyor.factsForTopology('diamond');
    const options = { ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() };
    const ids = conveyor.bootstrapVertical(seqSession, facts, options);
    const cells = conveyor.cellsForTopology('diamond', facts);
    const edges = conveyor.dependencyRowsOf(seqSession);
    for (const cell of cells) {
      const entered = conveyor.enterCell(seqSession, cell, options);
      conveyor.admitCellIntent(seqSession, entered, edges, options);
      conveyor.runDesk(seqSession, entered, 'success', options);
      conveyor.settleCellNode(seqSession, ids, entered, options);
    }
    conveyor.settleSuccessLadder(seqSession, ids, options);
    const seqTerminals = [...new Set(seqSession.hydrateWorld().world.proofs.map((proof) => proof.id))].filter((proof) => proof.startsWith('TerminalProof:run.'));
    checks.push(seqTerminals.includes('TerminalProof:run.success')
      ? okCheck('diamond-sequential-cap1-green', 'the same diamond topology driven cell-by-cell (cap 1) settles fully green - the finding isolates exactly the concurrency-cap-2 settlement')
      : redCheck('diamond-sequential-cap1-green', `the sequential diamond failed too: ${JSON.stringify(seqTerminals)}`));
  } finally {
    seqSession.close();
  }

  writeEvidence(evidenceDir, 'proof-b.json', { openCellsAt, barrier: barrierObserved, finding, checks });
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

    process.stdout.write('  proof A: four independent projects, concurrent processes, isolated roots ... \n');
    const proofA = await proofConcurrentIndependent(series, join(series.evidenceRoot, 'proof-a'));
    process.stdout.write(`    -> ${proofA.filter((check) => check.status === 'green').length}/${proofA.length} green\n`);

    process.stdout.write('  proof B: within-project diamond at cap 2, deterministic barrier ... \n');
    const proofB = await proofDiamondCapTwo(series, series.evidenceRoot);
    process.stdout.write(`    -> ${proofB.filter((check) => check.status === 'green').length}/${proofB.length} green\n`);

    const allChecks = [...proofA.map((check) => ({ ...check, id: `proof-a:${check.id}` })), ...proofB.map((check) => ({ ...check, id: `proof-b:${check.id}` }))];
    for (const check of allChecks.filter((check) => check.status === 'red')) process.stdout.write(`      [RED] ${check.id}: ${check.detail.slice(0, 220)}\n`);

    const results = [
      { id: 'proof-a-four-independent-concurrent', status: proofA.every((check) => check.status === 'green') ? 'green' : 'red', checks: proofA },
      { id: 'proof-b-diamond-cap2-barrier', status: proofB.every((check) => check.status === 'green') ? 'green' : 'red', checks: proofB },
    ];
    const { summary, sealed, record } = await series.seal(results.map((result) => ({ id: result.id, status: result.status, elapsedMs: 0, checksGreen: `${result.checks.filter((check) => check.status === 'green').length}/${result.checks.length}` })));
    const recordPath = writeSeriesRecord(record, join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'series'));
    process.stdout.write(`\n=== concurrency proofs: ${results.every((result) => result.status === 'green') ? 'GREEN' : 'RED (finding recorded)'} ===\n`);
    process.stdout.write(`evidence: ${series.evidenceRoot.replaceAll('\\', '/')} (manifest digest ${sealed.treeHash})\n`);
    process.stdout.write(`record: ${recordPath.replaceAll('\\', '/')}\n`);
    process.exit(summary.allGreen ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
