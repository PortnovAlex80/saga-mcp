// CI-02 — acceptance-matrix coverage & no-hidden-failure guard.
//
// Proves the deterministic Factory acceptance matrix is complete and trustworthy:
//   G1  every quarantined file is a real file on disk that is DELIBERATELY
//       skipped (never silently dropped) — and none leaks into a blocking run-set;
//   G2  every required deterministic Factory suite IS in a blocking run-set
//       (factory-model, transition-obligation, local-runnability, the ADR-053
//       cutover gates, the C5 adversarial matrix, the LR-07 readiness binding);
//   G3  the specific known flaky / pre-existing-red files are quarantined;
//   G4  ci.yml has no hidden failures on blocking steps (no `|| true`, no
//       continue-on-error), every matrix group is invoked by CI, and no CI
//       step invokes a group the matrix no longer defines. Both G4d
//       directions use EXACT membership in the comment-stripped extracted
//       invocation set — a group name that merely shares a prefix with an
//       invoked name does not count (CC-U1 repair 2026-08-23).
//   G5  ADR-092 cross-guard: the CC proof-hosting manifest's declared
//       registryGroup must exist in the matrix export and be exactly invoked
//       by CI. This test is hosted in the INDEPENDENT matrix-coverage group
//       (not cc-proof-registry), so a coordinated removal of the registry
//       group AND its CI step AND the registry's own test still leaves THIS
//       check red — the registry cannot bootstrap itself out of existence.
//       The group name is derived from the manifest, never hardcoded.
//
// This is the "small workflow-validation test" required by CI-02: it makes the
// "no required deterministic suite is silently omitted" exit rule machine-checked.
//
// ADR-092: facts come from the MACHINE-READABLE matrix export
// (run-acceptance-matrix.mjs --list-json) — the human --list text is never
// parsed — and the required CI group set is DERIVED from that export (no
// hardcoded group list can lag a rename or a new group).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractInvokedGroups } from '../../tools/cc-proof-hosting-registry.mjs';
import { CC_PROOF_HOSTING_MANIFEST } from './cc-proof-hosting-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(root, 'tools', 'run-acceptance-matrix.mjs');
const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');

const list = spawnSync(process.execPath, [runner, '--list-json'], { cwd: root, encoding: 'utf8' });
assert.equal(list.status, 0, `runner --list-json must exit 0 (got ${list.status})\n${list.stderr}`);
let matrix;
try {
  matrix = JSON.parse(list.stdout);
} catch (error) {
  assert.fail(`--list-json must emit parseable JSON (ADR-092 machine surface): ${error.message}`);
}
assert.ok(matrix.groups && typeof matrix.groups === 'object', 'matrix export must carry a groups object');
assert.ok(Array.isArray(matrix.quarantine), 'matrix export must carry a quarantine array');

const runFiles = Object.values(matrix.groups).flatMap((g) => g.files);
const quarantine = matrix.quarantine;

const runSet = new Set(runFiles);
const qSet = new Set(quarantine.map(q => q.path));

// G1 — quarantined files are real, deliberate skips; no leak into run-sets.
test('G1a: every quarantined file exists on disk', () => {
  // EK-8 cutover (2026-08-26): the quarantine table shrank to the one
  // KEEP-tree pre-existing-red file - every other entry's file was deleted
  // by the purge, and a quarantine row for an absent file is a phantom skip.
  assert.ok(quarantine.length >= 1, 'expected at least 1 quarantined file');
  for (const q of quarantine) {
    assert.ok(
      existsSync(path.join(root, q.path)),
      `quarantined file missing on disk: ${q.path}`,
    );
  }
});

test('G1b: no quarantined file leaks into a blocking run-set', () => {
  for (const q of qSet) {
    assert.ok(!runSet.has(q), `quarantined file leaked into a run-set: ${q}`);
  }
});

test('G1c: every quarantine entry has a non-empty kind and reason', () => {
  for (const q of quarantine) {
    assert.match(q.kind, /^(FLAKY|PRE-EXISTING-RED)$/, `bad kind for ${q.path}`);
    assert.ok(q.reason.length > 10, `empty reason for ${q.path}`);
  }
});

// G2 — required deterministic suites are covered (blocking), re-pinned to
// the post-cutover matrix by WP-12 (the old guards over deleted suites died
// with the purge; each carries its successor note).
test('G2a: the kernel model suites are covered (factory-model successor)', () => {
  assert.ok(
    runFiles.some(f => f.startsWith('tests/workflow-kernel/model/')),
    'the kernel model suites (successor of the deleted factory-model group) missing',
  );
});

