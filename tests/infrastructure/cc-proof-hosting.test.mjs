// tests/infrastructure/cc-proof-hosting.test.mjs
//
// ADR-092 / CC-U1 — the CC closure proof-hosting registry, proven blocking.
//
// Structure (mirrors the acceptance-matrix coverage self-check style):
//   1. REAL-REPO validation: the committed manifest is validated against the
//      live machine-readable matrix export (run-acceptance-matrix.mjs
//      --list-json — never the human --list text) and the real CI group
//      invocations extracted from .github/workflows/ci.yml.
//   2. FAIL-CLOSED MUTATION BATTERY: every drift direction the ADR names is
//      killed IN MEMORY (the validation core is pure over injected facts —
//      no repository file is touched by a mutation):
//        (m1)  missing proof file            -> ROW_FILE_MISSING
//        (m2)  duplicate row                 -> ROW_FILE_DUPLICATE
//        (m3)  group rename                  -> GROUP_UNKNOWN (+ CI side red)
//        (m4)  run-set drop (de-hosting)     -> PROOF_NOT_HOSTED
//        (m5)  quarantine reclassification   -> PROOF_QUARANTINED (+ PROOF_NOT_HOSTED)
//        (m6)  CI omission                   -> GROUP_NOT_INVOKED_BY_CI
//        (m7)  stale pending (hosted proof
//              typed pending)               -> PENDING_ABSORBS_HOSTED
//        (m8)  pending without tracker/reason-> PENDING_TRACKER_MISSING /
//                                              PENDING_REASON_MISSING
//        (m9)  registry-group widening       -> REGISTRY_GROUP_WIDENED
//        (m10) stale CI wiring (renamed group
//              still invoked by CI)          -> CI_INVOKES_UNKNOWN_GROUP
//        (m11) registry-group row not hosted -> REGISTRY_GROUP_ROW_NOT_HOSTED
//        (m12) emptied / malformed manifest  -> MANIFEST_MALFORMED
//        (m14) registryGroup typo / unknown  -> REGISTRY_GROUP_UNKNOWN
//              (the pure validator previously failed OPEN here — a mutated
//              registryGroup silently skipped the bijection block)
//        (m15) registryGroup defined but not CI-invoked
//                                      -> REGISTRY_GROUP_NOT_INVOKED_BY_CI
//        (m16) registryGroup anchored by no blocking row
//                                      -> REGISTRY_GROUP_UNANCHORED
//        (m17) coordinated group+CI removal -> REGISTRY_GROUP_UNKNOWN
//              (+ row-level GROUP_UNKNOWN) — the validator layer of the
//              bootstrap guard; the independent matrix-coverage G5 cross-guard
//              is the second layer (it stays red even when this test's own
//              group is the thing removed)
//        (m18) prefix-colliding group name  -> REGISTRY_GROUP_NOT_INVOKED_BY_CI
//              (`--group X-shadow` must not satisfy `--group X`; exact
//              membership in the extracted invocation set, both directions)
//
// This file is itself a manifest blocking row (origin CC-U1, group
// cc-proof-registry): the registry proves its own hosting both ways.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProofHosting,
  extractInvokedGroups,
  loadRepositoryFacts,
} from '../../tools/cc-proof-hosting-registry.mjs';
import { CC_PROOF_HOSTING_MANIFEST } from './cc-proof-hosting-manifest.mjs';

// EK-8 cutover (WP-12, 2026-08-26): the old-runtime proof rows died with
// their suites and matrix groups; the manifest carries the registry row
// itself (the closure proof survives the tree it guards). The assertions
// below pin the NEW hosting truth.
const REGISTRY_TEST = 'tests/infrastructure/cc-proof-hosting.test.mjs';
// The post-cutover invariant successors of the deleted CC proofs: kernel
// material-chain/settlement suites + the corpus (hosted in CI-invoked
// groups; asserted by R2 below).
const SUCCESSOR_KERNEL_MATERIAL_CHAIN = 'tests/workflow-kernel/development/material-chain.test.mjs';
const SUCCESSOR_KERNEL_ENGINE = 'tests/workflow-kernel/engine/scenario.test.mjs';
const SUCCESSOR_CORPUS = 'tests/project-corpus/corpus.test.mjs';

// --- real-repo facts --------------------------------------------------------

const facts = loadRepositoryFacts();
const { matrix, ciInvokedGroups, fileExists } = facts;

const groupRunSet = (name) => matrix.groups[name]?.files ?? [];

