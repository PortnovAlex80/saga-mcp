import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('D4 architecture: live settlement policy is pure and infrastructure-free', () => {
  const source = read('src/modules/discovery/domain/discovery-settlement-policy.ts');
  assert.doesNotMatch(source, /from ['"].*(?:db|sqlite)/i);
  assert.doesNotMatch(source, /WorkerExecutorFactory|LanguageModel|\bgetDb\b/);
});

test('D4 architecture: settlement input remains a pure domain contract', () => {
  const source = read('src/modules/discovery/domain/discovery-settlement-input.ts');
  assert.doesNotMatch(source, /from ['"].*(?:db|sqlite)/i);
});

test('D4 architecture: workers cannot mint settlement certificates through MCP', () => {
  const source = read('src/index.ts');
  assert.doesNotMatch(source, /settlement_submit|certificate_submit/);
});
