// Engine supervisor (antifreeze layer C).
//
// Layer A (commit 681ca660) made a frozen engine externally observable: the
// engine touches `${SAGA_ENGINE_LOG}.heartbeat` every 5s from its main loop,
// so a main-thread freeze pins the heartbeat mtime while the OS pid stays
// alive. Layer B bound the engine log path + pid durably to the launch row
// (factory_launch_requests.engine_log_path/engine_pid). This module is the
// panel-side SUPERVISOR that closes the loop:
//
//   - every SWEEP_INTERVAL_MS it checks each active launch (state='running'):
//     dead pid → durable 'engine_dead' mark; live pid with a heartbeat older
//     than STALE_MS → FREEZE → treatment (audit row + guarded stop + restart);
//   - treatment stops the engine through the operator SOFT-STOP engine brake
//     (brakeEnginesForProject — pid-guarded tree-kill that never touches a
//     reused foreign pid), then restarts via the panel's own resume code
//     (sagaApplication.startEngine — the same path POST /api/factory/start
//     uses, called directly, no HTTP self-call);
//   - restarts are rate-limited by a backoff ladder (1→5→15 min) and a budget
//     (MAX_ATTEMPTS per BUDGET_WINDOW_MS). Both are derived from the durable
//     factory_engine_watchdog_events table, so the policy survives panel
//     restarts. Budget exhaustion stamps engine_state='failed_watchdog' +
//     last_error on lifecycle_execution_controls — visible in
//     /api/factory/status, never a silent stop;
//   - sweepBeforeSpawn() enforces one engine per epic at every spawn gate in
//     the panel: a live pid with a fresh heartbeat blocks the duplicate spawn
//     (ok:'already-running'); a live pid with a stale heartbeat is a frozen
//     corpse — killed first, then the caller spawns a fresh engine.
//
// The supervisor NEVER touches engines it cannot identify: a launch without
// durable markers (pre-layer-B rows) is LEGACY and skipped, and a live pid
// whose command line is not orchestrate-cli.js is never killed.

import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { brakeEnginesForProject, REAL_ENGINE_BRAKE_DEPS } from '../dist/app/operator-soft-stop.js';

const HEARTBEAT_SUFFIX = '.heartbeat';

/** Sweep cadence (task spec: 30s). */
const SWEEP_INTERVAL_MS = 30_000;
/** Live pid + heartbeat older than this = frozen main thread (task: 120s). */
const STALE_MS = 120_000;
/** Backoff ladder AFTER the Nth restart attempt (index = attempts so far). */
const BACKOFF_AFTER_ATTEMPT_MS = [0, 60_000, 300_000, 900_000, 900_000];
/** Max watchdog restarts per rolling window (task: 5 per 2h). */
const MAX_ATTEMPTS = 5;
const BUDGET_WINDOW_MS = 2 * 60 * 60_000;

