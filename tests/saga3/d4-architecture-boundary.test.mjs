/**
 * D4 — Phase B architecture boundary static tests.
 *
 * The Saga 3 discovery settlement (D4 authoritative discovery settlement)
 * layer must stay kernel-only and pure: no getDb(), no inline SQL, no worker
 * executor, no LM client, no tools-layer import. SQLite is an adapter only;
 * the engine/domain depend on ports, not on adapters. Workers must never be
 * able to mint OutcomeCertificates via an MCP handler, and the certificates
 * table has no mutation path. D4 must also not introduce a stage transition.
 * This mirrors the boundary the D3 Phase B tests already guard.
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

test('D4 architecture: discovery engine stays db-free (no getDb, no inline SQL)', () => {
  assertNoDbInSource(['engines', 'saga3-discovery-engine.ts'], 'saga3-discovery-engine');
});

test('D4 architecture: settlement service stays db-free (no getDb, no inline SQL)', () => {
  assertNoDbInSource(['saga3', 'application', 'discovery-settlement-service.ts'], 'discovery-settlement-service');
});

test('D4 architecture: settlement service must NOT reference WorkerExecutorFactory (settlement is kernel-only)', () => {
  const source = readFileSync(SRC('saga3', 'application', 'discovery-settlement-service.ts'), 'utf8');
  assert.doesNotMatch(source, /WorkerExecutorFactory/,
    'discovery-settlement-service must not reference WorkerExecutorFactory (settlement is kernel-only)');
});

test('D4 architecture: settlement service must NOT import from the tools/ layer', () => {
  const source = readFileSync(SRC('saga3', 'application', 'discovery-settlement-service.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"].*\/tools\//,
    'discovery-settlement-service must not import from the tools/ layer');
});

test('D4 architecture: settlement policy domain has no DB import', () => {
  assertNoDbInSource(['saga3', 'domain', 'discovery-settlement-policy.ts'], 'discovery-settlement-policy domain');
});

test('D4 architecture: settlement policy must NOT import an LM client', () => {
  const source = readFileSync(SRC('saga3', 'domain', 'discovery-settlement-policy.ts'), 'utf8');
  assert.doesNotMatch(source, /LMStudio|openai|llm/i,
    'discovery-settlement-policy must not import an LM client');
});

test('D4 architecture: settlement policy must NOT import the SQLite adapter', () => {
  const source = readFileSync(SRC('saga3', 'domain', 'discovery-settlement-policy.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(better-sqlite3|sqlite)/,
    'discovery-settlement-policy must not import the SQLite adapter');
});

test('D4 architecture: settlement input domain has no DB import', () => {
  assertNoDbInSource(['saga3', 'domain', 'discovery-settlement-input.ts'], 'discovery-settlement-input domain');
});

test('D4 architecture: outcome certificate domain has no DB import', () => {
  assertNoDbInSource(['saga3', 'domain', 'discovery-outcome-certificate.ts'], 'discovery-outcome-certificate domain');
});

test('D4 architecture: settlement repository does NOT import from application/engine layer (no upward dependency)', () => {
  const source = readFileSync(SRC('saga3', 'persistence', 'saga3-settlement-repository.ts'), 'utf8');
  // The persistence adapter may import the domain layer + db, but never the
  // application service or engine.
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/(engines|saga3\/application|app)\//,
    'settlement repository must not import the engine or application layer');
});

test('D4 architecture: no settlement_submit or certificate_submit MCP handler is registered', () => {
  const source = readFileSync(SRC('index.ts'), 'utf8');
  assert.doesNotMatch(source, /settlement_submit/,
    'index.ts must NOT register a settlement_submit tool (workers must not create certificates)');
  assert.doesNotMatch(source, /certificate_submit/,
    'index.ts must NOT register a certificate_submit tool (workers must not create certificates)');
});

test('D4 architecture: outcome certificates table has no mutation (UPDATE) path', () => {
  const source = readFileSync(SRC('saga3', 'persistence', 'saga3-settlement-repository.ts'), 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+saga3_discovery_outcome_certificates/i,
    'settlement repository must not UPDATE the outcome certificates table (certificates are immutable)');
});

test('D4 architecture: D4 must NOT add a stage transition', () => {
  const source = readFileSync(SRC('engines', 'saga3-discovery-engine.ts'), 'utf8');
  assert.doesNotMatch(source, /episode_transition|finalStage.*formalization|'formalization'/,
    'D4 must not introduce a stage transition in the discovery engine');
});
