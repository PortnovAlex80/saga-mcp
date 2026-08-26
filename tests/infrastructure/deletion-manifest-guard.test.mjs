// EK-1 / WP-04b — deletion-manifest stop-gate hosting (operator review item 8).
//
// POST-CUTOVER SHAPE (WP-12, 2026-08-26): the validator wrapped here
// (docs/refactoring/event-kernel/tools/validate-deletion-manifests.mjs)
// flipped at the EK-8 hard cutover:
//   V1 (DELETE)  INVERTED — every file that existed at the manifest base and
//                is classified DELETE must now be ABSENT; a survivor is a
//                red V1-SURVIVOR (an old-path resurrection fails CI).
//   V1 (KEEP)    unchanged — classified KEEP/RETAIN files must exist.
//   V2 NO-ROT    unchanged — every tracked file under src/**, tracker-view/**
//                (empty), scripts/** (empty) and the *.md doc scope appears
//                in a manifest row.
//   V3           unchanged — no file carries two dispositions / two sections.
//   V4           the old src/schema.ts must NOT exist (its 91 tables died);
//                duplicate §A rows still fail.
//
// This suite proves the gate itself is alive and non-vacuous:
//   1. GREEN now (the validator exits 0 on the purged tree);
//   2. deterministic — two runs print byte-identical output;
//   3. five encoded negative mutations, executed against TEMP COPIES of the
//      manifests or in-memory --extra-file simulations (never the real tree):
//        M1 a KEEP row classifying a nonexistent path        -> V1-STALE
//        M2 a new unclassified file joining the scope        -> V2-UNCLASSIFIED
//        M3 a duplicate classification in a second section   -> V3-DUPLICATE
//        M4 the RESURRECTION of a DELETE-classified file     -> V1-SURVIVOR
//           (the WP-12 cutover law: old paths may not come back)
//        M5 the resurrection of the old schema DDL file      -> V4-OLD-SCHEMA
//
// Registration:
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

test('green now: the validator passes on the purged tree (post-cutover V1 inversion)', () => {
  const r = runValidator();
  assert.equal(r.status, 0, `validator must exit 0 on the purged tree:\n${r.out}`);
  assert.match(r.out, /ALL GREEN — digest [0-9a-f]{64}/);
  // The old schema DDL is gone: V4 reports zero classified schema.ts tables.
  assert.match(r.out, /schema\.ts CREATE TABLE: 0/);
});

test('deterministic: two runs print byte-identical output', () => {
  const a = runValidator();
  const b = runValidator();
  assert.equal(a.status, 0);
  assert.equal(a.out, b.out, 'two runs on the same tree must be byte-identical');
});

test('M1 killed: a KEEP row naming a nonexistent path is RED (V1-STALE names it)', () => {
  const dir = tempManifestDir();
  try {
    // Post-cutover, a DELETE row for a nonexistent path is REQUIRED state;
    // the stale-row oracle is now the KEEP direction.
    mutate(
      dir, LEGACY,
      '| `tools/agent-proxy/**` | opencode shim (**the only legal worker transport today**) | KEEP |',
      '| `tools/wp04b-keep-mutation-fake.mjs` | WP-04b mutation probe (nonexistent KEEP path) | KEEP | — | none — mutation |',
    );
    const r = runValidator('--manifest-dir', dir);
    assert.notEqual(r.status, 0, 'a KEEP row naming a path that exists in no tree must fail the gate');
    assert.match(r.out, /RED V1-STALE[^\n]*tools\/wp04b-keep-mutation-fake\.mjs/);
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
    mutate(
      dir, LEGACY,
      '| `tools/adr-closure-registry.mjs` (+test) | ADR registry validator',
      '| `src/db.ts` | WP-04b mutation probe (duplicate classification of a §B.1 file) | DELETE @ EK-8 | none — mutation |',
    );
    const r = runValidator('--manifest-dir', dir);
    assert.notEqual(r.status, 0, 'one file classified by two sections must fail the gate');
    assert.match(r.out, /RED V3-DUPLICATE[^\n]*src\/db\.ts is classified by 2 sections/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M4 killed: RESURRECTING a DELETE-classified file is RED (V1-SURVIVOR — the WP-12 cutover law)', () => {
  // src/db.ts was classified DELETE at the manifest base and is deleted on
  // the real tree; simulating its resurrection must turn the gate red.
  const r = runValidator('--extra-file', 'src/db.ts');
  assert.notEqual(r.status, 0, 'an old-path resurrection must fail the gate (the cutover is irreversible)');
  assert.match(r.out, /RED V1-SURVIVOR[^\n]*src\/db\.ts/);
});

test('M5 killed: resurrecting the old schema DDL file is RED (V4-OLD-SCHEMA)', () => {
  const r = runValidator('--extra-file', 'src/schema.ts');
  assert.notEqual(r.status, 0, 'the old schema.ts may never return');
  assert.match(r.out, /V4-OLD-SCHEMA/);
});
