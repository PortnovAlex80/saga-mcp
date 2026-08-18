// tests/architecture/legacy-expansion-freeze.test.mjs
//
// K2 commit 2/5 of the Saga Core Renewal program — the freeze ratchet.
//
// The legacy surface may only shrink. This suite fails when:
//   - any file OUTSIDE docs/architecture/legacy-allowlist.json gains a
//     legacy code reference (escalate vocabulary, recency selectors in
//     authority persistence),
//   - `latestCandidate` or the execution-scoped lookup helpers reappear in
//     code (both are pinned at zero since the ADR-053 Phase 7 cutover).
//
// Lowering the baseline happens in the SAME commit as a real removal; any
// broadening requires a new ADR (see docs/architecture/LEGACY-INVENTORY.md).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../../tools/legacy-freeze.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const allowlist = JSON.parse(
  readFileSync(join(repoRoot, 'docs/architecture/legacy-allowlist.json'), 'utf8'),
);
const scan = scanTree();

test('no NEW file carries legacy escalate vocabulary outside the freeze baseline', () => {
  const allowed = new Set(allowlist.categories['escalate-vocabulary'].files);
  const added = scan.categories['escalate-vocabulary'].filter(f => !allowed.has(f));
  assert.deepEqual(added, [], `new escalate references (owner K15 removes the rest):\n${added.join('\n')}`);
});

test('no NEW file selects authority-persistence rows by recency outside the freeze baseline', () => {
  const allowed = new Set(allowlist.categories['recency-selector-authority-persistence'].files);
  const added = scan.categories['recency-selector-authority-persistence'].filter(f => !allowed.has(f));
  assert.deepEqual(added, [], `new ORDER BY ... DESC ... LIMIT 1 selectors (owners K7/K8):\n${added.join('\n')}`);
});

test('execution-scoped lookup helpers stay at ZERO code references', () => {
  assert.deepEqual(
    scan.categories['execution-scoped-lookup'],
    [],
    'listArtifactsForExecution/listTracesForExecution reappeared in code',
  );
});

test('latestCandidate stays at ZERO code references', () => {
  assert.equal(scan.latestCandidateRefs, 0, 'latestCandidate reappeared in code');
});

test('clean schema matches the recorded snapshot — no silent schema change', () => {
  const snapshot = allowlist.schemaSnapshot;
  assert.equal(
    scan.schema.digest,
    snapshot.digest,
    `schema drifted (tables ${scan.schema.tableCount} vs snapshot ${snapshot.tableCount}). `
    + 'Schema changes must update legacy-allowlist.json in the SAME commit, deliberately; '
    + 'K17 owns the legacy-object deletion set.',
  );
  assert.equal(scan.schema.tableCount, snapshot.tableCount);
});
