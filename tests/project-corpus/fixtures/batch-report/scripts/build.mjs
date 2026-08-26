/**
 * batch-report/scripts/build.mjs - the deterministic build step of the
 * corpus BATCH product: generates the periodic report from a fixed input
 * window (pure arithmetic - no clock, no randomness) and digests it into
 * dist/report.json + dist/build-manifest.json. Byte-identical on re-run.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The frozen input window (a scheduled batch never reads the wall clock). */
const WINDOW = { from: 20260801, to: 20260831, series: 'corpus-batch' };

const rows = [];
for (let day = WINDOW.from; day <= WINDOW.to; day += 1) {
  // Deterministic per-day metric: a fixed LCG over the day id.
  let state = day % 2147483647;
  const next = () => { state = (state * 48271) % 2147483647; return state; };
  rows.push({ day, events: next() % 1000, latencyMs: 1 + (next() % 49) });
}
const totals = rows.reduce(
  (acc, row) => ({ events: acc.events + row.events, latencySum: acc.latencySum + row.latencyMs }),
  { events: 0, latencySum: 0 },
);
const report = {
  kind: 'batch-report.report.v1',
  window: WINDOW,
  rows,
  totals: { ...totals, meanLatencyMs: Number((totals.latencySum / rows.length).toFixed(3)) },
};
const body = JSON.stringify(report, null, 2) + '\n';
const reportDigest = createHash('sha256').update(body, 'utf8').digest('hex');

const manifest = {
  kind: 'batch-report.build-manifest.v1',
  window: WINDOW,
  reportDigest,
  buildDigest: reportDigest,
};
await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist', 'report.json'), body);
await writeFile(join(ROOT, 'dist', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`batch-report build: ${reportDigest}\n`);
