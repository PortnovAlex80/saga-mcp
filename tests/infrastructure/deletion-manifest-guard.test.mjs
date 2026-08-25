// EK-1 / WP-04b — deletion-manifest stop-gate hosting (operator review item 8).
//
// Wraps docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs,
// the blocking validator proving the two WP-04 deletion manifests cannot rot
// before EK-7/EK-8:
//   V1 existence  — every classified path exists in the tree today;
//   V2 no-rot     — every scoped tracked file is classified (a NEW file under
//                   src/, tracker-view/, scripts/ or any *.md / doc artifact
//                   turns the gate red until it is consciously classified);
//   V3 consistency— no file carries two dispositions / two sections;
//   V4 tables     — every src/schema.ts CREATE TABLE name is classified in
//                   legacy §A exactly once.
//
// This suite proves the gate itself is alive and non-vacuous:
//   1. GREEN now (the validator exits 0 on the current tree; its real-manifest
//      defects are declared as KNOWN-GAP entries inside the validator, each
//      printed on every run — coordinator amendments pending);
//   2. deterministic — two runs print byte-identical output;
//   3. three encoded negative mutations, executed against TEMP COPIES of the
//      manifests (never the real ones), each of which MUST turn the validator
//      red naming the exact defect:
//        M1 a row classifying a nonexistent path            -> V1-STALE
//        M2 a new unclassified file joining the scope       -> V2-UNCLASSIFIED
//        M3 a duplicate classification of an already-listed
//           file in a second section                        -> V3-DUPLICATE
//
// Registration (coordinator-owned wiring, see the WP-04b handoff):
//   npm script   : validate:deletion-manifests
//   matrix group : ek-manifest-guard -> tests/infrastructure/deletion-manifest-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALIDATOR = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'tools', 'validate-deletion-manifests.mjs');
const MANIFEST_DIR = path.join(ROOT, 'docs', 'refactoring', 'event-kernel');
const LEGACY = 'LEGACY-DELETION-MANIFEST.md';
const DOCUMENT = 'DOCUMENT-DELETION-MANIFEST.md';

function runValidator(...args) {
  const r = spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** Fresh temp copy of both manifests for mutation runs (never the real ones). */
function tempManifestDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wp04b-manifest-guard-'));
  copyFileSync(path.join(MANIFEST_DIR, LEGACY), path.join(dir, LEGACY));
  copyFileSync(path.join(MANIFEST_DIR, DOCUMENT), path.join(dir, DOCUMENT));
  return dir;
}

function mutate(dir, file, anchor, insertion) {
  const p = path.join(dir, file);
  const md = readFileSync(p, 'utf8');
  assert.ok(md.includes(anchor), `mutation anchor not found in ${file} — the manifest row this probe splices after moved; update the anchor to the current row text`);
  writeFileSync(p, md.replace(anchor, `${anchor}\n${insertion}`));
}

test('green now: the validator passes on the current tree (declared KNOWN-GAPs aside)', () => {
  const r = runValidator();
  assert.equal(r.status, 0, `validator must exit 0 on the current tree:\n${r.out}`);
  assert.match(r.out, /ALL GREEN — digest [0-9a-f]{64}/);
  // the known-gap debt stays visible on every run (it may never go silent);
  // once the coordinator amends the manifest and removes the gap entry, the
  // stale date may not appear at all — either way is green, silence is not
  const mentionsStaleDate = r.out.includes('2026-08-28-failures');
  if (mentionsStaleDate) {
    assert.match(r.out, /KNOWN-GAP V1-STALE[^\n]*2026-08-28-failures/,
      'the mistyped characterization-fixture date may appear ONLY as a declared KNOWN-GAP line');
  }
});

test('deterministic: two runs print byte-identical output', () => {
  const a = runValidator();
  const b = runValidator();
  assert.equal(a.status, 0);
  assert.equal(a.out, b.out, 'two runs on the same tree must be byte-identical');
});

test('M1 killed: a row classifying a nonexistent path is RED (V1-STALE names it)', () => {
  const dir = tempManifestDir();
  try {
    // splice a fake row into the legacy §B.1 table (after its last real row)
    mutate(
      dir, LEGACY,
      '| `src/checkpoint-cli.ts` | Checkpoint capture/restore CLI | EK-8 | none — obsolete (obligation recovery; no snapshots) |',
      '| `src/wp04b-mutation-fake.ts` | WP-04b mutation probe (nonexistent path) | EK-8 | none — mutation |',
    );
    const r = runValidator('--manifest-dir', dir);
    assert.notEqual(r.status, 0, 'a manifest row naming a path that exists in no tree must fail the gate');
    assert.match(r.out, /RED V1-STALE[^\n]*src\/wp04b-mutation-fake\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2 killed: a new unclassified file under scope is RED (V2-UNCLASSIFIED names it)', () => {
  const r = runValidator('--extra-file', 'src/wp04b-mutation-new-file.ts');
  assert.notEqual(r.status, 0, 'a new file joining src/ without a manifest row must fail the gate');
  assert.match(r.out, /RED V2-UNCLASSIFIED[^\n]*src\/wp04b-mutation-new-file\.ts/);
});

test('M3 killed: a duplicate classification in a second section is RED (V3-DUPLICATE names the file)', () => {
  const dir = tempManifestDir();
  try {
    // splice a second classification of src/db.ts (already §B.1) into §C
    mutate(
      dir, LEGACY,
      '| `claude-runner.mjs` + `claude-runner.d.mts` | Worker spawn through the opencode shim;',
      '| `src/db.ts` | WP-04b mutation probe (duplicate classification of a §B.1 file) | EK-8 | none — mutation |',
    );
    const r = runValidator('--manifest-dir', dir);
    assert.notEqual(r.status, 0, 'one file classified by two sections must fail the gate');
    assert.match(r.out, /RED V3-DUPLICATE[^\n]*src\/db\.ts is classified by 2 sections: B\.1, C/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
