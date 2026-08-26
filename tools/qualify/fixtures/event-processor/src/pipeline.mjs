/**
 * event-processor/src/pipeline.mjs - the multi-module event processor (plan
 * EK-11 P14): three independent processing modules (parse -> enrich ->
 * aggregate) over a raw event stream. Pure functions; deterministic.
 */

/** Module 1: parse raw lines into typed events (typed refusals, no drops). */
export function parseModule(lines) {
  const events = [];
  const refusals = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const match = /^(\w+)@(\d+) (.+)$/.exec(line.trim());
    if (match === null) {
      refusals.push({ line: index + 1, reason: 'malformed' });
      continue;
    }
    events.push({ type: match[1], at: Number(match[2]), payload: match[3] });
  }
  return { events, refusals };
}

/** Module 2: enrich events with derived fields (bucket + weight). */
export function enrichModule(events) {
  return events.map((event) => ({
    ...event,
    bucket: Math.floor(event.at / 1000) * 1000,
    weight: event.payload.length,
  }));
}

/** Module 3: aggregate enriched events into the summary document. */
export function aggregateModule(enriched) {
  const byType = new Map();
  const byBucket = new Map();
  for (const event of enriched) {
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
    byBucket.set(event.bucket, (byBucket.get(event.bucket) ?? 0) + event.weight);
  }
  return {
    kind: 'event-processor.summary.v1',
    total: enriched.length,
    types: [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([type, count]) => ({ type, count })),
    buckets: [...byBucket.entries()].sort(([a], [b]) => a - b).map(([bucket, weight]) => ({ bucket, weight })),
  };
}

/** The full multi-module pipeline. */
export function processLines(lines) {
  const parsed = parseModule(lines);
  return { ...aggregateModule(enrichModule(parsed.events)), refused: parsed.refusals };
}

const isMain = process.argv[1] !== undefined
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);
if (isMain) {
  const { readFileSync } = await import('node:fs');
  const input = process.argv[2];
  if (input === undefined) {
    process.stderr.write('usage: pipeline.mjs <events.log>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(processLines(readFileSync(input, 'utf8').split(/\r\n|\r|\n/)), null, 2)}\n`);
}
