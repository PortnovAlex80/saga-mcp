import { execFileSync, spawn, spawnSync } from 'node:child_process';

/**
 * LR-05 — a focused, RELIABLE lifecycle runner for the served process a local
 * readiness check starts on loopback. It makes three guarantees the previous
 * inline spawn/terminate path could not:
 *
 *   1. ISOLATION — the serve command is spawned DETACHED so it becomes its own
 *      process-group leader (POSIX setsid) / is created in a new process group
 *      (win32). That is what makes whole-tree termination targetable: on POSIX
 *      `process.kill(-pid)` only reaches the whole group when the child IS the
 *      group leader. Spawning non-detached left the child in the parent's group,
 *      so a group kill would have targeted the wrong group (the provider's own).
 *
 *   2. OBSERVATION — the runner proves the process started (a real pid), probes
 *      loopback until it answers, and DETECTS the process's liveness/exit on
 *      every probe iteration (a process that exits before answering is reported
 *      as `SERVED_PROCESS_DIED`, not silently retried until the deadline).
 *
 *   3. RELIABLE TERMINATION — the whole process tree is cleaned up in a finally
 *      block that runs on success, failure, probe-timeout, and abort. Kill is
 *      escalated (graceful → force) and then VERIFIED; kill errors are SURFACED
 *      (never swallowed). When the platform cannot guarantee whole-tree control,
 *      the runner refuses to start (fail closed) rather than leak a process.
 *
 * The runner is SYNCHRONOUS by design: the gate-run-driver rejects async
 * providers (`ASYNC_CHECK_PROVIDER_UNSUPPORTED`), so the readiness provider's
 * `run` must return a value, not a promise. A long-running server cannot be
 * started with `spawnSync` (it would block until exit), so the server itself is
 * started with async `spawn` while the probe + terminate phases drive it via
 * synchronous OS primitives (`process.kill(pid,0)` liveness, `execFileSync`
 * single-shot HTTP probes, `spawnSync` taskkill).
 */

/**
 * Platforms on which the runner can GUARANTEE whole-process-tree control. On any
 * other platform {@link runServedProcess} refuses to start (fail closed) instead
 * of launching a served process it cannot reliably clean up.
 */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['linux', 'darwin', 'win32']);

/**
 * Grace window after a graceful (SIGTERM / taskkill tree) signal before
 * escalating to a force kill. Bounded so cleanup cannot hang.
 */
const TERMINATE_GRACE_MS = 1500;
/**
 * Window after a force kill (SIGKILL / `taskkill /T /F`) during which the
 * process must be observed gone. Bounded so cleanup cannot hang.
 */
const TERMINATE_FORCE_WAIT_MS = 2500;
/** Liveness poll interval while waiting for a signaled process to exit. */
const EXIT_POLL_INTERVAL_MS = 25;
/** Liveness poll interval between loopback probe attempts. */
const PROBE_POLL_INTERVAL_MS = 120;
/** Per-attempt HTTP connect/read timeout for one loopback probe shot. */
const PROBE_ATTEMPT_TIMEOUT_MS = 600;
/** Cap on captured stdout/stderr per stream (best-effort, for evidence digests). */
const MAX_STREAM_CAPTURE = 16_384;

export interface CommandTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export interface ServedProcessRunOptions {
  /** Absolute working directory to spawn the serve command in. */
  readonly cwd: string;
  /** Resolved spawn target (executable + args + shell) from the profile command. */
  readonly target: CommandTarget;
  /** Deterministic loopback port the serve command listens on (via PORT env). */
  readonly port: number;
  /** Environment for the served process. */
  readonly env: NodeJS.ProcessEnv;
  /** Loopback probe deadline (ms) — bounds the start→answer phase. */
  readonly probeTimeoutMs: number;
  /**
   * Optional abort signal. When already aborted (or observed aborted between
   * probe attempts) the runner terminates the process and throws
   * `SERVED_PROCESS_ABORTED`; cleanup still runs. Sync code cannot be
   * interrupted mid-statement, so abortion is observed at probe-iteration
   * boundaries — the bounded probe deadline remains the hard outer guarantee.
   */
  readonly signal?: AbortSignal;
  /**
   * Injection seam for tests: override the platform used for the support gate
   * and the platform-specific kill path. Defaults to `process.platform`.
   */
  readonly platform?: string;
}