test('G2b: the obligation/fencing suites are covered (transition-obligation successor)', () => {
  const obligationSuites = runFiles.filter(f => /workflow-kernel\/(application|persistence)\/.+\.test\.mjs$/.test(f));
  assert.ok(obligationSuites.length >= 5, `expected >=5 kernel application/persistence suites (the CAS lease/fencing successors), got ${obligationSuites.length}`);
});

test('G2d: the ADR-053 material-authority proofs are covered (post-cutover successors)', () => {
  // EK-8 (WP-12): the four adr-053-*.test.mjs architecture ratchets died
  // with the old runtime they scanned. The ADR-053 material authority is
  // proven by the kernel suites: the material chain (sealProductionRevision
  // -> CandidateSet -> gates -> CellFinalAcceptance) and the structure
  // ratchet that froze the post-cutover tree shape.
  const required = [
    'tests/workflow-kernel/development/material-chain.test.mjs',
    'tests/architecture/ek8-cutover-structure.test.mjs',
  ];
  for (const f of required) {
    assert.ok(runSet.has(f), `${f} must be blocking (the ADR-053 successor surface)`);
  }
});

test('G2k: the ADR-095 program is closed by the EK-8 cutover proof surface (Phase-2C successor)', () => {
  // EK-8 (WP-12): the adr-095-ratchet-suite died with the Discovery v2
  // runtime it ratcheted (its eight ratchets pinned the REMOVAL program that
  // this cutover completed). The closure proof surface is the deletion
  // manifest guard + the legacy-zero laws + the structure ratchet.
  const required = [
    'tests/infrastructure/deletion-manifest-guard.test.mjs',
    'tests/infrastructure/ek-removal-guard.test.mjs',
    'tests/architecture/ek8-cutover-structure.test.mjs',
  ];
  for (const f of required) {
    assert.ok(runSet.has(f), `${f} must be blocking (the ADR-095 program closure proof)`);
  }
});

test('G2o: every workshop suite is hosted (desk-zone successor ratchet)', () => {
  // EK-8 repin: the desk zones died with the old tests; the closed ratchet
  // now walks the converted workshop suites of the kernel.
  const zones = [
    'tests/workflow-kernel/workshops',
    'tests/workflow-kernel/development',
    'tests/workflow-kernel/composition',
  ];
  const orphans = [];
  for (const zone of zones) {
    const dir = path.join(root, zone);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const rel = `${zone}/${name}`;
      if (!runSet.has(rel) && !qSet.has(rel)) orphans.push(rel);
    }
  }
  assert.deepEqual(orphans, [],
    'kernel-zone orphans found — every workshop/vertical/composition suite must be hosted by the workflow-kernel group glob');
});

// G2l — R1 omnibus closure ratchet (2026-08-24), carried through the EK-8
// purge: NO test file in the repository may be an orphan.
const LIVE_SANDBOX_ALLOWLIST = new Set([]);
test('G2p: the repository has ZERO orphan test files (R1 omnibus ratchet)', () => {
  const tracked = spawnSync('git', ['ls-files', '*.test.mjs'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, 'git ls-files must succeed');
  const ciText = readFileSync(ciPath, 'utf8');
  const ciInvoked = new Set(
    [...ciText.matchAll(/(?:node(?:\s+--test)?\s+)((?:tests|tools)\/[A-Za-z0-9_\/.-]+\.mjs)/g)].map((m) => m[1]),
  );
  const orphans = [];
  for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
    if (runSet.has(file) || qSet.has(file) || LIVE_SANDBOX_ALLOWLIST.has(file) || ciInvoked.has(file)) continue;
    orphans.push(file);
  }
  assert.deepEqual(orphans, [],
    'orphan test files found — every suite must be hosted in a blocking group, quarantined '
    + 'with a reason, or (live-sandbox class) added to LIVE_SANDBOX_ALLOWLIST in the same '
    + 'commit it lands');
});

// G3 — the known pre-existing-red file stays quarantined (the FLAKY classes
// died with their files at the EK-8 purge).
test('G3: the pre-existing-red diagnostics file is quarantined', () => {
  for (const f of ['tests/architecture/submission-validator-diagnostics.test.mjs']) {
    assert.ok(qSet.has(f), `required quarantine missing: ${f}`);
  }
});

test('G3b: flaky quarantine entries reference a stabilization plan', () => {
  for (const q of quarantine) {
    if (q.kind === 'FLAKY') {
      assert.match(
        q.reason,
        /W9|stabilize|stabilization|cold-start|real (command|process) execution/i,
        `flaky quarantine must note a stabilization reason: ${q.path}`,
      );
    }
  }
});

