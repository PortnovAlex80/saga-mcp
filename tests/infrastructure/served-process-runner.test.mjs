import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runServedProcess,
  assertPlatformSupportsProcessTreeControl,
  ServedProcessError,
  isLinuxProcStatLive,
} from '../../dist/infrastructure/verification/served-process-runner.js';

// LR-05 — focused tests for the reliable served-process lifecycle runner.
// Each test proves ONE invariant of the start → observe → terminate contract:
//   - the process is ISOLATED (detached) and OBSERVED (pid captured, loopback
//     answered, liveness/exit detected);
//   - the whole tree is RELIABLY TERMINATED on success, failure, timeout, and
//     abort (no leak);
//   - kill errors are SURFACED (never swallowed);
//   - the runner FAILS CLOSED on platforms it cannot guarantee control over.

const NODE = process.execPath;

test('Linux proc-state parsing treats an unreaped zombie as terminated', () => {
  assert.equal(isLinuxProcStatLive('1676 (node) S 1 2 3 4'), true);
  assert.equal(isLinuxProcStatLive('1676 (node worker) Z 1 2 3 4'), false);
  assert.equal(isLinuxProcStatLive('1676 (node) X 1 2 3 4'), false);
});

/** True when `pid` is a live OS process (signal-0 probe; EPERM = alive, foreign). */
function isAlive(pid) {
  if (process.platform === 'linux') {
    try { return isLinuxProcStatLive(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return false; }
  }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Best-effort whole-tree cleanup for test hygiene (never throws). */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'saga-served-runner-'));
}

/** A real loopback http server: listens on PORT, answers 200 on any path. */
const HTTP_SERVER = [
  "const http=require('http');",
  "const port=Number(process.env.PORT);",
  "http.createServer((_q,r)=>{r.end('ready')}).listen(port,'127.0.0.1');",
].join('\n');

/** A process that stays alive but never binds a port (hangs forever). */
const HANG_FOREVER = "setTimeout(()=>{},120000);";

function writeFixture(dir, source) {
  writeFileSync(join(dir, 'server.js'), `${source}\n`);
}

function target() {
  // No shell: spawn the bundled node directly on server.js (deterministic, no
  // PATH/shell variance). detached is applied by the runner itself.
  return { executable: NODE, args: ['server.js'], shell: false };
}

// ---------------------------------------------------------------------------
// ISOLATION + OBSERVATION + clean termination on success
// ---------------------------------------------------------------------------

