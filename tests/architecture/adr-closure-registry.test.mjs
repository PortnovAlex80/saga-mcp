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
import { readFileSync } from 'node:fs';
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
