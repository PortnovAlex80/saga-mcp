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

const GAP8_ACCOUNTING = 'tests/modules/development/development-terminal-exit-accounting.test.mjs';
const GAP8_LEDGER = 'tests/modules/development/verification-ledger.test.mjs';
const GAP2_JOURNAL = 'tests/process-modules/run-terminal-journal-projection.test.mjs';
const GAP2_ORPHAN_SETTLEMENT = 'tests/app/launch-terminal-settlement.test.mjs';
const GAP2_ORPHAN_TRACKER = 'tests/tracker-view/engine-status-launch-projection.test.mjs';
const REGISTRY_TEST = 'tests/infrastructure/cc-proof-hosting.test.mjs';

// --- real-repo facts --------------------------------------------------------

const facts = loadRepositoryFacts();
const { matrix, ciInvokedGroups, fileExists } = facts;

const groupRunSet = (name) => matrix.groups[name]?.files ?? [];

test('R1: the committed CC proof-hosting manifest validates against the live matrix export and CI wiring', () => {
  const result = validateProofHosting({ manifest: CC_PROOF_HOSTING_MANIFEST, matrix, ciInvokedGroups, fileExists });
  assert.deepEqual(result.violations, [],
    `CC proof-hosting violations:\n${result.violations.map((v) => `  [${v.code}] ${v.file ?? ''}: ${v.detail}`).join('\n')}`);
  assert.equal(result.summary.blocking, 4);
  assert.equal(result.summary.pending, 2);
});

test('R2: both GAP-8 proofs and the hosted GAP-2 projection are pinned blocking in the CI-invoked process-modules group (G2g surface preserved)', () => {
  assert.ok(ciInvokedGroups.includes('process-modules'), 'ci.yml must invoke --group process-modules');
  for (const f of [GAP8_ACCOUNTING, GAP8_LEDGER, GAP2_JOURNAL]) {
    assert.ok(groupRunSet('process-modules').includes(f), `${f} must stay in the process-modules run-set`);
  }
});

test('R3: the two GAP-2 orphan terminal-projection proofs are HONESTLY pending — on disk, green-critical, and hosted nowhere', () => {
  for (const f of [GAP2_ORPHAN_SETTLEMENT, GAP2_ORPHAN_TRACKER]) {
    const row = CC_PROOF_HOSTING_MANIFEST.rows.find((r) => r.file === f);
    assert.ok(row, `${f} must have a manifest row`);
    assert.equal(row.type, 'pending');
    assert.ok(row.tracker.trim().length > 0, 'pending row must carry a tracker');
    assert.ok(row.reason.trim().length > 0, 'pending row must carry a reason');
    assert.ok(fileExists(f), `${f} must exist on disk`);
    for (const [gName, g] of Object.entries(matrix.groups)) {
      assert.ok(!g.files.includes(f), `${f} must not appear hosted in group '${gName}' while typed pending`);
    }
  }
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
    assert.ok(!groupRunSet('factory-proof').includes(row.file),
      `CC manifest row must not be hosted in the factory-proof group: ${row.file}`);
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
    (f) => f !== GAP8_ACCOUNTING);
  expectCode(result, 'ROW_FILE_MISSING', GAP8_ACCOUNTING);
});

test('m2: a duplicated row fails closed (ROW_FILE_DUPLICATE)', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.rows.push(clone(m.rows[0]));
  expectCode(validate(m), 'ROW_FILE_DUPLICATE');
});

test('m3: renaming the pinned group fails closed (GROUP_UNKNOWN) — and the renamed-away CI step is caught too', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.rows = m.rows.map((r) => (r.group === 'process-modules' ? { ...r, group: 'process-modules-renamed' } : r));
  const result = validate(m);
  expectCode(result, 'GROUP_UNKNOWN', GAP8_ACCOUNTING);
  // CI side of the rename: ci.yml still invokes the old name only.
  const matrixRenamed = clone(matrix);
  matrixRenamed.groups['process-modules-renamed'] = matrixRenamed.groups['process-modules'];
  delete matrixRenamed.groups['process-modules'];
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixRenamed, ciInvokedGroups), 'GROUP_UNKNOWN', GAP8_ACCOUNTING);
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixRenamed, [...ciInvokedGroups, 'process-modules']), 'CI_INVOKES_UNKNOWN_GROUP');
});

test('m4: dropping the proof from its group run-set fails closed (PROOF_NOT_HOSTED)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['process-modules'].files =
    matrixMutated.groups['process-modules'].files.filter((f) => f !== GAP8_ACCOUNTING);
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'PROOF_NOT_HOSTED', GAP8_ACCOUNTING);
});

