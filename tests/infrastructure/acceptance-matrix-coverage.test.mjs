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
//       step invokes a group the matrix no longer defines.
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
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractInvokedGroups } from '../../tools/cc-proof-hosting-registry.mjs';

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
  assert.ok(quarantine.length >= 6, 'expected at least 6 quarantined files');
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

// G2 — required deterministic suites are covered (blocking).
test('G2a: factory-model suite is covered', () => {
  assert.ok(runFiles.some(f => f.startsWith('tests/factory-model/')), 'factory-model missing');
});

test('G2b: transition-obligation fencing suites are covered', () => {
  const tos = runFiles.filter(f => /transition-obligation-.*\.test\.mjs$/.test(f));
  assert.ok(tos.length >= 8, `expected >=8 transition-obligation files, got ${tos.length}`);
});

test('G2c: local-runnability-check-provider is covered (run OR quarantined as flaky)', () => {
  const file = 'tests/infrastructure/local-runnability-check-provider.test.mjs';
  assert.ok(
    runSet.has(file) || qSet.has(file),
    'local-runnability-check-provider neither run nor quarantined',
  );
});

test('G2d: ADR-053 cutover gate architecture tests are covered', () => {
  const adr = runFiles.filter(f => /adr-053-.*\.test\.mjs$/.test(f));
  assert.ok(adr.length >= 3, `expected >=3 adr-053 files, got ${adr.length}`);
  assert.ok(
    runSet.has('tests/architecture/adr-053-cutover-gates.test.mjs'),
    'adr-053-cutover-gates must be blocking',
  );
});

test('G2e: C5 carry-forward adversarial matrix is covered', () => {
  assert.ok(
    runSet.has('tests/factory-contract/c5-carry-forward-adversarial-matrix.test.mjs'),
    'C5 adversarial matrix missing',
  );
});

test('G2f: LR-07 development-local-readiness binding is covered', () => {
  assert.ok(
    runSet.has('tests/process-modules/development-local-readiness-binding.test.mjs'),
    'LR-07 readiness binding missing',
  );
});

test('G2g: CC-GAP-8 terminal-exit accounting oracle is covered (proof hosting)', () => {
  // tests/modules/development/development-terminal-exit-accounting.test.mjs
  // is the structural CC-GAP-8 proof (settlement-accounted vs pre-ledger
  // terminal exits, with a RED/GREEN mutation oracle). It was committed but
  // orphaned — no GROUPS entry ran it, so CI never executed the proof.
  // Removing the exact file from the process-modules group must fail HERE,
  // not silently orphan the proof again. Asserted against runSet only (not
  // run-or-quarantined): reclassifying the proof as FLAKY/PRE-EXISTING-RED
  // is not an honest way to drop it.
  assert.ok(
    runSet.has('tests/modules/development/development-terminal-exit-accounting.test.mjs'),
    'development-terminal-exit-accounting must stay in a blocking run-set (CC-GAP-8 proof hosting)',
  );
});

// G3 — specific known flaky / pre-existing-red files are quarantined.
test('G3: known flaky / pre-existing-red files are quarantined', () => {
  const required = [
    'tests/factory-contract/golden-path.test.mjs',
    'tests/factory-contract/parallel-git-desk.test.mjs',
    'tests/process-modules/development-task-graph-diagnostics.test.mjs',
    'tests/architecture/submission-validator-diagnostics.test.mjs',
  ];
  for (const f of required) {
    assert.ok(qSet.has(f), `required quarantine missing: ${f}`);
  }
  // factory-temporal: the whole suite is quarantined (>= 5 files).
  const temporal = quarantine.filter(q => q.path.startsWith('tests/factory-temporal/'));
  assert.ok(temporal.length >= 5, `factory-temporal quarantine incomplete: ${temporal.length}`);
});

test('G3b: flaky quarantine entries reference either the W9 replacement or a stabilization plan', () => {
  for (const q of quarantine) {
    if (q.kind === 'FLAKY') {
      assert.match(
        q.reason,
        /W9|stabilize|stabilization|cold-start|real (command|process) execution/i,
        `flaky quarantine must note W9 replacement OR a stabilization reason: ${q.path}`,
      );
    }
  }
});

// G4 — ci.yml has no hidden failures on blocking steps.
// Comments are stripped first so that documenting a forbidden pattern (e.g. an
// inline "no `|| true`" note) is not mistaken for the pattern itself.
const ciRaw = readFileSync(ciPath, 'utf8');
const ci = ciRaw.split(/\r?\n/).map(line => line.replace(/(^|\s)#.*$/, '$1')).join('\n');

test('G4a: ci.yml has no `|| true` hiding a blocking step failure', () => {
  // A bare `|| true` in any run command silently swallows non-zero exits.
  assert.ok(!/\|\|\s*true/.test(ci), 'ci.yml contains a hidden `|| true` failure');
});

test('G4b: ci.yml has no continue-on-error on any step', () => {
  assert.ok(!/continue-on-error/.test(ci), 'ci.yml contains continue-on-error');
});

test('G4c: ci.yml does not run the blanket `npm test` step', () => {
  // The blanket step ran every *.test.mjs (flaky + red); it must be gone.
  assert.ok(!/^\s*run:\s*npm\s+test\s*$/m.test(ci), 'ci.yml still runs blanket `npm test`');
});

test('G4d: ci.yml invokes EVERY acceptance-matrix group and no unknown group (derived from the machine-readable export)', () => {
  // ADR-092: the required group set is DERIVED from the matrix export — a
  // hardcoded list here could silently lag a group rename, a removal, or a
  // newly added group (exactly how the CC-GAP-8 proof went orphaned).
  // Direction 1: every matrix group must have a blocking CI step.
  const matrixGroups = Object.keys(matrix.groups).sort();
  assert.ok(matrixGroups.length >= 7, `expected at least 7 matrix groups, got ${matrixGroups.length}`);
  for (const g of matrixGroups) {
    assert.ok(
      ci.includes(`--group ${g}`),
      `ci.yml missing blocking step for matrix group '${g}'`,
    );
  }
  // Direction 2: every `--group X` CI invokes must be a group the matrix
  // still defines — a stale step after a rename/removal is dead wiring.
  const invoked = [...new Set(extractInvokedGroups(ci))];
  assert.ok(invoked.length >= 7, `expected ci.yml to invoke at least 7 groups, got ${invoked.length}`);
  for (const g of invoked) {
    assert.ok(
      Object.hasOwn(matrix.groups, g),
      `ci.yml invokes '--group ${g}' but the acceptance matrix defines no such group (stale wiring)`,
    );
  }
});

test('G4e: dispatcher-race step excludes pre-existing-red worktree-isolation.mjs', () => {
  // worktree-isolation.mjs is a plain .mjs (not *.test.mjs); it is excluded from
  // the dispatcher-race step directly. ci.yml must reference the green scripts
  // and must NOT invoke worktree-isolation.mjs.
  assert.ok(/dispatcher-race/.test(ci), 'ci.yml missing a dispatcher-race step');
  assert.ok(
    !/worktree-isolation\.mjs/.test(ci),
    'ci.yml invokes quarantined worktree-isolation.mjs',
  );
});

test('G4f: ci.yml runs the cgad-spec-lint unit test and the evidence validator', () => {
  assert.ok(ci.includes('tools/cgad-spec-lint.test.mjs'), 'cgad-spec-lint test missing');
  assert.ok(ci.includes('validate-completion-evidence.mjs'), 'evidence validator missing');
});
