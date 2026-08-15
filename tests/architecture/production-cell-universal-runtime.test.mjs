import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Production Cell composition never depends on Discovery-specific workplace persistence', () => {
  const source = readFileSync('src/app/product-lifecycle-runtime.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /createDiscoveryWorkplacePersistence/,
    'Factory-wide Production Cell physics must not be wired through Discovery runtime',
  );
  assert.match(
    source,
    /createSqliteProductionCellProjectionPersistence/,
    'Factory-wide Production Cell projection persistence must be explicit in composition root',
  );
});
