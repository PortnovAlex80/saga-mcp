// tests/factory-proof/proof-claims.test.mjs
//
// K1-D: the proof-claim registry is complete and honest. Runs against the
// REAL acceptance-matrix group definition (single source of truth for the
// blocking file set) and prints the claim summary into the test output
// (K5: "publish exact claim and coverage summaries in test output").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROOF_CLAIMS, validateProofClaims, PROOF_MODES } from './proof-claims.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function groupFiles() {
  const list = spawnSync(process.execPath,
    ['tools/run-acceptance-matrix.mjs', '--list'],
    { cwd: REPO_ROOT, encoding: 'utf-8' });
  assert.equal(list.status, 0, `--list failed: ${list.stderr}`);
  const out = list.stdout;
  const factoryProof = out.slice(out.indexOf('[group] factory-proof'));
  return [...factoryProof.matchAll(/^\s*\[run\] (\S+)$/gm)].map(m => m[1]);
}

test('K1-D: every blocking factory-proof file declares honest proof modes', () => {
  const files = groupFiles();
  // CC-10A provisional floor: the v1 measuring surface is blocking (23 files).
  // Final K5 floors (self-mutations, vacuity, budgets) land at CC-10B.
  assert.ok(files.length >= 23, `expected the CC-10A 23-file floor, got ${files.length}`);
  const errors = validateProofClaims(files);
  assert.deepEqual(errors, [],
    `proof-claim registry violations:\n${errors.join('\n')}`);
  for (const file of Object.keys(PROOF_CLAIMS)) {
    assert.ok(existsSync(path.join(REPO_ROOT, file)), `${file} claimed but missing`);
  }
});

test('CC-10A negative: a group file WITHOUT a claim fails validation', () => {
  const files = groupFiles();
  const ghost = 'tests/factory-proof/ghost-unclaimed.test.mjs';
  const errors = validateProofClaims([...files, ghost]);
  assert.ok(
    errors.some(e => e.includes(ghost) && e.includes('WITHOUT a proof claim')),
    `an unclaimed group file must fail:\n${errors.join('\n')}`);
});

test('CC-10A negative: a registry entry ABSENT from the group fails validation (bidirectional closure)', () => {
  const files = groupFiles();
  const dropped = 'tests/factory-proof/k0-baseline.test.mjs';
  const errors = validateProofClaims(files.filter(f => f !== dropped));
  assert.ok(
    errors.some(e => e.includes(dropped) && e.includes('ABSENT from the blocking group')),
    `a claimed file missing from the group must fail:\n${errors.join('\n')}`);
  // The negative direction must not smear: with the file restored, closure is clean.
  assert.deepEqual(validateProofClaims(files), []);
});

test('K1-D: the claim summary is published (no proof exceeds its seam)', () => {
  const lines = [];
  for (const [file, claim] of Object.entries(PROOF_CLAIMS)) {
    lines.push(`${path.basename(file)} :: ${claim.modes.join('+')}`);
    for (const c of claim.claims) lines.push(`   ✓ ${c}`);
    for (const n of claim.notClaimed) lines.push(`   ✗ NOT claimed: ${n}`);
  }
  console.log(`\n[proof-claims] ${PROOF_MODES.length} modes; ${Object.keys(PROOF_CLAIMS).length} files:\n${lines.join('\n')}`);
  // K2-B LANDED: strict spawned-actor scenarios are blocking, so the floor
  // now REQUIRES at least one CanonicalSpawn claim — a regression to
  // fast-lane-only proofs must not pass silently.
  const anySpawn = Object.values(PROOF_CLAIMS).some(c => c.modes.includes('CanonicalSpawn'));
  assert.equal(anySpawn, true,
    'CanonicalSpawn landed with K2 — at least one blocking file must claim the strict spawned seam');
});
