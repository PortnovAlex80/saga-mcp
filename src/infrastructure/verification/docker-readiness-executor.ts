import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../shared/canonical-json.js';
import { probeLoopbackOnce } from './served-process-runner.js';
import {
  commandFailureDetail,
  type ExecutorDescription,
  type ReadinessExecutor,
  type ServeEvidence,
  ReadinessExecutionError,
} from './readiness-executor.js';

/**
 * Phase-1 docker readiness executor — runs the profile-stated install/test/serve
 * commands inside the worker-declared Docker image.
 *
 * The executor is SYNCHRONOUS (the gate-run-driver rejects async providers).
 * Every docker CLI call goes through execFileSync/spawnSync with bounded
 * timeouts. No dockerode, no daemon API — just the docker CLI, the same way a
 * human runs `docker run`.
 *
 * Tree transfer: the sealed git archive tar (the exact frozen commitSha's tree)
 * is streamed into a named docker volume via a throwaway alpine container. This
 * avoids bind mounts (which the task forbids and which break on Windows path
 * translation) — the tar bytes are substrate-neutral. `git archive` already
 * excludes gitignored paths (node_modules etc.), so the volume carries only
 * tracked files.
 *
 * Fail-closed policy: when the profile declares an image but docker is
 * unavailable (daemon down, not linux), the executor throws
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE. The provider catches this INSIDE its
 * try block and records outcome 'failed' (NOT 'error', which would retry
 * indefinitely). This is deliberate: the product declared a docker substrate,
 * so the provider refuses to silently fall back to host.
 */

/** `docker info` availability probe timeout (bounded so a hung daemon does not stall the gate). */
const DOCKER_INFO_TIMEOUT_MS = 8_000;
/** `docker pull` timeout — matches the install phase budget. */
const DOCKER_PULL_TIMEOUT_MS = 600_000;
/** `docker volume rm` / `docker rm -f` cleanup timeout. */
const DOCKER_RM_TIMEOUT_MS = 30_000;
/** Tree-copy (tar stream into volume) timeout. */
const DOCKER_TREE_COPY_TIMEOUT_MS = 120_000;
/** `docker run -d` (served start) timeout. */
const DOCKER_RUN_D_TIMEOUT_MS = 30_000;
/** Container state inspect timeout per poll. */
const DOCKER_INSPECT_TIMEOUT_MS = 5_000;
/** `docker logs` capture timeout. */
const DOCKER_LOGS_TIMEOUT_MS = 10_000;
/** Best-effort capture cap per stream (matches the host served runner). */
const MAX_STREAM_CAPTURE = 16_384;
/** Loopback probe poll interval (matches the host served runner). */
const PROBE_POLL_INTERVAL_MS = 120;
/** Per-attempt HTTP connect/read timeout for one loopback probe shot. */
const PROBE_ATTEMPT_TIMEOUT_MS = 600;

/**
 * Process-level docker availability cache. Probing `docker info` on every
 * command would be wasteful; the daemon state does not change within one
 * readiness check. Reset only by process restart.
 */
let dockerAvailabilityCache: { available: boolean; linux: boolean } | null = null;

/**
 * Probe whether the docker daemon is reachable and running a linux runtime.
 * Cached for the process lifetime. Returns { available: false } when the daemon
 * is down, unreachable, or the CLI is absent. Returns { available: true, linux:
 * false } when the daemon is up but the OSType is not linux (e.g. a Windows
 * container runtime) — the executor refuses non-linux because PORT/HOST/CI env
 * conventions and alpine-based tree-copy assume linux.
 */
function checkDockerAvailable(): { available: boolean; linux: boolean } {
  if (dockerAvailabilityCache) return dockerAvailabilityCache;
  let result = { available: false, linux: false };
  try {
    const osType = execFileSync(
      'docker',
      ['info', '--format', '{{.OSType}}'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_INFO_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
      },
    ).trim();
    result = { available: true, linux: osType === 'linux' };
  } catch {
    result = { available: false, linux: false };
  }
  dockerAvailabilityCache = result;
  return result;
}

/**
 * Exported for tests: probe docker availability. Tests use this to decide
 * whether to run the docker e2e test or skip it. Returns true only when the
 * daemon is reachable AND running a linux runtime.
 */
export function isDockerAvailableForReadiness(): boolean {
  const docker = checkDockerAvailable();
  return docker.available && docker.linux;
}