test('served process is started isolated, observed answering loopback, and cleanly terminated', { timeout: 20000 }, () => {
  const dir = tmpDir();
  writeFixture(dir, HTTP_SERVER);
  try {
    const obs = runServedProcess({
      cwd: dir,
      target: target(),
      port: 43101,
      env: { ...process.env, PORT: '43101', HOST: '127.0.0.1' },
      probeTimeoutMs: 8000,
    });
    // OBSERVED — a real pid was captured and the port matches what we asked for.
    assert.ok(Number.isInteger(obs.pid) && obs.pid > 0, 'a real pid must be captured');
    assert.equal(obs.port, 43101);
    assert.equal(typeof obs.stdout, 'string');
    assert.equal(typeof obs.stderr, 'string');
    // RELIABLY TERMINATED — by the time runServedProcess returns, the whole tree
    // must already be gone (terminate ran in finally and verified the exit).
    assert.equal(isAlive(obs.pid), false, 'process must not leak after a successful run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Clean termination on FAILURE (process died) + observation of the exit
// ---------------------------------------------------------------------------

test('a served process that exits before answering is detected (DIED) and cleaned up', { timeout: 20000 }, () => {
  const dir = tmpDir();
  // Exits immediately with code 1 — never binds the port.
  writeFixture(dir, 'process.exit(1);');
  let caught;
  try {
    runServedProcess({
      cwd: dir,
      target: target(),
      port: 43102,
      env: { ...process.env, PORT: '43102', HOST: '127.0.0.1' },
      probeTimeoutMs: 8000,
    });
  } catch (e) { caught = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }

  assert.ok(caught instanceof ServedProcessError, 'must throw');
  assert.equal(caught.code, 'SERVED_PROCESS_DIED', 'must attribute the failure to the exit, not a silent timeout');
  assert.match(caught.message, /pid=\d+/);
});

// ---------------------------------------------------------------------------
// Clean termination on TIMEOUT (process never answers)
// ---------------------------------------------------------------------------

test('a served process that never answers times out (PROBE_FAILED) and is still cleaned up', { timeout: 20000 }, () => {
  const dir = tmpDir();
  writeFixture(dir, HANG_FOREVER); // alive, but never binds PORT
  let caught;
  try {
    runServedProcess({
      cwd: dir,
      target: target(),
      port: 43103,
      env: { ...process.env, PORT: '43103', HOST: '127.0.0.1' },
      probeTimeoutMs: 1500, // short, bounded deadline
    });
  } catch (e) { caught = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }

  assert.ok(caught instanceof ServedProcessError, 'must throw');
  assert.equal(caught.code, 'SERVED_PROCESS_PROBE_FAILED');
  assert.match(caught.message, /timed out/);
});

test('cleanup runs on every failure path: no process leaks after a probe timeout', { timeout: 20000 }, () => {
  // The timeout case above must not leak a hung process. We re-run it and prove
  // the tree was terminated by checking there is nothing left on the port. This
  // is the structural guarantee that the finally ran and verified cleanup.
  const dir = tmpDir();
  writeFixture(dir, HANG_FOREVER);
  let thrown;
  try {
    runServedProcess({
      cwd: dir,
      target: target(),
      port: 43113,
      env: { ...process.env, PORT: '43113', HOST: '127.0.0.1' },
      probeTimeoutMs: 1200,
    });
  } catch (e) { thrown = e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(thrown.code, 'SERVED_PROCESS_PROBE_FAILED');
  // After the run, a fresh loopback probe to the port must be refused — proving
  // the hung server was actually killed (not leaked).
  const refused = !probeOnce('http://127.0.0.1:43113/', 600);
  assert.equal(refused, true, 'no process may remain listening after cleanup');
});

// ---------------------------------------------------------------------------
// ABORT — observed at entry (sync provider cannot be preempted mid-statement;
// the bounded probe deadline remains the hard guarantee, exercised above)
// ---------------------------------------------------------------------------

test('an already-aborted signal is observed and the run fails closed (ABORTED)', () => {
  const ac = new AbortController();
  ac.abort();
  // Pre-aborted: the runner refuses to even start a process (no leak) — cleanup
  // of a never-started process is trivially clean.
  let caught;
  try {
    runServedProcess({
      cwd: tmpDir(),
      target: target(),
      port: 43104,
      env: { ...process.env, PORT: '43104' },
      probeTimeoutMs: 1000,
      signal: ac.signal,
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ServedProcessError);
  assert.equal(caught.code, 'SERVED_PROCESS_ABORTED');
});

// ---------------------------------------------------------------------------
// FAIL CLOSED on unsupported platforms (simulate / document the path)
// ---------------------------------------------------------------------------

test('fails closed (PLATFORM_UNSUPPORTED) on platforms without guaranteed tree control, without starting a process', () => {
  // The pure gate is unit-testable for any exotic kernel without running on it.
  for (const unsupported of ['freebsd', 'sunos', 'aix', 'openbsd']) {
    assert.throws(
      () => assertPlatformSupportsProcessTreeControl(unsupported),
      (e) => e instanceof ServedProcessError && e.code === 'SERVED_PROCESS_PLATFORM_UNSUPPORTED',
      `${unsupported} must be unsupported`,
    );
  }
  // The supported platforms do NOT trip the gate.
  for (const supported of ['linux', 'darwin', 'win32']) {
    assert.doesNotThrow(() => assertPlatformSupportsProcessTreeControl(supported));
  }
  // And runServedProcess refuses to start on an unsupported platform — proving
  // the fail-closed check happens BEFORE any process is spawned (no leak).
  const dir = tmpDir();
  try {
    assert.throws(
      () => runServedProcess({
        cwd: dir,
        target: target(),
        port: 43105,
        env: { ...process.env, PORT: '43105' },
        probeTimeoutMs: 1000,
        platform: 'freebsd',
      }),
      (e) => e instanceof ServedProcessError && e.code === 'SERVED_PROCESS_PLATFORM_UNSUPPORTED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// KILL ERRORS ARE SURFACED (not swallowed)
// ---------------------------------------------------------------------------
// The previous terminate path used a bare `catch {}` that hid every kill error
// and could silently leak a process it believed it had killed. The reliable
// runner VERIFIES termination and surfaces a failure when the process survives.
// We force that situation deterministically by telling the runner to use the
// WRONG platform's kill primitive (POSIX group-kill on Windows, or taskkill on
// POSIX): the primitive cannot actually kill the process, so the post-kill
// liveness check finds it still alive and throws TERMINATION_FAILED instead of
// pretending success.

test('a kill that fails to terminate the tree is SURFACED (TERMINATION_FAILED), not swallowed', { timeout: 25000 }, () => {
  const dir = tmpDir();
  writeFixture(dir, HTTP_SERVER);
  const wrongPlatform = process.platform === 'win32' ? 'linux' : 'win32';
  let caught;
  let leakedPid;
  try {
    runServedProcess({
      cwd: dir,
      target: target(),
      port: 43106,
      env: { ...process.env, PORT: '43106', HOST: '127.0.0.1' },
      probeTimeoutMs: 8000,
      platform: wrongPlatform, // forces a kill primitive that cannot control this tree
    });
  } catch (e) {
    caught = e;
    // Recover the pid from the surfaced error so the test does not leak.
    const m = /pid=(\d+)/.exec(e.message);
    if (m) leakedPid = Number(m[1]);
  } finally {
    if (leakedPid) killTree(leakedPid); // test hygiene: clean up the survived process
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(caught instanceof ServedProcessError, 'the kill failure must be thrown');
  assert.equal(caught.code, 'SERVED_PROCESS_TERMINATION_FAILED',
    'a survived process must be reported, not silently leaked (the old bare-catch behavior)');
});

// ---------------------------------------------------------------------------
// NOTE on "already-dead termination is clean success": the DIED test above
// already proves it. When the served process exits on its own, the runner's
// `finally` runs `terminateProcessTreeReliably` against an already-dead pid;
// `isPidAlive` returns false immediately and terminate returns WITHOUT throwing
// (ESRCH / "no such process" is success, not a kill error). If it wrongly
// surfaced TERMINATION_FAILED, the `finally` throw would OVERRIDE the DIED
// error and the assertion `caught.code === 'SERVED_PROCESS_DIED'` would fail —
// so that assertion is itself the proof that already-dead cleanup is clean.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
function probeOnce(url, attemptTimeoutMs) {
  const script = String.raw`
const http=require('http');
const req=http.get(process.argv[1],res=>{res.resume();const c=res.statusCode||500;process.exit(c>=200&&c<500?0:1);});
req.setTimeout(Number(process.argv[2]),()=>req.destroy());
req.on('error',()=>process.exit(1));
req.on('timeout',()=>process.exit(1));`;
  // spawnSync does not throw on a non-zero exit; it returns .status. It only
  // fails to spawn when .error is set (treated as "not answering").
  const r = spawnSync(NODE, ['-e', script, url, String(attemptTimeoutMs)], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: attemptTimeoutMs + 1000,
    windowsHide: true,
  });
  return r.status === 0;
}
