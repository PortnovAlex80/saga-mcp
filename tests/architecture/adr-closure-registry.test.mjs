// tests/architecture/adr-closure-registry.test.mjs
//
// ADR-076 §6 — architecture enforcement of the ADR closure registry.
//
// K0 commit 4/4 of the Saga Core Renewal program. Runs the registry
// validator against the REAL repository state, so any of the following
// fails the architecture suite:
//
//   - a decision file appears without a registry entry (untracked ADR),
//   - a registry entry orphans or duplicates,
//   - an Accepted ADR lacks owningReleases + evidenceOwner (unowned ADR),
//   - a superseded ADR loses its verified successor,
//   - the registry's decision status diverges from the file header,
//   - the evidence baseline SHA disappears.
//
// This is the closure theorem's enforcement organ: from K0 on, "we decided
// something" without an owned implementation path is a build failure.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRegistry } from '../../tools/adr-closure-registry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('ADR closure registry is complete and every Accepted ADR is owned', () => {
  const result = validateRegistry({
    decisionsDir: join(repoRoot, 'docs/architecture/decisions'),
    registryPath: join(repoRoot, 'docs/architecture/adr-closure-registry.json'),
  });
  assert.deepEqual(
    result.violations,
    [],
    `ADR closure registry violations:\n${result.violations.map((v) => `  [${v.code}] ADR-${v.adr ?? '-'}: ${v.detail}`).join('\n')}`,
  );
});

test('registry reconciles the full decisions directory (no silent subset)', () => {
  const result = validateRegistry({
    decisionsDir: join(repoRoot, 'docs/architecture/decisions'),
    registryPath: join(repoRoot, 'docs/architecture/adr-closure-registry.json'),
  });
  const registry = JSON.parse(readFileSync(join(repoRoot, 'docs/architecture/adr-closure-registry.json'), 'utf8'));
  assert.ok(result.summary.files >= 51, 'decisions directory shrank unexpectedly');
  assert.equal(result.summary.entries, result.summary.files);
  // Every entry must name a Saga Core Renewal K-release as its owner.
  for (const entry of registry.decisions) {
    if (entry.closureState === 'superseded' || entry.closureState === 'rejected') continue;
    assert.ok(
      entry.owningReleases.every((r) => /^K\d+$/.test(r)),
      `ADR-${entry.adr} owningReleases must be K-releases, got ${JSON.stringify(entry.owningReleases)}`,
    );
  }
});

test('ADR-076 closure evidence: this suite enforces the protocol', () => {
  // The protocol ADR is closed by the very enforcement this file provides:
  // reintroducing an unowned Accepted ADR or an incomplete registry fails
  // the first test above.
  const registry = JSON.parse(readFileSync(join(repoRoot, 'docs/architecture/adr-closure-registry.json'), 'utf8'));
  const entry = registry.decisions.find((d) => d.adr === '076');
  assert.ok(entry, 'ADR-076 must be registered');
  assert.equal(entry.closureState, 'closed', 'ADR-076 closure evidence is this architecture test');
  assert.ok(
    Array.isArray(entry.evidence) && entry.evidence.length > 0,
    'ADR-076 must cite its evidence bundle',
  );
});

test('stage 5: the releases block records all 22 K-releases; the closed set is K0-K12', () => {
  const registry = JSON.parse(readFileSync(join(repoRoot, 'docs/architecture/adr-closure-registry.json'), 'utf8'));
  const keys = Object.keys(registry.releases).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(
    keys,
    Array.from({ length: 22 }, (_, i) => `K${i}`),
    'the releases block must cover K0-K21 — removing a release from the record is a deliberate act',
  );
  const closed = keys.filter((k) => registry.releases[k].state === 'closed');
  // K11 was reopened 2026-08-18 (the effect read task.integration_state as proof
  // of a merge, which its own exit gate forbids) and RE-CLOSED the same day once
  // stage-7 made ancestry the sole proof and stage-8 removed the grant plus
  // installed the §27 ratchet. The round trip is recorded in releases.K11.evidence
  // — a release that reopens and re-closes must leave both halves visible.
  assert.deepEqual(
    closed,
    ['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10', 'K11', 'K12', 'K13'],
    `closed set drifted: got ${closed.join(',')}`,
  );
  // K13 signed 2026-08-19 — MILESTONE M3 (Authority-Correct Beta). The flip and
  // this pin land in ONE commit by design: the state alone fails two tests, so a
  // release can never close as a bookkeeping edit. K14 is now the open frontier.
  assert.equal(registry.releases.K13.state, 'closed', 'K13 is signed (M3); reopening it is a deliberate act with a reason');
  assert.equal(registry.releases.K14.state, 'open', 'K14 closure is the architect\'s exit gate to sign, never a bookkeeping edit');
  for (const key of keys) {
    const rel = registry.releases[key];
    assert.ok(['closed', 'open', 'unknown', 'reopened'].includes(rel.state), `${key}.state must be closed|open|unknown|reopened`);
    if (rel.state === 'reopened') {
      assert.ok(typeof rel.reopenReason === 'string' && rel.reopenReason.length > 0,
        `${key} is reopened without stating what evidence broke the closure`);
    }
    if (rel.state === 'closed') {
      assert.ok(Array.isArray(rel.evidence) && rel.evidence.length > 0,
        `${key} is closed without citing where the closure came from`);
    }
  }
});

