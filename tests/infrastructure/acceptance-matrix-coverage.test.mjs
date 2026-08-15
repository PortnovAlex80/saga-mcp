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
//       continue-on-error) and the dispatcher-race step excludes the
//       pre-existing-red worktree-isolation.mjs.
//
// This is the "small workflow-validation test" required by CI-02: it makes the
// "no required deterministic suite is silently omitted" exit rule machine-checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(root, 'tools', 'run-acceptance-matrix.mjs');
const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');

const list = spawnSync(process.execPath, [runner, '--list'], { cwd: root, encoding: 'utf8' });
assert.equal(list.status, 0, `runner --list must exit 0 (got ${list.status})\n${list.stderr}`);
const out = list.stdout;

const runFiles = [...out.matchAll(/^\s*\[run\] (\S+)/gm)].map(m => m[1]);
const quarantine = [...out.matchAll(/^\[quarantine\] (.+?) :: (.+?) :: (.+)$/gm)].map(
  m => ({ path: m[1], kind: m[2], reason: m[3] }),
);

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

// G3 — specific known flaky / pre-existing-red files are quarantined.
test('G3: known flaky / pre-existing-red files are quarantined', () => {
  const required = [
    'tests/factory-contract/golden-path.test.mjs',
    'tests/factory-contract/parallel-git-desk.test.mjs',
    'tests/process-modules/development-task-graph-diagnostics.test.mjs',
    'tests/architecture/worker-done-completion-authority.test.mjs',
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

test('G4d: ci.yml runs the acceptance-matrix runner for every required group', () => {
  const requiredGroups = ['architecture', 'factory-model', 'readiness-fencing', 'factory-contract', 'process-modules', 'matrix-coverage'];
  for (const g of requiredGroups) {
    assert.ok(
      ci.includes(`--group ${g}`),
      `ci.yml missing blocking step for group '${g}'`,
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
