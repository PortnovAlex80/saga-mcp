// tests/factory-proof/import-ratchet.test.mjs
//
// W0-1 ratchet: new causal proofs under tests/factory-proof/ must compose
// through tests/factory-proof/canonical-proof-composition.mjs ONLY. Importing
// any of the three LEGACY composition surfaces from a proof is forbidden —
// they remain migration debt for their existing consumers until the migration
// map (tests/factory-proof/MIGRATION-MAP.md) retires them suite by suite.
//
//   Legacy surfaces (see MIGRATION-MAP.md):
//     tests/factory-contract/scenario-composition.mjs
//     tests/factory-temporal/lib/temporal-composition.mjs
//     tests/factory-e2e/harness-composition.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROOF_DIR = path.dirname(fileURLToPath(import.meta.url));
const THIS_FILE = path.basename(fileURLToPath(import.meta.url));

const BANNED_REFERENCES = [
  '../factory-contract/scenario-composition.mjs',
  '../../factory-contract/scenario-composition.mjs',
  '../factory-temporal/lib/temporal-composition.mjs',
  '../../factory-temporal/lib/temporal-composition.mjs',
  '../factory-e2e/harness-composition.mjs',
  '../../factory-e2e/harness-composition.mjs',
  'factory-contract/scenario-composition',
  'factory-temporal/lib/temporal-composition',
  'factory-e2e/harness-composition',
];

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listMjsFiles(full));
    } else if (entry.endsWith('.mjs') && entry !== THIS_FILE) {
      out.push(full);
    }
  }
  return out;
}

test('factory-proof imports no legacy composition surface (canonical adapter only)', () => {
  const files = listMjsFiles(PROOF_DIR);
  assert.ok(files.length >= 3, `expected proof files to scan, got ${files.length}`);
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const banned of BANNED_REFERENCES) {
      if (source.includes(banned)) {
        offenders.push(`${path.relative(PROOF_DIR, file)} → ${banned}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'New causal proofs must compose through '
    + 'tests/factory-proof/canonical-proof-composition.mjs, never through a '
    + 'legacy composition surface. Offenders:\n' + offenders.join('\n'),
  );
});

test('the canonical adapter itself exists and carries the allowlist contract', async () => {
  const mod = await import('./canonical-proof-composition.mjs');
  assert.equal(typeof mod.buildCanonicalProofComposition, 'function');
  assert.equal(typeof mod.assertCanonicalOverlay, 'function');
  assert.equal(typeof mod.driveCanonicalProof, 'function');
  assert.ok(mod.CANONICAL_OVERLAY_ALLOWLIST.includes('workerExecutorFactory'));
  // The allowlist must NOT admit policy mirrors — the exact legacy mistake.
  for (const banned of [
    'development', 'development.settlementPolicy', 'development.taskGraphPolicy',
    'delivery.preflightPolicy', 'delivery.settlementPolicy', 'delivery.runtime',
  ]) {
    assert.ok(!mod.CANONICAL_OVERLAY_ALLOWLIST.includes(banned),
      `allowlist must not admit '${banned}'`);
  }
});