export interface ServedProcessObservation {
  /** The captured OS pid of the started (detached) serve process. */
  readonly pid: number;
  /** The loopback port the process answered on. */
  readonly port: number;
  /** Best-effort captured stdout (already capped). Caller digests for evidence. */
  readonly stdout: string;
  /** Best-effort captured stderr (already capped). Caller digests for evidence. */
  readonly stderr: string;
}

export type ServedProcessErrorCode =
  /** Platform cannot guarantee whole-tree control — refused to start. */
  | 'SERVED_PROCESS_PLATFORM_UNSUPPORTED'
  /** Spawn did not produce a pid (the serve command did not start). */
  | 'SERVED_PROCESS_NOT_STARTED'
  /** The serve process exited before answering on loopback. */
  | 'SERVED_PROCESS_DIED'
  /** Loopback probe did not succeed before the deadline. */
  | 'SERVED_PROCESS_PROBE_FAILED'
  /** The run was aborted via its abort signal. */
  | 'SERVED_PROCESS_ABORTED'
  /** The process tree could not be killed/verified gone — surfaced, fail closed. */
  | 'SERVED_PROCESS_TERMINATION_FAILED';

export class ServedProcessError extends Error {
  readonly code: ServedProcessErrorCode;
  constructor(code: ServedProcessErrorCode, message: string) {
    super(message);
    this.name = 'ServedProcessError';
    this.code = code;
  }
}

/**
 * Fail closed when the platform cannot guarantee whole-process-tree control.
 * Exported (and pure) so the unsupported path is unit-testable without running
 * on an exotic kernel: pass `'freebsd'` / `'sunos'` / … and assert it throws.
 */
export function assertPlatformSupportsProcessTreeControl(platform: string): void {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new ServedProcessError(
      'SERVED_PROCESS_PLATFORM_UNSUPPORTED',
      `cannot guarantee whole-process-tree control on platform '${platform}'; `
        + 'refusing to start a served process (fail closed)',
    );
  }
}

/**
 * Start the served process isolated, observe it until loopback answers, then
 * (in a finally) reliably terminate the whole tree. Throws {@link ServedProcessError}
 * on any lifecycle failure so the caller can record a fail-closed readiness
 * outcome. Never swallows a kill error: ESRCH / "no such process" is success
 * (the process is already gone); every other failure is surfaced.
 */
export function runServedProcess(opts: ServedProcessRunOptions): ServedProcessObservation {
  const platform = opts.platform ?? process.platform;
  // Fail closed BEFORE spawning: if we cannot guarantee cleanup, do not start.
  assertPlatformSupportsProcessTreeControl(platform);

  if (opts.signal?.aborted) {
    throw new ServedProcessError('SERVED_PROCESS_ABORTED', 'serve run aborted before start');
  }

  // ISOLATION — detached makes the child its own process-group leader (POSIX
  // setsid) / a new process group (win32), which is what makes -pid / taskkill
  // /T target the whole tree. We do NOT unref: we own the lifecycle and
  // terminate it explicitly below.
  const child = spawn(opts.target.executable, opts.target.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    shell: opts.target.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // OBSERVATION — capture the pid and prove the process actually started.
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) {
    // A synchronous spawn failure also surfaces via the 'error' event, but the
    // pid being absent is the deterministic signal we can act on right here.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    throw new ServedProcessError(
      'SERVED_PROCESS_NOT_STARTED',
      'serve command did not start a process (no pid)',
    );
  }

  let stdout = '';
  let stderr = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  child.stdout?.on('data', chunk => {
    if (stdout.length < MAX_STREAM_CAPTURE) stdout += String(chunk).slice(0, MAX_STREAM_CAPTURE - stdout.length);
  });
  child.stderr?.on('data', chunk => {
    if (stderr.length < MAX_STREAM_CAPTURE) stderr += String(chunk).slice(0, MAX_STREAM_CAPTURE - stderr.length);
  });
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.once('error', err => { spawnError = err; });

  try {
    observeUntilReady(pid, opts.port, opts.probeTimeoutMs, opts.signal, () => exited, () => spawnError);
    return { pid, port: opts.port, stdout, stderr };
  } finally {
    // RELIABLE TERMINATION — runs on success, failure, probe-timeout, and abort.
    // Streams are destroyed to release libuv handles for the (now dead) child so
    // the synchronous caller does not leave an open handle behind.
    terminateProcessTreeReliably(pid, platform);
    try { child.stdout?.destroy(); } catch { /* destroyed */ }
    try { child.stderr?.destroy(); } catch { /* destroyed */ }
  }
}

