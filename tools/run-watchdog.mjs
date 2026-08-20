#!/usr/bin/env node
// STAGE-15 TASK 1 — the run watchdog.
//
// WHY THIS EXISTS (brief): the stage-12 engine died and we learned it
// afterwards; the stage-10 journal recorded 241 events and not one failure.
// This tool samples the run's durable state on a fixed interval and writes
// EVERY sample, so "the engine died" / "the run stagnated" / "the settings
// hash moved" are observed facts with timestamps, not reconstructions.
//
// OBSERVATION ONLY — the companion discipline of run-journal.ts: this tool
// never opens the DB read-write, never writes factory tables, never kills a
// process, never repairs anything. It samples, classifies, and records. The
// operator (or the agent observing the run) reads the output and acts.
//
// Usage:
//   node tools/run-watchdog.mjs --db <factory.sqlite> --out <logs-dir> \
//     [--journal <run-journal.jsonl>] [--interval-seconds 60] \
//     [--stagnation-minutes 45] [--settings-sha <sha256>] [--max-hours 12]
//
// Output: <out>/watchdog.jsonl, one line per sample. Trip lines carry a
// non-empty `trips` array; the observed outcome carries `outcome`:
//
//   trips: STAGNATION   — the progress fingerprint (lifecycle status, stage
//                         counts, workplace revision/loop_state, task counts,
//                         gate count, journal growth — heartbeats deliberately
//                         EXCLUDED, a spinning engine is not progress) has
//                         been unchanged >= --stagnation-minutes.
//          ENGINE_VANISHED — the engine pid stamped in the launch/controls
//                         rows was seen alive and is now dead while the
//                         lifecycle run is not terminal. This is exactly what
//                         went unobserved in stage 12.
//          SETTINGS_DRIFT — ~/.claude/settings.json sha256 moved off the
//                         baseline (first sample unless --settings-sha).
//   outcome: TERMINAL   — the lifecycle run reached a terminal status.
//
// The watchdog keeps sampling after a trip (evidence continues to flow);
// acting on the trip is the observer's job, per the brief's abort protocol.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function parseArgs(argv) {
  const out = { db: null, out: null, journal: null, intervalSeconds: 60, stagnationMinutes: 45, settingsSha: null, maxHours: 12 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const value = argv[i + 1];
    const need = () => { if (!value) die(`${a} requires a value`); i += 1; return value; };
    if (a === '--db') out.db = need();
    else if (a === '--out') out.out = need();
    else if (a === '--journal') out.journal = need();
    else if (a === '--interval-seconds') { out.intervalSeconds = Number(need()); }
    else if (a === '--stagnation-minutes') { out.stagnationMinutes = Number(need()); }
    else if (a === '--settings-sha') out.settingsSha = need();
    else if (a === '--max-hours') { out.maxHours = Number(need()); }
    else die(`unknown option ${a}`);
  }
  if (!out.db || !out.out) die('usage: node tools/run-watchdog.mjs --db <sqlite> --out <dir> [--journal <jsonl>] [--interval-seconds 60] [--stagnation-minutes 45] [--settings-sha <sha>] [--max-hours 12]');
  return out;
}
function die(msg) { process.stderr.write(`run-watchdog: ${msg}\n`); process.exit(2); }

function sha256File(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Read-only helpers tolerant of lazily-created tables (absent → default). */
function allTolerant(db, sql, fallback = []) {
  try { return db.prepare(sql).all(); } catch { return fallback; }
}
function getTolerant(db, sql, fallback = null) {
  try { return db.prepare(sql).get() ?? fallback; } catch { return fallback; }
}

function sampleDatabase(dbPath, journalPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const lifecycle = getTolerant(db,
      `SELECT id, status, terminal_status, current_stage_id, updated_at
         FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1`);
    const stages = Object.fromEntries(allTolerant(db,
      `SELECT status, COUNT(*) AS n FROM factory_stage_runs GROUP BY status`).map(r => [r.status, r.n]));
    const workplaces = allTolerant(db,
      `SELECT workplace_ref, revision, loop_state, kanban_phase, updated_at
         FROM factory_workplaces ORDER BY workplace_ref`);
    const tasks = Object.fromEntries(allTolerant(db,
      `SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`).map(r => [r.status, r.n]));
    const gates = getTolerant(db, `SELECT COUNT(*) AS n FROM factory_gate_runs`, { n: 0 }).n;
    const widening = Object.fromEntries(allTolerant(db,
      `SELECT event_kind, COUNT(*) AS n FROM factory_scope_widening_events GROUP BY event_kind`).map(r => [r.event_kind, r.n]));
    const launch = getTolerant(db,
      `SELECT launch_ref, state, engine_pid, engine_log_path, engine_spawned_at
         FROM factory_launch_requests ORDER BY rowid DESC LIMIT 1`);
    const controls = getTolerant(db,
      `SELECT engine_state, engine_pid FROM lifecycle_execution_controls ORDER BY rowid DESC LIMIT 1`);
    return { lifecycle, stages, workplaces, tasks, gates, widening, launch, controls };
  } finally {
    db.close();
  }
}

