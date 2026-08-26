/**
 * event-processor/test/pipeline.test.mjs - unit verification (node:test):
 * each module's contract + the composed pipeline's determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModule, enrichModule, aggregateModule, processLines } from '../src/pipeline.mjs';

const LINES = [
  'login@1000 user=alice',
  'click@1200 button=buy',
  'login@1500 user=bob',
  'not-an-event',
  'click@1900 button=cart',
];

test('the parse module refuses malformed lines with typed refusals', () => {
  const parsed = parseModule(LINES);
  assert.equal(parsed.events.length, 4);
  assert.deepEqual(parsed.refusals, [{ line: 4, reason: 'malformed' }]);
});

test('the enrich module derives buckets and weights', () => {
  const enriched = enrichModule(parseModule(LINES).events);
  assert.deepEqual(enriched[0], { type: 'login', at: 1000, payload: 'user=alice', bucket: 1000, weight: 10 });
  assert.equal(enriched[1].bucket, 1000);
  assert.equal(enriched[3].bucket, 1000);
});

test('the aggregate module composes the ordered summary', () => {
  const summary = aggregateModule(enrichModule(parseModule(LINES).events));
  assert.deepEqual(summary.types, [{ type: 'click', count: 2 }, { type: 'login', count: 2 }]);
  assert.equal(summary.total, 4);
});

test('the composed pipeline is deterministic', () => {
  const first = processLines(LINES);
  const second = processLines(LINES);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