/**
 * Probe loopback until the process answers, the deadline elapses, the process
 * dies, or the run is aborted. Detects liveness on every iteration so a process
 * that exits before answering is reported as `SERVED_PROCESS_DIED` promptly
 * rather than retried until the probe deadline.
 */
function observeUntilReady(
  pid: number,
  port: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  getExited: () => { code: number | null; signal: NodeJS.Signals | null } | null,
  getSpawnError: () => Error | null,
): void {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) {
      throw new ServedProcessError('SERVED_PROCESS_ABORTED', `serve run aborted (pid=${pid})`);
    }
    const err = getSpawnError();
    if (err) {
      throw new ServedProcessError('SERVED_PROCESS_NOT_STARTED', `serve process failed to start: ${err.message}`);
    }
    // OBSERVATION — detect exit via the OS liveness probe (works even while the
    // synchronous probe shot below blocks the delivery of the 'exit' event).
    if (!isPidAlive(pid)) {
      const exit = getExited();
      const detail = exit ? ` (code=${exit.code}, signal=${exit.signal})` : '';
      throw new ServedProcessError(
        'SERVED_PROCESS_DIED',
        `serve process pid=${pid} exited before answering on loopback${detail}`,
      );
    }
    if (probeLoopbackOnce(url, PROBE_ATTEMPT_TIMEOUT_MS)) {
      return; // observed answering on loopback
    }
    if (Date.now() >= deadline) {
      // Final attribution: a process that died on the last attempt is reported
      // as DIED rather than a plain timeout.
      if (!isPidAlive(pid)) {
        throw new ServedProcessError(
          'SERVED_PROCESS_DIED',
          `serve process pid=${pid} exited during loopback probe`,
        );
      }
      throw new ServedProcessError(
        'SERVED_PROCESS_PROBE_FAILED',
        `loopback readiness probe timed out after ${deadlineMs}ms (pid=${pid}, port=${port})`,
      );
    }
    sleepSync(PROBE_POLL_INTERVAL_MS);
  }
}

/**
 * One synchronous loopback HTTP GET via a throwaway node process. Resolves true
 * when the endpoint answered with a non-5xx status; false on any connect/read
 * failure or timeout. Keeping each shot to a single attempt lets the caller
 * interleave liveness checks so a dead process is detected promptly.
 *
 * Exported so the docker readiness executor can reuse the exact same host-side
 * loopback probe against a docker-published port (the port is published to
 * 127.0.0.1, so the probe is identical whether the server is a host process or
 * a container).
 */
