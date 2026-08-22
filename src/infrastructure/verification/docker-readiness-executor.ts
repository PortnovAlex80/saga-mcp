import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
 * Docker readiness executor — prepares one post-install OCI environment, then
 * runs test and serve in independent fresh containers from that exact image.
 *
 * The executor is SYNCHRONOUS (the gate-run-driver rejects async providers).
 * Every docker CLI call goes through execFileSync/spawnSync with bounded
 * timeouts. No dockerode, no daemon API — just the docker CLI, the same way a
 * human runs `docker run`.
 *
 * Tree transfer: the provider extracts the exact git archive into a disposable
 * build context. Docker builds one session-owned image from an exact local tag
 * of the declared base plus the verbatim install command. Test mutations then
 * cannot prepare the separately-created serve container.
 *
 * Fail-closed policy (CC-GAP-9 / ADR-089): when the profile declares an image
 * but docker is unavailable (daemon down, not linux), the executor throws
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE / LOCAL_RUNNABILITY_DOCKER_NOT_LINUX.
 * The provider catches these INSIDE its try block, retries the precondition
 * deterministically up to the frozen in-check bound, and on exhaustion emits
 * the typed unknown outcome (`warrant-blocked-environment`) — never a product
 * `failed`. This is deliberate: the product declared a docker substrate, so
 * the provider refuses to silently fall back to host; and a missing
 * environment precondition is not a product verdict.
 */

/** `docker info` availability probe timeout (bounded so a hung daemon does not stall the gate). */
const DOCKER_INFO_TIMEOUT_MS = 8_000;
/** `docker pull` timeout — matches the install phase budget. */
const DOCKER_PULL_TIMEOUT_MS = 600_000;
/** `docker volume rm` / `docker rm -f` cleanup timeout. */
const DOCKER_RM_TIMEOUT_MS = 30_000;
/** Prepared-image build timeout, including the profile install command. */
const DOCKER_BUILD_TIMEOUT_MS = 600_000;
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
 * readiness check attempt. Reset between CC-GAP-9 in-check substrate retry
 * attempts (each retry must genuinely re-probe, never replay a cached miss)
 * and by process restart.
 */
let dockerAvailabilityCache: { available: boolean; linux: boolean } | null = null;

/**
 * Invalidate the process-level docker availability cache. Called by the
 * provider's bounded in-check substrate retry between attempts (CC-GAP-9 /
 * ADR-089) and by tests that need a fresh probe.
 */
