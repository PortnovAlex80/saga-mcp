/**
 * event-processor/verify/smoke.mjs - the CLI smoke: run the REAL processor
 * over the fixture event log and assert the composed summary; run it twice
 * and assert byte-identical output (the processor is deterministic).
 * Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = () => spawnSync(process.execPath, ['src/pipeline.mjs', 'events.log'], { cwd: ROOT, encoding: 'utf8' });

const first = run();
assert.equal(first.status, 0, `processor exited ${String(first.status)}: ${String(first.stderr)}`);
const summary = JSON.parse(first.stdout);
assert.equal(summary.kind, 'event-processor.summary.v1');
assert.ok(summary.total > 0, 'the fixture log produced events');
assert.equal(summary.refused.length, 2, 'the fixture log carries exactly two malformed lines');
assert.ok(summary.types.length > 0);
assert.ok(summary.buckets.length > 0);

const second = run();
assert.equal(second.status, 0);
assert.equal(second.stdout, first.stdout, 'two processing runs are byte-identical');
process.stdout.write('event-processor smoke ok: composed modules, typed refusals, deterministic\n');