/** Block the current thread for `ms` without spinning (Atomics.wait). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin — SharedArrayBuffer unavailable */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DockerReadinessExecutor implements ReadinessExecutor {
  private readonly volumeName: string;
  private volumeCreated = false;

  constructor(
    private readonly archivePath: string,
    private readonly image: string,
    private readonly candidateHash: string,
  ) {
    this.volumeName = `saga-lr-${randomBytes(6).toString('hex')}`;
  }

  /**
   * Lazily prepare the docker substrate: verify the daemon, ensure the image is
   * present (pull if needed), create the volume, and stream the sealed tree tar
   * into it. Idempotent — the second call is a no-op. Throws
   * ReadinessExecutionError on any substrate-level failure so the provider
   * records a decodable 'failed' outcome.
   */
  private ensurePrepared(): void {
    if (this.volumeCreated) return;
    // 1. Daemon availability + linux runtime.
    const docker = checkDockerAvailable();
    if (!docker.available) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
        'environment.image is declared but the docker daemon is not available '
          + '(docker info failed within 8s). The readiness profile declares a '
          + 'containerized substrate; refusing to fall back to host (fail closed). '
          + 'Start Docker Desktop / the docker daemon and re-run.',
      );
    }
    if (!docker.linux) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX',
        'environment.image is declared but the docker daemon OSType is not linux '
          + '(only linux containers are supported). The readiness profile declares '
          + 'a containerized linux substrate; refusing to run on a non-linux runtime.',
      );
    }
    // 2. Ensure the declared image is present locally (pull if absent).
    this.ensureImagePulled();
    // 3. Create a named volume and stream the sealed git archive tar into it.
    this.createVolumeAndCopyTree();
    this.volumeCreated = true;
  }

  private ensureImagePulled(): void {
    try {
      execFileSync('docker', ['image', 'inspect', this.image], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_INFO_TIMEOUT_MS,
        windowsHide: true,
      });
      return; // image already present locally
    } catch {
      // not found → fall through to pull
    }
    try {
      execFileSync('docker', ['pull', this.image], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_PULL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED',
        `docker image pull failed for "${this.image}": `
          + commandFailureDetail('docker pull', [this.image], error),
      );
    }
  }

  private createVolumeAndCopyTree(): void {
    try {
      execFileSync('docker', ['volume', 'create', this.volumeName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        windowsHide: true,
      });
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_VOLUME_CREATE_FAILED',
        `docker volume create "${this.volumeName}" failed: ${errorMessage(error)}`,
      );
    }
    // Stream the git archive tar into the volume via a throwaway alpine
    // container. The tar bytes are substrate-neutral (no Windows path
    // translation). alpine ships tar, so `tar -xf -` extracts the stream into
    // the volume-mounted /work. `git archive` already excludes gitignored
    // paths, so node_modules etc. are absent.
    let tarData: Buffer;
    try {
      tarData = readFileSync(this.archivePath);
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_TREE_COPY_FAILED',
        `could not read candidate archive "${this.archivePath}": ${errorMessage(error)}`,
      );
    }
    const result = spawnSync(
      'docker',
      ['run', '--rm', '-i', '-v', `${this.volumeName}:/work`, 'alpine', 'sh', '-c', 'tar -xf - -C /work'],
      {
        input: tarData,
        timeout: DOCKER_TREE_COPY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      const detail = typeof result.stderr === 'string'
        ? result.stderr
        : Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : '';
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_TREE_COPY_FAILED',
        `docker tree copy into volume "${this.volumeName}" failed (exit status=${result.status}): ${detail.slice(-2000)}`,
      );
    }
  }

  runCommand(command: string, timeoutMs: number): void {
    this.ensurePrepared();
    // The command runs verbatim via `sh -c` inside the container. No npm/node
    // routing, no ./ stripping, no JVM env — the image IS the environment. CI=1
    // matches the host executor's convention so the product's test command
    // behaves the same in both substrates.
    try {
      execFileSync('docker', [
        'run', '--rm',
        '-v', `${this.volumeName}:/work`,
        '-w', '/work',
        '-e', 'CI=1',
        this.image,
        'sh', '-c', command,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run ${this.image} sh -c`,
        [command],
        error,
      ));
    }
  }

  runServed(startCommand: string, probeTimeoutMs: number, port: number): ServeEvidence {
    this.ensurePrepared();
    // Deterministic container name from the candidate hash (first 8 hex chars).
    // Pre-run collision cleanup: a prior crashed run may have left a container.
    const containerName = `saga-lr-${this.candidateHash.slice(0, 8)}`;
    this.removeContainer(containerName);
    // Start the serve command detached. The port is published to 127.0.0.1 so
    // the host-side loopback probe can reach it. HOST=0.0.0.0 tells the product
    // to bind all interfaces inside the container (binding 127.0.0.1 inside the
    // container would be unreachable from the host-published port).
    try {
      // docker run -d prints the container id to stdout; we track the container
      // by its deterministic name (for inspect/rm) rather than the id.
      execFileSync('docker', [
        'run', '-d',
        '--name', containerName,
        '-p', `127.0.0.1:${port}:${port}`,
        '-v', `${this.volumeName}:/work`,
        '-w', '/work',
        '-e', `PORT=${port}`,
        '-e', 'HOST=0.0.0.0',
        '-e', 'CI=1',
        this.image,
        'sh', '-c', startCommand,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RUN_D_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run -d ${this.image} sh -c`,
        [startCommand],
        error,
      ));
    }
    try {
      // Observe: poll the container state + host-side loopback probe until the
      // endpoint answers, the deadline elapses, or the container exits.
      this.observeContainerReady(containerName, port, probeTimeoutMs);
      // Capture logs for evidence digests (best-effort, capped).
      const { stdout, stderr } = this.captureLogs(containerName);
      return {
        port,
        containerName,
        stdoutDigest: sha256Hex(stdout),
        stderrDigest: sha256Hex(stderr),
      };
    } finally {
      // RELIABLE TERMINATION — the container is always removed (force) in a
      // finally that runs on success, probe-timeout, and container-exit.
      this.removeContainer(containerName);
    }
  }

  describe(): ExecutorDescription {
    return { substrate: 'docker', image: this.image };
  }

  dispose(): void {
    // Remove the named volume. Best-effort: a volume-leak does not invalidate
    // the readiness result (the outcome was already determined), but it should
    // be cleaned up so repeated runs do not accumulate stale volumes.
    if (!this.volumeCreated) return;
    try {
      execFileSync('docker', ['volume', 'rm', this.volumeName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RM_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // Best-effort — a leftover volume is a janitorial concern, not a gate failure.
    }
    this.volumeCreated = false;
  }

  /**
   * Poll the container state and the host-side loopback probe until the endpoint
   * answers, the deadline elapses, or the container exits before answering.
   * Mirrors the host served runner's observeUntilReady, but uses `docker inspect`
   * for liveness (the pid is inside the container namespace and not directly
   * killable/observable from the host).
   */
  private observeContainerReady(
    containerName: string,
    port: number,
    deadlineMs: number,
  ): void {
    const url = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const state = this.inspectContainer(containerName);
      if (state !== null && state.status !== 'running' && state.status !== 'created') {
        // The container exited (or is in a terminal state) before answering.
        throw new Error(
          `served container "${containerName}" exited before answering on loopback `
            + `(state=${state.status}, exitCode=${state.exitCode})`,
        );
      }
      if (probeLoopbackOnce(url, PROBE_ATTEMPT_TIMEOUT_MS)) {
        return; // endpoint is answering on loopback
      }
      if (Date.now() >= deadline) {
        // Final attribution: a container that died on the last attempt is
        // reported as exited rather than a plain timeout.
        const finalState = this.inspectContainer(containerName);
        if (finalState !== null && finalState.status !== 'running' && finalState.status !== 'created') {
          throw new Error(
            `served container "${containerName}" exited during loopback probe `
              + `(state=${finalState.status}, exitCode=${finalState.exitCode})`,
          );
        }
        throw new Error(
          `loopback readiness probe timed out after ${deadlineMs}ms `
            + `(container="${containerName}", port=${port})`,
        );
      }
      sleepSync(PROBE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Inspect the container's runtime state via `docker inspect`. Returns null
   * when the container is absent or the inspect fails (treated as "unknown, keep
   * polling" — the deadline is the hard outer guarantee).
   */
  private inspectContainer(containerName: string): { status: string; exitCode: number } | null {
    try {
      const output = execFileSync(
        'docker',
        ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerName],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: DOCKER_INSPECT_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
        },
      ).trim();
      const parts = output.split(/\s+/u);
      const status = parts[0] ?? 'unknown';
      const exitCode = Number.parseInt(parts[1] ?? '-1', 10);
      return { status, exitCode: Number.isFinite(exitCode) ? exitCode : -1 };
    } catch {
      return null;
    }
  }

  /**
   * Capture the container's stdout/stderr logs for evidence digests. Uses
   * spawnSync so both streams are captured separately. Best-effort, capped at
   * MAX_STREAM_CAPTURE per stream (matches the host served runner).
   */
  private captureLogs(containerName: string): { stdout: string; stderr: string } {
    try {
      const result = spawnSync('docker', ['logs', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_LOGS_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: MAX_STREAM_CAPTURE,
      });
      const stdout = typeof result.stdout === 'string'
        ? result.stdout.slice(0, MAX_STREAM_CAPTURE) : '';
      const stderr = typeof result.stderr === 'string'
        ? result.stderr.slice(0, MAX_STREAM_CAPTURE) : '';
      return { stdout, stderr };
    } catch {
      return { stdout: '', stderr: '' };
    }
  }

  /**
   * Force-remove a container by name (idempotent — a missing container is not
   * an error). Used for pre-run collision cleanup and post-run termination.
   */
  private removeContainer(containerName: string): void {
    try {
      execFileSync('docker', ['rm', '-f', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RM_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // A missing container is expected on the pre-run cleanup and after a
      // container that exited on its own. Swallow — the observe/terminate
      // logic above already detected the real failure mode.
    }
  }
}