test('R1: the committed CC proof-hosting manifest validates against the live matrix export and CI wiring', () => {
  const result = validateProofHosting({ manifest: CC_PROOF_HOSTING_MANIFEST, matrix, ciInvokedGroups, fileExists });
  assert.deepEqual(result.violations, [],
    `CC proof-hosting violations:\n${result.violations.map((v) => `  [${v.code}] ${v.file ?? ''}: ${v.detail}`).join('\n')}`);
  // EK-8 cutover (2026-08-26): the four old-runtime proof rows died with
  // their suites; the registry row itself is the sole blocking row and the
  // pending set stays at its terminal zero.
  assert.equal(result.summary.blocking, 1);
  assert.equal(result.summary.pending, 0);
});

test('R2: the EK-8 invariant successors of the old CC proofs are hosted in CI-invoked groups', () => {
  // The deleted CC proofs (GAP-8 terminal accounting/ledger, GAP-2
  // terminal projection/settlement) asserted old-runtime invariants. Their
  // post-cutover equivalents live in the kernel suites and the corpus: the
  // material chain (settlement-accounted terminal exits), the engine
  // scenario comparison (expected-world proofs) and the 20-project corpus
  // (terminal proofs over public commands). Same bite, new surface.
  for (const g of ['workflow-kernel', 'project-corpus']) {
    assert.ok(ciInvokedGroups.includes(g), `ci.yml must invoke --group ${g}`);
  }
  for (const f of [SUCCESSOR_KERNEL_MATERIAL_CHAIN, SUCCESSOR_KERNEL_ENGINE, SUCCESSOR_CORPUS]) {
    assert.ok(groupRunSet('workflow-kernel').includes(f) || groupRunSet('project-corpus').includes(f),
      `${f} must stay in a blocking CI-invoked run-set (the CC invariant successor)`);
    assert.ok(fileExists(f), `${f} must exist on disk`);
  }
});

test('R3: the post-cutover manifest carries ONLY the registry row - no phantom rows over deleted trees', () => {
  for (const row of CC_PROOF_HOSTING_MANIFEST.rows) {
    assert.ok(fileExists(row.file), `manifest row names a deleted file: ${row.file}`);
    const g = matrix.groups[row.group];
    assert.ok(g, `matrix group '${row.group}' must exist`);
    assert.ok(ciInvokedGroups.includes(row.group), `ci.yml must invoke '${row.group}'`);
  }
  assert.equal(CC_PROOF_HOSTING_MANIFEST.rows.filter((r) => r.type === 'blocking').length, 1,
    'the registry row is the sole blocking row after the EK-8 purge');
});

test('R4: the registry group run-set equals the manifest blocking rows pinned to it (exact bijection, no widening)', () => {
  const runSet = groupRunSet(CC_PROOF_HOSTING_MANIFEST.registryGroup);
  assert.deepEqual(runSet, [REGISTRY_TEST]);
  const pinned = CC_PROOF_HOSTING_MANIFEST.rows
    .filter((r) => r.type === 'blocking' && r.group === CC_PROOF_HOSTING_MANIFEST.registryGroup)
    .map((r) => r.file);
  assert.deepEqual([...runSet].sort(), [...pinned].sort());
  assert.ok(ciInvokedGroups.includes(CC_PROOF_HOSTING_MANIFEST.registryGroup),
    'ci.yml must invoke the cc-proof-registry group');
});

test('R5: tests/factory-proof/proof-claims.mjs is untouched by this registry (ADR-092 Option C preserves the K1-D bijection byte-for-byte)', () => {
  // The K1-D proof-mode registry governs ONLY the factory-proof group; the
  // CC hosting manifest governs the CC critical proofs. A CC row may never
  // leak into PROOF_CLAIMS and a factory-proof group file is never a CC
  // manifest row — two authorities, two surfaces.
  for (const row of CC_PROOF_HOSTING_MANIFEST.rows) {
    assert.ok(!row.file.startsWith('tests/factory-proof/'),
      `CC manifest row must not sit on the K1-D proof-claims surface: ${row.file}`);
    assert.deepEqual(groupRunSet('factory-proof'), [],
      'the factory-proof group died with the EK-8 purge; it must not reappear');
  }
});

// --- fail-closed mutation battery (pure, in-memory) --------------------------

const allFilesExist = () => true;
const clone = (x) => JSON.parse(JSON.stringify(x));

function validate(mutatedManifest, mutatedMatrix = matrix, mutatedCi = ciInvokedGroups, exists = allFilesExist) {
  return validateProofHosting({
    manifest: mutatedManifest,
    matrix: mutatedMatrix,
    ciInvokedGroups: mutatedCi,
    fileExists: exists,
  });
}

