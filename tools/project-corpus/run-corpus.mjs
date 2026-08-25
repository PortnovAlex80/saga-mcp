#!/usr/bin/env node
/**
 * tools/project-corpus/run-corpus.mjs - the EK-9 project-corpus qualification
 * driver (WP-13D). Runs scripted project descriptors against a FRESH
 * GREENFIELD database through PUBLIC COMMANDS ONLY (no direct authority-table
 * writes), applies fault schedules via the WP-13B scheduler (crash + restart
 * settlement, projection wipe/stale write, worker loss), compares the
 * observed normalized world against each descriptor's expected world (the
 * WP-13A comparison core), and evaluates the closed invariant battery.
 *
 * Usage:
 *   node tools/project-corpus/run-corpus.mjs --list
 *   node tools/project-corpus/run-corpus.mjs --smoke          (fast subset)
 *   node tools/project-corpus/run-corpus.mjs --full           (all 20)
 *   node tools/project-corpus/run-corpus.mjs --project <id>   (one project)
 *   [--json] [--show-green]
 *
 * Deterministic (seeded), Windows-safe, hermetic: no docker, no external
 * network (products verify via the simple-server pattern - build + loopback
 * over 127.0.0.1 + smoke), no model calls.
 *
 * Exit code 0 only when every executed project is GREEN. Failures are
 * FINDINGS: they are printed honestly, never hidden.
 */

import { loadCorpus, SMOKE_PROJECT_IDS } from '../../tests/project-corpus/registry.mjs';
import { runProject } from './lib/execute.mjs';

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
const mode = args.list ? 'list' : args.project ? 'project' : args.full ? 'full' : args.smoke ? 'smoke' : null;
if (mode === null || (mode !== 'list' && args._.length > 0)) {
  console.error('usage: run-corpus.mjs --list | --smoke | --full | --project <id> [--json] [--show-green]');
  process.exit(2);
}

const corpus = await loadCorpus();

if (mode === 'list') {
  for (const descriptor of corpus) {
    console.log(`${descriptor.projectId.padEnd(30)} ${descriptor.projectKind.padEnd(18)} ${descriptor.drive.mode.padEnd(21)} ${descriptor.product.class.padEnd(20)} ${SMOKE_PROJECT_IDS.includes(descriptor.projectId) ? '[smoke]' : ''}`);
  }
  console.log(`\n${corpus.length} projects; smoke subset: ${SMOKE_PROJECT_IDS.join(', ')}`);
  process.exit(0);
}

const selected = mode === 'project'
  ? corpus.filter((descriptor) => descriptor.projectId === args.project)
  : mode === 'smoke'
    ? corpus.filter((descriptor) => SMOKE_PROJECT_IDS.includes(descriptor.projectId))
    : corpus;
if (selected.length === 0) {
  console.error(`unknown project id "${String(args.project)}" (use --list)`);
  process.exit(2);
}

const results = [];
for (const descriptor of selected) {
  if (!args.json) process.stdout.write(`running ${descriptor.projectId} (${descriptor.drive.mode}) ... `);
  const result = await runProject(descriptor);
  results.push(result);
  if (!args.json) process.stdout.write(`${result.status.toUpperCase()} in ${result.elapsedMs}ms\n`);
}

if (args.json) {
  console.log(JSON.stringify({ mode, results }, null, 2));
} else {
  const width = Math.max(...results.map((result) => result.projectId.length));
  console.log('\n=== project-corpus result table ===');
  for (const result of results) {
    const icon = result.status === 'green' ? 'PASS' : 'RED ';
    console.log(`${icon}  ${result.projectId.padEnd(width)}  ${result.driveMode.padEnd(21)} ${String(result.elapsedMs).padStart(7)}ms  checks ${result.checks.filter((c) => c.status === 'green').length}/${result.checks.length} green`);
    for (const check of result.checks.filter((check) => check.status === 'red' || args.showGreen)) {
      console.log(`      [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
    }
  }
  const green = results.filter((result) => result.status === 'green').length;
  console.log(`\n${green}/${results.length} projects green (mode: ${mode})`);
}

process.exit(results.every((result) => result.status === 'green') ? 0 : 1);
