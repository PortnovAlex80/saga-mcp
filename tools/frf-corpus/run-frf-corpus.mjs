#!/usr/bin/env node
/**
 * tools/frf-corpus/run-frf-corpus.mjs - the FRF scenario-corpus runner
 * (FRF-WP10): drives the NEW semantic chain (the FRF-WP04..09 cells)
 * through their exported test-only surfaces - the same way the cells'
 * own focused suites drive them - compares the observed normalized world
 * against each descriptor's expected world (the WP03 vocabulary), and
 * evaluates the crash/restart exactly-once law over the D12/D5 resume
 * points.
 *
 * Usage:
 *   node tools/frf-corpus/run-frf-corpus.mjs --list
 *   node tools/frf-corpus/run-frf-corpus.mjs --smoke          (fast subset)
 *   node tools/frf-corpus/run-frf-corpus.mjs --full           (all 11)
 *   node tools/frf-corpus/run-frf-corpus.mjs --scenario <id>  (one scenario)
 *   [--json] [--show-green]
 *
 * Mutation-testing mode (proves the comparisons detect tampering):
 *   node tools/frf-corpus/run-frf-corpus.mjs --scenario s01-desk-chain-happy --tamper expectations
 *   (exit 0 only when the tampered run is RED - the kill is demonstrated)
 *
 * Deterministic (seeded), Windows-safe, hermetic: no docker, no network,
 * no model calls, no kernel database - the cells are pure exported
 * functions over immutable artifacts; the only durable seam (the WP07
 * evidence ledger) is addressed through its public submit() path.
 *
 * Exit code 0 only when every executed scenario is GREEN (or, under
 * --tamper, when every tampered run is RED). Failures are FINDINGS:
 * printed honestly, never hidden.
 */

import { frfCorpus, SMOKE_SCENARIO_IDS } from './lib/registry.mjs';
import { runFrfScenario } from './lib/execute.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.list ? 'list' : args.scenario ? 'scenario' : args.full ? 'full' : args.smoke ? 'smoke' : null;
if (mode === null || (mode !== 'list' && args._.length > 0)) {
  console.error('usage: run-frf-corpus.mjs --list | --smoke | --full | --scenario <id> [--json] [--show-green] [--tamper expectations]');
  process.exit(2);
}

const corpus = await frfCorpus();

if (mode === 'list') {
  for (const descriptor of corpus) {
    console.log(`${descriptor.frf.scenarioId.padEnd(38)} ${descriptor.frf.dimension.padEnd(30)} ${SMOKE_SCENARIO_IDS.includes(descriptor.frf.scenarioId) ? '[smoke]' : ''}`);
  }
  console.log(`\n${corpus.length} scenarios; smoke subset: ${SMOKE_SCENARIO_IDS.join(', ')}`);
  process.exit(0);
}

const selected = mode === 'scenario'
  ? corpus.filter((descriptor) => descriptor.frf.scenarioId === args.scenario)
  : mode === 'smoke'
    ? corpus.filter((descriptor) => SMOKE_SCENARIO_IDS.includes(descriptor.frf.scenarioId))
    : corpus;
if (selected.length === 0) {
  console.error(`unknown scenario id "${String(args.scenario)}" (use --list)`);
  process.exit(2);
}

/** The tampering hooks (mutation-testing mode; documented data flips). */
const TAMPERERS = {
  expectations: (world) => {
    if (Array.isArray(world.verdicts) && world.verdicts.length > 0) {
      world.verdicts[0] = { ...world.verdicts[0], verdict: 'terminal-reject' };
      return world;
    }
    if (Array.isArray(world.sweep) && world.sweep.length > 0) {
      world.sweep[0] = { ...world.sweep[0], reason: 'SCOPE_VIOLATION' };
      return world;
    }
    if (world.closure !== undefined) return { ...world, closure: { ...world.closure, verdict: 'consistent', gapReasons: [] } };
    return { ...world, crashLaw: 'not-a-law' };
  },
};

const mutations = args.tamper === undefined ? {} : { tamperExpectations: TAMPERERS[args.tamper] };
if (args.tamper !== undefined && TAMPERERS[args.tamper] === undefined) {
  console.error(`unknown tamper family "${String(args.tamper)}" (known: ${Object.keys(TAMPERERS).join(', ')})`);
  process.exit(2);
}

const results = [];
for (const descriptor of selected) {
  if (!args.json) process.stdout.write(`running ${descriptor.frf.scenarioId} (${descriptor.frf.dimension}) ... `);
  const result = await runFrfScenario(descriptor, { mutations });
  results.push(result);
  if (!args.json) process.stdout.write(`${result.status.toUpperCase()} in ${result.elapsedMs}ms\n`);
}

if (args.json) {
  console.log(JSON.stringify({ mode, results, tampered: args.tamper === true || typeof args.tamper === 'string' }, null, 2));
} else {
  const width = Math.max(...results.map((result) => result.scenarioId.length));
  console.log('\n=== frf-corpus result table ===');
  for (const result of results) {
    const icon = result.status === 'green' ? 'PASS' : 'RED ';
    console.log(`${icon}  ${result.scenarioId.padEnd(width)}  ${result.dimension.padEnd(30)} ${String(result.elapsedMs).padStart(7)}ms  checks ${result.checks.filter((c) => c.status === 'green').length}/${result.checks.length} green`);
    for (const check of result.checks.filter((check) => check.status === 'red' || args.showGreen)) {
      console.log(`      [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
    }
  }
  const passed = results.filter((result) => result.status === 'green').length;
  const tamperedMode = typeof args.tamper === 'string';
  if (tamperedMode) {
    const killed = results.filter((result) => result.status === 'red').length;
    console.log(`\n${killed}/${results.length} tampered runs RED (mutation kill demonstrated) [mode: ${mode}, tamper: ${args.tamper}]`);
    process.exit(killed === results.length ? 0 : 1);
  }
  console.log(`\n${passed}/${results.length} scenarios green (mode: ${mode})`);
}

process.exit(results.every((result) => result.status === 'green') ? 0 : 1);