function expectCode(result, code, file = undefined) {
  const hit = result.violations.find((v) => v.code === code && (file === undefined || v.file === file));
  assert.ok(hit, `expected violation [${code}${file ? ` on ${file}` : ''}], got:\n${
    result.violations.map((v) => `  [${v.code}] ${v.file ?? ''}: ${v.detail}`).join('\n')}`);
  return hit;
}

test('m1: a proof file deleted from disk fails closed (ROW_FILE_MISSING)', () => {
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrix, ciInvokedGroups,
    (f) => f !== REGISTRY_TEST);
  expectCode(result, 'ROW_FILE_MISSING', REGISTRY_TEST);
});

test('m2: a duplicated row fails closed (ROW_FILE_DUPLICATE)', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.rows.push(clone(m.rows[0]));
  expectCode(validate(m), 'ROW_FILE_DUPLICATE');
});

test('m3: renaming the pinned group fails closed (GROUP_UNKNOWN) — and the renamed-away CI step is caught too', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.rows = m.rows.map((r) => (r.group === 'cc-proof-registry' ? { ...r, group: 'cc-proof-registry-renamed' } : r));
  const result = validate(m);
  expectCode(result, 'GROUP_UNKNOWN', REGISTRY_TEST);
  // CI side of the rename: ci.yml still invokes the old name only.
  const matrixRenamed = clone(matrix);
  matrixRenamed.groups['cc-proof-registry-renamed'] = matrixRenamed.groups['cc-proof-registry'];
  delete matrixRenamed.groups['cc-proof-registry'];
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixRenamed, ciInvokedGroups), 'GROUP_UNKNOWN', REGISTRY_TEST);
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixRenamed, [...ciInvokedGroups, 'cc-proof-registry']), 'CI_INVOKES_UNKNOWN_GROUP');
});

test('m4: dropping the proof from its group run-set fails closed (PROOF_NOT_HOSTED)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['cc-proof-registry'].files =
    matrixMutated.groups['cc-proof-registry'].files.filter((f) => f !== REGISTRY_TEST);
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'PROOF_NOT_HOSTED', REGISTRY_TEST);
});

test('m5: quarantining a blocking proof fails closed (PROOF_QUARANTINED — reclassification is not an honest drop)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['cc-proof-registry'].files =
    matrixMutated.groups['cc-proof-registry'].files.filter((f) => f !== REGISTRY_TEST);
  matrixMutated.quarantine.push({
    path: REGISTRY_TEST, kind: 'FLAKY', reason: 'dishonest reclassification to drop the registry proof',
  });
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated);
  expectCode(result, 'PROOF_QUARANTINED', REGISTRY_TEST);
  expectCode(result, 'PROOF_NOT_HOSTED', REGISTRY_TEST);
});

test('m6: CI omitting the pinned group invocation fails closed (GROUP_NOT_INVOKED_BY_CI)', () => {
  const ci = ciInvokedGroups.filter((g) => g !== 'cc-proof-registry');
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrix, ci), 'GROUP_NOT_INVOKED_BY_CI', REGISTRY_TEST);
});

test('m7: typing a HOSTED proof as pending fails closed (PENDING_ABSORBS_HOSTED — pending cannot absorb a blocking proof)', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  const row = m.rows.find((r) => r.file === REGISTRY_TEST);
  row.type = 'pending';
  delete row.group;
  row.tracker = 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md fake-tracker row';
  row.reason = 'reclassified pending to dodge the hosting proof — must stay red';
  expectCode(validate(m), 'PENDING_ABSORBS_HOSTED', REGISTRY_TEST);
});

test('m7b: a pending row whose file lands in a blocking run-set goes stale and fails closed', () => {
  // Post-conversion the manifest carries zero real pending rows, so this
  // direction is proven with a SYNTHETIC pending row (same mutation class,
  // same validator code path): the blocking ex-orphan row is flipped to
  // pending while its file stays hosted in conveyor-app.
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  const row = m.rows.find((r) => r.file === REGISTRY_TEST);
  row.type = 'pending';
  row.tracker = 'synthetic stale pending — must stay red';
  row.reason = 'reclassified pending to dodge the hosting proof — must stay red';
  expectCode(validate(m), 'PENDING_ABSORBS_HOSTED', REGISTRY_TEST);
});

