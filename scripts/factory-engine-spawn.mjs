#!/usr/bin/env node
/**
 * Detached engine-host spawn for scripts/factory.mjs (E-P1 repair, stage-11
 * PREVENTIVE-HUNT Layer 3 / B-002 root).
 *
 * The old factory.mjs spawn claimed "detached so the factory outlives this
 * script" while passing only `{ stdio:'inherit', env }`:
 *
 *   - NO `detached:true` → the engine died with the operator's console
 *     (Ctrl+C, window close) and a terminal QuickEdit selection froze it via
 *     the inherited pipe (the B-002 freeze class);
 *   - NO `SAGA_ENGINE_LOG` → engineLog/heartbeat/phase markers were NOOP
 *     (engine-file-logger), so the stage-10 engine death was undiagnosable;
 *   - the launch row never got engine_log_path/engine_pid → the panel engine
 *     supervisor (tracker-view/engine-supervisor.mjs observableLaunches)
 *     filtered the launch out as LEGACY → freezes were undetectable AND
 *     unkillable by the watchdog, and the soft-stop engine brake had no pid.
 *
 * This module owns the full spawn contract (mirrors the two already-correct
 * spawners — src/app/product-lifecycle-run-starter.ts and
 * src/infrastructure/engine/engine-administration.ts — plus the durable
 * stamps):
 *
 *   1. `detached:true` + `child.unref()` — the factory outlives factory.mjs.
 *   2. stdio `['ignore', fd, fd]` — stdout AND stderr are append-mode file
 *      descriptors on the engine log, never the terminal (QuickEdit freeze)
 *      and never a pipe a stalled parent could fill (antifreeze layer A).
 *   3. `SAGA_ENGINE_LOG` is set to a durable path so engine-file-logger's
 *      heartbeat/phase markers live next to the log (observability contract
 *      the watchdog reads: `<log>.heartbeat` mtime stale + live pid = freeze).
 *   4. AFTER spawn: the launch row is stamped engine_log_path/engine_pid/
 *      engine_spawned_at (run-starter pattern) and
 *      lifecycle_execution_controls is stamped engine_state='running' +
 *      engine_pid + started_at (engine-administration pattern), idempotently —
 *      the start path creates the controls row, resume may not.
 *
 * Exported for the spawn-contract characterization test
 * (tests/app/factory-engine-spawn.test.mjs); scripts/factory.mjs is the only
 * production consumer.
 */