export function probeLoopbackOnce(url: string, attemptTimeoutMs: number): boolean {
  const script = String.raw`
const http=require('http');
const url=process.argv[1];
const to=Number(process.argv[2]);
const req=http.get(url,res=>{
  res.resume();
  const c=res.statusCode||500;
  process.exit(c>=200&&c<500?0:1);
});
req.setTimeout(to,()=>req.destroy());
req.on('error',()=>process.exit(1));
req.on('timeout',()=>process.exit(1));`;
  try {
    execFileSync(process.execPath, ['-e', script, url, String(attemptTimeoutMs)], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: attemptTimeoutMs + 1000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate the whole process tree and VERIFY it is gone. Kill errors are
 * surfaced (never swallowed): a "no such process" outcome is success (the
 * process is already gone), but every other error is thrown as
 * `SERVED_PROCESS_TERMINATION_FAILED`. If the process survives the force step,
 * the runner fails closed rather than assuming cleanup succeeded.
 *
 * POSIX: the child was spawned detached, so it is a process-group leader and
 * `process.kill(-pid, sig)` reaches the whole group. win32: `taskkill /T /F`
 * walks the process tree from the pid; Windows has no portable graceful tree
 * signal, so the force step is the reliable path (the graceful step is a
 * best-effort `taskkill /T` without `/F`).
 */
function terminateProcessTreeReliably(pid: number, platform: string): void {
  if (!isPidAlive(pid)) return; // already gone — success, nothing to do

  if (platform === 'win32') {
    // Windows: graceful best-effort, then force /T /F.
    killTreeStep(pid, platform, 'graceful');
    waitForExit(pid, TERMINATE_GRACE_MS);
    if (!isPidAlive(pid)) return;
    killTreeStep(pid, platform, 'force');
    waitForExit(pid, TERMINATE_FORCE_WAIT_MS);
  } else {
    // POSIX: SIGTERM the group, then escalate to SIGKILL.
    killTreeStep(pid, platform, 'graceful');
    waitForExit(pid, TERMINATE_GRACE_MS);
    if (!isPidAlive(pid)) return;
    killTreeStep(pid, platform, 'force');
    waitForExit(pid, TERMINATE_FORCE_WAIT_MS);
  }

  if (isPidAlive(pid)) {
    // Survived SIGKILL / taskkill /T /F — we cannot guarantee cleanup.
    // Fail closed and surface it (do NOT pretend success).
    throw new ServedProcessError(
      'SERVED_PROCESS_TERMINATION_FAILED',
      `serve process pid=${pid} survived force tree-kill; cleanup could not be verified`,
    );
  }
}

function killTreeStep(pid: number, platform: string, mode: 'graceful' | 'force'): void {
  try {
    if (platform === 'win32') {
      const args = mode === 'force' ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      const result = spawnSync('taskkill', args, { windowsHide: true, timeout: 10_000 });
      // A missing taskkill binary is a real failure — surface it. A non-zero
      // status ("no such process") is not: we verify via liveness below.
      if (result.error) throw result.error;
      return;
    }
    // POSIX: -pid targets the whole process group (child is its own leader).
    process.kill(-pid, mode === 'graceful' ? 'SIGTERM' : 'SIGKILL');
  } catch (error) {
    // ESRCH = no such process → already gone, not an error. Everything else
    // (EPERM, missing taskkill, …) is SURFACED.
    if (!isErrnoCode(error, 'ESRCH')) {
      throw new ServedProcessError(
        'SERVED_PROCESS_TERMINATION_FAILED',
        `tree-kill (${mode}) for pid=${pid} failed: ${errorMessage(error)}`,
      );
    }
  }
}

function waitForExit(pid: number, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    sleepSync(EXIT_POLL_INTERVAL_MS);
  }
}

/**
 * Liveness check via a signal-0 probe. `process.kill(pid, 0)` throws ESRCH when
 * the pid is gone and EPERM when it exists but is owned by another user (i.e.
 * still alive) — identical on every supported platform, so no platform branch.
 * Inlined (rather than imported from worker-executions) to keep this focused
 * runner free of the worker-supervision module's DB/lifecycle coupling; the
 * idiom is identical.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Block the current thread for `ms` without spinning (Atomics.wait). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (rare sandbox): fall back to a bounded busy
    // wait so the poll loop still throttles. Cleanup stays bounded by the
    // outer probe/terminate deadlines either way.
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}
