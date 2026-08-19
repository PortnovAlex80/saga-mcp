// tests/infrastructure/artifact-code-null-replay-debris.test.mjs
//
// PREVENTIVE-HUNT Layer 2 R-D6 — replay debris: code-null artifacts ALWAYS
// inserted a new row. A failed-then-retried capsule replay re-creates the
// same code-null artifact, so duplicates accumulate; the replay matcher
// (resolveExistingArtifactId in capsule-replay-executor.ts) returns null when
// the selector tuple matches MORE than one row, so OTHER capsules' replays
// then die with TRACE_SOURCE_MISSING — one workplace's retry poisons another
// workplace's resolution space.
//
// Fix contract, driven through the REAL handler seam (handlers.artifact_create
// on a temp DB, exactly like a replay-side artifact_create call):
//
//   AN1 a repeat code-null create with the SAME selector tuple the replay
//       matcher uses (project, type, code NULL, title, path) UPDATES the
//       existing row — same artifact id, still exactly one row;
//   AN2 a code-null create with a DIFFERENT tuple still inserts (zero-match
//       path is unchanged);
//   AN3 the code-present upsert is untouched (same (epic,type,code) match
//       still updates one row).
//
// BEFORE the fix this is RED on AN1 (two rows, two ids).
//
// NOTE: the ambiguous case (two pre-existing code-null rows with the same
// tuple) intentionally still INSERTS — fail-closed, never a silent pick —
// but logs; that behavior is characterized here so a future change is a
// visible diff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'saga-artifact-codenull-'));
process.env.DB_PATH = path.join(tmpDir, 'artifacts.db');

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/artifacts.js');

// Seed the referents artifact_create validates (business-project guard only
// applies to type 'theme'; a 'hypothesis' artifact just needs the rows).
const db = getDb();
db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')").run();

const selectorRowCount = (projectId, type, title, artifactPath) => db.prepare(
  `SELECT COUNT(*) AS n FROM artifacts
    WHERE project_id=? AND type=? AND code IS NULL AND title=? AND path=?`,
).get(projectId, type, title, artifactPath).n;

test('AN1/R-D6: repeat code-null create UPDATES the exact selector match — no duplicate debris', () => {
  const args = {
    project_id: 1, epic_id: 1, type: 'hypothesis',
    title: 'Implementation summary', path: 'docs/summary.md',
    status: 'draft', metadata: { note: 'created by replay' },
  };
  const first = handlers.artifact_create({ ...args });
  const second = handlers.artifact_create({ ...args, metadata: { note: 'created by retry' } });

  assert.equal(second.id, first.id,
    'R-D6: the retried create must resolve the existing row by the replay matcher tuple, not INSERT a duplicate');
  assert.equal(selectorRowCount(1, 'hypothesis', 'Implementation summary', 'docs/summary.md'), 1,
    'R-D6: exactly one row for the selector — duplicates poison other capsules\' replay resolution');
  const row = db.prepare('SELECT metadata FROM artifacts WHERE id=?').get(first.id);
  assert.equal(JSON.parse(row.metadata).note, 'created by retry',
    'the existing row was UPDATED with the retried payload');
});

test('AN2: a different code-null tuple still inserts (zero-match path unchanged)', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n;
  const inserted = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'hypothesis',
    title: 'A different summary', path: 'docs/other-summary.md',
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n;
  assert.equal(after, before + 1, 'a distinct tuple is a genuinely new artifact');
  assert.notEqual(inserted.id, undefined);
});

test('AN3: the code-present upsert is untouched (same (epic,type,code) match updates)', () => {
  const first = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'SPEC', code: 'SPEC-1',
    title: 'Spec one', path: 'docs/spec-1.md',
  });
  const second = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'SPEC', code: 'SPEC-1',
    title: 'Spec one (revised)', path: 'docs/spec-1.md',
  });
  assert.equal(second.id, first.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE type='SPEC' AND code='SPEC-1'").get().n,
    1,
  );
});

test('AN4 (characterization): an ambiguous pre-existing code-null duplicate still INSERTS, never silently picks', () => {
  // Two rows with the same tuple (possible only from pre-fix debris).
  db.prepare(
    `INSERT INTO artifacts (project_id,epic_id,type,code,title,path,status,storage_kind)
     VALUES (1,1,'hypothesis',NULL,'Ambiguous summary','docs/amb.md','draft','db_native'),
            (1,1,'hypothesis',NULL,'Ambiguous summary','docs/amb.md','draft','db_native')`,
  ).run();
  const before = db.prepare(
    `SELECT COUNT(*) AS n FROM artifacts
      WHERE project_id=1 AND type='hypothesis' AND code IS NULL
        AND title='Ambiguous summary' AND path='docs/amb.md'`,
  ).get().n;
  assert.equal(before, 2);
  const created = handlers.artifact_create({
    project_id: 1, epic_id: 1, type: 'hypothesis',
    title: 'Ambiguous summary', path: 'docs/amb.md',
  });
  const after = db.prepare(
    `SELECT COUNT(*) AS n FROM artifacts
      WHERE project_id=1 AND type='hypothesis' AND code IS NULL
        AND title='Ambiguous summary' AND path='docs/amb.md'`,
  ).get().n;
  assert.equal(after, before + 1,
    'fail-closed: ambiguity stays an insert (logged), never a silent pick among duplicates');
  assert.notEqual(created.id, undefined);
});

test.after?.(() => {});
process.on('exit', () => closeDb?.());