test('m8: pending rows without tracker/reason fail closed (PENDING_TRACKER_MISSING / PENDING_REASON_MISSING)', () => {
  // Synthetic isolated-pending base (post-conversion no real pending row
  // exists): the ex-orphan row flips to pending AND its file is dropped
  // from the cloned matrix run-set, so ONLY the tracker/reason codes fire.
  const pendingIsolated = () => {
    const m = clone(CC_PROOF_HOSTING_MANIFEST);
    const row = m.rows.find((r) => r.file === REGISTRY_TEST);
    row.type = 'pending';
    row.reason = 'synthetic pending for the tracker/reason isolation';
    const matrixIsolated = clone(matrix);
    const g = matrixIsolated.groups[row.group];
    matrixIsolated.groups[row.group] = { ...g, files: g.files.filter((f) => f !== REGISTRY_TEST) };
    delete row.group;
    return { m, matrixIsolated };
  };

  const mNoTracker = pendingIsolated();
  mNoTracker.m.rows.find((r) => r.file === REGISTRY_TEST).tracker = '';
  expectCode(validate(mNoTracker.m, mNoTracker.matrixIsolated), 'PENDING_TRACKER_MISSING', REGISTRY_TEST);

  const mNoReason = pendingIsolated();
  const b = mNoReason.m.rows.find((r) => r.file === REGISTRY_TEST);
  b.tracker = 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md fake-tracker row';
  b.reason = '';
  expectCode(validate(mNoReason.m, mNoReason.matrixIsolated), 'PENDING_REASON_MISSING', REGISTRY_TEST);

  const mBadTrackerPath = pendingIsolated();
  const c = mBadTrackerPath.m.rows.find((r) => r.file === REGISTRY_TEST);
  c.tracker = 'docs/plans/DOES-NOT-EXIST.md tracker path must exist';
  const trackerExists = (f) => f !== 'docs/plans/DOES-NOT-EXIST.md';
  expectCode(validate(mBadTrackerPath.m, mBadTrackerPath.matrixIsolated, ciInvokedGroups, trackerExists), 'PENDING_TRACKER_PATH_MISSING', REGISTRY_TEST);
});

test('m9: an unregistered file joining the registry group fails closed (REGISTRY_GROUP_WIDENED)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['cc-proof-registry'].files.push('tests/infrastructure/ghost-cc-proof.test.mjs');
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'REGISTRY_GROUP_WIDENED', 'tests/infrastructure/ghost-cc-proof.test.mjs');
});

test('m10: ci.yml invoking a group the matrix no longer defines fails closed (CI_INVOKES_UNKNOWN_GROUP)', () => {
  const matrixMutated = clone(matrix);
  // EK-8 repin: factory-model died with the purge; kept-tooling is a live
  // CI-invoked group the manifest carries no row for - deleting it from the
  // matrix export must still be caught (ci.yml invokes a ghost group).
  delete matrixMutated.groups['kept-tooling'];
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'CI_INVOKES_UNKNOWN_GROUP');
});

test('m11: a manifest row pinned to the registry group but absent from its run-set fails closed (REGISTRY_GROUP_ROW_NOT_HOSTED)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['cc-proof-registry'].files = [];
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated);
  expectCode(result, 'REGISTRY_GROUP_ROW_NOT_HOSTED', REGISTRY_TEST);
});

test('m12: emptying or malformed manifest rows fail closed (MANIFEST_MALFORMED)', () => {
  const emptied = clone(CC_PROOF_HOSTING_MANIFEST);
  emptied.rows = [];
  assert.equal(validate(emptied).ok, false);
  assert.equal(validate({ ...emptied, rows: 'not-an-array' }).violations[0].code, 'MANIFEST_MALFORMED');
});

test('m13: a row with an invalid type or missing proof statement fails closed', () => {
  const mType = clone(CC_PROOF_HOSTING_MANIFEST);
  mType.rows[0].type = 'maybe';
  expectCode(validate(mType), 'ROW_TYPE_INVALID');

  const mProof = clone(CC_PROOF_HOSTING_MANIFEST);
  mProof.rows[0].proof = '';
  expectCode(validate(mProof), 'ROW_PROOF_MISSING');
});

// m14-m18 — CC-U1 repair (2026-08-23): the registry-group bootstrap axes.
// The pure validator previously failed OPEN on a mutated manifest.registryGroup:
// an unknown group skipped the bijection block entirely and returned ok=true.

test('m14: mutating manifest.registryGroup to an unknown/typo group fails closed (REGISTRY_GROUP_UNKNOWN)', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.registryGroup = `${CC_PROOF_HOSTING_MANIFEST.registryGroup}-typo`;
  const result = validate(m);
  expectCode(result, 'REGISTRY_GROUP_UNKNOWN');
  assert.equal(result.ok, false, 'a mutated (typo) registryGroup may never validate ok=true');
});