function positiveEnvInt(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** SQLite datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS'. */
function sqliteUtcIso(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function createEngineSupervisor({
  withDb,
  withDbWrite,
  sagaApplication,
  brakeDeps = REAL_ENGINE_BRAKE_DEPS,
  now = () => Date.now(),
  intervalMs = positiveEnvInt('SAGA_ENGINE_SUPERVISOR_INTERVAL_MS', SWEEP_INTERVAL_MS),
  staleMs = positiveEnvInt('SAGA_ENGINE_SUPERVISOR_STALE_MS', STALE_MS),
}) {
  let timer = null;
  let sweeping = false;

  function enabled() {
    return process.env.SAGA_ENGINE_SUPERVISOR !== '0';
  }

  // --- audit trail ----------------------------------------------------------

  function recordEvent(db, launch, kind, extra = {}) {
    db.prepare(
      `INSERT INTO factory_engine_watchdog_events
         (event_ref, project_id, epic_id, launch_ref, kind, reason,
          engine_pid, heartbeat_age_ms, log_age_ms, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `wd-${randomUUID()}`,
      launch.project_id,
      launch.epic_id ?? null,
      launch.launch_ref,
      kind,
      extra.reason ?? 'engine_watchdog_heartbeat_stale',
      launch.engine_pid ?? null,
      extra.heartbeatAgeMs ?? null,
      extra.logAgeMs ?? null,
      extra.detail ?? null,
    );
  }

  function lastEventForLaunch(db, launchRef) {
    return db.prepare(
      `SELECT kind, engine_pid FROM factory_engine_watchdog_events
        WHERE launch_ref=? ORDER BY rowid DESC LIMIT 1`,
    ).get(launchRef);
  }

  function restartAttempts(db, launchRef, windowStartIso) {
    return db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last_at
         FROM factory_engine_watchdog_events
        WHERE launch_ref=? AND kind='restart_attempted'
          AND created_at >= ?`,
    ).get(launchRef, windowStartIso);
  }

  // --- markers / verdicts ---------------------------------------------------

  /**
   * Marker freshness for one launch. Heartbeat file first; LEGACY fallback
   * (engine predates layer A, or the heartbeat file was wiped) is the engine
   * log's own mtime — the file logger appends to it continuously. Both
   * missing → null (unobservable).
   */
  function markerAges(engineLogPath) {
    const nowMs = now();
    try {
      const heartbeat = statSync(`${engineLogPath}${HEARTBEAT_SUFFIX}`);
      const log = statSync(engineLogPath);
      return {
        heartbeatAgeMs: Math.max(0, nowMs - heartbeat.mtimeMs),
        logAgeMs: Math.max(0, nowMs - log.mtimeMs),
        source: 'heartbeat',
      };
    } catch {
      try {
        const log = statSync(engineLogPath);
        const logAgeMs = Math.max(0, now() - log.mtimeMs);
        return { heartbeatAgeMs: logAgeMs, logAgeMs, source: 'log-legacy' };
      } catch {
        return { heartbeatAgeMs: null, logAgeMs: null, source: 'missing' };
      }
    }
  }

  /** Live running launches with durable markers, newest per epic wins. */
  function observableLaunches(db) {
    const rows = db.prepare(
      `SELECT launch_ref, project_id, epic_id, engine_log_path, engine_pid
         FROM factory_launch_requests
        WHERE state='running' AND engine_pid IS NOT NULL AND engine_log_path IS NOT NULL
        ORDER BY rowid DESC`,
    ).all();
    const byEpic = new Map();
    for (const row of rows) {
      if (!byEpic.has(row.epic_id)) byEpic.set(row.epic_id, row);
    }
    return [...byEpic.values()];
  }

  // --- treatment ------------------------------------------------------------

  /**
   * Guarded stop of exactly this engine. Primary: the operator SOFT-STOP
   * engine brake (pid + command-line guarded tree-kill that never touches a
   * reused foreign pid) — but only when no OTHER epic of the same project
   * holds a live engine, because the brake is project-scoped by operator
   * semantics and the watchdog must treat exactly THIS launch. Fallback /
   * always: the same command-line guard applied to the launch pid directly.
   * A live pid that is NOT orchestrate-cli.js is a reused foreign pid —
   * NEVER killed.
   */
  function stopEngine(launch, events) {
    let brakeError = null;
    const hasSiblingEngine = withDb(db => Boolean(db.prepare(
      `SELECT 1 FROM lifecycle_execution_controls c
        WHERE c.epic_id<>? AND c.engine_state='running' AND c.engine_pid IS NOT NULL
          AND c.epic_id IN (SELECT id FROM epics WHERE project_id=?)`,
    ).get(launch.epic_id, launch.project_id)));
    if (!hasSiblingEngine) {
      try {
        withDbWrite(db => brakeEnginesForProject(db, { projectId: launch.project_id }, brakeDeps));
      } catch (error) {
        brakeError = error;
      }
    }
    if (brakeDeps.isAlive(launch.engine_pid)) {
      const commandLine = brakeDeps.readCommandLine(launch.engine_pid);
      if (commandLine !== null && commandLine.includes('orchestrate-cli.js')) {
        brakeDeps.killTree(launch.engine_pid);
      }
    }
    if (brakeDeps.isAlive(launch.engine_pid)) {
      events.push({ kind: 'brake_failed', reason: 'engine_watchdog_heartbeat_stale', detail: `engine pid ${launch.engine_pid} survived the guarded stop: ${brakeError?.message ?? 'kill did not take'}` });
      return false;
    }
    if (brakeError) {
      events.push({ kind: 'brake_failed', reason: 'engine_watchdog_heartbeat_stale', detail: `soft-stop brake threw (${brakeError.message}) but the launch pid is dead after the guarded fallback kill` });
    }
    return true;
  }

  /** Full freeze treatment for one launch. Returns the durable event kinds. */
  function treatFrozenLaunch(launch, ages) {
    const nowMs = now();
    const windowStartIso = sqliteUtcIso(nowMs - BUDGET_WINDOW_MS);
    const { n: attempts, last_at: lastAttemptAt } = withDb(db => restartAttempts(db, launch.launch_ref, windowStartIso));

    if (attempts >= MAX_ATTEMPTS) {
      withDbWrite(db => {
        recordEvent(db, launch, 'freeze_detected', { heartbeatAgeMs: ages.heartbeatAgeMs, logAgeMs: ages.logAgeMs });
        recordEvent(db, launch, 'attempts_exhausted', {
          detail: `${attempts} watchdog restarts in the last ${Math.round(BUDGET_WINDOW_MS / 60000)} min`,
        });
        markFailedWatchdogRow(db, launch,
          `restart budget exhausted (${attempts} attempts / 2h); heartbeat stale ${Math.round(ages.heartbeatAgeMs / 1000)}s`);
      });
      return ['freeze_detected', 'attempts_exhausted'];
    }

    if (attempts > 0 && lastAttemptAt) {
      const lastAttemptMs = Date.parse(`${String(lastAttemptAt).replace(' ', 'T')}Z`);
      const required = BACKOFF_AFTER_ATTEMPT_MS[Math.min(attempts, BACKOFF_AFTER_ATTEMPT_MS.length - 1)];
      if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < required) {
        // Backoff deferral: no event row (the gap stays auditable from the
        // freeze_detected vs restart_attempted timestamps), no restart.
        return ['deferred'];
      }
    }

    // Durable BEFORE the stop/restart: if the panel dies mid-treatment, the
    // attempt is still counted against the budget (crash-safe accounting).
    withDbWrite(db => {
      recordEvent(db, launch, 'freeze_detected', { heartbeatAgeMs: ages.heartbeatAgeMs, logAgeMs: ages.logAgeMs });
      recordEvent(db, launch, 'restart_attempted', { detail: `attempt ${attempts + 1}/${MAX_ATTEMPTS}` });
    });
    const events = [];
    // Stop first (a frozen main thread cannot service any graceful signal —
    // same rationale as the operator soft-stop engine brake).
    const stopped = stopEngine(launch, events);
    if (!stopped) {
      withDbWrite(db => {
        for (const event of events) recordEvent(db, launch, event.kind, event);
      });
      return ['freeze_detected', 'restart_attempted', ...events.map(event => event.kind)];
    }
    // Restart through the panel's own resume path (direct call, no HTTP).
    try {
      const state = sagaApplication.startEngine({ epicId: launch.epic_id });
      events.push({ kind: state?.running ? 'restart_succeeded' : 'restart_failed', detail: `engine pid after restart: ${state?.pid ?? 'null'}` });
    } catch (error) {
      events.push({ kind: 'restart_failed', detail: error.message });
    }
    withDbWrite(db => {
      for (const event of events) recordEvent(db, launch, event.kind, event);
    });
    return ['freeze_detected', 'restart_attempted', ...events.map(event => event.kind)];
  }

  function markFailedWatchdogRow(db, launch, detail) {
    db.prepare(
      `INSERT INTO lifecycle_execution_controls
         (epic_id, engine_state, last_error, stopped_at)
       VALUES (?, 'failed_watchdog', ?, datetime('now'))
       ON CONFLICT(epic_id) DO UPDATE SET
         engine_state='failed_watchdog',
         last_error=excluded.last_error,
         stopped_at=datetime('now'),
         updated_at=datetime('now')`,
    ).run(launch.epic_id, `engine watchdog: ${detail}`);
  }

  // --- sweeps ---------------------------------------------------------------

  /**
   * One periodic sweep over all running launches. Throws never: a sweep error
   * is logged and retried on the next tick.
   */
  function sweepOnce() {
    if (sweeping) return { swept: 0, verdicts: [] };
    sweeping = true;
    const verdicts = [];
    try {
      const ready = withDb(db => Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_engine_watchdog_events'",
      ).get()));
      if (!ready) return { swept: 0, verdicts: [], skipped: 'schema-not-migrated' };
      const launches = withDb(observableLaunches);
      for (const launch of launches) {
        const ages = markerAges(launch.engine_log_path);
        const pidAlive = brakeDeps.isAlive(launch.engine_pid);
        if (!pidAlive) {
          // Dead pid: durable mark only (no restart — the operator's resume
          // button or the order flow owns re-launching a dead factory). Skip
          // when the last event for this launch is already the same mark, so
          // a sweep every 30s does not spam the audit table while the launch
          // row stays 'running'.
          const last = withDb(db => lastEventForLaunch(db, launch.launch_ref));
          if (!(last && last.kind === 'engine_dead' && last.engine_pid === launch.engine_pid)) {
            withDbWrite(db => recordEvent(db, launch, 'engine_dead', {
              reason: 'engine_watchdog_pid_dead',
              heartbeatAgeMs: ages.heartbeatAgeMs,
              logAgeMs: ages.logAgeMs,
            }));
          }
          verdicts.push({ launch_ref: launch.launch_ref, verdict: 'engine_dead' });
          continue;
        }
        if (ages.heartbeatAgeMs === null) {
          // Live pid, no observable markers (tmp-wiped logs) — LEGACY, skip.
          verdicts.push({ launch_ref: launch.launch_ref, verdict: 'unobservable' });
          continue;
        }
        if (ages.heartbeatAgeMs > staleMs) {
          const kinds = treatFrozenLaunch(launch, ages);
          verdicts.push({ launch_ref: launch.launch_ref, verdict: 'freeze_treated', events: kinds });
        } else {
          verdicts.push({ launch_ref: launch.launch_ref, verdict: 'healthy' });
        }
      }
      return { swept: launches.length, verdicts };
    } catch (error) {
      console.error(`[engine-supervisor] sweep failed: ${error?.message ?? error}`);
      return { swept: 0, verdicts: [], error: String(error?.message ?? error) };
    } finally {
      sweeping = false;
    }
  }

  /**
   * Single-engine sweep before EVERY engine spawn from this panel. Verdicts:
   *   'already-running' — live pid, fresh heartbeat: the caller MUST NOT spawn
   *                       a duplicate (respond ok:'already-running' instead);
   *   'killed_frozen'   — live pid, stale heartbeat: the frozen corpse was
   *                       guarded-killed; the caller may spawn a fresh engine;
   *   'none'            — no observable running engine for the epic (dead pid
   *                       needs no cleanup; missing markers cannot be judged).
   */
  function sweepBeforeSpawn({ projectId, epicId }) {
    let launch = null;
    try {
      launch = withDb(db => db.prepare(
        `SELECT launch_ref, project_id, epic_id, engine_log_path, engine_pid
           FROM factory_launch_requests
          WHERE state='running' AND engine_pid IS NOT NULL AND engine_log_path IS NOT NULL
            AND epic_id=?
          ORDER BY rowid DESC LIMIT 1`,
      ).get(epicId));
    } catch {
      // Unmigrated schema (no engine marker columns yet) — nothing to observe.
      return { action: 'none', ok: 'spawn', detail: 'schema-not-migrated' };
    }
    if (!launch) return { action: 'none', ok: 'spawn' };
    if (projectId !== undefined && Number(projectId) !== Number(launch.project_id)) {
      return { action: 'none', ok: 'spawn' };
    }
    if (!brakeDeps.isAlive(launch.engine_pid)) return { action: 'none', ok: 'spawn' };
    const ages = markerAges(launch.engine_log_path);
    if (ages.heartbeatAgeMs !== null && ages.heartbeatAgeMs <= staleMs) {
      return { action: 'already_running', ok: 'already-running', launch_ref: launch.launch_ref, engine_pid: launch.engine_pid };
    }
    if (ages.heartbeatAgeMs === null) {
      // Live pid but no readable markers: unverifiable, fall through to the
      // existing liveness-based dedupe in EngineProcessAdministration.start().
      return { action: 'none', ok: 'spawn', detail: 'markers-unreadable' };
    }
    // Live pid, stale heartbeat → frozen corpse. Kill it (guarded), then let
    // the caller spawn fresh. Durable sweep receipt.
    const commandLine = brakeDeps.readCommandLine(launch.engine_pid);
    const guardedKill = commandLine !== null && commandLine.includes('orchestrate-cli.js');
    if (guardedKill) brakeDeps.killTree(launch.engine_pid);
    const killed = !brakeDeps.isAlive(launch.engine_pid);
    withDbWrite(db => recordEvent(db, launch, killed ? 'sweep_killed_frozen' : 'sweep_blocked_live', {
      reason: 'engine_watchdog_heartbeat_stale',
      heartbeatAgeMs: ages.heartbeatAgeMs,
      logAgeMs: ages.logAgeMs,
      detail: `pre-spawn sweep: ${killed ? 'frozen corpse killed' : `pid ${launch.engine_pid} survived the guarded kill`}`,
    }));
    return killed
      ? { action: 'killed_frozen', ok: 'spawn', launch_ref: launch.launch_ref, engine_pid: launch.engine_pid }
      : { action: 'kill_failed', ok: 'blocked', launch_ref: launch.launch_ref, engine_pid: launch.engine_pid };
  }

  function start() {
    if (!enabled() || timer) return;
    timer = setInterval(() => { sweepOnce(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    console.log(`[engine-supervisor] watchdog active (interval ${Math.round(intervalMs / 1000)}s, stale after ${Math.round(staleMs / 1000)}s)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, sweepOnce, sweepBeforeSpawn };
}
