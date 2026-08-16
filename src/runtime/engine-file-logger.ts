/**
 * Engine file-only logger + liveness markers (antifreeze layer A+B1).
 *
 * WHY THIS EXISTS: the engine host (dist/orchestrate-cli.js) is spawned by
 * the panel with piped stdio. If the panel — the pipe reader — stalls or
 * dies, the OS pipe buffer fills and the next blocking
 * `process.stdout.write` in the engine blocks the main thread FOREVER: the
 * process stays "alive" while every timer dies and the log ends mid-line.
 * Routing ALL engine output to an append-only file removes that freeze
 * class structurally — file writes never wait on the panel's event loop.
 *
 * Contract:
 *  - `engineLog(line)` appends exactly one line to `$SAGA_ENGINE_LOG`.
 *    NOOP when the env is unset: in-process hosts, tests and the panel must
 *    not spray log files. A write failure (disk full, deleted directory…)
 *    is swallowed — logging must never take the engine down.
 *  - `initEngineMarkers()` creates the heartbeat file and truncates an
 *    oversized phase file. Call once at engine start.
 *  - `engineHeartbeatTouch()` bumps the mtime of `$SAGA_ENGINE_LOG.heartbeat`
 *    at least every 5 seconds. External observers can detect a frozen main
 *    thread by a stale heartbeat mtime: a blocked main thread cannot run
 *    timers, so the timestamp stops advancing while the process still looks
 *    alive in the process table.
 *  - `enginePhaseMark(name)` appends a short line to
 *    `$SAGA_ENGINE_LOG.phase` on every main-loop phase transition. The file
 *    grows slowly and is truncated at startup above 64KB, so the LAST
 *    written phase is always cheap to read even after a freeze.
 *
 * Everything here is synchronous on purpose: the whole point of the module
 * is to work when the event loop is unhealthy, and each call is a single
 * tiny append. All env reads happen per call (not at import) so tests can
 * toggle the env around individual calls.
 */

import {
  appendFileSync,
  existsSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

const HEARTBEAT_SUFFIX = '.heartbeat';
const PHASE_SUFFIX = '.phase';
/** Phase files grow one short line per main-loop transition; 64KB is days
 * of running. Truncate at startup instead of unbounded growth. */
const PHASE_TRUNCATE_BYTES = 64 * 1024;

function engineLogPath(): string | null {
  const configured = process.env.SAGA_ENGINE_LOG?.trim();
  return configured ? configured : null;
}

/**
 * Append one line to the engine file log. NOOP unless SAGA_ENGINE_LOG is
 * set (the production starter always sets it for the engine child). Never
 * throws: a broken log sink must not become a broken engine.
 */
export function engineLog(line: string): void {
  const target = engineLogPath();
  if (target === null) return;
  try {
    appendFileSync(target, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    /* best-effort by design */
  }
}

/**
 * Create the liveness marker files next to the engine log and reset an
 * oversized phase file. Idempotent; safe to call on every engine start.
 */
export function initEngineMarkers(): void {
  const target = engineLogPath();
  if (target === null) return;
  try {
    const heartbeatPath = `${target}${HEARTBEAT_SUFFIX}`;
    if (!existsSync(heartbeatPath)) {
      writeFileSync(heartbeatPath, '');
    }
    engineHeartbeatTouch();
  } catch {
    /* best-effort by design */
  }
  try {
    const phasePath = `${target}${PHASE_SUFFIX}`;
    if (existsSync(phasePath)) {
      if (statSync(phasePath).size > PHASE_TRUNCATE_BYTES) {
        truncateSync(phasePath, 0);
      }
    }
  } catch {
    /* best-effort by design */
  }
}

/**
 * Bump the heartbeat file mtime WITHOUT growing the file (utimes, not
 * append). Called from a 5s interval — when the main thread freezes the
 * timer stops firing and the mtime goes stale, which is exactly the
 * externally observable freeze signal.
 */
export function engineHeartbeatTouch(): void {
  const target = engineLogPath();
  if (target === null) return;
  try {
    const heartbeatPath = `${target}${HEARTBEAT_SUFFIX}`;
    const now = new Date();
    // Recreate on-the-fly if an operator cleanup deleted the file.
    if (!existsSync(heartbeatPath)) {
      writeFileSync(heartbeatPath, '');
    }
    utimesSync(heartbeatPath, now, now);
  } catch {
    /* best-effort by design */
  }
}

/**
 * Record a main-loop phase transition (`runEpisode`, `dispatch`,
 * `wait-poll task=…`, `supervision`, `checkpoint`, …) as one short line.
 * The last line of the phase file is the engine's last known position —
 * the first thing to read after a freeze.
 */
export function enginePhaseMark(phase: string): void {
  const target = engineLogPath();
  if (target === null) return;
  try {
    appendFileSync(
      `${target}${PHASE_SUFFIX}`,
      `${new Date().toISOString()} ${phase}\n`,
    );
  } catch {
    /* best-effort by design */
  }
}
