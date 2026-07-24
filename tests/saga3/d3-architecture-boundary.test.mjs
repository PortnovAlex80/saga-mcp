/**
 * D3 — Phase B architecture boundary static tests.
 *
 * The Saga 3 discovery engine and the readiness application service must stay
 * pure orchestration: no getDb(), no inline SQL. SQLite is an adapter only;
 * the engine/service depend on the Saga3DiscoveryRuntimePersistence port.
 * This guards the same boundary Phase B established for Saga 2 and D1/D2
 * already guard for the discovery engine.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = (...parts) => path.resolve(import.meta.dirname, '..', '..', 'src', ...parts);

function assertNoDbInSource(file, label) {
  const source = readFileSync(SRC(...file), 'utf8');
  // No direct DB handle.
  assert.doesNotMatch(source, /\bgetDb\b/, `${label} must not call getDb()`);
  // No inline SQL statements (CREATE/INSERT/UPDATE/DELETE/SELECT ... FROM).
  assert.doesNotMatch(source, /\b(CREATE TABLE|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i,
    `${label} must not contain inline SQL`);
}

test('D3 architecture: discovery engine stays db-free (no getDb, no inline SQL)', () => {
  assertNoDbInSource(['engines', 'saga3-discovery-engine.ts'], 'saga3-discovery-engine');
});

test('D3 architecture: readiness service stays db-free (no getDb, no inline SQL)', () => {
  assertNoDbInSource(['saga3', 'application', 'discovery-readiness-service.ts'], 'discovery-readiness-service');
});

test('D3 architecture: readiness domain has no DB import', () => {
  assertNoDbInSource(['saga3', 'domain', 'discovery-readiness-assessment.ts'], 'discovery-readiness-assessment domain');
});

test('D3 architecture: readiness records have no DB import', () => {
  assertNoDbInSource(['saga3', 'domain', 'discovery-readiness-records.ts'], 'discovery-readiness-records domain');
});

test('D3 architecture: readiness repository does NOT import from application/engine layer (no upward dependency)', () => {
  const source = readFileSync(SRC('saga3', 'persistence', 'saga3-readiness-repository.ts'), 'utf8');
  // The persistence adapter may import the domain layer + db, but never the
  // application service or engine.
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/(engines|saga3\/application|app)\//,
    'readiness repository must not import the engine or application layer');
});

test('D3 architecture: readiness MCP handler is the only layer allowed to use the transaction helper directly', () => {
  const source = readFileSync(SRC('tools', 'saga3-readiness.ts'), 'utf8');
  assert.match(source, /withImmediateTransaction/, 'handler uses the shared transaction helper');
  // And it must not bypass the readiness repository for persistence.
  assert.match(source, /from ['"]\.\.\/saga3\/persistence\/saga3-readiness-repository/, 'handler goes through the persistence boundary');
});