// G4 — ci.yml has no hidden failures on blocking steps.
// Comments are stripped first so that documenting a forbidden pattern (e.g. an
// inline "no `|| true`" note) is not mistaken for the pattern itself.
const ciRaw = readFileSync(ciPath, 'utf8');
const ci = ciRaw.split(/\r?\n/).map(line => line.replace(/(^|\s)#.*$/, '$1')).join('\n');

// The comment-stripped EXTRACTED invocation set: the only form in which CI
// group invocations may be compared (CC-U1 repair 2026-08-23).
const ciInvokedList = [...new Set(extractInvokedGroups(ci))];
const ciInvokedExact = new Set(ciInvokedList);

test('G4a: ci.yml has no `|| true` hiding a blocking step failure', () => {
  assert.ok(!/\|\|\s*true/.test(ci), 'ci.yml contains a hidden `|| true` failure');
});

test('G4b: ci.yml has no continue-on-error on any step', () => {
  assert.ok(!/continue-on-error/.test(ci), 'ci.yml contains continue-on-error');
});

test('G4c: ci.yml does not run the blanket `npm test` step', () => {
  assert.ok(!/^\s*run:\s*npm\s+test\s*$/m.test(ci), 'ci.yml still runs blanket `npm test`');
});

test('G4d: ci.yml invokes EVERY acceptance-matrix group and no unknown group (derived from the machine-readable export, EXACT invocation membership)', () => {
  const matrixGroups = Object.keys(matrix.groups).sort();
  assert.ok(matrixGroups.length >= 7, `expected at least 7 matrix groups, got ${matrixGroups.length}`);
  for (const g of matrixGroups) {
    assert.ok(
      ciInvokedExact.has(g),
      `ci.yml missing blocking step for matrix group '${g}' (exact '--group ${g}' invocation required — a longer name sharing this prefix does not count)`,
    );
  }
  assert.ok(ciInvokedList.length >= 7, `expected ci.yml to invoke at least 7 groups, got ${ciInvokedList.length}`);
  for (const g of ciInvokedList) {
    assert.ok(
      Object.hasOwn(matrix.groups, g),
      `ci.yml invokes '--group ${g}' but the acceptance matrix defines no such group (stale wiring)`,
    );
  }
});

// G5 — ADR-092 / CC-U1 coordinated-removal cross-guard (independently hosted).
test('G5: the manifest-declared CC proof-registry group exists in the matrix export and is exactly invoked by CI (ADR-092 coordinated-removal cross-guard)', () => {
  const registryGroup = CC_PROOF_HOSTING_MANIFEST.registryGroup;
  assert.ok(
    typeof registryGroup === 'string' && registryGroup.trim().length > 0,
    'the CC proof-hosting manifest must declare a non-empty registryGroup',
  );
  assert.ok(
    Object.hasOwn(matrix.groups, registryGroup),
    `manifest.registryGroup '${registryGroup}' is missing from the matrix export — coordinated removal of the registry group and its CI step must not leave matrix-coverage green`,
  );
  assert.ok(
    ciInvokedExact.has(registryGroup),
    `ci.yml does not invoke '--group ${registryGroup}' exactly (real CI invocation set: [${ciInvokedList.join(', ')}]) — coordinated removal of the registry group and its CI step must not leave matrix-coverage green`,
  );
});

test('G4e: the retired dispatcher-race/legacy steps are gone (EK-8 purge)', () => {
  // The dispatcher-race harness died with the deleted scheduling authority;
  // ci.yml must not invoke it (or any deleted suite) anymore.
  assert.ok(!/dispatcher-race/.test(ci), 'ci.yml still references the deleted dispatcher-race harness');
  for (const dead of ['factory-model', 'readiness-fencing', 'factory-contract', 'process-modules',
    'discovery-live-v2', 'desk-coverage', 'e2e-deterministic', 'k4-fault-edges',
    'conveyor-app', 'conveyor-infra', 'conveyor-periphery', 'factory-proof']) {
    assert.ok(!ciInvokedExact.has(dead), `ci.yml invokes the deleted legacy group '${dead}'`);
  }
});

test('G4f: ci.yml runs the cgad-spec-lint unit test and the evidence validator', () => {
  assert.ok(ci.includes('tools/cgad-spec-lint.test.mjs'), 'cgad-spec-lint test missing');
  assert.ok(ci.includes('validate-completion-evidence.mjs'), 'evidence validator missing');
});

test('G4g: ci.yml hosts the legacy-zero laws BLOCKING in --strict (the WP-12 flip)', () => {
  // The WP-12 cutover tripwire: CI runs the five legacy-zero laws in
  // --strict (any surviving or resurrected legacy reference is a red build).
  assert.match(ci, /node tools\/ek-legacy-zero\.mjs --strict/, 'ci.yml must run the legacy-zero laws in --strict');
  assert.doesNotMatch(ciRaw, /node tools\/ek-legacy-zero\.mjs --check\s*$/m, 'ci.yml must not run legacy-zero in pre-cutover --check mode');
});