test('m5: quarantining a blocking proof fails closed (PROOF_QUARANTINED — reclassification is not an honest drop)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['process-modules'].files =
    matrixMutated.groups['process-modules'].files.filter((f) => f !== GAP8_ACCOUNTING);
  matrixMutated.quarantine.push({
    path: GAP8_ACCOUNTING, kind: 'FLAKY', reason: 'dishonest reclassification to drop the CC-GAP-8 proof',
  });
  const result = validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated);
  expectCode(result, 'PROOF_QUARANTINED', GAP8_ACCOUNTING);
  expectCode(result, 'PROOF_NOT_HOSTED', GAP8_ACCOUNTING);
});

test('m6: CI omitting the pinned group invocation fails closed (GROUP_NOT_INVOKED_BY_CI)', () => {
  const ci = ciInvokedGroups.filter((g) => g !== 'process-modules');
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrix, ci), 'GROUP_NOT_INVOKED_BY_CI', GAP8_ACCOUNTING);
});

test('m7: typing a HOSTED proof as pending fails closed (PENDING_ABSORBS_HOSTED — pending cannot absorb a blocking proof)', () => {
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  const row = m.rows.find((r) => r.file === GAP8_ACCOUNTING);
  row.type = 'pending';
  delete row.group;
  row.tracker = 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md fake-tracker row';
  row.reason = 'reclassified pending to dodge the hosting proof — must stay red';
  expectCode(validate(m), 'PENDING_ABSORBS_HOSTED', GAP8_ACCOUNTING);
});

test('m7b: a pending row whose file later lands in a blocking run-set goes stale and fails closed', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups.architecture.files.push(GAP2_ORPHAN_SETTLEMENT);
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'PENDING_ABSORBS_HOSTED', GAP2_ORPHAN_SETTLEMENT);
});

test('m8: pending rows without tracker/reason fail closed (PENDING_TRACKER_MISSING / PENDING_REASON_MISSING)', () => {
  const mNoTracker = clone(CC_PROOF_HOSTING_MANIFEST);
  const a = mNoTracker.rows.find((r) => r.file === GAP2_ORPHAN_SETTLEMENT);
  a.tracker = '';
  expectCode(validate(mNoTracker), 'PENDING_TRACKER_MISSING', GAP2_ORPHAN_SETTLEMENT);

  const mNoReason = clone(CC_PROOF_HOSTING_MANIFEST);
  const b = mNoReason.rows.find((r) => r.file === GAP2_ORPHAN_SETTLEMENT);
  b.reason = '';
  expectCode(validate(mNoReason), 'PENDING_REASON_MISSING', GAP2_ORPHAN_SETTLEMENT);

  const mBadTrackerPath = clone(CC_PROOF_HOSTING_MANIFEST);
  const c = mBadTrackerPath.rows.find((r) => r.file === GAP2_ORPHAN_SETTLEMENT);
  c.tracker = 'docs/plans/DOES-NOT-EXIST.md tracker path must exist';
  const trackerExists = (f) => f !== 'docs/plans/DOES-NOT-EXIST.md';
  expectCode(validate(mBadTrackerPath, matrix, ciInvokedGroups, trackerExists), 'PENDING_TRACKER_PATH_MISSING', GAP2_ORPHAN_SETTLEMENT);
});

test('m9: an unregistered file joining the registry group fails closed (REGISTRY_GROUP_WIDENED)', () => {
  const matrixMutated = clone(matrix);
  matrixMutated.groups['cc-proof-registry'].files.push('tests/infrastructure/ghost-cc-proof.test.mjs');
  expectCode(validate(CC_PROOF_HOSTING_MANIFEST, matrixMutated), 'REGISTRY_GROUP_WIDENED', 'tests/infrastructure/ghost-cc-proof.test.mjs');
});

test('m10: ci.yml invoking a group the matrix no longer defines fails closed (CI_INVOKES_UNKNOWN_GROUP)', () => {
  const matrixMutated = clone(matrix);
  delete matrixMutated.groups['factory-model'];
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
  const m = clone(CC_PROOF_HOSTING_MANIFEST);
  m.rows = m.rows.filter((r) => !(r.type === 'blocking' && r.group === m.registryGroup));
  const result = validate(m);
  expectCode(result, 'REGISTRY_GROUP_UNANCHORED');
  // The now-unanchored group run-set also fails the widening direction —
  // the anchor requirement is what gives the bijection its fixed point.
  expectCode(result, 'REGISTRY_GROUP_WIDENED', REGISTRY_TEST);
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
