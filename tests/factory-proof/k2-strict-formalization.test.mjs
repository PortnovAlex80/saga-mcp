// tests/factory-proof/k2-strict-formalization.test.mjs
//
// K2-B — the STRICT L3 formalization vertical through SPAWNED children:
// every cell from discovery to the Formalization settle runs as a real
// child process under the production envelope, its effects flowing through
// the real saga MCP server (the in-process fast lane is not composed).
//
// Variants (the actor's constitution — the W1-1 pattern, moved to spawn):
//   positive           — honest everywhere → stage outcome 'formalized',
//                        capsule {AC-1, AC-2}, real spawns only.
//   fabricated-exact   — acceptance first attempt submits a fabricated
//                        digest; the typed tool error IS the exact feedback;
//                        the actor repairs with honest bytes → accepted.
//   fabricated-absent/stale/corrupt — same fault; the actor cannot lawfully
//                        repair → bounded stasis park, durable rejections,
//                        and the lifecycle NEVER dies terminally.
//
// The causal claim: repair happens ONLY under exact typed feedback — the
// same theorem W1-1 proved on the fast lane, now through real processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/k2-strict-formalization-drive.mjs');

function drive(variant) {
  const result = spawnSync(process.execPath, [DRIVE], {
    cwd: REPO_ROOT,
    env: { ...process.env, K2_VARIANT: variant },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 420_000,
  });
  if (result.status !== 0) {
    throw new Error(`${variant}: drive exited ${result.status}\n`
      + `stderr: ${(result.stderr || '').slice(-2500)}\nstdout: ${(result.stdout || '').slice(-800)}`);
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('K2-B positive: the full formalization settles through spawned children', () => {
  const e = drive('positive');
  assert.equal(e.stage, 'formalized', JSON.stringify(e));
  assert.equal(e.stoppedByStageOutcome, true);
  assert.deepEqual(e.capsuleCodes, ['AC-1', 'AC-2']);
  assert.ok(e.spawns >= 13, `expected >= 13 real child spawns, got ${e.spawns}`);
  assert.equal(e.inProcessInferences, 0, 'the fast lane must not be composed');
  assert.equal(e.stranded, 0);
  assert.ok(e.fabricatedHashInCapsule === false);
});

test('K2-B fabricated-exact: typed feedback repairs to acceptance', () => {
  const e = drive('fabricated-exact');
  assert.equal(e.stage, 'formalized', JSON.stringify(e));
  assert.deepEqual(e.capsuleCodes, ['AC-1', 'AC-2']);
  assert.equal(e.fabricatedHashInCapsule, false, 'the repaired capsule must not carry the fabricated digest');
  assert.equal(e.fabricatedFaultSeen, true,
    'the fabricated attempt must have happened and been rejected at intake (witness rail)');
  assert.equal(e.stranded, 0);
});

test('K2-D negative: an envelope without --mcp-config fails BEFORE any handler', () => {
  const e = drive('no-mcp-config');
  assert.equal(e.envelopeRefused, true,
    'the argv-compatible child must refuse the envelope (exit 3) before any tool call');
  assert.equal(e.capsuleCodes, null, 'no authority may be produced');
  assert.equal(e.lifecycleStatus, 'paused', 'bounded, never a terminal death');
  assert.ok(e.spawns <= 8, `bounded retries, got ${e.spawns}`);
});

for (const variant of ['fabricated-absent', 'fabricated-stale', 'fabricated-corrupt']) {
  test(`K2-B ${variant}: no lawful repair — bounded stasis, never a terminal death`, () => {
    const e = drive(variant);
    assert.equal(e.lifecycleStatus, 'paused',
      'the lifecycle must stay bounded-paused, not terminally failed');
    assert.equal(e.acceptancePhase, 'blocked',
      'the acceptance cell must end blocked for operator review');
    assert.equal(e.stasisPark, true, 'the park must be SUBMISSION_STASIS_IDENTICAL_BYTES');
    assert.ok(e.durableRejections >= 1, 'the fault must remain durable evidence');
    assert.equal(e.capsuleCodes, null, 'no capsule may freeze the fabricated state');
    assert.equal(e.fabricatedFaultSeen, true, 'the fault must occur in this variant too');
  });
}
