/**
 * simple-server/test/unit.test.mjs - unit verification hook (node:test,
 * zero dependencies): deterministic message, route table, contract shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicMessage, ROUTES } from '../src/server.js';

test('the API message is deterministic', () => {
  assert.deepEqual(deterministicMessage(), { message: 'hello from simple-server', code: 7 });
  assert.equal(JSON.stringify(deterministicMessage()), JSON.stringify(deterministicMessage()));
});

test('the route table owns exactly the contract surfaces', () => {
  assert.deepEqual([...ROUTES].sort(), ['/', '/api/message', '/healthz', '/app.js'].sort());
});