test('stage 5: release-consistency codes fire on synthetic registries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adr-registry-stage5-'));
  try {
    const decisionsDir = join(dir, 'decisions');
    mkdirSync(decisionsDir);
    writeFileSync(join(decisionsDir, '900-alpha.md'), '# ADR-900: Alpha\n\n- **Status:** Accepted\n');
    const base = {
      adr: '900',
      file: '900-alpha.md',
      decisionStatus: 'accepted',
      closureState: 'planned',
      owningReleases: ['K9'],
      evidenceOwner: 'K9',
      principalProof: 'x',
      successor: null,
      notes: null,
    };
    const registryPath = join(dir, 'registry.json');
    const run = (releases, decisions) => {
      writeFileSync(registryPath, JSON.stringify({
        schemaVersion: 1,
        protocol: 'ADR-076',
        program: 't',
        evidenceBaseline: { commit: 'a'.repeat(40), capturedAt: '2026-08-18' },
        releases,
        decisions,
      }));
      return validateRegistry({ decisionsDir, registryPath }).violations.map((v) => v.code);
    };

    // RELEASES_BLOCK_MISSING — deleting the block must not silently disable
    // the consistency checks.
    assert.ok(run(undefined, [base]).includes('RELEASES_BLOCK_MISSING'));

    // RELEASE_UNKNOWN — an entry naming a release the block does not record
    // (owningReleases and evidenceOwner each).
    const unknown = run({ K5: { state: 'closed' } }, [base]);
    assert.equal(unknown.filter((c) => c === 'RELEASE_UNKNOWN').length, 2);

    // CLOSURE_LAGS_RELEASES — all owners closed + accepted + planned + silent.
    assert.ok(run({ K9: { state: 'closed' } }, [base]).includes('CLOSURE_LAGS_RELEASES'));

    // The documented-lag exception must SAY something: a bare sticker note
    // still violates; a note naming the missing evidence does not.
    assert.ok(
      run({ K9: { state: 'closed' } }, [{ ...base, notes: 'missing evidence' }]).includes('CLOSURE_LAGS_RELEASES'),
      'a bare "missing evidence" sticker does not document a lag',
    );
    assert.ok(
      !run({ K9: { state: 'closed' } }, [{ ...base, notes: 'Missing evidence: no behavioral test exercises the carry-forward predicate or its single-use consumption idempotency.' }]).includes('CLOSURE_LAGS_RELEASES'),
      'a note naming the missing evidence documents the lag',
    );

    // An open owner suppresses the lag rule (the entry is waiting for work).
    assert.ok(
      !run({ K9: { state: 'closed' }, K13: { state: 'open' } }, [{ ...base, owningReleases: ['K9', 'K13'] }]).includes('CLOSURE_LAGS_RELEASES'),
    );

    // CLOSED_WITHOUT_EVIDENCE — closed requires a non-empty evidence[].
    assert.ok(run({ K9: { state: 'closed' } }, [{ ...base, closureState: 'closed' }]).includes('CLOSED_WITHOUT_EVIDENCE'));
    assert.ok(
      !run({ K9: { state: 'closed' } }, [{ ...base, closureState: 'closed', evidence: ['suite 1/1'] }]).includes('CLOSED_WITHOUT_EVIDENCE'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
