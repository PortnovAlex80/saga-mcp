// tests/factory-e2e/perturbation-tapes.test.mjs
//
// ADR-096 Phase 7 / W4 — tests for the deterministic perturbation-seed tape
// selector (perturbation-tapes.mjs + perturbation-tapes.v1.json).
//
// Proves exactly what the qualification gate item 3 relies on:
//   - seed -> tape is DETERMINISTIC (same seed -> same tape; different seeds
//     -> different tapes while the table has >= 2 entries);
//   - absent/unparseable seed -> the default tape (current behavior);
//   - the run manifest RECORDS the tape names and stays in bijection with
//     the frozen table (one tape selects exactly one declared scenario);
//   - parseRunManifest is additive: manifests without tapeName still parse,
//     duplicate tapeName is rejected;
//   - the env contract resolves the way the drives consume it (in-lane,
//     out-of-lane, conflict);
//   - end-to-end: a seeded whole-factory drive (w9-02) still completes the
//     golden path unchanged while attributing itself to the resolved tape.
//
// The manifest/dist assertions import the BUILT run-manifest (dist/) — run
// `npm run build` first (the full suite and npm test both do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const {
  loadPerturbationTapeTable,
  parsePerturbationSeed,
  selectPerturbationTape,
  resolvePerturbationTape,
  resolveDriveTapeSelection,
  PERTURBATION_SEED_ENV,
} = await import('./perturbation-tapes.mjs');

const manifestMod = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { defaultW9RunManifest, parseRunManifest } = manifestMod;

const table = loadPerturbationTapeTable();

test('tape table: frozen v1 shape — contiguous indexes, unique names, single default at index 0, drives exist', () => {
  assert.equal(table.kind, 'saga-mcp.perturbation-tapes');
  assert.equal(table.version, 1);
  assert.ok(table.tapes.length >= 2, 'the table must expose >= 2 tapes for seeds to distinguish');
  table.tapes.forEach((tape, i) => {
    assert.equal(tape.index, i);
    assert.equal(typeof tape.name, 'string');
    assert.equal(typeof tape.drive, 'string');
    assert.equal(typeof tape.manifestId, 'string');
    assert.ok(tape.scenario === null || typeof tape.scenario === 'string');
    assert.ok(typeof tape.varies === 'string' && tape.varies.length > 0, `tape ${tape.name} must say what varies`);
  });
  const names = new Set(table.tapes.map(t => t.name));
  assert.equal(names.size, table.tapes.length, 'tape names unique');
  const defaults = table.tapes.filter(t => t.default === true);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].index, 0);
  assert.equal(defaults[0].name, 'golden-full-lifecycle');
});

test('seed -> tape determinism: same seed -> same tape, seed n === seed n + table-length', () => {
  for (const seed of [0, 1, 5, 13, 27]) {
    const a = selectPerturbationTape(table, seed);
    const b = selectPerturbationTape(table, seed);
    assert.equal(a.name, b.name, `seed ${seed} must resolve stably`);
    assert.equal(
      selectPerturbationTape(table, seed + table.tapes.length).name,
      a.name,
      `seed ${seed} and seed ${seed + table.tapes.length} are the same tape (mod table length)`,
    );
  }
});

test('seed -> tape variety: different seeds select different tapes across the table', () => {
  const names = new Set();
  for (let seed = 0; seed < table.tapes.length; seed++) names.add(selectPerturbationTape(table, seed).name);
  assert.equal(names.size, table.tapes.length, 'seeds 0..L-1 must cover every tape exactly once');
  assert.notEqual(
    selectPerturbationTape(table, 0).name,
    selectPerturbationTape(table, 1).name,
    'adjacent seeds must differ while the table has >= 2 tapes',
  );
});

test('absent/unparseable seed -> default tape (golden path, current behavior)', () => {
  for (const raw of [undefined, null, '', '   ', 'abc', '-3', '1.5', '0x2']) {
    assert.equal(parsePerturbationSeed(raw), null, `raw seed ${JSON.stringify(raw)} must parse as "no seed"`);
    assert.equal(resolvePerturbationTape({ [PERTURBATION_SEED_ENV]: raw }).tapeName, 'golden-full-lifecycle');
  }
  assert.equal(resolvePerturbationTape({}).seed, null);
  assert.equal(resolvePerturbationTape({ [PERTURBATION_SEED_ENV]: '4' }).seed, 4);
});

test('run manifest records the tape names: table <-> manifest bijection (one tape = one declared scenario)', () => {
  const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: 'tape-test' }));
  const byId = new Map(manifest.scenarios.map(s => [s.scenarioId, s]));
  for (const tape of table.tapes) {
    const scenario = byId.get(tape.manifestId);
    assert.ok(scenario, `manifest must declare scenario ${tape.manifestId} for tape '${tape.name}'`);
    assert.equal(scenario.tapeName, tape.name, `scenario ${tape.scenarioId} must carry tapeName '${tape.name}'`);
  }
  const manifestTapeNames = new Set(manifest.scenarios.map(s => s.tapeName));
  assert.equal(manifestTapeNames.size, manifest.scenarios.length, 'every declared scenario carries a distinct tapeName');
  assert.equal(manifestTapeNames.size, table.tapes.length, 'manifest tapes and table tapes are in bijection');
});

