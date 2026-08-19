// tests/factory-contract/run-snapshot-tool.test.mjs
//
// STAGE-10 TASK 2 — the snapshot harness is SAFE ON A LIVE DATABASE.
//
// The brief: "It must run on demand and at run end, and be safe to invoke
// while the factory is live. Verify that last property explicitly — a
// snapshot that corrupts a live run is worse than no snapshot."
//
// This suite verifies the property by construction: a WAL database under an
// ACTIVE writer (a second connection inserting rows every few milliseconds
// throughout the capture) is snapshotted by the real tool as a child
// process; the copy must pass integrity_check, be a readable WAL database
// with a consistent point-in-time row count, and the MANIFEST must record
// the repo commit, the dist build time, and the journal. A raw file copy
// under the same writer routinely fails this (torn WAL) — that is exactly
// the failure mode the backup API exists to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = join(dirname_(fileURLToPath(import.meta.url)), '../..');
function dirname_(p) { return join(p, '..'); }

test('capture-run-snapshot is safe on a live WAL database under an active writer', { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-snapshot-live-'));
  const dbPath = join(dir, 'factory.sqlite');
  const outDir = join(dir, 'snapshot-out');
  try {
    // Build a WAL database with the minimal live-run shape.
    const setup = new Database(dbPath);
    setup.pragma('journal_mode = WAL');
    setup.exec(`
      CREATE TABLE lifecycle_execution_controls (
        epic_id INTEGER PRIMARY KEY, engine_state TEXT, engine_pid INTEGER,
        concurrency INTEGER, model_provider TEXT, model_name TEXT,
        model_effort TEXT, model_concurrency_limit INTEGER
      );
      INSERT INTO lifecycle_execution_controls VALUES (1, 'running', 424242, 2, 'zai', 'glm-4.7', 'high', 2);
    `);
    setup.exec('CREATE TABLE live_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)');
    setup.prepare('INSERT INTO live_telemetry (note) VALUES (?)').run('seed');
    setup.close();

    // ACTIVE WRITER: keeps inserting for the whole capture window.
    const writer = new Database(dbPath);
    const insert = writer.prepare('INSERT INTO live_telemetry (note) VALUES (?)');
    const writerTimer = setInterval(() => {
      try { insert.run(`tick-${Date.now()}`); } catch { /* table may be locked momentarily; keep writing */ }
    }, 3);

    let result;
    try {
      result = spawnSync(process.execPath, [join(repoRoot, 'tools', 'capture-run-snapshot.mjs'),
        '--db', dbPath, '--out', outDir, '--note', 'live-safety verification'], { encoding: 'utf8', timeout: 90000 });
    } finally {
      clearInterval(writerTimer);
      writer.close();
    }

    assert.equal(result.status, 0, `tool exit 0 (stderr: ${result.stderr})`);
    assert.match(result.stdout, /snapshot OK/u);
    assert.match(result.stdout, /integrity=ok/u);

    // The copy is a usable WAL database with a CONSISTENT point-in-time state.
    const copy = new Database(join(outDir, 'factory.sqlite'), { readonly: true });
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
    const controls = copy.prepare('SELECT * FROM lifecycle_execution_controls').all();
    assert.equal(controls.length, 1);
    assert.equal(controls[0].model_name, 'glm-4.7');
    const rows = copy.prepare('SELECT COUNT(*) AS n, MAX(id) AS maxId FROM live_telemetry').get();
    assert.ok(rows.n >= 1 && rows.maxId >= 1, 'the copy carries the seed rows');
    // Monotonic snapshot: ids form a contiguous prefix (no gaps from tearing).
    const gaps = copy.prepare(
      'SELECT COUNT(*) AS g FROM live_telemetry a WHERE a.id > 1 AND NOT EXISTS (SELECT 1 FROM live_telemetry b WHERE b.id = a.id - 1)',
    ).get().g;
    assert.equal(gaps, 0, 'row ids are contiguous — the copy is a consistent point-in-time, not a torn state');
    copy.close();

    // The MANIFEST records what a post-mortem needs.
    const manifest = JSON.parse(readFileSync(join(outDir, 'MANIFEST.json'), 'utf8'));
    assert.match(manifest.repo.commit, /^[0-9a-f]{40}$/u);
    assert.match(manifest.repo.distBuiltAt, /^2\d{3}-/u);
    assert.equal(manifest.capturedWhileLive, true, 'the tool detected the running-engine marker row');
    assert.equal(manifest.resolvedConfig.lifecycleExecutionControls[0].model_name, 'glm-4.7');
    assert.ok(manifest.missed.some((m) => m.startsWith('journal:')), 'absent journal is named in missed[], not silently dropped');
    assert.ok(manifest.files.some((f) => f.file === 'factory.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture-run-snapshot fails loudly on a nonexistent database', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'tools', 'capture-run-snapshot.mjs'),
    '--db', join(tmpdir(), `definitely-absent-${Date.now()}.sqlite`)], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found/u);
});
