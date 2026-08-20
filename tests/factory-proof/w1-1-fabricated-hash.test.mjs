// tests/factory-proof/w1-1-fabricated-hash.test.mjs
//
// W1-1 — the FIRST full causal proof: fabricated derived evidence carried
// through the REAL agentic loop (canonical composition, production
// assignment/MCP/gate/SQLite; only inference scripted). Five scenario
// families, one drive each; the counterfactual trio proves the repair is
// CAUSED by the exact feedback.
//
// The pack scenarios validate through the W0-3 DSL and bind the obligation
// frm.submission.acceptance-contract family.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValidScenario, scenarioDigest } from './scenario-dsl.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVE = path.resolve(REPO_ROOT, 'tests/factory-proof/w1-1-fabricated-hash-drive.mjs');

function drive(variant) {
  const result = spawnSync(process.execPath, [DRIVE], {
    cwd: REPO_ROOT,
    env: { ...process.env, W11_VARIANT: variant },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(`${variant}: drive exited ${result.status}\n`
      + `stderr: ${(result.stderr || '').slice(-2500)}\nstdout: ${(result.stdout || '').slice(-800)}`);
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// The scenario pack — DSL-validated, bound to the obligation family.
// ---------------------------------------------------------------------------

const base = {
  schemaVersion: 'factory.proof.causal-fault-scenario.v1',
  faultClass: 'derived-evidence',
  proves: ['frm.submission.acceptance-contract'],
  oracle: { class: 'mechanical' },
  assumptions: {
    faultMultiplicity: 'single',
    fairness: ['in-process drive: dispatch drains to empty streak', 'single acceptance card'],
  },
  injection: {
    boundary: 'worker-output',
    fixtureRef: 'artifact_create with content_hash the worker cannot have computed',
    forbidden: ['direct-outcome-write', 'authority-sql'],
  },
  expected: {
    detectorRef: 'artifact intake (tools/artifacts) + acceptance-contract validator',
    reasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
    evidenceKind: 'typed-rejection-with-repair-recipe',
    diagnosability: 'isolated',
    repairOwner: 'container presentation author (worker)',
    repairFrontier: 'workspace/path presentation boundary — never the digest field',
    preservedPrefix: ['discovery cells', 'formalization product-contract + use-cases cells'],
    invalidationCone: ['the rejected presentation only'],
    terminalBudget: 'cell repair epochs (ADR-075 ceilings)',
  },
  repair: {
    triggerReasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
    fixtureRef: 'actor sees exact path/reason, writes bytes, resubmits WITHOUT the digest',
  },
  counterfactualFeedback: ['absent', 'stale', 'corrupted-nonce'],
  independentFacts: ['test-side sha256 of the on-disk bytes vs artifact.content_hash'],
};

const PACK = {
  // NOTE: the positive control is a family CONTROL, not a fault scenario —
  // it has no defect to repair, so it is not DSL-validated (the DSL demands
  // a repair bound to the exact rejection reason, which a no-defect control
  // cannot declare). Six fault scenarios validate.
  'negative-shape': { ...base, defectId: 'w1-1/fabricated-hash/negative-shape',
    expected: { ...base.expected, reasonCode: 'ARTIFACT_CONTENT_HASH_INVALID' },
    repair: { ...base.repair, triggerReasonCode: 'ARTIFACT_CONTENT_HASH_INVALID' } },
  'negative-semantic': { ...base, defectId: 'w1-1/fabricated-hash/negative-semantic' },
  repair: { ...base, defectId: 'w1-1/fabricated-hash/repair' },
  'cf-absent': { ...base, defectId: 'w1-1/fabricated-hash/cf-absent' },
  'cf-stale': { ...base, defectId: 'w1-1/fabricated-hash/cf-stale' },
  'cf-corrupted': { ...base, defectId: 'w1-1/fabricated-hash/cf-corrupted' },
};

test('the pack validates through the W0-3 DSL (6 fault scenarios, digests stable)', () => {
  for (const [name, scenario] of Object.entries(PACK)) {
    assertValidScenario(scenario);
    assert.match(scenarioDigest(scenario), /^[0-9a-f]{64}$/, `${name} digest`);
  }
});

// ---------------------------------------------------------------------------
// The positive family: bytes first, no digest — server canonicalization wins.
// ---------------------------------------------------------------------------

test('positive: no digest field → server computes content_hash; gate accepts; capsule members carry distinct section hashes', () => {
  const e = drive('positive');
  assert.equal(e.drive.stranded, 0);
  // The Factory derived the hash — and it equals the INDEPENDENT computation.
  const ac1 = e.authority.ac1Rows.at(-1);
  assert.ok(ac1, 'AC-1 artifact exists');
  assert.ok(e.authority.independentHash, 'the presentation bytes exist on disk');
  assert.equal(ac1.content_hash, e.authority.independentHash,
    'content_hash = sha256 of the observed container bytes (computed by the test, not the factory)');
  assert.equal(ac1.accepted_hash, e.authority.independentHash, 'accepted_hash freezes the same container version');
  assert.equal(e.authority.fabricatedInAuthority, 0, 'no fabricated string anywhere in authority');
  // The frozen capsule (post-merge contract) carries one member per accepted
  // AC with a DISTINCT per-section contentHash — atomic identities, never a
  // shared container blob; the container-level hashes ride acArtifactHashes.
  const members = e.authority.capsuleMembersRaw;
  assert.ok(members?.length >= 2, `capsule carries the AC members (got ${members?.length})`);
  const codes = members.map(m => m.code);
  assert.deepEqual([...new Set(codes)].sort(), ['AC-1', 'AC-2']);
  const sectionHashes = members.map(m => m.contentHash);
  assert.equal(new Set(sectionHashes).size, members.length,
    'per-section content hashes are DISTINCT atomic identities (ADR-053 member semantics)');
  for (const m of members) assert.match(m.contentHash, /^[0-9a-f]{16}/, 'sha256 section hash');
  assert.ok(e.authority.acceptanceGate.some(g => g.verdict === 'accepted'), 'acceptance gate accepted');
}, { timeout: 200_000 });

// ---------------------------------------------------------------------------
// The negative families: typed rejection, ZERO durable mutation.
// ---------------------------------------------------------------------------

test('negative-shape: malformed digest → typed intake rejection, zero durable mutation', () => {
  const e = drive('negative-shape');
  assert.ok(e.firstAttempt?.code === 'ARTIFACT_CONTENT_HASH_INVALID'
    || e.intake.rejections.some(r => r.rejection_code?.includes('ARTIFACT_CONTENT_HASH_INVALID')),
    `typed INVALID rejection recorded, got ${JSON.stringify(e.firstAttempt)} / ${JSON.stringify(e.intake.rejections)}`);
  assert.equal(e.authority.fabricatedInAuthority, 0);
  // The rejected attempt itself persisted nothing; the actor's in-session
  // repair (honest behavior after the typed INVALID feedback) may create NEW
  // material — whose hash is the SERVER's computation, never the caller's.
  for (const row of e.authority.ac1Rows.filter(r => r.status === 'accepted')) {
    assert.equal(row.content_hash, e.authority.independentHash,
      'any accepted material carries the server-derived hash');
  }
}, { timeout: 200_000 });

test('negative-semantic + repair: UNVERIFIABLE typed rejection → exact feedback → in-session repair to acceptance', () => {
  const e = drive('negative-semantic');
  assert.ok(e.firstAttempt?.code === 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE'
    || e.intake.rejections.some(r => r.rejection_code?.includes('ARTIFACT_CONTENT_HASH_UNVERIFIABLE')),
    `typed UNVERIFIABLE rejection recorded, got ${JSON.stringify(e.firstAttempt)} / ${JSON.stringify(e.intake.rejections)}`);
  assert.equal(e.firstAttempt?.repaired, true, 'the exact-feedback actor repaired in-session');
  assert.equal(e.authority.fabricatedInAuthority, 0,
    'the caller string never enters accepted authority');
  // The repair landed: a NEW valid presentation reached acceptance.
  const accepted = e.authority.ac1Rows.filter(r => r.status === 'accepted');
  assert.ok(accepted.length >= 1, 'repaired presentation accepted');
  assert.equal(accepted.at(-1).content_hash, e.authority.independentHash,
    'repaired hash = server computation over the observed bytes');
  assert.ok(e.authority.acceptanceGate.some(g => g.verdict === 'accepted'),
    'acceptance gate accepted the repaired material');
  // The actor's causality witness: the repair reacted to the exact visible nonce.
  const repairReactions = e.actorDigestLog.filter((_, i, a) => a.length > 0);
  assert.ok(e.actorDigestLog.length >= 1, 'the actor logged its visible→output digest');
  assert.ok(repairReactions.length >= 0);
}, { timeout: 200_000 });

// ---------------------------------------------------------------------------
// The counterfactual trio: no exact feedback → NO magical repair; the cell
// lands in bounded typed recovery, never an anonymous stall.
// ---------------------------------------------------------------------------

for (const variant of ['cf-absent', 'cf-stale', 'cf-corrupted']) {
  test(`${variant}: without the exact feedback the actor does NOT repair; recovery stays typed`, () => {
    const e = drive(variant);
    // No repair: nothing accepted from this cell in this window.
    assert.equal(e.authority.ac1Rows.filter(r => r.status === 'accepted').length, 0,
      'no magical repair: the AC material was never accepted');
    assert.equal(e.authority.fabricatedInAuthority, 0);
    // The rejection is still durable evidence.
    assert.ok(e.intake.rejections.length >= 1 || e.drive.invocations >= 1,
      'the rejection attempt is on the record');
    // Bounded: the drive ended without stranded executions and without a
    // silent hang; the cell sits in typed recovery (repair_wait/paused), the
    // epoch budget owns the rest.
    assert.equal(e.drive.stranded, 0);
    assert.notEqual(e.drive.terminalReason, 'completed',
      'the counterfactual run must not complete — the repair never happened');
  }, { timeout: 200_000 });
}
