#!/usr/bin/env node
// tools/capture-run-snapshot.mjs
//
// STAGE-10 TASK 2 — the complete post-mortem artefact.
//
// Produces one timestamped directory containing a CONSISTENT copy of the
// factory SQLite database, the run journal, the worker/engine logs it can
// find, the resolved configuration, and a MANIFEST.json naming what was
// captured, when, and at which commit SHA + dist build time.
//
// LIVE-SAFETY (the brief demands explicit verification): the DB copy uses
// better-sqlite3's backup API (awaited) against a READ-ONLY source handle —
// SQLite's documented online-backup mechanism, safe while the factory is
// running (same pattern as scripts/factory.mjs continue --check). Never a
// raw file copy of a live DB (a torn WAL copy is corruption, not evidence).
// The captured copy is verified with PRAGMA integrity_check before the
// snapshot is declared complete; a failed integrity check fails the tool.
//
// Usage:
//   node tools/capture-run-snapshot.mjs --db <factory.sqlite> [--out <dir>]
//     [--note "..."]        — free-text reason, stored in MANIFEST.json
//
// Exit 0 = snapshot complete and integrity-verified. Exit 1 = the DB copy
// failed verification — the snapshot is not claimed usable.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import Database from 'better-sqlite3';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  const dbArg = arg('db');
  if (!dbArg) {
    process.stderr.write('usage: node tools/capture-run-snapshot.mjs --db <factory.sqlite> [--out <dir>] [--note "..."]\n');
    process.exit(1);
  }
  const dbPath = resolve(dbArg);
  if (!existsSync(dbPath)) {
    process.stderr.write(`snapshot: database not found: ${dbPath}\n`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(arg('out', join(repoRoot, 'factory-snapshots', `${basename(dirname(dbPath))}-${stamp}`)));
  mkdirSync(outDir, { recursive: true });

  const manifest = {
    capturedAt: new Date().toISOString(),
    capturedWhileLive: false,
    reason: arg('note', 'on-demand'),
    repo: { commit: undefined, distBuiltAt: undefined, treeDirty: undefined },
    database: { sourcePath: dbPath, copyFile: 'factory.sqlite', userVersion: undefined, integrityCheck: undefined, bytes: undefined },
    journal: { path: undefined, copied: false, lines: undefined },
    logs: [],
    resolvedConfig: {},
    files: [],
    missed: [],
  };
  const record = (file, rel) => {
    manifest.files.push({ file: rel, bytes: statSync(file).size, sha256: sha256(file) });
  };

  // --- repo identity ---------------------------------------------------------
  try {
    manifest.repo.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    manifest.repo.treeDirty = status.split(/\r?\n/).filter((l) => l.trim() !== '');
  } catch (e) {
    manifest.missed.push(`repo identity: ${e.message}`);
  }
  try {
    manifest.repo.distBuiltAt = statSync(join(repoRoot, 'dist', 'index.js')).mtime.toISOString();
  } catch {
    manifest.missed.push('dist/index.js mtime (no build present)');
  }

  // --- consistent DB copy (awaited backup API, read-only source) -------------
  const copyPath = join(outDir, 'factory.sqlite');
  let engineLogPaths = [];
  try {
    const source = new Database(dbPath, { readonly: true });
    manifest.database.userVersion = source.pragma('user_version', { simple: true });
    try {
      const controls = source.prepare(
        'SELECT epic_id, engine_state, engine_pid, concurrency, model_provider, model_name, model_effort FROM lifecycle_execution_controls',
      ).all();
      manifest.resolvedConfig.lifecycleExecutionControls = controls;
      manifest.capturedWhileLive = controls.some((c) => c.engine_state === 'running' && c.engine_pid);
    } catch (e) {
      manifest.missed.push(`lifecycle_execution_controls: ${e.message}`);
    }
    try {
      engineLogPaths = source.prepare(
        'SELECT engine_log_path FROM factory_launch_requests WHERE engine_log_path IS NOT NULL ORDER BY rowid DESC LIMIT 3',
      ).all().map((r) => r.engine_log_path);
      manifest.resolvedConfig.engineLogPaths = engineLogPaths;
    } catch { /* pre-run DB: table may be empty/absent — fine */ }
    try {
      const digests = {};
      const tables = source.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%installation%'",
      ).all().map((r) => r.name);
      for (const table of tables) {
        try {
          const cols = source.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
          const digestCol = cols.find((c) => /digest/i.test(c));
          if (!digestCol) continue;
          digests[table] = source.prepare(`SELECT ${digestCol} AS d, COUNT(*) AS n FROM ${table} GROUP BY ${digestCol}`).all();
        } catch { /* best effort */ }
      }
      manifest.resolvedConfig.installationDigests = digests;
    } catch { /* best effort */ }
    await source.backup(copyPath);
    source.close();
    const verify = new Database(copyPath, { readonly: true });
    const integrity = verify.pragma('integrity_check', { simple: true });
    verify.close();
    if (integrity !== 'ok') throw new Error(`integrity_check failed on the copy: ${integrity}`);
    manifest.database.integrityCheck = integrity;
    manifest.database.bytes = statSync(copyPath).size;
    record(copyPath, 'factory.sqlite');
  } catch (e) {
    process.stderr.write(`snapshot: DB capture FAILED: ${e.message}\n`);
    manifest.missed.push(`database: ${e.message}`);
  }

  // --- run journal ------------------------------------------------------------
  const journalPath = process.env.SAGA_RUN_JOURNAL && process.env.SAGA_RUN_JOURNAL !== 'off'
    ? resolve(process.env.SAGA_RUN_JOURNAL)
    : join(dirname(dbPath), 'factory-run-journal.jsonl');
  manifest.journal.path = journalPath;
  if (existsSync(journalPath)) {
    try {
      copyFileSync(journalPath, join(outDir, 'factory-run-journal.jsonl'));
      manifest.journal.copied = true;
      manifest.journal.lines = readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
      record(join(outDir, 'factory-run-journal.jsonl'), 'factory-run-journal.jsonl');
    } catch (e) {
      manifest.missed.push(`journal: ${e.message}`);
    }
  } else {
    manifest.missed.push(`journal: not found at ${journalPath}`);
  }

  // --- logs: heartbeat, worker JSONL trees, engine logs ------------------------
  const copyIfExists = (file, rel) => {
    try {
      if (!existsSync(file)) return;
      const safeRel = rel.replace(/[<>:"|?*]/g, '_');
      const dest = join(outDir, 'logs', safeRel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(file, dest);
      manifest.logs.push(rel);
      record(dest, `logs/${safeRel}`.replaceAll('\\', '/'));
    } catch (e) {
      manifest.missed.push(`log ${rel}: ${e.message}`);
    }
  };

  const orchestrationRoot = process.env.SAGA_ORCHESTRATION_LOG
    ? resolve(process.env.SAGA_ORCHESTRATION_LOG)
    : join(os.homedir(), '.zcode', 'cli');
  copyIfExists(join(orchestrationRoot, 'worker-heartbeat.log'), 'worker-heartbeat.log');

  const boardRuns = join(orchestrationRoot, 'board-runs');
  if (existsSync(boardRuns)) {
    try {
      const runDirs = readdirSync(boardRuns)
        .map((d) => join(boardRuns, d))
        .filter((p) => statSync(p).isDirectory())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        .slice(0, 3);
      for (const runDir of runDirs) {
        const files = readdirSync(runDir).slice(0, 200);
        for (const f of files) copyIfExists(join(runDir, f), `board-runs/${basename(runDir)}/${f}`);
      }
    } catch (e) {
      manifest.missed.push(`board-runs: ${e.message}`);
    }
  }
  for (const engineLogPath of engineLogPaths) {
    copyIfExists(engineLogPath, `engine/${basename(engineLogPath)}`);
    copyIfExists(`${engineLogPath}.heartbeat`, `engine/${basename(engineLogPath)}.heartbeat`);
    copyIfExists(`${engineLogPath}.phase`, `engine/${basename(engineLogPath)}.phase`);
  }

  // --- manifest ---------------------------------------------------------------
  writeFileSync(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const ok = manifest.database.integrityCheck === 'ok';
  process.stdout.write(
    `snapshot ${ok ? 'OK' : 'INCOMPLETE'}: ${outDir}\n`
    + `  db copy ${manifest.database.bytes ?? 0} bytes, integrity=${manifest.database.integrityCheck ?? 'FAILED'}, `
    + `journal ${manifest.journal.copied ? `${manifest.journal.lines} lines` : 'absent'}, `
    + `logs ${manifest.logs.length}, missed ${manifest.missed.length}\n`,
  );
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`snapshot: unexpected failure: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
