/**
 * job-queue-sim/verify/smoke.mjs - the simulator smoke: run the REAL
 * simulator CLI twice and assert the deterministic report (all jobs drain,
 * the bounded queue held, peak concurrency never exceeded the pool).
 * Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = () => spawnSync(process.execPath, ['src/simulate.mjs'], { cwd: ROOT, encoding: 'utf8' });

const first = run();
assert.equal(first.status, 0, `simulator exited ${String(first.status)}: ${String(first.stderr)}`);
const report = JSON.parse(first.stdout);
assert.equal(report.kind, 'job-queue-sim.report.v1');
assert.equal(report.completed, 24, 'every job drains');
assert.ok(report.retries > 0, 'the retry path exercised');
assert.ok(report.peakQueueLength <= 4, 'the queue bound held');
assert.ok(report.peakBusyWorkers <= 2, 'the worker pool bound held');
assert.equal(report.perWorkerCompleted.reduce((sum, count) => sum + count, 0), 24);

/* Determinism: a second run is byte-identical. */
const second = run();
assert.equal(second.status, 0);
assert.equal(second.stdout, first.stdout, 'two simulation runs are byte-identical');
process.stdout.write('job-queue-sim smoke ok: drains, bounded, deterministic\n');