export function resetDockerAvailabilityCache(): void {
  dockerAvailabilityCache = null;
}

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
  private readonly sessionId = randomBytes(8).toString('hex');
  private readonly preparedTag: string;
  private readonly baseTag: string;
  private readonly servedContainerName: string;
  private preparedImageId: string | null = null;
  private resolvedBaseImageId: string | null = null;

  constructor(
    private readonly contextDirectory: string,
    private readonly image: string,
  ) {
    this.preparedTag = `saga-lr-prepared:${this.sessionId}`;
    this.baseTag = `saga-lr-base:${this.sessionId}`;
    this.servedContainerName = `saga-lr-serve-${this.sessionId}`;
  }

  /**
   * Lazily prepare the docker substrate: verify the daemon, ensure the image is
   * present (pull if needed), create the volume, and stream the sealed tree tar
   * into it. Idempotent — the second call is a no-op. Throws
   * ReadinessExecutionError on any substrate-level failure: the two
   * environment-precondition codes (daemon down / not linux) carry the
   * CC-GAP-9 in-check retry and, on exhaustion, the typed unknown
   * `warrant-blocked-environment` outcome in the provider; every other code
   * records a decodable 'failed' outcome as before.
   */
  private ensureDockerAvailable(): void {
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
    // Ensure the declared image is present locally (pull if absent).
    this.ensureImagePulled();
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

  prepare(installCommand: string | null, timeoutMs: number): void {
    if (this.preparedImageId !== null) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PREPARE_REPLAY',
        'the Docker readiness environment was prepared more than once',
      );
    }
    this.ensureDockerAvailable();
    try {
      this.resolvedBaseImageId = execFileSync(
        'docker', ['image', 'inspect', '--format', '{{.Id}}', this.image],
        {
          stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_INFO_TIMEOUT_MS,
          windowsHide: true, encoding: 'utf8',
        },
      ).trim();
      execFileSync('docker', ['tag', this.resolvedBaseImageId, this.baseTag], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        windowsHide: true,
      });
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_BASE_RESOLUTION_FAILED',
        `could not freeze declared image "${this.image}" to a local image identity: ${errorMessage(error)}`,
      );
    }
    const dockerfile = [
      `FROM ${this.baseTag}`,
      'WORKDIR /work',
      'COPY . /work',
      ...(installCommand === null
        ? []
        : [`RUN ["sh", "-c", ${JSON.stringify(installCommand)}]`]),
      '',
    ].join('\n');
    const result = spawnSync(
      'docker', [
        'build', '--quiet', '--file', '-', '--tag', this.preparedTag,
        '--label', `saga.readiness.session=${this.sessionId}`,
        this.contextDirectory,
      ],
      {
        input: dockerfile,
        timeout: Math.max(timeoutMs, DOCKER_BUILD_TIMEOUT_MS),
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        commandFailureDetail('docker build', [installCommand ?? '<no-install>'], {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.error && (result.error as NodeJS.ErrnoException).code,
          message: result.error?.message,
        }),
      );
    }
    try {
      this.preparedImageId = execFileSync(
        'docker', ['image', 'inspect', '--format', '{{.Id}}', this.preparedTag],
        {
          stdio: ['ignore', 'pipe', 'pipe'], timeout: DOCKER_INFO_TIMEOUT_MS,
          windowsHide: true, encoding: 'utf8',
        },
      ).trim();
    } catch (error) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_PREPARED_IMAGE_MISSING',
        `Docker build completed without an inspectable prepared image: ${errorMessage(error)}`,
      );
    }
  }

  runCommand(command: string, timeoutMs: number): void {
    const preparedImage = this.requirePreparedImage();
    // The command runs verbatim via `sh -c` inside the container. No npm/node
    // routing, no ./ stripping, no JVM env — the image IS the environment. CI=1
    // matches the host executor's convention so the product's test command
    // behaves the same in both substrates.
    try {
      execFileSync('docker', [
        'run', '--rm',
        '-w', '/work',
        '-e', 'CI=1',
        preparedImage,
        'sh', '-c', command,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run ${preparedImage} sh -c`,
        [command],
        error,
      ));
    }
  }

  runServed(startCommand: string, probeTimeoutMs: number, port: number): ServeEvidence {
    const preparedImage = this.requirePreparedImage();
    const containerName = this.servedContainerName;
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
        '--label', `saga.readiness.session=${this.sessionId}`,
        '-p', `127.0.0.1:${port}:${port}`,
        '-w', '/work',
        '-e', `PORT=${port}`,
        '-e', 'HOST=0.0.0.0',
        '-e', 'CI=1',
        preparedImage,
        'sh', '-c', startCommand,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RUN_D_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error(commandFailureDetail(
        `docker run -d ${preparedImage} sh -c`,
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
    return {
      substrate: 'docker',
      image: this.image,
      ...(this.resolvedBaseImageId ? { resolvedImageId: this.resolvedBaseImageId } : {}),
      phaseModel: 'prepared-oci-image',
    };
  }

  dispose(): void {
    this.removeContainer(this.servedContainerName);
    this.removeImage(this.preparedTag);
    this.removeImage(this.baseTag);
    this.preparedImageId = null;
    this.resolvedBaseImageId = null;
  }

  private requirePreparedImage(): string {
    if (this.preparedImageId === null) {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_NOT_PREPARED',
        'Docker readiness test/serve was invoked before environment preparation',
      );
    }
    return this.preparedImageId;
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
          + `(container="${containerName}", port=${port}); the served command `
          + 'must bind the Factory-provided PORT environment variable',
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

  /** Remove only an image tag owned by this readiness session. */
  private removeImage(imageRef: string): void {
    try {
      execFileSync('docker', ['image', 'rm', '-f', imageRef], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DOCKER_RM_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup; tags are random and session-owned.
    }
  }
}