/** Journal tail facts (tools/ is the sanctioned journal consumer). */
function sampleJournal(journalPath) {
  if (!journalPath) return { lines: 0, last_ts: null, engine_exit: null, run_terminal: null };
  try {
    const text = readFileSync(journalPath, 'utf8');
    const lines = text.length === 0 ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    let engineExit = null;
    let runTerminal = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i -= 1) {
      try {
        const evt = JSON.parse(lines[i]);
        if (!engineExit && evt.kind === 'engine.exit') engineExit = evt;
        if (!runTerminal && evt.kind === 'run.terminal') runTerminal = evt;
      } catch { /* truncated tail line */ }
    }
    return { lines: lines.length, last_ts: lines.length > 0 ? (JSON.parse(lines[lines.length - 1]).ts ?? null) : null, engine_exit: engineExit, run_terminal: runTerminal };
  } catch {
    return { lines: 0, last_ts: null, engine_exit: null, run_terminal: null };
  }
}

function heartbeatAgeSeconds(engineLogPath) {
  if (!engineLogPath) return null;
  try {
    const mtimeMs = statSync(`${engineLogPath}.heartbeat`).mtimeMs;
    return Math.round((Date.now() - mtimeMs) / 1000);
  } catch { return null; }
}

/** Progress fingerprint: everything that must MOVE for the run to be alive.
 * Heartbeats and log growth are deliberately excluded — a spinning engine
 * is not progress (the brief: stagnation is a result, not a wait cue). */
function fingerprint(sample) {
  const core = {
    lifecycle: sample.lifecycle
      ? { s: sample.lifecycle.status, t: sample.lifecycle.terminal_status, c: sample.lifecycle.current_stage_id }
      : null,
    stages: sample.stages,
    workplaces: sample.workplaces.map(w => [w.workplace_ref, w.revision, w.loop_state]),
    tasks: sample.tasks,
    gates: sample.gates,
    journal_lines: sample.journal.lines,
  };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

const args = parseArgs(process.argv);
mkdirSync(args.out, { recursive: true });
const outPath = join(args.out, 'watchdog.jsonl');
const settingsPath = join(homedir(), '.claude', 'settings.json');
const baselineSettingsSha = args.settingsSha ?? sha256File(settingsPath);
const deadline = Date.now() + args.maxHours * 3600_000;

let fingerprintFirstTs = null;
let lastFingerprint = null;
let lastSeenAliveTs = null;
const tripped = new Set();

function write(record) { appendFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8'); }

write({
  ts: new Date().toISOString(),
  kind: 'watchdog.start',
  db: args.db,
  out: args.out,
  journal: args.journal,
  interval_seconds: args.intervalSeconds,
  stagnation_minutes: args.stagnationMinutes,
  settings_baseline_sha: baselineSettingsSha,
  max_hours: args.maxHours,
});

/* eslint-disable no-constant-condition */
while (true) {
  let record;
  try {
    const dbSample = sampleDatabase(args.db, args.journal);
    const journal = sampleJournal(args.journal);
    const enginePid = dbSample.launch?.engine_pid ?? dbSample.controls?.engine_pid ?? null;
    const alive = enginePid != null && pidAlive(enginePid);
    if (alive) lastSeenAliveTs = Date.now();
    const settingsSha = sha256File(settingsPath);
    const fp = fingerprint({ ...dbSample, journal });
    const now = Date.now();
    if (fp !== lastFingerprint) { lastFingerprint = fp; fingerprintFirstTs = now; }

    const trips = [];
    if (fingerprintFirstTs !== null
      && now - fingerprintFirstTs >= args.stagnationMinutes * 60_000
      && !tripped.has('STAGNATION')) {
      trips.push('STAGNATION');
      tripped.add('STAGNATION');
    }
    const lifecycleTerminal = dbSample.lifecycle != null
      && (['completed', 'failed', 'cancelled'].includes(dbSample.lifecycle.status)
        || dbSample.lifecycle.terminal_status != null);
    if (enginePid != null && !alive && !lifecycleTerminal && lastSeenAliveTs !== null
      && !tripped.has('ENGINE_VANISHED')) {
      trips.push('ENGINE_VANISHED');
      tripped.add('ENGINE_VANISHED');
    }
    if (settingsSha !== null && settingsSha !== baselineSettingsSha && !tripped.has('SETTINGS_DRIFT')) {
      trips.push('SETTINGS_DRIFT');
      tripped.add('SETTINGS_DRIFT');
    }

    record = {
      ts: new Date().toISOString(),
      kind: 'sample',
      sample: {
        lifecycle: dbSample.lifecycle,
        stages: dbSample.stages,
        workplaces: dbSample.workplaces,
        tasks: dbSample.tasks,
        gates: dbSample.gates,
        widening: dbSample.widening,
        engine: {
          pid: enginePid,
          alive,
          last_seen_alive_ts: lastSeenAliveTs !== null ? new Date(lastSeenAliveTs).toISOString() : null,
          heartbeat_age_s: heartbeatAgeSeconds(dbSample.launch?.engine_log_path ?? null),
          launch_state: dbSample.launch?.state ?? null,
        },
        journal,
        settings_sha: settingsSha,
      },
      fingerprint: fp,
      stagnant_seconds: fingerprintFirstTs !== null ? Math.round((now - fingerprintFirstTs) / 1000) : 0,
    };
    if (trips.length > 0) record.trips = trips;
    if (lifecycleTerminal && !tripped.has('TERMINAL')) {
      tripped.add('TERMINAL');
      record.outcome = 'TERMINAL';
    }
  } catch (error) {
    record = { ts: new Date().toISOString(), kind: 'sample_error', error: String(error?.message ?? error) };
  }
  write(record);
  if (Date.now() >= deadline) {
    write({ ts: new Date().toISOString(), kind: 'watchdog.exit', reason: 'max-hours reached' });
    break;
  }
  await new Promise(resolve => setTimeout(resolve, args.intervalSeconds * 1000));
}
