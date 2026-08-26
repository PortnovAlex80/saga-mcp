#!/usr/bin/env node
/**
 * tools/project-corpus/replay-elite-kit.mjs - the Elite Evidence Kit replay
 * driver (WP-13D). Feeds each kit corpus entry's input-capsule through the
 * WP-08 PUBLIC ingress, drives the entry's actor program over the WP-09
 * conveyor (public commands only), and compares the normalized trace
 * against the entry's expected-trace.json under the kit's own
 * normalization rules - with TYPED COMPARISON NOTES wherever the kit's
 * trace models legacy-only behavior (DB-only loss transitions, worker
 * process streams), never forced equality.
 *
 * Usage:
 *   node tools/project-corpus/replay-elite-kit.mjs            (all entries)
 *   node tools/project-corpus/replay-elite-kit.mjs --entry <id>
 *   [--json]
 *
 * Exit code 0 only when every replayed entry is GREEN.
 */

import { KIT_ENTRIES, replayKitEntry } from './lib/kit.mjs';

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
const entries = args.entry ? [args.entry] : KIT_ENTRIES;

const results = [];
for (const entryId of entries) {
  if (!args.json) process.stdout.write(`replaying ${entryId} ... `);
  try {
    const result = await replayKitEntry(entryId);
    results.push(result);
    if (!args.json) process.stdout.write(`${result.status.toUpperCase()}\n`);
  } catch (error) {
    results.push({ entryId, status: 'red', checks: [{ id: 'replay', status: 'red', detail: String(error?.stack ?? error) }], notes: [], normalized: null });
    if (!args.json) process.stdout.write(`RED (threw: ${String(error?.message ?? error)})\n`);
  }
}

if (args.json) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  console.log('\n=== elite-evidence-kit replay results ===');
  for (const result of results) {
    console.log(`${result.status === 'green' ? 'PASS' : 'RED '}  ${result.entryId}`);
    for (const check of result.checks) {
      console.log(`      [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
    }
    const notes = result.notes ?? [];
    if (notes.length > 0) {
      console.log('      typed comparison notes:');
      for (const note of notes) console.log(`        - [${note.id}] ${note.note}`);
    }
  }
  const green = results.filter((result) => result.status === 'green').length;
  console.log(`\n${green}/${results.length} kit entries replayed green`);
}

process.exit(results.every((result) => result.status === 'green') ? 0 : 1);