test('m15: registryGroup defined in the matrix but not CI-invoked fails closed (REGISTRY_GROUP_NOT_INVOKED_BY_CI)', () => {
  const rg = CC_PROOF_HOSTING_MANIFEST.registryGroup;
  const ci = ciInvokedGroups.filter((g) => g !== rg);
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrix, ci);
  expectCode(result, 'REGISTRY_GROUP_NOT_INVOKED_BY_CI');
  // The registry's own test row pins the same group — the row-level code
  // fires too (both layers of the same omission, by design).
  expectCode(result, 'GROUP_NOT_INVOKED_BY_CI', REGISTRY_TEST);
});

test('m16: a registryGroup anchored by no blocking manifest row fails closed (REGISTRY_GROUP_UNANCHORED)', () => {
  // EK-8 repin: emptying rows is MANIFEST_MALFORMED (the surface may never
  // be silently emptied), so the unanchoring is proven by demoting the sole
  // registry row to a well-formed pending row isolated from its run-set.
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  const matrixIsolated = clone(matrix);
  matrixIsolated.groups[m.registryGroup] = { ...matrixIsolated.groups[m.registryGroup], files: [] };
  const row = m.rows.find((r) => r.file === REGISTRY_TEST);
  row.type = 'pending';
  delete row.group;
  row.tracker = 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md fake-tracker row';
  row.reason = 'synthetic unanchoring - must stay red';
  const result = validate(m, matrixIsolated);
  expectCode(result, 'REGISTRY_GROUP_UNANCHORED');
});

test('m17: coordinated removal (registry group deleted from the matrix AND its CI step deleted) still fails closed (REGISTRY_GROUP_UNKNOWN)', () => {
  const rg = CC_PROOF_HOSTING_MANIFEST.registryGroup;
  const matrixMutated = clone(matrix);
  delete matrixMutated.groups[rg];
  const ci = ciInvokedGroups.filter((g) => g !== rg);
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated, ci);
  expectCode(result, 'REGISTRY_GROUP_UNKNOWN');
  expectCode(result, 'GROUP_UNKNOWN', REGISTRY_TEST);
  // This is the validator layer only. When this group is really deleted the
  // registry's own test is orphaned with it — the INDEPENDENT layer that
  // stays red is the matrix-coverage G5 cross-guard (acceptance-matrix-
  // coverage.test.mjs), which derives registryGroup from this manifest.
});

test('m18: a prefix-colliding group name cannot satisfy exact invocation (G4d/G5 exactness, both directions)', () => {
  const rg = CC_PROOF_HOSTING_MANIFEST.registryGroup;
  const shadow = `${rg}-shadow`;
  // Control: the OLD substring probe really would have passed —
  // '--group cc-proof-registry-shadow' contains '--group cc-proof-registry'.
  const ciText = `run: node tools/run-acceptance-matrix.mjs --group ${shadow}`;
  assert.ok(
    ciText.includes(`--group ${rg}`),
    'control failed: the old substring probe no longer exhibits the collision',
  );
  // Exact extraction yields ONLY the shadow token — the shared prefix is not
  // an invocation of the real group (same extractor/semantics as coverage G4d/G5).
  assert.deepEqual(extractInvokedGroups(ciText), [shadow]);
  assert.ok(!new Set(extractInvokedGroups(ciText)).has(rg));

  // And the validator stays red: shadow defined+invoked, real group not invoked.
  const matrixMutated = clone(matrix);
  matrixMutated.groups[shadow] = { files: [], concurrency: null, note: 'prefix-collision counterexample group' };
  const ci = [...ciInvokedGroups.filter((g) => g !== rg), shadow];
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated, ci);
  expectCode(result, 'REGISTRY_GROUP_NOT_INVOKED_BY_CI');
  expectCode(result, 'GROUP_NOT_INVOKED_BY_CI', REGISTRY_TEST);
});

test('M-RED control: with every mutation reverted, the same validation is green (no over-fitting)', () => {
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrix, ciInvokedGroups, fileExists);
  assert.equal(result.ok, true);
});

test('extractInvokedGroups parses --group flags (both spaced and =-joined) and nothing else', () => {
  assert.deepEqual(
    extractInvokedGroups('run: node tools/run-acceptance-matrix.mjs --group architecture && node tools/run-acceptance-matrix.mjs --group=factory-model'),
    ['architecture', 'factory-model'],
  );
  assert.deepEqual(extractInvokedGroups('no invocations here'), []);
});
