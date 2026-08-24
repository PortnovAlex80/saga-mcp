import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('D3 architecture: live readiness domain has no DB dependency', () => {
  const source = readFileSync(
    path.join(ROOT, 'src/modules/discovery/domain/discovery-readiness-assessment.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"].*(?:db|sqlite)/i);
  assert.doesNotMatch(source, /\bgetDb\b|\bprepare\s*\(/);
});