test('parseRunManifest is additive: tapeName optional (old manifests parse), duplicates rejected', () => {
  const manifest = parseRunManifest(defaultW9RunManifest({ startingSha: 'tape-test' }));
  const raw = JSON.parse(JSON.stringify(manifest));

  // Backwards-compatible: stripping the new optional field still parses.
  for (const s of raw.scenarios) delete s.tapeName;
  const stripped = parseRunManifest(raw);
  assert.ok(stripped.scenarios.every(s => s.tapeName === undefined));

  // Honest validation: two scenarios claiming one tape is a manifest error.
  const dup = JSON.parse(JSON.stringify(manifest));
  dup.scenarios[1].tapeName = dup.scenarios[0].tapeName;
  assert.throws(() => parseRunManifest(dup), /RUN_MANIFEST_INVALID: tapeName '.*' is duplicated/);

  // And a non-string tapeName is rejected where present.
  const junk = JSON.parse(JSON.stringify(manifest));
  junk.scenarios[0].tapeName = 42;
  assert.throws(() => parseRunManifest(junk), /RUN_MANIFEST_INVALID: scenario\.tapeName must be a non-empty string/);
});

test('resolveDriveTapeSelection: no seed keeps the legacy W9_SCENARIO behavior byte-for-byte', () => {
  const env0 = { W9_DRIVE_LABEL: 'x' };
  let sel = resolveDriveTapeSelection({ env: env0, driveFile: 'w9-03-adversarial-drive.mjs' });
  assert.equal(sel.scenario, null);
  assert.equal(sel.applied, false);
  assert.equal(sel.tapeName, 'golden-full-lifecycle'); // recorded, not applied

  sel = resolveDriveTapeSelection({
    env: { ...env0, W9_SCENARIO: 'reviewer-reject-repair' },
    driveFile: 'w9-03-adversarial-drive.mjs',
  });
  assert.equal(sel.scenario, 'reviewer-reject-repair');
  assert.equal(sel.applied, false);

  // A malformed seed must not disturb the explicit selection either.
  sel = resolveDriveTapeSelection({
    env: { ...env0, W9_SCENARIO: 'reviewer-reject-repair', [PERTURBATION_SEED_ENV]: 'nope' },
    driveFile: 'w9-03-adversarial-drive.mjs',
  });
  assert.equal(sel.scenario, 'reviewer-reject-repair');
  assert.equal(sel.seed, null);
});

test('resolveDriveTapeSelection: an in-lane seed selects that tape scenario; a conflicting W9_SCENARIO is a typed error', () => {
  // seed 1 -> tape 'cross-execution-durability' (drive w9-03-...), in-lane.
  let sel = resolveDriveTapeSelection({
    env: { [PERTURBATION_SEED_ENV]: '1' },
    driveFile: 'w9-03-adversarial-drive.mjs',
  });
  assert.equal(sel.tapeName, 'cross-execution-durability');
  assert.equal(sel.scenario, 'cross-execution-durability');
  assert.equal(sel.applied, true);

  // Agreeing explicit scenario: fine.
  sel = resolveDriveTapeSelection({
    env: { [PERTURBATION_SEED_ENV]: '1', W9_SCENARIO: 'cross-execution-durability' },
    driveFile: 'w9-03-adversarial-drive.mjs',
  });
  assert.equal(sel.scenario, 'cross-execution-durability');
  assert.equal(sel.applied, true);

  // Conflicting explicit scenario: typed error, never a silent guess.
  assert.throws(
    () => resolveDriveTapeSelection({
      env: { [PERTURBATION_SEED_ENV]: '1', W9_SCENARIO: 'reviewer-reject-repair' },
      driveFile: 'w9-03-adversarial-drive.mjs',
    }),
    /W9_TAPE_CONFLICT: W9_PERTURBATION_SEED=1 selects tape 'cross-execution-durability' \(scenario 'cross-execution-durability'\) for w9-03-adversarial-drive\.mjs, but W9_SCENARIO='reviewer-reject-repair'/,
  );
});

test('resolveDriveTapeSelection: an out-of-lane seed keeps the current behavior but records the tape name', () => {
  // seed 1 -> a w9-03 tape, asked of the w9-02 golden drive.
  const sel = resolveDriveTapeSelection({
    env: { [PERTURBATION_SEED_ENV]: '1' },
    driveFile: 'w9-02-single-drive.mjs',
  });
  assert.equal(sel.tapeName, 'cross-execution-durability');
  assert.equal(sel.scenario, null);
  assert.equal(sel.applied, false);

  // seed 0 (or any multiple of the table length) IS the golden tape, in-lane.
  const golden = resolveDriveTapeSelection({
    env: { [PERTURBATION_SEED_ENV]: '14' },
    driveFile: 'w9-02-single-drive.mjs',
  });
  assert.equal(golden.tapeName, 'golden-full-lifecycle');
  assert.equal(golden.scenario, null);
  assert.equal(golden.applied, false); // the golden tape needs no override — it IS the default
});

test('end-to-end: a seeded whole-factory w9-02 drive runs the golden path unchanged and attributes itself to the resolved tape', () => {
  const DRIVE_SCRIPT = path.resolve(REPO_ROOT, 'tests/factory-e2e/w9-02-single-drive.mjs');
  // seed 15 -> 15 mod 14 = 1 -> tape 'cross-execution-durability' (out-of-lane
  // for w9-02): the drive must keep its golden behavior AND record the tape.
  const result = spawnSync('node', [DRIVE_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, W9_DRIVE_LABEL: 'seeded-15', [PERTURBATION_SEED_ENV]: '15' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240_000,
  });
  assert.equal(result.status, 0, `seeded drive must succeed:\n${(result.stderr || '').slice(-2000)}`);
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const evidence = JSON.parse(lines[lines.length - 1]);
  assert.equal(evidence.perturbationSeed, 15);
  assert.equal(evidence.perturbationTape, 'cross-execution-durability');
  assert.equal(evidence.perturbationTapeApplied, false);
  assert.equal(evidence.reachedRunnableLocal, true, 'default behavior unchanged under an out-of-lane seed');
  assert.equal(evidence.devOutcome, 'verified');
  assert.equal(evidence.lrReceiptOutcome, 'passed');
});