import Database from 'better-sqlite3';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Durable engine-log path under the run's log convention. Mirrors the
 * run-starter/engine-administration naming (`saga-engine-<epic>-<ts>.log`) in
 * the OS tmpdir, or under the operator-configured SAGA_ORCHESTRATION_LOG root
 * when set (the run's own log root, e.g. beside the sandbox DB).
 */
export function resolveEngineLogPath({ epicId = null, now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replaceAll(':', '-');
  const name = `saga-engine-${epicId ?? 'launch'}-${stamp}.log`;
  const configuredRoot = process.env.SAGA_ORCHESTRATION_LOG?.trim();
  if (configuredRoot) return join(configuredRoot, name);
  return join(tmpdir(), name);
}

function defaultCliPath() {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(join(here, '..', '..'));
  return join(repoRoot, 'dist', 'orchestrate-cli.js');
}

function defaultCompositionPath() {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(join(here, '..', '..'));
  const configured = process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION;
  return resolve(
    configured && configured.trim() !== ''
      ? configured
      : join(repoRoot, 'tracker-view', 'product-delivery-composition.mjs'),
  );
}

/** Read the launch's epic (log naming) — read-only, best-effort. */
function launchEpicId(dbPath, launchRef) {
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      'SELECT epic_id FROM factory_launch_requests WHERE launch_ref=?',
    ).get(launchRef);
    return row?.epic_id ?? null;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

/**
 * Durable post-spawn stamps (antifreeze layer C). Best-effort by design, the
 * same contract as the run-starter's marker binding: the engine is ALREADY
 * alive when this runs, so a failed stamp must not misreport the start as
 * failed — but it is loud, because an unstamped launch is a watchdog-blind
 * launch (exactly the E-P1 defect).
 */
function stampEngineBinding({ dbPath, launchRef, epicId, engineLog, pid }) {
  let db = null;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.prepare(
      `UPDATE factory_launch_requests
          SET engine_log_path=?, engine_pid=?, engine_spawned_at=datetime('now')
        WHERE launch_ref=?`,
    ).run(engineLog, pid ?? null, launchRef);
    if (pid != null && epicId != null) {
      // engine-administration upsertControl pattern: partial columns, ON
      // CONFLICT keeps every operator-owned column (concurrency, model
      // profile) of a pre-existing row.
      db.prepare(
        `INSERT INTO lifecycle_execution_controls (epic_id, engine_state, engine_pid, started_at)
         VALUES (?, 'running', ?, datetime('now'))
         ON CONFLICT(epic_id) DO UPDATE SET
           engine_state='running',
           engine_pid=excluded.engine_pid,
           started_at=excluded.started_at,
           updated_at=datetime('now')`,
      ).run(epicId, pid);
    }
    return true;
  } catch (error) {
    process.stderr.write(
      `[factory] WARNING: engine started but its durable binding failed `
      + `(watchdog/brake will not see this launch): `
      + `${error instanceof Error ? error.message : String(error)}\n`
      + `[factory] engine log (observe manually): ${engineLog}\n`,
    );
    return false;
  } finally {
    if (db) db.close();
  }
}

/**
 * Spawn the runtime host (orchestrate-cli) DETACHED with file-backed stdio and
 * durably bind it to the launch. Returns `{ child, engineLog, epicId }`. The
 * caller (factory.mjs) exits right after — the engine must outlive it.
 */
export function spawnOrchestrateCliEngine({
  dbPath,
  launchRef,
  compositionPath,
  cliPath,
  baseEnv = process.env,
  spawnProcess = spawn,
  now = () => Date.now(),
  log = (line) => process.stdout.write(`[factory] ${line}\n`),
} = {}) {
  const resolvedCliPath = cliPath ?? defaultCliPath();
  if (!existsSync(resolvedCliPath)) {
    throw new Error(`orchestrate-cli.js not found at ${resolvedCliPath} — run 'npm run build' first`);
  }
  const resolvedComposition = compositionPath ?? defaultCompositionPath();
  if (!existsSync(resolvedComposition)) {
    throw new Error(
      `production lifecycle composition not found at ${resolvedComposition}; `
      + 'set SAGA_PRODUCT_LIFECYCLE_COMPOSITION to an existing ESM composition module',
    );
  }
  const epicId = launchEpicId(dbPath, launchRef);
  const engineLog = resolveEngineLogPath({ epicId, now: now() });
  mkdirSync(dirname(engineLog), { recursive: true });

  const childEnv = {
    ...baseEnv,
    DB_PATH: dbPath,
    // Package bytes are durable execution authority. Keep their default next
    // to the durable DB, not under the code checkout: container/image or
    // release-directory replacement must not make an unchanged active
    // installation look corrupt on resume. Explicit operator configuration
    // remains authoritative.
    SAGA_PACKAGE_STORE_DIR: baseEnv.SAGA_PACKAGE_STORE_DIR?.trim()
      || join(dirname(resolve(dbPath)), 'package-store'),
    SAGA_PRODUCT_LIFECYCLE_COMPOSITION: resolvedComposition,
    // The engine's own logging + heartbeat/phase markers (engine-file-logger)
    // target this file; the watchdog reads `<engineLog>.heartbeat`.
    SAGA_ENGINE_LOG: engineLog,
  };

  // stdio to FILES, not the terminal: an append-mode fd for stdout AND stderr.
  // File writes never block on a parent event loop and never freeze on a
  // terminal QuickEdit selection. The fd is closed in the parent right after
  // spawn — the child holds its own inherited copy.
  const logFd = openSync(engineLog, 'a');
  let child;
  try {
    child = spawnProcess('node', [resolvedCliPath, `--launch-ref=${launchRef}`], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  // C-5 (stage-11 PREVENTIVE-HUNT Layer 6): stamp the DURABLE worker-backend
  // marker next to the engine log. The tracker's /api/model/set guard reads it
  // (factory_launch_requests.engine_log_path + '.worker-backend') so an engine
  // spawned on the agent-proxy shim refuses the ~/.claude/settings.json switch
  // EVEN WHEN the tracker process itself lacks the env markers — the bd81b02b
  // recurrence vector. Best-effort: a failed marker write warns loudly but must
  // not kill an already-alive engine.
  try {
    const launcher = `${childEnv.SAGA_REAL_CLAUDE_PATH ?? ''} ${childEnv.SAGA_CLAUDE_PATH ?? ''}`;
    const backend = /agent-proxy/.test(launcher) ? 'agent-proxy' : 'claude-cli';
    writeFileSync(`${engineLog}.worker-backend`, `${backend}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(
      `[factory] WARNING: engine started but its worker-backend marker failed `
      + `(/api/model/set cannot durably detect the shim for this launch): `
      + `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (typeof child.on === 'function') {
    // Spawn-time errors (node missing, EMFILE): the script exits right after
    // this call, so surface the failure instead of dying silently.
    child.on('error', (error) => {
      process.stderr.write(`[factory] engine spawn error: ${error?.message ?? error}\n`);
    });
  }

  stampEngineBinding({ dbPath, launchRef, epicId, engineLog, pid: child.pid ?? null });

  log(`engine detached pid=${child.pid ?? 'unknown'} log=${engineLog}`);
  log(`observe: tail -f "${engineLog}" (heartbeat marker: "${engineLog}.heartbeat")`);
  return { child, engineLog, epicId };
}
